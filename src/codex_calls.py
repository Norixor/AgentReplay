"""Turn Codex tool calls (call row + output row + nested item_completed rows) into replay call dicts.

Most Codex work goes through `exec`, a JavaScript cell that calls nested tools (`tools.exec_command(...)`,
`tools.apply_patch(...)`). The real command text and exit code come from the CommandExecution items
that complete between the cell's call row and its output row, so those are attached to the call.
"""
import json
import re

from common import LONG_MS, classify_bash, cut

_NEST = re.compile(r"tools\.([A-Za-z_]\w*)\s*\(")
_ENC = re.compile(r'"(message|prompt)"\s*:\s*"gAAAA[^"]*"')
_EXIT = re.compile(r"^Exit code:\s*(-?\d+)")
_HOOK = re.compile(r"^\s*(Command |Tool )?(blocked|denied|rejected) by [\w:.\- ]*hook|^\s*PreToolUse[:\s].*(hook|blocked)", re.I)
_SCRIPT_HEAD = re.compile(r"^Script (completed|failed|running with cell ID \d+)\nWall time [\d.]+ seconds\n(Output:\n)?")

WRITE_TOOLS = {"apply_patch", "write_file", "append_to_file"}
READ_TOOLS = {"view_image", "read_file", "list_files_by_prefix", "list_items", "list_mcp_resources", "list_mcp_resource_templates",
              "list_threads", "read_thread", "get_goal", "get_app_state", "list_apps", "web_search", "web__run", "clock__curr_time",
              "load_workspace_dependencies", "list_archived_threads", "list_artifacts"}
AGENT_TOOLS = {"spawn_agent", "send_message", "followup_task", "list_agents", "interrupt_agent", "close_agent", "send_message_to_thread"}
WAIT_TOOLS = {"wait_agent", "wait", "sleep", "wait_threads"}
SHELL_TOOLS = {"exec_command", "shell_command"}


def nested_calls(js):
    """[(tool name, args dict|None)] for every `tools.x({...})` in an exec cell."""
    out, dec = [], json.JSONDecoder()
    for m in _NEST.finditer(js):
        i, args = m.end(), None
        while i < len(js) and js[i] in " \n\t":
            i += 1
        if i < len(js) and js[i] == "{":
            try:
                args, _ = dec.raw_decode(js[i:i + 30000])
            except ValueError:
                args = None
        out.append((m.group(1), args if isinstance(args, dict) else None))
    return out


def _short(name):
    """mcp__codex_app__list_threads -> list_threads (keeps the server hint in the full name)."""
    return name.split("__")[-1] if name.startswith("mcp__") else name


def _tool_cat(names, cmd, args_first):
    short = [_short(n) for n in names]
    if any(n in WRITE_TOOLS for n in short):
        return "write"
    if any(n in SHELL_TOOLS for n in short) or (cmd and not names):
        return classify_bash(cmd)
    if any(n in WAIT_TOOLS for n in short):
        return "wait"
    if "write_stdin" in short:
        return "wait" if not (args_first or {}).get("chars") else "other"
    if any(n in AGENT_TOOLS for n in short):
        return "agent"
    if any(n in READ_TOOLS or re.match(r"(list|get|read|search|fetch|view)_", n) for n in short):
        return "read"
    return "other"


