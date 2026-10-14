"""Parse a Codex thread tree (root rollout plus sub-agent rollouts) into the shared replay data model.

Mapping to the page model:
  thread            -> agent (root = "main", sub-agent threads keyed by thread id, parent from session_meta)
  task_started..end -> turn (the first trigger event, user message or agent message, is the turn head)
  token_count       -> step boundary: one model response, with that response's token usage
  tool call         -> call (exec cells are expanded using the nested command/patch items)
Briefings sent to sub-agents are encrypted in the rollout; only the dispatch parameters are readable.
"""
import os
import re

import prices
import source_codex
from codex_calls import make_call
from codex_scan import scan_thread
from common import Progress, cut, finish_agent, link_agents, merge_kind, totals

BRIEF_ENC = "派单正文在 Codex 会话文件中是加密的，无法还原；下面只列出可读的派单参数。"
KIND_BY_MSG = {"NEW_TASK": "brief", "FINAL_ANSWER": "handback"}
TRIGGERS = {"human", "followup", "brief", "handback", "agentmsg", "xsession", "interrupt", "info", "compact", "meta", "taskstat"}


def _model_of(thread_state):
    return thread_state["model"] or "codex"


def build_thread(aid, data, ctx, paths):
    """Return (agent dict without cost decisions applied, raw step list). paths: agent path -> agent id."""
    meta, events = data["meta"], data["events"]
    own_path = meta.get("agent_path") or "/root"
    is_root = aid == "main"
    st = {"model": "", "effort": "", "cwd": meta.get("cwd") or ""}
    turns, steps, stamps = [], [], []
    cur = None
    start_pending = closed = True
    pending, recs, open_exec = [], {}, []
    seg = None
    last_act = 0
    prev_text = None
    prev_ctx = 0
    prev_total = -1

    def new_seg():
        return {"reason": [], "msgs": [], "recs": [], "think": 0, "t0": None, "rsn_ts": None}

    def open_turn(ev):
        nonlocal cur, pending, prev_text, start_pending, closed
        carried = []
        if cur is not None and not cur["steps"]:
            old = turns.pop()  # an empty turn folds into the next one as inline events
            carried = [dict(old["trig"], at=0)] + old["evs"]
        cur = {"trig": ev, "evs": carried, "steps": []}
        turns.append(cur)
        pending, prev_text, start_pending, closed = [], None, False, False

    def add_event(ev):
        nonlocal last_act
        if ev.get("ts"):
            stamps.append(ev["ts"])
            last_act = max(last_act, ev["ts"])
        if start_pending or closed or cur is None:
            open_turn(ev)
        else:
            cur["evs"].append(dict(ev, at=len(cur["steps"])))
            pending.append({"k": ev["k"], "text": cut(ev.get("text", ""), 240), "ts": ev["ts"], "tu": None, "from": ev.get("from")})

    def flush(usage_ev):
        """Close the current segment into a step. usage_ev may be None for work cut short by an abort."""
        nonlocal seg, prev_text, last_act, prev_ctx
        s, seg = seg, None
        if s is None or not (s["reason"] or s["msgs"] or s["recs"] or usage_ev):
            return
        if cur is None or start_pending or closed:
            ts0 = s["t0"] or (usage_ev["ts"] if usage_ev else 0)
            open_turn({"k": "meta", "ts": ts0, "text": "（本轮没有可见的触发消息，Codex 自动继续）"})
        u = usage_ev["last"] if usage_ev else {"in": 0, "cached": 0, "cw": 0, "out": 0, "rsn": 0}
        first_ts = min([x for x in [s["t0"]] + [m["ts"] for m in s["msgs"]] + [r["ev"]["ts"] for r in s["recs"]] + [r["ts"] for r in s["reason"]] if x] or [usage_ev["ts"] if usage_ev else last_act])
        texts_before = [m["text"] for m in s["msgs"] if m["ncalls"] == 0]
        texts_all = [m["text"] for m in s["msgs"]]
        said, src = "\n\n".join(texts_before), "same"
        if not said and s["recs"] and prev_text:
            said, src = prev_text, "prev"
        elif not said:
            src = ""
        model = st["model"] or "codex"
        pr = source_codex.price_step(model, u)
        if not usage_ev:  # work cut short by an abort has no usage row: nothing to price, nothing unpriced
            pr["cost"], pr["priced"] = 0.0, True
        step = {"n": len(steps), "ts": first_ts, "end": usage_ev["ts"] if usage_ev else first_ts, "fam": model, "model": model,
                "effort": st["effort"], "cost": pr["cost"], "priced": pr["priced"], "ctx": u["in"] if usage_ev else prev_ctx, "tok": pr["tok"],
                "think": s["think"],
                "gap": 0, "_lastev": last_act, "_cwd": st["cwd"], "said": said, "saidSrc": src, "says": "\n\n".join(texts_all) if not s["recs"] else "",
                "rsum": "\n".join(r["text"] for r in s["reason"]), "cause": pending[:],
                "after": steps[-1]["n"] if steps and not pending else None, "calls": [], "_recs": s["recs"]}
        if pr["local"]:
            step["local"] = True
        pending.clear()
        steps.append(step)
        cur["steps"].append(step)
        stamps.extend([first_ts, step["end"]])
        prev_ctx = step["ctx"]
        prev_text = "\n\n".join(texts_all) if texts_all else None
        last_act = max(last_act, first_ts)

    for e in events:
        t = e["t"]
        if t == "turn_start":
            flush(None)
            start_pending, closed = True, False
            stamps.append(e["ts"])
        elif t == "turn_end":
            flush(None)
            if e["aborted"]:
                add_event({"k": "interrupt", "ts": e["ts"], "text": "回合被中断（%s）" % (e.get("reason") or "interrupted")})
            elif e["err"]:
                add_event({"k": "info", "ts": e["ts"], "text": "回合出错结束：" + cut(e["err"], 400)})
            if cur is not None and e.get("last"):
                cur["_last"] = e["last"]
            if cur is not None and not start_pending:  # a task that produced nothing must not end the previous turn
                cur["end"] = e["ts"]
                cur["endKind"] = "abort" if e["aborted"] else "error" if e["err"] else "complete"
            closed, start_pending = True, False
        elif t == "ctx":
            st["model"] = e["model"] or st["model"]
            st["effort"] = e["effort"] or st["effort"]
            st["cwd"] = e["cwd"] or st["cwd"]
        elif t == "ev":
            ev = dict(e["ev"])
            if ev["k"] == "usermsg":
                ev["k"] = "xsession" if ev["text"].lstrip().startswith("<codex_delegation>") else ("human" if is_root else "followup")
            add_event(ev)
        elif t == "agentmsg":
            if e["recipient"] != own_path and not (is_root and e["recipient"] in ("/root", "")):
                continue
            sender_id = paths.get(e["sender"], e["sender"])
            kind = KIND_BY_MSG.get(e["mtype"], "agentmsg")
            text = e["text"] if not e["enc"] else (e["text"] + "（正文已加密）").strip()
            briefs = ctx.setdefault("brief", {})
            if kind == "brief" and aid in briefs:
                kind = "agentmsg"  # only the first NEW_TASK is the briefing
            if kind == "brief":
                briefs[aid] = {"briefing": e["text"] if (e["text"] and not e["enc"]) else "", "from": sender_id}
                add_event({"k": "brief", "ts": e["ts"], "text": ""})
            else:
                add_event({"k": kind, "ts": e["ts"], "from": sender_id, "text": text or "（空消息）", "mtype": e["mtype"]})
        elif t == "compact":
            flush(None)
            add_event({"k": "compact", "ts": e["ts"], "trigger": "unknown", "pre": prev_ctx, "text": "上下文压缩"})
        elif t in ("reason", "think", "msg", "call", "out", "item", "usage"):
            if t == "usage":
                if e["total"]["total"] == prev_total:
                    continue  # repeated token_count without a new model response
                prev_total = e["total"]["total"]
                if seg is None:
                    seg = new_seg()
                flush(e)
                continue
            if seg is None:
                seg = new_seg()
            if t == "reason":
                seg["reason"].append(e)
            elif t == "think":
                seg["think"] += e["ms"]
                seg["t0"] = e["ts"] if seg["t0"] is None else min(seg["t0"], e["ts"])
            elif t == "msg":
                seg["msgs"].append({"ts": e["ts"], "text": e["text"], "phase": e["phase"], "ncalls": len(seg["recs"])})
            elif t == "call":
                rec = {"ev": e, "out": None, "items": []}
                seg["recs"].append(rec)
                recs[e["id"]] = rec
                if e["name"] == "exec" or e["custom"]:
                    open_exec.append(rec)
            elif t == "out":
                rec = recs.get(e["id"])
                if rec:
                    rec["out"] = e
                    if rec in open_exec:
                        open_exec.remove(rec)
            elif t == "item":
                if e["k"] == "sub":
                    rec = recs.get(e["id"])
                    if rec is not None:
                        rec["sub"] = e
                    ctx.setdefault("subact", {})[e["id"]] = e
                elif open_exec:
                    open_exec[0]["items"].append(e)
                else:  # function-style tools (e.g. MCP) complete their item right after the call row
                    last = next((r for r in reversed(seg["recs"]) if r["out"] is None), None)
                    if last:
                        last["items"].append(e)
    flush(None)

    # Second pass: now that every output has arrived, build call dicts and time gaps.
    prev_end = 0
    for s in steps:
        calls = []
        cwd = s.pop("_cwd", "")
        for rec in s.pop("_recs"):
            c = make_call(rec["ev"], rec["out"], rec["items"], ctx)
            if c["cat"] == "git" and c["st"] == "ok":
                mk = merge_kind(c.get("inp") or c["sum"], cwd)
                if mk:
                    c["merge"] = mk
            sub = rec.get("sub") or ctx.get("subact", {}).get(rec["ev"]["id"])
            if sub and sub.get("kind") == "started":
                c["agent"] = sub["thread"]
            elif c["name"] == "spawn_agent" and rec["out"]:
                c["_spawn_out"] = rec["out"]["text"]
            calls.append(c)
            stamps.append(c["ts"] + c["dur"])
        s["calls"] = calls
        s["end"] = max([s["end"]] + [c["ts"] + c["dur"] for c in calls])
        s["gap"] = max(0, s["ts"] - max(s.pop("_lastev"), prev_end))
        prev_end = s["end"]
    return {"turns": turns, "steps": steps, "stamps": stamps, "model": _model_of(st), "effort": st["effort"], "cwd": st["cwd"]}


