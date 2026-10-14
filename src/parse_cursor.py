"""Parse a Cursor chat tree (a chat plus its sub-agent chats, all rows of one SQLite database) into the shared replay data
model.

Mapping to the page model:
  chat (composerData)     -> agent (the listed chat = "main"; every sub-agent chat keyed by its composerId, parent from the
                             task call that started it, else subagentInfo.parentComposerId)
  user message (type 1)   -> turn (in a sub-agent chat the first one is the briefing, later ones are follow-ups)
  assistant messages      -> steps. One model response is stored as several separate messages in order: thinking (with
                             thinkingDurationMs), reply text, then one message per tool call. They are merged into one step:
                             a thinking or text message starts a new step once the open step has tool calls; a tool message
                             joins the open step when both carry the same response id (the calls of one response share the
                             <uuid> of toolFormerData.toolCallId "call-<uuid>-<n>", or the base of modelCallId "fc_<uuid>_<i>").
                             When an id is missing on either side, it joins if it starts within SAME_RESPONSE_GAP_MS of the
                             previous call's end (parallel or back-to-back calls; a new model call needs a round trip first).
                             A step without tool calls is the final reply of a turn.
  thinking / text         -> the step's reasoning summary (rsum, the thinking text when Cursor stored it) and its explanation
                             (said); a reply before the tool calls explains them, a step with only a reply is "says"
  tool message            -> call: toolFormerData.name / params / rawArgs / result / error / status (cursor_calls.py);
                             cancelled, error, a refused or non-zero shell command are failed calls
  task_v2 call            -> dispatch of the sub-agent chat named in additionalData.subagentComposerId (else result.agentId);
                             params.prompt is the briefing, the chat's last reply without tool calls (else its subtitle) is
                             the report. The call is marked disp.block: it returns when the sub-agent is done, so the parent
                             waits (timeseg.js "等子代理")
Model and effort come from composerData.modelConfig (modelName, selectedModels[].parameters effort); empty when missing.

Times are estimates from recorded stamps. A message is stamped when it started streaming (the next message of a response
follows at the end of the previous one: a thinking message at T lasting thinkingDurationMs is followed by the reply at about
T + thinkingDurationMs). A tool message starts at its stamp and ends at the header's completedAtMs; where Cursor did not
record that, the next message's stamp stands in for the end. The model wait of a step ("gap") is its first stamp minus the end
of the previous step or the user message; thinking time is the sum of thinkingDurationMs; the end of a turn's final reply is
the user stamp plus turnDurationMs when the header has it, else the reply's own stamp. A message with no time at all inherits
the previous message's stamp (zero length), nothing is invented.

Tokens and amounts: Cursor does not record token usage locally (tokenCount is always 0). Every step has zero tokens and no
price (cost None, "unpriced"): the page shows "未定价" instead of a made-up $0.00. The end-of-chat context snapshot
(contextTokensUsed) becomes the context size of the agent's last step.
"""
import prices
import source_cursor
from common import Progress, cut, finish_agent, link_agents, totals
from cursor_calls import AGENT_TOOLS, agent_id, agent_kind, args_of, make_call, response_key
from cursor_scan import load_session, ms_of, project_dir, snapshot, split, stat

SAME_RESPONSE_GAP_MS = 800


def model_of(sess):
    """-> (model name, effort) from composerData.modelConfig."""
    mc = sess.get("modelConfig") if isinstance(sess.get("modelConfig"), dict) else {}
    model, effort = str(mc.get("modelName") or ""), ""
    for sm in mc.get("selectedModels") or []:
        if not isinstance(sm, dict):
            continue
        model = model or str(sm.get("modelId") or "")
        for p in sm.get("parameters") or []:
            if isinstance(p, dict) and p.get("id") == "effort" and not effort:
                effort = str(p.get("value") or "")
    return model, effort


def stamps_of(msgs):
    """Time of each message (ms): its createdAt, else the header's startedAtMs / createdAt, else the previous message's. A
    leading run without any time takes the first known one."""
    out, last = [], None
    for m in msgs:
        h = m["h"]
        ts = next((t for t in (ms_of(m.get("createdAt")), ms_of(h.get("startedAtMs")), ms_of(h.get("createdAt"))) if t is not None), last)
        out.append(ts)
        last = ts if ts is not None else last
    first = next((t for t in out if t is not None), 0)
    return [first if t is None else t for t in out]


def _new_pending():
    return {"ts": None, "last": None, "texts": [], "thinks": [], "tdur": 0, "calls": [], "mcid": None, "call_end": None}


