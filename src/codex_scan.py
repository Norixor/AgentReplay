"""Single-pass scanner for one Codex rollout file: turns raw JSONL rows into a compact event list.

Codex rollouts duplicate most content (response_item and event_msg/item_completed describe the same
work), so the scanner keeps only what the replay needs and skips the rest with a cheap header regex
before paying for json.loads. Strings are length-capped here so a 200 MB rollout stays small in memory.

Event kinds (dict key "t"):
  turn_start / turn_end   task boundaries (turn_end carries error text, aborted flag, last agent message)
  ctx                     model / effort / cwd from turn_context
  ev                      a trigger or inline event shown in the page ("ev" holds the page event dict)
  reason / think          reasoning summary text / reasoning duration
  msg                     assistant message (phase commentary|final_answer)
  call / out              tool call / its output, paired later by call_id
  item                    condensed item_completed (command, patch, MCP call, sub-agent activity ...)
  usage                   a model response finished: token usage of that response
  compact                 context compaction
"""
import json
import re

from common import cut, ts_ms

_HDR = re.compile(r'^\{"timestamp":"([^"]+)","ordinal":(\d+),"type":"(\w+)","payload":\{(?:"type":"(\w+)")?')
_ITEM = re.compile(r'"item":\{"type":"(\w+)"')
_STARTED = re.compile(r'"started_at_ms":(\d+)')
_DONE = re.compile(r'"completed_at_ms":(\d+)')
_MSG_HEAD = re.compile(r"Message Type: (\w+)\nTask name: (\S*)\nSender: (\S*)\nPayload:\n?")
_BOILERPLATE = ("<", "# AGENTS.md", "[Image")
# Row types that carry nothing the page shows.
_SKIP = {"world_state", "inter_agent_communication_metadata", "token_usage_record"}
_SKIP_EVENT = {"thread_settings_applied", "turn_started"}
# item_completed kinds worth keeping (the rest duplicate response_item rows).
_ITEMS = {"CommandExecution", "FileChange", "McpToolCall", "Extension", "ImageView", "SubAgentActivity",
          "UserMessage", "CollabAgentToolCall"}


def content_text(content):
    """Join the text parts of a message/output content list (string passes through)."""
    if isinstance(content, str):
        return content
    out = []
    for b in content or []:
        if not isinstance(b, dict):
            out.append(str(b))
            continue
        t = b.get("type")
        if t in ("input_text", "output_text", "text", "Text"):
            out.append(b.get("text", ""))
        elif t in ("input_image", "image", "Image", "localImage"):
            out.append("[图片]")
        elif t == "encrypted_content":
            out.append("")
    return "\n".join(x for x in out if x != "")


def parse_agent_message(payload):
    """-> (message type, sender path, plain text, encrypted?) for an agent_message payload."""
    parts = payload.get("content") or []
    head = next((b.get("text", "") for b in parts if b.get("type") == "input_text"), "")
    enc = any(b.get("type") == "encrypted_content" for b in parts)
    m = _MSG_HEAD.match(head)
    if not m:
        return "MESSAGE", payload.get("author", ""), head, enc
    return m.group(1), payload.get("author") or m.group(3), head[m.end():].strip(), enc


def _usage(u):
    u = u or {}
    inp, cached, cw = u.get("input_tokens", 0) or 0, u.get("cached_input_tokens", 0) or 0, u.get("cache_write_input_tokens", 0) or 0
    return {"in": inp, "cached": cached, "cw": cw, "out": u.get("output_tokens", 0) or 0,
            "rsn": u.get("reasoning_output_tokens", 0) or 0, "total": u.get("total_tokens", 0) or 0}