def parse_codex(root_id, tree, name="", out_chars=600, inp_chars=6000, progress=None):
    """tree: {thread id: rollout path} for the root thread and all its descendants."""
    tracker = Progress(progress, sum(os.path.getsize(p) for p in tree.values()))
    caps = (out_chars, inp_chars)
    scanned = {}
    for tid, path in tree.items():
        tracker.label("读取 %s" % ("主线程" if tid == root_id else "子代理线程 %s" % tid[:8]))
        scanned[tid] = scan_thread(path, caps, tracker.add)
    tracker.label("整理步骤")
    metas = {tid: d["meta"] for tid, d in scanned.items()}
    paths = {}
    for tid, m in metas.items():
        paths[m.get("agent_path") or ("/root" if tid == root_id else "")] = "main" if tid == root_id else tid
    paths.setdefault("/root", "main")
    ctx = {"out": out_chars, "inp": inp_chars, "family": lambda m: m or "codex", "codex": True}
    built = {}
    order = [root_id] + sorted((t for t in scanned if t != root_id), key=lambda t: scanned[t]["meta"].get("timestamp") or "")
    for tid in order:
        aid = "main" if tid == root_id else tid
        built[tid] = build_thread(aid, scanned[tid], ctx, paths)

    models = {s["model"] for b in built.values() for s in b["steps"]}
    agents = []
    spawn_args = {}
    for tid in order:
        for s in built[tid]["steps"]:
            for c in s["calls"]:
                sp, so = c.pop("_spawn", None), c.pop("_spawn_out", None)
                if not c.get("agent") and so:  # fallback: spawn output names the child by path
                    m = re.search(r'"task_name"\s*:\s*"([^"]+)"', so)
                    c["agent"] = paths.get(m.group(1)) if m else None
                if c.get("agent") and sp:
                    spawn_args[c["agent"]] = (sp, tid)
    for tid in order:
        aid = "main" if tid == root_id else tid
        b, m = built[tid], metas[tid]
        spawn, _ = spawn_args.get(tid, ({}, None))
        path = m.get("agent_path") or ""
        desc = "主代理" if aid == "main" else ("%s%s" % (path.rsplit("/", 1)[-1] or tid[:8], " · " + m["agent_nickname"] if m.get("agent_nickname") else ""))
        brief = ctx.get("brief", {}).get(aid, {})
        briefing = _briefing(brief.get("briefing", ""), spawn, aid)
        parent_tid = m.get("parent_thread_id")
        spawn_depth = (((m.get("source") or {}).get("subagent") or {}).get("thread_spawn") or {}).get("depth") if isinstance(m.get("source"), dict) else None
        meta = {"description": desc, "model": b["model"], "effort": b["effort"], "agentType": m.get("agent_role") or spawn.get("agent_type", ""),
                "spawnDepth": 0 if aid == "main" else (spawn_depth or (path.count("/") - 1 if path else 1))}
        a = finish_agent(aid, b["turns"], b["steps"], b["stamps"], briefing if aid != "main" else "", meta, ctx)
        a["tool"] = "codex"
        a["path"] = path
        a["parent"] = None if aid == "main" else ("main" if parent_tid == root_id or parent_tid not in scanned else parent_tid)
        a["cwd"] = b["cwd"]
        for t in b["turns"]:
            last = t.pop("_last", None)
            if last and aid != "main" and not a["report"]:
                a["report"], a["reportSrc"] = last, "lastmsg"
        if aid != "main":
            for t in b["turns"]:
                if t["trig"]["k"] == "brief":
                    t["trig"]["text"] = ""
        agents.append(a)
    # Sub-agents whose parent thread is not part of the scanned tree attach to the root.
    link_agents(agents)
    root = agents[0]
    meta_out = {"tool": "codex", "pricing": prices.meta("codex"), "sid": root_id,
                "name": name or root_id[:8], "start": root["start"], "end": max(a["end"] for a in agents), "outChars": out_chars,
                "inpChars": inp_chars, "project": root.get("cwd") or metas[root_id].get("cwd") or "",
                "rows": sum(len(d["events"]) for d in scanned.values()),
                "models": sorted(models)}
    return {"meta": meta_out, "agents": agents, "totals": totals(agents)}


def _briefing(text, spawn, aid):
    if text:
        return text
    parts = []
    for k in ("task_name", "agent_type", "model", "reasoning_effort", "fork_turns", "fork_context"):
        if spawn.get(k) not in (None, ""):
            parts.append("%s = %s" % (k, spawn[k]))
    return BRIEF_ENC + ("\n" + "\n".join(parts) if parts else "")