def build_agent(aid, sess, msgs, ctx, is_root, meta, dispatch):
    """One chat -> agent dict (finish_agent applies the cost decisions)."""
    caps = (ctx["out"], ctx["inp"])
    model, effort = model_of(sess)
    stamps_all = stamps_of(msgs)
    turns, steps, stamps = [], [], []
    st = {"cur": None, "pend": _new_pending(), "prev_text": None, "last_act": 0, "brief": None, "turn_ms": 0}
    pr = source_cursor.price_step(model, {})

    def open_turn(ev):
        close_turn(False)
        st["cur"] = {"trig": ev, "evs": [], "steps": [], "t0": ev["ts"]}
        turns.append(st["cur"])
        st["prev_text"], st["turn_ms"] = None, 0
        st["last_act"] = ev["ts"]
        stamps.append(ev["ts"])

    def close_turn(final):
        flush()
        t = st["cur"]
        if t is None:
            return
        last = t["steps"][-1] if t["steps"] else None
        if last is not None and not last["calls"] and last["says"]:
            if st["turn_ms"] and t["t0"] + st["turn_ms"] > last["end"]:
                last["fin"] = last["end"] = t["t0"] + st["turn_ms"]
                stamps.append(last["end"])
            t["end"], t["endKind"] = last["end"], "complete"
        elif final and sess.get("status") == "aborted" and last is not None:
            t["end"], t["endKind"] = last["end"], "abort"
        t.pop("t0", None)

    def flush():
        p = st["pend"]
        st["pend"] = _new_pending()
        if not (p["texts"] or p["thinks"] or p["calls"]):
            return
        if st["cur"] is None:
            open_turn({"k": "meta", "ts": p["ts"], "text": "（本轮没有可见的触发消息）"})
        calls = p["calls"]
        text = "\n\n".join(p["texts"]).strip()
        said, src = (text, "same") if text and calls else ("", "")
        if not said and calls and st["prev_text"]:
            said, src = st["prev_text"], "prev"
        fin = p["last"]
        end = max([fin] + [c["ts"] + c["dur"] for c in calls])
        step = {"n": len(steps), "ts": p["ts"], "end": end, "fin": fin, "stop": "tool_use" if calls else "end_turn", "fam": model or "cursor",
                "model": model, "effort": effort, "cost": pr["cost"], "priced": pr["priced"], "ctx": 0, "tok": dict(pr["tok"]), "think": p["tdur"],
                "gap": max(0, p["ts"] - st["last_act"]) if st["last_act"] else 0, "said": said, "saidSrc": src,
                "says": text if not calls else "", "rsum": cut("\n\n".join(p["thinks"]), 1200), "cause": [],
                "after": steps[-1]["n"] if steps else None, "calls": calls}
        steps.append(step)
        st["cur"]["steps"].append(step)
        st["prev_text"] = text or None
        st["last_act"] = max(st["last_act"], end)
        stamps.extend([step["ts"], end])

    for i, m in enumerate(msgs):
        ts = stamps_all[i]
        nxt = stamps_all[i + 1] if i + 1 < len(msgs) else None
        h = m["h"]
        if h.get("turnDurationMs"):
            st["turn_ms"] = int(h["turnDurationMs"])
        if m["type"] == 1:
            text = (m["text"] or "").strip()
            flush()
            if not is_root and st["brief"] is None:
                st["brief"] = text or dispatch.get(aid, {}).get("prompt") or ""
                open_turn({"k": "brief", "ts": ts, "text": ""})
            else:
                open_turn({"k": "human" if is_root else "followup", "ts": ts, "text": cut(text or "（没有文本内容）", caps[1])})
            continue
        if m["type"] != 2:
            continue
        p = st["pend"]
        tool = m["tool"]
        if tool is None:
            text, think = (m["text"] or "").strip(), (m["thinking"] or "").strip()
            dur = m.get("thinkingDurationMs") or h.get("thinkingDurationMs") or 0
            if not (text or think or dur):
                continue
            if p["calls"]:
                flush()
                p = st["pend"]
            if p["ts"] is None:
                p["ts"] = ts
            p["last"] = ts
            if text:
                p["texts"].append(text)
            if think:
                p["thinks"].append(think)
            p["tdur"] += int(dur) if isinstance(dur, (int, float)) and not isinstance(dur, bool) else 0
            continue
        mcid = response_key(tool)
        if p["calls"]:
            same = mcid == p["mcid"] if (mcid and p["mcid"]) else (ts - (p["call_end"] or ts) < SAME_RESPONSE_GAP_MS)
            if not same:
                flush()
                p = st["pend"]
        end = ms_of(h.get("completedAtMs"))
        linked = agent_id(tool) if tool.get("name") in AGENT_TOOLS else ""
        call = make_call(m, ts, end if end is not None else nxt, ctx, linked if linked in ctx["ids"] else None)
        if p["ts"] is None:
            p["ts"] = ts
        p["last"], p["mcid"] = ts, p["mcid"] or mcid
        p["call_end"] = max(p["call_end"] or 0, call["ts"] + call["dur"])
        p["calls"].append(call)
    close_turn(True)
    ctx_end = sess.get("contextTokensUsed")
    if steps and isinstance(ctx_end, (int, float)) and not isinstance(ctx_end, bool) and ctx_end > 0:
        steps[-1]["ctx"] = int(ctx_end)
    a_meta = dict(meta, model=model, effort=effort)
    return finish_agent(aid, turns, steps, stamps, st["brief"] or "", a_meta, ctx)


