"""Parse a Gemini CLI session (main session plus its sub-agent sessions) into the shared replay data model.

Mapping to the page model:
  session file          -> agent (the main session = "main"; a sub-agent session is keyed by its session id)
  real user message     -> turn head (human; in a sub-agent file the first one is the briefing, later ones are follow-ups).
                           The first "user" record is a <session_context> block injected by the CLI: it is shown as a
                           system message folded into the first turn, not as something the user said. "user" records
                           whose parts carry no text are tool results echoed by the CLI and are skipped.
  info / error record   -> inline system event (cause of the next step)
  gemini message        -> step. Records are merged by id first (the CLI writes each model message twice; the second copy
                           has the tool calls), so tokens are counted once. The message text becomes the step's
                           explanation, thoughts[] (subject + description) its reasoning summary.
  toolCalls[]           -> calls of that step. invoke_agent (or any call with an agentId) is the dispatch of the sub-agent
                           session with that session id; its briefing is args.prompt and its report is the call's result.
Token usage: tokens.input includes tokens.cached; cached goes to the cache-read column, thoughts are billed (and shown) as
output with the thinking part reported separately, tool-use prompt tokens are billed as uncached input.

Times are estimates from the recorded timestamps:
  - a gemini message is stamped when the CLI wrote it, i.e. when the response had arrived: the model wait of a step is that
    stamp minus the previous record's stamp ("gap"), and the generation shows up as thinking time between them;
  - a tool call's own stamp is its completion time, so its duration is that stamp minus the stamp of the message that
    issued it. Calls issued by one message run in parallel and overlap (all of them start at the message stamp);
  - the thinking time of a step is the message stamp minus its first thought's stamp, limited to the wait since the
    previous record. Current CLI versions stamp thoughts with the message time, which then shows no thinking time.
"""
import os
from collections import Counter

import prices
import source_gemini
from common import Progress, cut, finish_agent, link_agents, totals, ts_ms
from gemini_calls import agent_result, make_call, unwrap_response
from gemini_scan import is_context, project_of, read_session, user_text

TURN_KINDS = {"human", "followup", "brief", "meta"}


def _ms(s):
    try:
        return ts_ms(s) if s else None
    except (ValueError, TypeError, AttributeError):
        return None


def _text(content):
    return (content if isinstance(content, str) else user_text(content)).strip()


def _thoughts(m, ts, floor):
    """-> (reasoning summary text, thinking ms). Thinking time never exceeds the wait since the previous record."""
    parts, first = [], None
    for t in m.get("thoughts") or []:
        if not isinstance(t, dict):
            continue
        subject, desc = str(t.get("subject") or "").strip(), str(t.get("description") or "").strip()
        if subject or desc:
            parts.append(("**%s**\n" % subject if subject else "") + desc)
        t0 = _ms(t.get("timestamp"))
        if t0 is not None:
            first = t0 if first is None else min(first, t0)
    think = max(0, ts - max(first, floor)) if (first is not None and floor is not None) else 0
    return "\n\n".join(parts), think


def build_agent(aid, sess, ctx, root, meta):
    """One session file -> agent dict (finish_agent applies the cost decisions)."""
    turns, steps, stamps = [], [], []
    st = {"cur": None, "pending": [], "prev_text": None, "last": None, "brief": None}

    def open_turn(ev):
        carried = []
        if st["cur"] is not None and not st["cur"]["steps"]:
            old = turns.pop()  # an empty turn folds into the next one as inline events
            carried = [dict(old["trig"], at=0)] + old["evs"]
        st["cur"] = {"trig": ev, "evs": carried, "steps": []}
        turns.append(st["cur"])
        st["pending"], st["prev_text"] = [], None

    def add_event(ev, stamp=True):
        if ev.get("ts") and stamp:
            stamps.append(ev["ts"])
        if ev["k"] in TURN_KINDS or st["cur"] is None:
            open_turn(ev)
        else:
            st["cur"]["evs"].append(dict(ev, at=len(st["cur"]["steps"])))
            st["pending"].append({"k": ev["k"], "text": cut(ev.get("text", ""), 240), "ts": ev["ts"], "tu": None, "from": None})

    for m in sess["msgs"]:
        ts = _ms(m.get("timestamp")) or st["last"] or 0
        kind = m.get("type")
        if kind == "user":
            text = _text(m.get("content"))
            if is_context(text):
                add_event({"k": "meta", "ts": ts, "text": cut(text, 240)}, stamp=False)
            elif text:
                if not root and st["brief"] is None:
                    st["brief"] = ctx["dispatch"].get(aid, {}).get("prompt") or text
                    add_event({"k": "brief", "ts": ts, "text": ""})
                else:
                    add_event({"k": "human" if root else "followup", "ts": ts, "text": text})
        elif kind in ("info", "error", "warning"):
            body = _text(m.get("content"))
            if body:
                add_event({"k": "info", "ts": ts, "text": ("错误：" if kind == "error" else "") + cut(body, 400)})
        elif kind == "gemini":
            _add_step(m, ts, st, ctx, steps, stamps, add_event)
        st["last"] = ts
    a_meta = dict(meta, model=Counter(s["model"] for s in steps if s["model"]).most_common(1)[0][0] if any(s["model"] for s in steps) else "")
    return finish_agent(aid, turns, steps, stamps, st["brief"] or "", a_meta, ctx)