def _condense_item(it, ts, caps):
    t = it.get("type")
    if t == "CommandExecution":
        cmd = it.get("command")
        if isinstance(cmd, list):
            cmd = cmd[-1] if cmd else ""
        d = it.get("duration")
        if isinstance(d, dict):  # {"secs":..,"nanos":..}
            d = d.get("secs", 0) * 1000 + d.get("nanos", 0) // 1_000_000
        return {"k": "cmd", "cmd": cut(cmd or "", caps[1]), "exit": it.get("exit_code"), "status": it.get("status"), "ms": d}
    if t == "FileChange":
        return {"k": "patch", "files": list((it.get("changes") or {}).keys())[:30], "status": it.get("status")}
    if t == "McpToolCall":
        a = it.get("arguments") if isinstance(it.get("arguments"), dict) else {}
        return {"k": "mcp", "server": it.get("server"), "tool": it.get("tool"), "title": a.get("title") or "", "status": it.get("status"),
                "args": cut(json.dumps(a, ensure_ascii=False), 600)}
    if t == "Extension":
        return {"k": "ext", "kind": it.get("kind"), "query": it.get("query") or ""}
    if t == "ImageView":
        return {"k": "image", "path": str(it.get("path") or "")}
    if t == "SubAgentActivity":
        return {"k": "sub", "kind": it.get("kind"), "id": it.get("id"), "thread": it.get("agent_thread_id"), "path": it.get("agent_path")}
    if t == "CollabAgentToolCall":
        return {"k": "collab", "tool": it.get("tool"), "status": it.get("status"), "receivers": it.get("receiver_thread_ids") or []}
    return None


def scan_thread(path, caps, progress=None):
    """-> {"meta": session_meta payload (minus instructions), "events": [...], "nbytes": int, "weak_users": bool}.

    caps = (output chars, input chars). progress(nbytes) is called periodically.
    """
    meta, events = {}, []
    start_ord = 0
    strong_user = False
    acc = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f):
            if progress:
                acc += len(line)
                if n % 400 == 399:
                    progress(acc)
                    acc = 0
            m = _HDR.match(line)
            if not m:
                continue
            tsr, ordinal, rtype, ptype = m.group(1), int(m.group(2)), m.group(3), m.group(4)
            if rtype in _SKIP or (rtype == "event_msg" and ptype in _SKIP_EVENT):
                continue
            if ordinal < start_ord and rtype != "session_meta":
                continue  # history copied from the parent thread into a forked sub-thread
            if rtype == "event_msg" and ptype == "item_completed":
                im = _ITEM.search(line)
                kind = im.group(1) if im else ""
                if kind == "Reasoning":
                    a, b = _STARTED.search(line), _DONE.search(line)
                    if a and b:
                        events.append({"t": "think", "ts": int(a.group(1)), "ms": max(0, int(b.group(1)) - int(a.group(1)))})
                    continue
                if kind not in _ITEMS:
                    continue
            elif rtype == "response_item" and ptype == "message" and '"role":"developer"' in line[:400]:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            p = r.get("payload") or {}
            ts = ts_ms(tsr)
            if rtype == "session_meta":
                if not meta:
                    meta = {k: v for k, v in p.items() if k not in ("base_instructions", "dynamic_tools")}
                    start_ord = meta.get("subagent_history_start_ordinal") or 0
                continue
            if rtype == "turn_context":
                cm = (p.get("collaboration_mode") or {}).get("settings") or {}
                events.append({"t": "ctx", "ts": ts, "model": p.get("model") or cm.get("model") or "",
                               "effort": p.get("effort") or cm.get("reasoning_effort") or "", "cwd": p.get("cwd") or ""})
            elif rtype == "compacted":
                events.append({"t": "compact", "ts": ts})
            elif rtype == "event_msg":
                _event(events, ts, ptype, p, caps)
                if ptype == "item_completed" and (p.get("item") or {}).get("type") == "UserMessage":
                    strong_user = True
            elif rtype == "response_item":
                _response(events, ts, ptype, p, caps)
    if progress and acc:
        progress(acc)
    if strong_user:  # response_item user messages are only a fallback for rollouts without UserMessage items
        events = [e for e in events if not e.get("weak")]
    else:
        for e in events:
            e.pop("weak", None)
    return {"meta": meta, "events": events}


