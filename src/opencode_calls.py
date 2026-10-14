"""Turn opencode "tool" parts into replay call dicts.

A tool part is {tool, callID, state: {status, input, output | error, title, metadata, time: {start, end}}}. The status moves
pending -> running -> completed | error; time.start / time.end are the real execution times, so durations are measured,
not estimated. A part that never finished (opencode was closed or the session is still running) is a pending call.
"""
import json
import re

from common import LONG_MS, classify_bash, cut

READ_TOOLS = {"read", "glob", "grep", "list", "ls", "webfetch", "websearch", "codesearch", "lsp", "view", "find", "search"}
WRITE_TOOLS = {"edit", "write", "multiedit", "patch", "apply_patch"}
AGENT_TOOLS = {"task"}


def _short(name):
    return name  # MCP tools are named <server>_<tool>: they fall into "other" unless they look like a read


def tool_cat(name, inp):
    short = _short(name)
    if short in ("bash", "shell"):
        return classify_bash(str(inp.get("command") or ""))
    if short in AGENT_TOOLS:
        return "agent"
    if short in WRITE_TOOLS:
        return "write"
    if short in READ_TOOLS or re.match(r"(list|get|read|search|fetch|view)", short):
        return "read"
    return "other"


def _files(state):
    """Paths touched by an edit / patch tool, from its metadata when present."""
    meta = state.get("metadata") or {}
    files = [f.get("relativePath") or f.get("filePath") for f in meta.get("files") or [] if isinstance(f, dict)]
    return [f for f in files if f]


def summarize(name, inp, state):
    short = _short(name)
    if short in ("bash", "shell"):
        c = str(inp.get("command") or "").strip()
        return c.split("\n", 1)[0][:200] + (" …" if "\n" in c or len(c) > 200 else "")
    if short in ("read", "edit", "write", "multiedit"):
        return str(inp.get("filePath") or inp.get("path") or "")
    if short in ("apply_patch", "patch"):
        files = _files(state)
        return ", ".join(files[:4]) + (" 等 %d 个文件" % len(files) if len(files) > 4 else "") if files else str(state.get("title") or "")
    if short in ("grep", "glob"):
        return str(inp.get("pattern") or "") + (" · " + str(inp.get("path")) if inp.get("path") else "")
    if short in ("webfetch",):
        return str(inp.get("url") or "")
    if short in ("websearch", "codesearch"):
        return str(inp.get("query") or "")
    if short == "task":
        return "%s · %s" % (inp.get("subagent_type") or "", inp.get("description") or "")
    if short == "todowrite":
        return "更新待办（%d 项）" % len(inp.get("todos") or [])
    if short == "list":
        return str(inp.get("path") or "")
    title = state.get("title")
    if title:
        return str(title)
    try:
        return json.dumps(inp, ensure_ascii=False)[:200]
    except (TypeError, ValueError):
        return ""


def _failed(name, state):
    if state.get("status") == "error":
        return True
    if _short(name) in ("bash", "shell"):
        ex = (state.get("metadata") or {}).get("exit")
        return isinstance(ex, int) and ex != 0
    return False


def make_call(part, ctx, cwd=""):
    """part: parsed part JSON of a tool part (+ "_created": part creation time). ctx: {"out", "inp"} caps."""
    name = str(part.get("tool") or "tool")
    state = part.get("state") or {}
    inp = state.get("input") if isinstance(state.get("input"), dict) else {}
    cat = tool_cat(name, inp)
    status = state.get("status")
    t = state.get("time") or {}
    ts = int(t.get("start") or part.get("_created") or 0)
    done = status in ("completed", "error")
    dur = max(0, int(t["end"]) - ts) if done and t.get("end") else 0
    if not done:
        st = "pend"
    else:
        st = "err" if _failed(name, state) else "ok"
    text = state.get("output") if status == "completed" else (state.get("error") or state.get("output") or "")
    text = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    short = _short(name)
    call = {"name": name, "cat": cat, "ts": ts, "dur": dur, "st": st, "bg": False, "shell": cat != "agent",
            "desc": str(inp.get("description") or ""),
            "sum": cut(summarize(name, inp, state), 400), "res": cut(text, ctx["out"]), "rlen": len(text), "hook": ""}
    if short in ("bash", "shell"):
        cmd = str(inp.get("command") or "")
        call["inp"] = "" if ("\n" not in cmd and len(cmd.strip()) <= 200) else cut(cmd, ctx["inp"])
    elif short == "task":
        call["inp"] = cut(str(inp.get("prompt") or ""), ctx["inp"])  # dropped by the parser when the sub-session is linked
        call["disp"] = {"model": "", "effort": "", "bg": False, "type": str(inp.get("subagent_type") or ""), "reason": ""}
        meta = state.get("metadata") or {}
        call["_sid"] = str(meta.get("sessionId") or meta.get("sessionID") or "")
        call["_in"] = {"subagent_type": inp.get("subagent_type"), "description": inp.get("description")}
    else:
        try:
            call["inp"] = cut(json.dumps(inp, ensure_ascii=False, indent=1), ctx["inp"])
        except (TypeError, ValueError):
            call["inp"] = ""
    call["long"] = bool(call["shell"] and dur > LONG_MS)
    return call
