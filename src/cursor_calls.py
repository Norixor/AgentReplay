"""Turn Cursor tool messages (bubble.toolFormerData) into replay call dicts.

toolFormerData carries {name, status, params, rawArgs, result, error, additionalData}; params / rawArgs / result are JSON
strings. params is Cursor's own (normalised) view of the arguments, rawArgs what the model sent. Neither tells when the call
ran: the parser passes the start (the message time) and the end (the header's completedAtMs, else the next message's time).
status is completed, error or cancelled (the user declined or interrupted it); anything else is a call that has not finished.
"""
import json
import re

from common import LONG_MS, classify_bash, cut

READ_TOOLS = {"read_file", "read_file_v2", "list_dir", "list_dir_v2", "grep_search", "file_search", "glob_file_search", "ripgrep",
              "ripgrep_raw_search", "codebase_search", "semantic_search_full", "read_lints", "web_search", "web_fetch", "fetch_rules",
              "get_mcp_tools"}
WRITE_TOOLS = {"search_replace", "edit_file", "edit_file_v2", "edit_file_v2_write", "edit_file_v2_search_replace",
               "edit_file_v2_multi_search_replace", "MultiEdit", "write", "delete_file", "apply_patch", "reapply"}
SHELL_TOOLS = {"run_terminal_cmd", "run_terminal_command_v2", "run_terminal_command"}
AGENT_TOOLS = {"task", "task_v2"}
_NOISE_PARAMS = {"parsingResult", "lineRanges", "gracefullyHandleRecoverableErrors", "shouldEagerlyProcessLints", "blocking",
                 "shouldEditFileFailForLargeFiles", "fileIsAllowedToBeReadEntirely", "maxLines", "maxChars", "minLines",
                 "allowMultipleMatches", "requireUserApproval", "options"}
_OK, _FAIL = {"completed", "success"}, {"error", "cancelled", "canceled", "failed"}
SAME_RESPONSE_GAP_MS = 800


def is_finished(tool):
    """True once a tool message has its outcome (completed, error or cancelled); anything else is a call still running."""
    status = str(tool.get("status") or "").lower()
    return status in _OK or status in _FAIL


def same_response(mcid, open_mcid, ts, call_end):
    """Does a tool message that starts at ts belong to the response whose calls are already open? Compared by the shared
    response id when both sides have one, else by whether it starts within SAME_RESPONSE_GAP_MS of the previous call's end
    (parallel or back-to-back calls; a new model call needs a round trip first)."""
    if mcid and open_mcid:
        return mcid == open_mcid
    return ts - (call_end or ts) < SAME_RESPONSE_GAP_MS


def obj(raw):
    """A JSON string (or an already parsed value) -> dict / list, None when it is neither."""
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str) and raw.strip()[:1] in ("{", "["):
        try:
            return json.loads(raw)
        except ValueError:
            return None
    return None


def category(name, params):
    if name in SHELL_TOOLS:
        return classify_bash(str(params.get("command") or ""))
    if name in AGENT_TOOLS:
        return "agent"
    if name in WRITE_TOOLS:
        return "write"
    if name in READ_TOOLS or re.match(r"(read|list|get|search|find|grep|fetch|view)_", name):
        return "read"
    return "other"


_CALL_UUID = re.compile(r"^call-([0-9A-Za-z-]+)-\d+")
_FC_BASE = re.compile(r"^(.+)_\d+$")


def response_key(tool):
    """Id shared by the calls of one model response: the <uuid> of toolCallId "call-<uuid>-<n>\\nfc_..." (n counts the calls of
    the chat), else the base of modelCallId "fc_<uuid>_<index>"; None when neither is recorded."""
    m = _CALL_UUID.match(str(tool.get("toolCallId") or ""))
    if m:
        return m.group(1)
    m = _FC_BASE.match(str(tool.get("modelCallId") or ""))
    return m.group(1) if m else None


def agent_kind(args):
    """Sub-agent type of a task call's arguments; "unspecified" falls back to the agent name."""
    kind = str(args.get("subagentType") or "")
    return str(args.get("name") or "") if kind in ("", "unspecified") else kind