def _event(events, ts, ptype, p, caps):
    if ptype == "task_started":
        events.append({"t": "turn_start", "ts": ts, "turn": p.get("turn_id"), "window": p.get("model_context_window")})
    elif ptype == "task_complete":
        err = p.get("error")
        events.append({"t": "turn_end", "ts": ts, "turn": p.get("turn_id"), "aborted": False,
                       "err": (err.get("message") if isinstance(err, dict) else err) or "", "last": cut(p.get("last_agent_message") or "", 6000)})
    elif ptype == "turn_aborted":
        events.append({"t": "turn_end", "ts": ts, "turn": p.get("turn_id"), "aborted": True, "err": "", "last": "", "reason": p.get("reason")})
    elif ptype == "token_count":
        info = p.get("info")
        if info:
            events.append({"t": "usage", "ts": ts, "last": _usage(info.get("last_token_usage")), "total": _usage(info.get("total_token_usage")),
                           "window": info.get("model_context_window")})
    elif ptype == "thread_goal_updated":
        g = p.get("goal") or {}
        events.append({"t": "ev", "ts": ts, "ev": {"k": "taskstat", "ts": ts, "text": "目标 %s：%s" % (g.get("status", ""), cut(g.get("objective", ""), 300))}})
    elif ptype == "item_completed":
        it = p.get("item") or {}
        if it.get("type") == "UserMessage":
            events.append({"t": "ev", "ts": ts, "ev": {"k": "usermsg", "ts": ts, "text": cut(content_text(it.get("content")), 6000)}})
        else:
            c = _condense_item(it, ts, caps)
            if c:
                c.update(t="item", ts=ts, start=p.get("started_at_ms"), end=p.get("completed_at_ms"))
                events.append(c)


def _response(events, ts, ptype, p, caps):
    if ptype == "reasoning":
        text = "\n".join(b.get("text", "") for b in (p.get("summary") or []) if isinstance(b, dict))
        raw = content_text(p.get("content")) if p.get("content") else ""
        if text or raw:
            events.append({"t": "reason", "ts": ts, "text": cut(text or raw, 2000)})
    elif ptype == "message":
        role = p.get("role")
        text = content_text(p.get("content")).strip()
        if role == "assistant" and text:
            events.append({"t": "msg", "ts": ts, "phase": p.get("phase") or "", "text": text})
        elif role == "user" and text and not text.startswith(_BOILERPLATE):
            events.append({"t": "ev", "ts": ts, "weak": True, "ev": {"k": "usermsg", "ts": ts, "text": cut(text, 6000)}})
    elif ptype == "agent_message":
        mtype, sender, text, enc = parse_agent_message(p)
        events.append({"t": "agentmsg", "ts": ts, "mtype": mtype, "author": p.get("author", ""), "recipient": p.get("recipient", ""),
                       "sender": sender, "text": cut(text, 6000), "enc": enc})
    elif ptype in ("function_call", "custom_tool_call"):
        raw = p.get("arguments") if ptype == "function_call" else p.get("input")
        raw = raw if isinstance(raw, str) else json.dumps(raw or {}, ensure_ascii=False)
        events.append({"t": "call", "ts": ts, "id": p.get("call_id") or p.get("id"), "name": p.get("name") or "", "ns": p.get("namespace") or "",
                       "custom": ptype == "custom_tool_call", "args": raw if len(raw) <= 60000 else raw[:60000]})
    elif ptype in ("function_call_output", "custom_tool_call_output"):
        text = content_text(p.get("output"))
        events.append({"t": "out", "ts": ts, "id": p.get("call_id"), "text": cut(text, caps[0] + 400), "len": len(text)})
    elif ptype == "web_search_call":
        a = p.get("action") or {}
        events.append({"t": "call", "ts": ts, "id": "ws-%d" % ts, "name": "web_search", "ns": "", "custom": False,
                       "args": json.dumps(a, ensure_ascii=False), "done": True})