def _dispatch_map(loaded):
    """sub-agent chat id -> {prompt, type, description, model, owner} from the task calls (in any chat of the tree)."""
    out = {}
    for aid, (_, msgs) in loaded.items():
        for m in msgs:
            t = m.get("tool")
            if t and t.get("name") in AGENT_TOOLS and agent_id(t):
                p, raw = args_of(t)
                both = dict(raw, **p)
                out.setdefault(agent_id(t), {"prompt": str(both.get("prompt") or ""), "type": agent_kind(both),
                                             "description": str(both.get("description") or ""), "model": str(both.get("model") or ""), "owner": aid})
    return out


def parse_cursor(root_id, tree, name="", out_chars=600, inp_chars=6000, progress=None):
    """tree: {"main": virtual path, composerId: virtual path of each sub-agent chat} (Source.tree)."""
    root_path = tree.get("main") or tree[root_id]
    try:
        total = stat(root_path)[0]
    except OSError:
        total = 1
    tracker = Progress(progress, total)
    loaded = {}
    for aid, path in tree.items():
        tracker.label("读取 %s" % ("主会话" if aid == "main" else "子代理会话 %s" % aid[:8]))
        sess, msgs = load_session(path)
        loaded[aid] = (sess, msgs)
        tracker.add(sum(m["bytes"] for m in msgs))
    tracker.label("整理步骤")
    root_sess = loaded["main"][0]
    root_sid = root_sess.get("id") or root_id
    dispatch = _dispatch_map(loaded)
    ids = {a for a in loaded if a != "main"}
    ctx = {"out": out_chars, "inp": inp_chars, "family": lambda m: m or "cursor", "codex": False, "ids": ids}
    depth, agents = {"main": 0}, []
    for aid in loaded:
        sess, msgs = loaded[aid]
        d = dispatch.get(aid, {})
        parent = None
        if aid != "main":
            info = sess.get("subagentInfo") if isinstance(sess.get("subagentInfo"), dict) else {}
            parent = d.get("owner") or (info.get("parentComposerId") if info.get("parentComposerId") in loaded else "main")
            depth[aid] = depth.get(parent, 0) + 1
            kind = d.get("type") or str(sess.get("name") or "")
            what = d.get("description") or str(sess.get("name") or "")
            desc = "%s · %s" % (kind, what) if kind and what and kind != what else (kind or what or "子代理")
            meta = {"description": desc, "agentType": d.get("type", ""), "spawnDepth": depth[aid]}
        else:
            meta = {"description": "主代理", "spawnDepth": 0}
        a = build_agent(aid, sess, msgs, ctx, aid == "main", meta, dispatch)
        a.update(tool="cursor", path="", parent=parent, cwd="")
        if aid != "main" and not a["report"] and str(sess.get("subtitle") or "").strip():
            a["report"], a["reportSrc"] = str(sess["subtitle"]).strip(), "lasttext"
        agents.append(a)
    by_id = {a["id"]: a for a in agents}
    for a in agents:  # a dispatching call shows the sub-agent's model
        for t in a["turns"]:
            for s in t["steps"]:
                for c in s["calls"]:
                    if c.get("agent") in by_id and c.get("disp"):
                        c["disp"]["model"], c["disp"]["effort"] = by_id[c["agent"]]["model"], by_id[c["agent"]]["effort"]
    link_agents(agents)
    root = agents[0]
    models = sorted({s["model"] for a in agents for t in a["turns"] for s in t["steps"] if s["model"]})
    meta_out = {"tool": "cursor", "pricing": prices.meta("cursor"), "sid": root_sid, "name": name or root_sid[:8],
                "start": root["start"], "end": max(a["end"] for a in agents), "outChars": out_chars, "inpChars": inp_chars,
                "project": _project(root_path), "rows": sum(len(msgs) for _, msgs in loaded.values()), "models": models}
    root["cwd"] = meta_out["project"]
    return {"meta": meta_out, "agents": agents, "totals": totals(agents)}


def _project(path):
    db, sid = split(path)
    snap = snapshot(db)
    s = snap.sessions.get(sid) if snap else None
    return project_dir(db, s["wid"]) if s else ""