def _summary(name, names, nested, items, args, cmd):
    first = nested[0][1] if nested and nested[0][1] else {}
    short = _short(names[0]) if names else name
    if cmd:
        c = cmd.strip()
        return c.split("\n", 1)[0][:200] + (" …" if "\n" in c or len(c) > 200 else "")
    if short in WRITE_TOOLS or any(i["k"] == "patch" for i in items):
        files = [f for i in items if i["k"] == "patch" for f in i["files"]]
        if not files:
            files = re.findall(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", args.get("_raw", ""), re.M)
        return ", ".join(files[:4]) + (" 等 %d 个文件" % len(files) if len(files) > 4 else "")
    if name == "spawn_agent":
        return "%s · %s%s" % (args.get("task_name", ""), args.get("agent_type", "") or "默认", " · %s/%s" % (args.get("model"), args.get("reasoning_effort")) if args.get("model") else "")
    if name in ("send_message", "followup_task"):
        return "→ %s（消息已加密）" % args.get("target", "")
    if name == "wait_agent":
        return "等待子代理 %s" % (", ".join(args.get("targets") or []) or "（任意）")
    if short == "web__run" or name == "web_search":
        return str(first.get("search_query") or args.get("query") or args.get("queries") or json.dumps(first or args, ensure_ascii=False))[:200]
    if short == "view_image":
        return str(first.get("path") or args.get("path") or "")
    mcp = next((i for i in items if i["k"] == "mcp"), None)
    if mcp:
        return "%s.%s %s" % (mcp["server"], mcp["tool"], mcp["title"] or mcp["args"])[:200]
    if short == "write_stdin":
        return "session %s %s" % (first.get("session_id", args.get("session_id", "")), "输入 " + cut(str(first.get("chars") or args.get("chars") or ""), 60) if (first.get("chars") or args.get("chars")) else "轮询输出")
    if short == "update_plan":
        return "更新计划"
    if short in ("js", "exec") or not names:
        return (args.get("title") or args.get("_raw", "").strip().split("\n", 1)[0])[:200]
    try:
        return json.dumps(first or args, ensure_ascii=False)[:200]
    except (TypeError, ValueError):
        return ""


def make_call(ev, out, items, ctx):
    """ev: call event, out: output event or None, items: condensed item events attached to this call."""
    name, raw = ev["name"], ev["args"]
    args, js_nested = {}, []
    if ev["custom"] and name == "exec":
        js_nested = nested_calls(raw)
        args = {"_raw": raw}
    elif ev["custom"]:
        args = {"_raw": raw}
    else:
        try:
            a = json.loads(raw)
            args = a if isinstance(a, dict) else {"_raw": raw}
        except ValueError:
            args = {"_raw": raw}
    names = [n for n, _ in js_nested] if js_nested else ([name] if not (ev["custom"] and name == "exec") else [])
    cmds = [i["cmd"] for i in items if i["k"] == "cmd" and i["cmd"]]
    if not cmds:
        cmds = [str((a or {}).get("cmd") or (a or {}).get("command") or "") for n, a in js_nested if _short(n) in SHELL_TOOLS]
        cmds = [c for c in cmds if c]
    if not cmds and name in SHELL_TOOLS:
        cmds = [str(args.get("cmd") or args.get("command") or "")]
    cmd = "\n".join(cmds)
    show = _short(names[0]) if names else name
    distinct = []
    for n in names:
        s = _short(n)
        if s not in distinct:
            distinct.append(s)
    shown = "+".join(distinct[:2]) + ("+%d" % (len(distinct) - 2) if len(distinct) > 2 else "") if distinct else ("exec" if name == "exec" else name)
    first_args = js_nested[0][1] if js_nested else args
    cat = _tool_cat(names, cmd, first_args)

    st, text, dur, hook = "pend", "", 0, ""
    if out is not None or ev.get("done"):
        text = _SCRIPT_HEAD.sub("", out["text"]) if out else ""
        dur = max(0, (out["ts"] - ev["ts"])) if out else 0
        st = "ok"
        bad = out is not None and (out["text"].startswith("Script failed") or _bad_exit(out["text"]))
        bad = bad or any(i["k"] == "cmd" and (i["exit"] not in (0, None) or i["status"] == "failed") for i in items)
        bad = bad or any(i["k"] in ("mcp", "patch") and i["status"] == "failed" for i in items)
        if bad:
            st = "err"
        if text and _HOOK.search(text[:300]):
            st, hook = "hook", text
    desc = _desc(args, js_nested, items, raw)
    rlen = out["len"] if out else 0
    call = {"name": shown, "cat": cat, "ts": ev["ts"], "dur": dur, "st": st, "bg": False, "shell": cat != "agent",
            "desc": desc, "sum": cut(_summary(name, names, js_nested, items, args, cmd), 400),
            "res": cut(text, ctx["out"]), "rlen": rlen, "hook": hook[:8000]}
    if cmd:
        call["inp"] = "" if ("\n" not in cmd and len(cmd.strip()) <= 200) else cut(cmd, ctx["inp"])
    elif name == "spawn_agent" or name in ("send_message", "followup_task"):
        call["inp"] = cut(_ENC.sub(r'"\1":"（已加密）"', raw), ctx["inp"])
    else:
        call["inp"] = cut(_pretty(args), ctx["inp"])
    if name == "spawn_agent":
        call["disp"] = {"model": args.get("model", ""), "effort": args.get("reasoning_effort", ""), "bg": False,
                        "type": args.get("agent_type", ""), "reason": ""}
        call["_spawn"] = args
    call["long"] = bool(call["shell"] and dur > LONG_MS and cat != "agent")
    return call


def _bad_exit(text):
    m = _EXIT.match(text)
    return bool(m and int(m.group(1)) != 0)


def _pretty(args):
    raw = args.get("_raw") if "_raw" in args else None
    if raw is not None:
        return raw
    try:
        return json.dumps(args, ensure_ascii=False, indent=1)
    except (TypeError, ValueError):
        return ""


def _desc(args, js_nested, items, raw):
    """Free-text justification carried by the call itself (justification / title / explanation)."""
    for src in [args] + [a for _, a in js_nested if a]:
        for k in ("justification", "title", "explanation", "description"):
            v = src.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for i in items:
        if i["k"] == "mcp" and i["title"]:
            return i["title"]
    m = re.search(r'"justification"\s*:\s*"((?:[^"\\]|\\.)*)"', raw)
    return m.group(1) if m else ""
