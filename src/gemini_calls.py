"""Turn one Gemini CLI tool call record into a replay call dict.

A toolCall carries everything in one place: name, args, the result (functionResponse items), a status and a timestamp that
is the moment the call finished. Its start is not recorded; the parser passes the time of the model message that issued it.
"""
import json
import re

from common import LONG_MS, classify_bash, cut

READ_TOOLS = {"read_file", "read_many_files", "list_directory", "glob", "grep_search", "search_file_content", "google_web_search",
              "web_fetch", "get_internal_docs", "list_mcp_resources", "read_mcp_resource"}
WRITE_TOOLS = {"write_file", "replace", "edit", "edit_file", "create_file", "delete_file", "move_file"}
SHELL_TOOLS = {"run_shell_command", "shell"}
AGENT_TOOLS = {"invoke_agent"}
_EXIT = re.compile(r"^Exit Code:\s*(-?\d+)\s*$", re.M)
_WRAP = re.compile(r"^\s*<untrusted_context>\s*|\s*</untrusted_context>\s*$")
_OK = {"success", "succeeded", "completed", "ok"}
_FAIL = {"error", "cancelled", "canceled", "failed"}


def result_text(tc):
    """-> (text of the result, True when the result itself reports an error)."""
    parts, err = [], False
    for item in tc.get("result") or []:
        fr = item.get("functionResponse") if isinstance(item, dict) else None
        resp = fr.get("response") if isinstance(fr, dict) else None
        if isinstance(resp, dict):
            if resp.get("error"):
                err = True
                parts.append(str(resp["error"]))
            elif resp.get("output") is not None:
                parts.append(str(resp["output"]))
            else:
                parts.append(json.dumps(resp, ensure_ascii=False))
        elif resp is not None:
            parts.append(str(resp))
    text = "\n".join(parts)
    if not text and isinstance(tc.get("resultDisplay"), str):
        text = tc["resultDisplay"]
    return _WRAP.sub("", text), err


def agent_result(tc):
    """The report a sub-agent handed back through invoke_agent (resultDisplay.result, else the text after "Result:")."""
    rd = tc.get("resultDisplay")
    raw = rd.get("result") if isinstance(rd, dict) else None
    if not isinstance(raw, str) or not raw.strip():
        text, _ = result_text(tc)
        raw = text.split("Result:", 1)[1] if "Result:" in text else ""
    return unwrap_response(raw)


def unwrap_response(raw):
    """A sub-agent's result is often a JSON object {"response": "..."}; return the response text, else the text as is."""
    s = (raw or "").strip()
    if s.startswith("{"):
        try:
            d = json.loads(s)
            if isinstance(d, dict) and isinstance(d.get("response"), str):
                return d["response"]
        except ValueError:
            pass
    return s


def _short(name):
    return name.split("__")[-1] if name.startswith("mcp__") else name


def category(name, args):
    n = _short(name)
    if n in SHELL_TOOLS:
        return classify_bash(str(args.get("command") or ""))
    if n in AGENT_TOOLS:
        return "agent"
    if n in WRITE_TOOLS:
        return "write"
    if n in READ_TOOLS or re.match(r"(read|list|get|search|find|grep|fetch|view)_", n):
        return "read"
    return "other"


def _first(args, keys):
    for k in keys:
        v = args.get(k)
        if isinstance(v, (str, int)) and str(v).strip():
            return str(v).strip()
    return ""


def summary(name, args):
    n = _short(name)
    if n in SHELL_TOOLS:
        c = str(args.get("command") or "").strip()
        return c.split("\n", 1)[0][:200] + (" …" if "\n" in c or len(c) > 200 else "")
    if n == "invoke_agent":
        p = str(args.get("prompt") or "").strip().split("\n", 1)[0]
        return "%s · %s" % (args.get("agent_name") or "?", p[:120])
    if n in ("grep_search", "search_file_content"):
        return "%s  %s" % (args.get("pattern", ""), _first(args, ("dir_path", "path", "include")))
    if n == "read_file":
        loc = _first(args, ("file_path", "path"))
        a, b = args.get("start_line", args.get("offset")), args.get("end_line")
        return loc + (" @%s%s" % (a, "-%s" % b if b else "") if a else "")
    if n == "read_many_files":
        inc = args.get("include") or args.get("paths") or []
        return ", ".join(str(x) for x in inc[:4]) + (" 等 %d 项" % len(inc) if len(inc) > 4 else "") if isinstance(inc, list) else str(inc)
    if n == "write_todos":
        t = args.get("todos")
        return "更新待办" + (" · %d 项" % len(t) if isinstance(t, list) else "")
    if n == "complete_task":
        return "交回最终结果"
    one = _first(args, ("file_path", "path", "dir_path", "pattern", "query", "url", "prompt", "name", "fact"))
    if one:
        return one[:200]
    try:
        return json.dumps(args, ensure_ascii=False)[:200]
    except (TypeError, ValueError):
        return ""


def make_call(tc, start, finish, ctx, linked):
    """tc: toolCall record. start: ms when the issuing model message was written; finish: ms of the call's own timestamp
    (None while it has not finished). linked: the sub-agent session id this call dispatches, if it is part of the session."""
    name = str(tc.get("name") or "tool")
    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
    cat = category(name, args)
    text, errored = result_text(tc)
    status = str(tc.get("status") or "").lower()
    if status in _FAIL:
        st = "err"
    elif status in _OK or (not status and tc.get("result")):
        st = "ok"
    else:
        st = "pend"
    if st == "ok":
        m = _EXIT.search(text) if _short(name) in SHELL_TOOLS else None
        if errored or (m and int(m.group(1)) != 0):
            st = "err"
    dur = max(0, finish - start) if (finish is not None and st != "pend") else 0
    desc = args.get("description")
    call = {"name": name, "cat": cat, "ts": start, "dur": dur, "st": st, "bg": False, "shell": cat != "agent",
            "desc": desc.strip() if isinstance(desc, str) else "", "sum": cut(summary(name, args), 400),
            "res": cut(text, ctx["out"]), "rlen": len(text), "hook": ""}
    if name in AGENT_TOOLS or tc.get("agentId"):
        prompt = str(args.get("prompt") or "")
        mo = re.search(r"^[\s>*\-]*(选档理由：.*)$", prompt, re.M)
        call["disp"] = {"model": "", "effort": "", "bg": False, "type": str(args.get("agent_name") or ""),
                        "reason": mo.group(1).strip() if mo else "", "block": True}  # invoke_agent returns when the child is done
        if linked:
            call["agent"] = linked
        else:
            call["inp"] = cut(prompt, ctx["inp"])
    elif _short(name) in SHELL_TOOLS:
        cmd = str(args.get("command") or "")
        call["inp"] = "" if ("\n" not in cmd and len(cmd.strip()) <= 200) else cut(cmd, ctx["inp"])
    else:
        try:
            call["inp"] = cut(json.dumps(args, ensure_ascii=False, indent=1), ctx["inp"])
        except (TypeError, ValueError):
            call["inp"] = ""
    call["long"] = bool(call["shell"] and dur > LONG_MS and cat != "agent")
    return call