def agent_id(tool):
    """The sub-agent chat a task call started: additionalData.subagentComposerId, else result.agentId."""
    ad = tool.get("additionalData") or {}
    if isinstance(ad.get("subagentComposerId"), str) and ad["subagentComposerId"]:
        return ad["subagentComposerId"]
    res = obj(tool.get("result"))
    return res["agentId"] if isinstance(res, dict) and isinstance(res.get("agentId"), str) else ""


def _first(d, keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, (str, int)) and str(v).strip():
            return str(v).strip()
    return ""


def args_of(tool):
    """-> (params dict, rawArgs dict); empty dicts when absent or not JSON objects."""
    p, r = obj(tool.get("params")), obj(tool.get("rawArgs"))
    return (p if isinstance(p, dict) else {}), (r if isinstance(r, dict) else {})


def summary(name, p, raw):
    both = dict(raw, **p)
    if name in SHELL_TOOLS:
        c = str(both.get("command") or "").strip()
        return c.split("\n", 1)[0][:200] + (" …" if "\n" in c or len(c) > 200 else "")
    if name in ("read_file", "read_file_v2"):
        loc = _first(both, ("relativeWorkspacePath", "target_file", "path"))
        a, b = p.get("startLineOneIndexed"), p.get("endLineOneIndexedInclusive")
        return loc + (" @%s%s" % (a, "-%s" % b if b else "") if a else "")
    if name in WRITE_TOOLS:
        loc = _first(both, ("relativeWorkspacePath", "file_path", "path"))
        edits = raw.get("edits")
        return loc + (" · %d 处修改" % len(edits) if isinstance(edits, list) else "")
    if name == "grep_search":
        pat = (p.get("patternInfo") or {}).get("pattern") if isinstance(p.get("patternInfo"), dict) else None
        return str(pat or raw.get("query") or "")
    if name == "list_dir":
        return _first(both, ("directoryPath", "relative_workspace_path"))
    if name == "read_lints":
        paths = both.get("paths")
        return ", ".join(str(x) for x in paths[:4]) + (" 等 %d 项" % len(paths) if len(paths) > 4 else "") if isinstance(paths, list) and paths else "全部文件"
    if name == "todo_write":
        t = both.get("todos")
        return "更新待办" + ("（%d 项）" % len(t) if isinstance(t, list) else "")
    if name == "get_mcp_tools":
        return " · ".join(str(both[k]) for k in ("server", "toolName") if both.get(k))
    if name in AGENT_TOOLS:
        return "%s · %s" % (agent_kind(both), both.get("description") or "")
    one = _first(both, ("query", "pattern", "url", "relativeWorkspacePath", "path", "directoryPath", "description", "name"))
    if one:
        return one[:200]
    try:
        return json.dumps(both, ensure_ascii=False)[:200]
    except (TypeError, ValueError):
        return ""


def _grep_text(res):
    lines = []
    for item in ((res.get("internal") or {}).get("results") or []):
        if not isinstance(item, dict):
            continue
        lines.append(str(item.get("resource") or ""))
        for m in item.get("results") or []:
            pv = (m.get("match") or {}).get("previewText") if isinstance(m, dict) else None
            if isinstance(pv, str):
                lines.append("  " + pv.strip()[:200])
        if len(lines) > 400:
            break
    return "\n".join(lines)


