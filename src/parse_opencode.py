"""Parse an opencode session tree (a session plus its sub-sessions, all rows of one SQLite database) into the shared
replay data model.

Mapping to the page model:
  session            -> agent (the listed session = "main"; every sub-session keyed by its session id, parent from
                        session.parent_id, so nesting follows the database and not the task calls)
  user message       -> turn (its text parts are the trigger; in a sub-session the first one is the briefing)
  assistant message  -> step: one model call plus the tool calls it made. opencode writes one assistant message per
                        loop iteration (step-start .. step-finish), so message.tokens is that response's usage:
                        input (uncached), output, reasoning (separate from output), cache.read, cache.write
  tool part          -> call: tool name, input, output or error, status, and state.time.start/end as measured times
  reasoning part     -> the step's reasoning summary (rsum); empty when the provider does not expose it
  text part          -> what the model said before / with its tool calls
  task tool call     -> opens the sub-session named in state.metadata.sessionId; when a call does not carry it, an
                        unclaimed child is matched to the latest earlier task call
Message errors become events of the turn: MessageAbortedError is an interruption, anything else a system notice.
A response that failed before producing anything has no step (nothing was generated or billed).
"""
import re

import prices
import source_opencode
from common import Progress, cut, finish_agent, link_agents, merge_kind, totals
from opencode_calls import make_call
from opencode_scan import load_session, model_id, split, stat

_DEFAULT_TITLE = re.compile(r"^(New|Child) session - ")
DONE_REASONS_OPEN = ("tool-calls", "tool_use", "unknown", None, "")
STOP_NAMES = {"stop": "end_turn", "tool-calls": "tool_use"}


def _tokens(d, parts):
    """Token counts of an assistant message: its own tokens, else the sum of its step-finish parts."""
    def of(t):
        c = (t or {}).get("cache") or {}
        return {"in": int(t.get("input") or 0), "out": int(t.get("output") or 0), "rsn": int(t.get("reasoning") or 0),
                "cr": int(c.get("read") or 0), "cw": int(c.get("write") or 0)} if isinstance(t, dict) else None
    own = of(d.get("tokens"))
    if own and any(own.values()):
        return own
    acc = {"in": 0, "out": 0, "rsn": 0, "cr": 0, "cw": 0}
    for p in parts:
        if p["data"].get("type") == "step-finish":
            for k, v in (of(p["data"].get("tokens")) or {}).items():
                acc[k] += v
    return acc


def _user_event(m, is_root, first, caps):
    """Trigger event of a user message, or a compact marker when it only requests a compaction."""
    texts, extra, compact = [], [], None
    for p in m["parts"]:
        pd = p["data"]
        t = pd.get("type")
        if t == "text" and not pd.get("ignored") and (pd.get("text") or "").strip():
            texts.append(pd["text"].strip())
        elif t == "file":
            extra.append("[附件] %s" % (pd.get("filename") or pd.get("mime") or "file"))
        elif t == "agent":
            extra.append("[@%s]" % (pd.get("name") or "agent"))
        elif t == "subtask":
            extra.append("[子任务] %s" % (pd.get("description") or pd.get("agent") or ""))
        elif t == "compaction":
            compact = pd
    ts = int((m["data"].get("time") or {}).get("created") or m["created"] or 0)
    if compact is not None and not texts:
        return {"k": "compact", "ts": ts, "trigger": "auto" if compact.get("auto") else "manual", "text": "上下文压缩"}
    text = "\n\n".join(texts + extra) or "（没有文本内容）"
    kind = "brief" if (not is_root and first) else ("human" if is_root else "followup")
    return {"k": kind, "ts": ts, "text": cut(text, caps[1]) if kind != "brief" else text}