def _add_step(m, ts, st, ctx, steps, stamps, add_event):
    model = str(m.get("model") or "")
    u = m.get("tokens") if isinstance(m.get("tokens"), dict) else None
    if u:
        pr = source_gemini.price_step(model, dict(u, day=str(m.get("timestamp") or "")[:10]))
    else:  # no usage recorded (e.g. an interrupted response): nothing to price
        pr = prices.result(0.0, source_gemini.gemini_tokens(None), True)
    tok = pr["tok"]
    calls = []
    for tc in m.get("toolCalls") or []:
        if isinstance(tc, dict):
            child = tc.get("agentId")
            calls.append(make_call(tc, ts, _ms(tc.get("timestamp")), ctx, child if child in ctx["ids"] else None))
    text = _text(m.get("content"))
    rsum, think = _thoughts(m, ts, st["last"])
    if st["cur"] is None:
        add_event({"k": "meta", "ts": ts, "text": "（本轮没有可见的触发消息）"})
    said, src = (text, "same") if text else ("", "")
    if not said and calls and st["prev_text"]:
        said, src = st["prev_text"], "prev"
    end = max([ts] + [c["ts"] + c["dur"] for c in calls])
    step = {"n": len(steps), "ts": ts, "end": end, "fin": ts, "fam": model or "gemini", "model": model, "effort": "",
            "cost": pr["cost"], "priced": pr["priced"], "ctx": tok["in"] + tok["cr"], "tok": tok, "think": think,
            "gap": max(0, ts - st["last"]) if st["last"] else 0, "said": said, "saidSrc": src, "says": text if not calls else "",
            "rsum": rsum, "cause": st["pending"], "after": steps[-1]["n"] if steps and not st["pending"] else None, "calls": calls}
    st["pending"] = []
    steps.append(step)
    st["cur"]["steps"].append(step)
    st["prev_text"] = text or None
    stamps.extend([ts, end])


def _dispatch_map(sessions, ids):
    """session id of a sub-agent -> {prompt, name, call} from the invoke_agent call (in any session) that started it."""
    out = {}
    for sess in sessions.values():
        for m in sess["msgs"]:
            for tc in m.get("toolCalls") or []:
                if isinstance(tc, dict) and tc.get("agentId") in ids:
                    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                    out[tc["agentId"]] = {"prompt": str(args.get("prompt") or ""), "name": str(args.get("agent_name") or ""), "call": tc}
    return out


def _own_report(sess):
    """A sub-agent's own account of its result: the complete_task argument, else the session summary."""
    for m in reversed(sess["msgs"]):
        for tc in reversed(m.get("toolCalls") or []):
            if isinstance(tc, dict) and tc.get("name") == "complete_task" and isinstance(tc.get("args"), dict):
                r = tc["args"].get("result")
                if isinstance(r, str) and r.strip():
                    return unwrap_response(r), _ms(tc.get("timestamp")) or 0
    return unwrap_response(str(sess["meta"].get("summary") or "")), 0


def parse_gemini(root_id, tree, name="", out_chars=600, inp_chars=6000, progress=None):
    """tree: {session id: file path}, the main session first (its key is root_id)."""
    tracker = Progress(progress, sum(os.path.getsize(p) for p in tree.values() if os.path.exists(p)))
    sessions = {}
    for sid, path in tree.items():
        tracker.label("读取 %s" % ("主会话" if sid == root_id else "子代理会话 %s" % sid[:8]))
        sessions[sid] = read_session(path, tracker.add)
    tracker.label("整理步骤")
    ids = {s for s in sessions if s != root_id}
    cwd, _ = project_of(source_gemini.SOURCE.root, tree[root_id], sessions[root_id]["meta"].get("projectHash") or "")
    dispatch = _dispatch_map(sessions, ids)
    ctx = {"out": out_chars, "inp": inp_chars, "family": lambda m: m or "gemini", "codex": True, "ids": ids, "dispatch": dispatch}
    order = [root_id] + sorted(ids, key=lambda s: _ms(sessions[s]["meta"].get("startTime")) or 0)
    agents = []
    for sid in order:
        aid = "main" if sid == root_id else sid
        if aid == "main":
            meta = {"description": "主代理", "spawnDepth": 0}
        else:
            kind = dispatch.get(sid, {}).get("name") or "子代理"
            meta = {"description": "%s · %s" % (kind, sid[:8]), "agentType": dispatch.get(sid, {}).get("name", ""), "spawnDepth": 1}
        a = build_agent(aid, sessions[sid], ctx, aid == "main", meta)
        a["tool"] = "gemini"
        a["cwd"] = cwd if aid == "main" else ""
        agents.append(a)
    link_agents(agents)
    by_id = {a["id"]: a for a in agents}
    calls = {c["agent"]: c for a in agents for t in a["turns"] for s in t["steps"] for c in s["calls"] if c.get("agent")}
    for a in agents[1:]:
        a["depth"] = 1 + (by_id[a["parent"]]["depth"] if a["parent"] in by_id and a["parent"] != "main" else 0)
        own, done = _own_report(sessions[a["id"]])
        rep = agent_result(dispatch[a["id"]]["call"]) if a["id"] in dispatch else ""
        if rep or own:
            a["report"], a["reportSrc"] = rep or own, "lasttext"
        call = calls.get(a["id"])
        a["doneTs"] = done or (call["ts"] + call["dur"] if call and call["st"] == "ok" else 0)
    root = agents[0]
    root_meta = sessions[root_id]["meta"]
    meta_out = {"tool": "gemini", "pricing": prices.meta("gemini"), "sid": root_id, "name": name or root_id[:8],
                "start": root["start"], "end": max(a["end"] for a in agents), "outChars": out_chars, "inpChars": inp_chars,
                "project": cwd, "rows": sum(len(s["msgs"]) for s in sessions.values()),
                "models": sorted({s["model"] for a in agents for t in a["turns"] for s in t["steps"] if s["model"]})}
    if root_meta.get("directories") and not cwd:
        meta_out["project"] = str((root_meta["directories"] or [""])[0])
    return {"meta": meta_out, "agents": agents, "totals": totals(agents)}