def result_text(name, tool):
    """-> text shown as the call's result (never the full raw JSON of a large payload)."""
    err = obj(tool.get("error"))
    if isinstance(err, dict):
        return str(err.get("modelVisibleErrorMessage") or err.get("clientVisibleErrorMessage") or "")
    if isinstance(tool.get("error"), str) and tool["error"].strip():
        return tool["error"]
    res = obj(tool.get("result"))
    if not isinstance(res, dict):
        return tool["result"] if isinstance(tool.get("result"), str) else ""
    if name in SHELL_TOOLS:
        return str(res.get("output") or res.get("outputRaw") or ("（用户拒绝执行此命令）" if res.get("rejected") is True else ""))
    if name in ("read_file", "read_file_v2"):
        return str(res.get("contents") or "")
    if name in WRITE_TOOLS:
        chunks = (res.get("diff") or {}).get("chunks") if isinstance(res.get("diff"), dict) else None
        if isinstance(chunks, list):
            return "\n".join(str(c.get("diffString") or "") for c in chunks if isinstance(c, dict))
        return str(res.get("resultForModel") or "")
    if name == "grep_search":
        return _grep_text(res)
    if name == "list_dir":
        return "\n".join("%s%s" % (f.get("name", ""), " (%s)" % f["size"] if f.get("size") else "") for f in res.get("files") or [] if isinstance(f, dict))
    if name == "file_search":
        return "\n".join(str(f.get("uri") or "") for f in res.get("files") or [] if isinstance(f, dict))
    if name == "codebase_search":
        return "\n".join(str(((c.get("codeBlock") or {}).get("relativeWorkspacePath")) or "") for c in res.get("codeResults") or [] if isinstance(c, dict))
    if name == "todo_write":
        return "\n".join("[%s] %s" % (t.get("status", ""), t.get("content", "")) for t in res.get("finalTodos") or [] if isinstance(t, dict))
    if name == "get_mcp_tools":
        c = res.get("content")
        return c if isinstance(c, str) else json.dumps(c, ensure_ascii=False) if c is not None else ""
    if name in AGENT_TOOLS:
        return ""
    return json.dumps(res, ensure_ascii=False) if res else ""


def _failed(name, tool):
    status = str(tool.get("status") or "").lower()
    if status in _FAIL:
        return True
    res = obj(tool.get("result"))
    if name in SHELL_TOOLS and isinstance(res, dict):
        code = res.get("exitCodeV2", res.get("exitCode"))
        return res.get("rejected") is True or (isinstance(code, int) and code != 0)
    return False


def make_call(b, ts, end, ctx, linked):
    """b: slim message with a tool. ts / end: ms the call started / ended (end None = unknown). linked: the sub-agent chat id
    this call started, when that chat is part of the tree."""
    t = b["tool"]
    name = str(t.get("name") or "tool")
    p, raw = args_of(t)
    cat = category(name, dict(raw, **p))
    status = str(t.get("status") or "").lower()
    done = is_finished(t)
    st = ("err" if _failed(name, t) else "ok") if done else "pend"
    text = result_text(name, t)
    if status in ("cancelled", "canceled") and not text:
        text = "（调用被取消：用户未批准或中途停止）"
    if name in AGENT_TOOLS:
        reason = (t.get("additionalData") or {}).get("terminationReason")
        text = text or ("子代理结束原因：%s" % reason if reason else "")
    dur = max(0, end - ts) if (done and end is not None) else 0
    desc = p.get("commandDescription") or raw.get("explanation") or p.get("instructions") or ""
    call = {"name": name, "cat": cat, "ts": ts, "dur": dur, "st": st, "bg": False, "shell": cat != "agent",
            "desc": desc.strip() if isinstance(desc, str) else "", "sum": cut(summary(name, p, raw), 400),
            "res": cut(text, ctx["out"]), "rlen": len(text), "hook": ""}
    both = dict(raw, **p)
    if name in AGENT_TOOLS:
        prompt = str(both.get("prompt") or "")
        call["disp"] = {"model": "", "effort": "", "bg": False, "type": agent_kind(both),
                        "reason": "", "block": True}  # the call returns when the sub-agent is done
        if linked:
            call["agent"] = linked
        else:
            call["inp"] = cut(prompt, ctx["inp"])
    elif name in SHELL_TOOLS:
        cmd = str(both.get("command") or "")
        call["inp"] = "" if ("\n" not in cmd and len(cmd.strip()) <= 200) else cut(cmd, ctx["inp"])
    else:
        shown = raw or {k: v for k, v in p.items() if k not in _NOISE_PARAMS}
        try:
            call["inp"] = cut(json.dumps(shown, ensure_ascii=False, indent=1), ctx["inp"])
        except (TypeError, ValueError):
            call["inp"] = ""
    call["long"] = bool(call["shell"] and dur > LONG_MS and cat != "agent")
    return call