def build_thread(aid, sess, msgs, ctx, is_root):
    """-> dict(turns, steps, stamps, model, effort, cwd, briefing, tasks) for one session; tasks = its task calls in order."""
    caps = (ctx["out"], ctx["inp"])
    turns, steps, stamps, tasks = [], [], [], []
    cur = None
    prev_text, prev_ctx, last_act = None, 0, 0
    cwd = sess.get("directory") or ""
    briefing = ""
    models = []

    def open_turn(ev):
        nonlocal cur, prev_text
        carried = []
        if cur is not None and not cur["steps"]:
            old = turns.pop()  # an empty turn folds into the next one as inline events
            carried = [dict(old["trig"], at=0)] + old["evs"]
        cur = {"trig": ev, "evs": carried, "steps": []}
        turns.append(cur)
        prev_text = None

    def event(ev):
        nonlocal last_act
        stamps.append(ev["ts"])
        last_act = max(last_act, ev["ts"])
        if cur is None:
            open_turn(ev)
        else:
            cur["evs"].append(dict(ev, at=len(cur["steps"])))

    for m in msgs:
        d = m["data"]
        role = d.get("role")
        if role == "user":
            ev = _user_event(m, is_root, not turns, caps)
            if ev["k"] == "compact":
                ev["pre"] = prev_ctx
                event(ev)
                continue
            if ev["k"] == "brief":
                briefing = ev["text"]
            open_turn(ev)
            stamps.append(ev["ts"])
            last_act = max(last_act, ev["ts"])
            continue
        if role != "assistant":
            continue
        tm = d.get("time") or {}
        created = int(tm.get("created") or m["created"] or 0)
        completed = int(tm.get("completed") or 0)
        err = d.get("error") if isinstance(d.get("error"), dict) else None
        texts, rsum, calls_raw, seen_tool, texts_before = [], [], [], False, []
        for p in m["parts"]:
            pd = dict(p["data"], _created=p["created"])
            t = pd.get("type")
            if t == "text" and not pd.get("ignored") and (pd.get("text") or "").strip():
                texts.append(pd["text"].strip())
                if not seen_tool:
                    texts_before.append(pd["text"].strip())
            elif t == "reasoning" and (pd.get("text") or "").strip():
                rsum.append(pd["text"].strip())
            elif t == "tool":
                seen_tool = True
                calls_raw.append(pd)
        tk = _tokens(d, m["parts"])
        model = model_id(d.get("modelID") or d.get("model")) or model_id(sess.get("model"))
        if cur is None:
            open_turn({"k": "meta", "ts": created, "text": "（本轮没有可见的触发消息）"})
            stamps.append(created)
        if not (texts or rsum or calls_raw or any(tk.values())):
            if err:  # failed before producing anything: no step, only the notice
                event(_error_event(err, completed or created))
                cur["_last"] = (completed, "error", err)
            continue
        usage = {"in": tk["in"], "out": tk["out"], "rsn": tk["rsn"], "cr": tk["cr"], "cw": tk["cw"], "provider": d.get("providerID") or ""}
        pr = source_opencode.price_step(model, usage)
        cwd_m = (d.get("path") or {}).get("cwd") or cwd
        calls = []
        for p in calls_raw:
            c = make_call(p, ctx)
            if c["cat"] == "git" and c["st"] == "ok":
                mk = merge_kind(c.get("inp") or c["sum"], cwd_m)
                if mk:
                    c["merge"] = mk
            if c["name"] == "task":
                tasks.append(c)
            calls.append(c)
            stamps.append(c["ts"] + c["dur"])
        fin = completed or created
        starts = [c["ts"] for c in calls if c["ts"]]
        think = max(0, (min(starts) if starts else fin) - created)
        end = max([fin] + [c["ts"] + c["dur"] for c in calls])
        said, src = "\n\n".join(texts_before), "same"
        if not said and calls and prev_text:
            said, src = prev_text, "prev"
        elif not said:
            src = ""
        finish = d.get("finish")
        ctx_tokens = tk["in"] + tk["cr"] + tk["cw"]
        step = {"n": len(steps), "ts": created, "end": end, "fin": fin, "stop": STOP_NAMES.get(finish, finish or ""), "fam": model or "opencode",
                "model": model, "effort": "", "cost": pr["cost"], "priced": pr["priced"], "ctx": ctx_tokens or prev_ctx, "tok": pr["tok"],
                "think": think, "gap": max(0, created - last_act) if last_act else 0, "said": said, "saidSrc": src,
                "says": "\n\n".join(texts) if not calls else "", "rsum": cut("\n".join(rsum), 1200), "cause": [],
                "after": steps[-1]["n"] if steps else None, "calls": calls}
        if pr["local"]:
            step["local"] = True
        steps.append(step)
        cur["steps"].append(step)
        stamps.extend([created, end])
        models.append(model)
        prev_ctx = step["ctx"]
        prev_text = "\n\n".join(texts) if texts else None
        last_act = max(last_act, end)
        cur["_last"] = (completed, finish, err)
        if err:
            ev = _error_event(err, completed or end)
            cur["evs"].append(dict(ev, at=len(cur["steps"])))
            stamps.append(ev["ts"])
    for t in turns:
        completed, finish, err = t.pop("_last", (0, None, None))
        if err:
            t["end"], t["endKind"] = completed or 0, "abort" if err.get("name") == "MessageAbortedError" else "error"
        elif completed and finish not in DONE_REASONS_OPEN:
            t["end"], t["endKind"] = completed, "complete"
    main_model = max(set(models), key=models.count) if models else model_id(sess.get("model"))
    return {"turns": turns, "steps": steps, "stamps": stamps, "model": main_model, "cwd": cwd, "briefing": briefing, "tasks": tasks}


def _error_event(err, ts):
    data = err.get("data") if isinstance(err.get("data"), dict) else {}
    msg = str(data.get("message") or "")
    if err.get("name") == "MessageAbortedError":
        return {"k": "interrupt", "ts": ts, "text": "回合被中断" + ("：" + cut(msg, 200) if msg else "")}
    return {"k": "info", "ts": ts, "text": "模型调用出错（%s）%s" % (err.get("name") or "error", "：" + cut(msg, 400) if msg else "")}


def _link_tasks(built, sessions):
    """Match task calls to sub-sessions -> {child agent id: the task call}; sets call["agent"]."""
    owner = {s["id"]: aid for aid, s in sessions.items()}
    claimed = {}
    for aid, b in built.items():
        for c in b["tasks"]:
            child = owner.get(c.get("_sid"))
            if child and child != aid and child not in claimed:
                claimed[child] = c
                c["agent"] = child
    for aid, b in built.items():  # fallback: an unclaimed child belongs to the latest earlier task call of its parent
        kids = sorted((k for k, s in sessions.items() if k not in claimed and owner.get(s.get("parent_id")) == aid),
                      key=lambda k: sessions[k].get("time_created") or 0)
        for k in kids:
            born = sessions[k].get("time_created") or 0
            free = [c for c in b["tasks"] if not c.get("agent") and c["ts"] <= born + 1000]
            if free:
                c = max(free, key=lambda x: x["ts"])
                c["agent"] = k
                claimed[k] = c
    return claimed


def _describe(aid, sess, task_in):
    if aid == "main":
        return "主代理"
    kind = task_in.get("subagent_type") or sess.get("agent") or "agent"
    title = sess.get("title") or ""
    what = task_in.get("description") or ("" if not title or _DEFAULT_TITLE.match(title) else title)
    return "%s · %s" % (kind, what) if what else kind


def parse_opencode(root_id, tree, name="", out_chars=600, inp_chars=6000, progress=None):
    """tree: {"main": virtual path, session id: virtual path of each sub-session} (Source.tree)."""
    root_path = tree.get("main") or tree[root_id]
    try:
        total = stat(root_path)[0]
    except OSError:
        total = 1
    tracker = Progress(progress, total)
    ctx = {"out": out_chars, "inp": inp_chars, "family": lambda m: m or "opencode", "codex": True}
    loaded, sessions = {}, {}
    for aid, path in tree.items():
        tracker.label("读取 %s" % ("主会话" if aid == "main" else "子会话 %s" % aid[-8:]))
        sess, msgs = load_session(path)
        loaded[aid], sessions[aid] = (sess, msgs), sess
        tracker.add(sum(m["bytes"] + sum(p["bytes"] for p in m["parts"]) for m in msgs))
    tracker.label("整理步骤")
    root_sid = sessions["main"]["id"] if "main" in sessions else root_id
    built = {aid: build_thread(aid, sess, msgs, ctx, aid == "main") for aid, (sess, msgs) in loaded.items()}
    claimed = _link_tasks(built, sessions)
    by_sid = {s["id"]: aid for aid, s in sessions.items()}
    order = ["main"] + sorted((a for a in built if a != "main"), key=lambda a: sessions[a].get("time_created") or 0)
    depth, agents = {"main": 0}, []
    for aid in order:
        sess, b = sessions[aid], built[aid]
        parent = None if aid == "main" else by_sid.get(sess.get("parent_id"), "main")
        depth[aid] = 0 if aid == "main" else depth.get(parent, 0) + 1
        call = claimed.get(aid)
        task_in = call.get("_in", {}) if call else {}
        meta = {"description": _describe(aid, sess, task_in), "model": b["model"], "effort": "",
                "agentType": task_in.get("subagent_type") or ("" if aid == "main" else sess.get("agent") or ""), "spawnDepth": depth[aid]}
        a = finish_agent(aid, b["turns"], b["steps"], b["stamps"], b["briefing"] if aid != "main" else "", meta, ctx)
        a.update(tool="opencode", path="", parent=parent, cwd=b["cwd"])
        if call is not None:
            call["inp"] = ""  # the prompt is the sub-session's briefing
            call["disp"]["model"] = b["model"]
        agents.append(a)
    for b in built.values():
        for c in b["tasks"]:
            c.pop("_sid", None)
            c.pop("_in", None)
    link_agents(agents)
    root = agents[0]
    models = sorted({s["model"] for b in built.values() for s in b["steps"] if s["model"]})
    meta_out = {"tool": "opencode", "pricing": prices.meta("opencode"), "sid": root_sid, "name": name or root_sid[-8:],
                "start": root["start"], "end": max(a["end"] for a in agents), "outChars": out_chars, "inpChars": inp_chars,
                "project": root.get("cwd") or "", "rows": sum(len(msgs) + sum(len(m["parts"]) for m in msgs) for _, msgs in loaded.values()),
                "models": models}
    return {"meta": meta_out, "agents": agents, "totals": totals(agents)}
