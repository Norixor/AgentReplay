#!/usr/bin/env python3
"""Parse a Claude Code session (main transcript + subagents) into a replay data model.

Output is plain JSON-serialisable dicts. Text is NOT redacted here (render.py does that);
only length caps are applied (tool output / tool input), because they depend on page size.
Timestamps are epoch milliseconds (UTC); the page converts to local time.
"""
import ast
import json
import os
import re

import prices
from common import LONG_MS, Progress, classify_bash, cut, finish_agent, link_agents, merge_kind, totals, ts_ms

ROW_TYPES = ("user", "assistant", "system", "attachment", "queue-operation")
# Events that always open a new turn; IDLE_KINDS open one only when the agent was idle.
TURN_KINDS = {"human", "handback", "xsession", "goal", "local", "interrupt", "meta", "brief", "followup"}
IDLE_KINDS = {"notify", "silent"}


def family(model):
    key, _ = prices.lookup("claude", model)
    return key or "sonnet"


def msg_cost(fam, u):
    return prices.cost(prices.load("claude")["models"].get(fam), u)


def read_rows(path, progress=None):
    """Load a JSONL transcript; progress(nbytes) is called every few hundred lines with bytes consumed since last call."""
    rows = []
    acc = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f):
            if progress:
                acc += len(line)
                if n % 400 == 399:
                    progress(acc)
                    acc = 0
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    if progress and acc:
        progress(acc)
    return rows



def flat(c):
    """Flatten tool_result content (string, block list, or repr of a block list) to text."""
    if isinstance(c, str):
        if c.startswith("[{'type':") or c.startswith('[{"type":'):
            try:
                c = ast.literal_eval(c)
            except (ValueError, SyntaxError):
                return c
        else:
            return c
    out = []
    for b in c or []:
        if isinstance(b, dict):
            if b.get("type") == "text":
                out.append(b.get("text", ""))
            elif b.get("type") == "image":
                out.append("[图片]")
            else:
                out.append(str(b))
        else:
            out.append(str(b))
    return "\n".join(out)


# ---------------------------------------------------------------- categories

def categorize(name, inp):
    if name in ("Read", "Grep", "Glob", "LSP", "WebFetch", "WebSearch", "NotebookRead", "ListSkills", "SearchSkills"):
        return "read"
    if name in ("Edit", "Write", "NotebookEdit"):
        return "write"
    if name in ("Agent", "Task", "SendMessage"):
        return "agent"
    if name == "Monitor":
        return "wait"
    if name == "Bash":
        return classify_bash((inp or {}).get("command", ""))
    return "other"


def summarize(name, inp):
    inp = inp or {}
    if name == "Bash":
        c = (inp.get("command", "") or "").strip()
        return c.split("\n", 1)[0][:200] + (" …" if "\n" in c or len(c) > 200 else "")
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        p = inp.get("file_path") or inp.get("notebook_path") or ""
        if name == "Read" and inp.get("offset"):
            p += " @%s" % inp.get("offset")
        return p
    if name == "Grep":
        return "%s  %s" % (inp.get("pattern", ""), inp.get("path", ""))
    if name == "Glob":
        return inp.get("pattern", "")
    if name in ("Agent", "Task"):
        return inp.get("description", "")
    if name == "SendMessage":
        return "%s: %s" % (inp.get("to", ""), str(inp.get("message", ""))[:100])
    if name == "SubagentHandback":
        return "交回最终报告"
    if name == "Skill":
        return inp.get("skill", "")
    if name == "ToolSearch":
        return inp.get("query", "")
    if name == "Monitor":
        return inp.get("description") or inp.get("command", "")
    try:
        return json.dumps(inp, ensure_ascii=False)[:200]
    except (TypeError, ValueError):
        return ""


# ---------------------------------------------------------------- event classification

def parse_notify(t):
    def g(tag):
        m = re.search(r"<%s>(.*?)</%s>" % (tag, tag), t, re.S)
        return m.group(1).strip() if m else ""
    ev = {"k": "notify", "task": g("task-id"), "tu": g("tool-use-id"), "status": g("status"),
          "text": g("summary") or t[:200]}
    m = re.search(r"<duration_ms>(\d+)", t)
    if m:
        ev["durMs"] = int(m.group(1))
    m = re.search(r"<subagent_tokens>(\d+)", t)
    if m:
        ev["tokens"] = int(m.group(1))
    m = re.search(r"<tool_uses>(\d+)", t)
    if m:
        ev["toolUses"] = int(m.group(1))
    return ev


def classify_text(text, meta=False):
    t = (text or "").strip()
    if not t:
        return None
    if t.startswith("<task-notification>"):
        return parse_notify(t)
    if t.startswith("Another Claude session sent a message:"):
        m = re.search(r'<agent-message from="([^"]+)"[^>]*>(.*?)</agent-message>', t, re.S)
        if m and "[Subagent hand-back]" in m.group(2):
            body = m.group(2)
            i = body.find("The report follows:")
            rep = body[i + len("The report follows:"):] if i >= 0 else body
            lines = [l[2:] if l.startswith("  ") else l for l in rep.strip("\n").split("\n")]
            return {"k": "handback", "from": m.group(1), "text": "\n".join(lines).strip()}
        m = re.search(r"<cross-session-message([^>]*)>(.*?)</cross-session-message>", t, re.S)
        if m:
            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(1)))
            return {"k": "xsession", "from": attrs.get("from-session") or attrs.get("from", ""), "text": m.group(2).strip()}
        return {"k": "xsession", "from": "", "text": t}
    if t.startswith(("<local-command-caveat>", "<system-reminder>")):
        return None
    if t.startswith(("Goal check-in", "Stop hook feedback", "A session-scoped Stop hook")):
        return {"k": "goal", "text": t}
    if t.startswith(("<command-name>", "<bash-input>", "<local-command-stdout>", "<bash-stdout>")):
        return {"k": "local", "text": re.sub(r"</?[\w-]+>", " ", t).strip()}
    if t.startswith("[Image: source:") or t.startswith("[Image #"):
        return {"k": "image", "text": t}
    if t.startswith("[Request interrupted"):
        return {"k": "interrupt", "text": t}
    return {"k": "meta" if meta else "human", "text": t}


def user_texts(row):
    m = row.get("message", {}).get("content")
    if isinstance(m, str):
        return [m]
    out = []
    for b in m or []:
        if b.get("type") == "text":
            out.append(b.get("text", ""))
        elif b.get("type") == "image":
            out.append("[图片]")
    return out


# ---------------------------------------------------------------- agent building

def build_agent(aid, rows, ctx, meta=None):
    """Turn one transcript (main or a subagent) into turns/steps. ctx carries caps and lookup maps."""
    msgs, seq, results = {}, [], {}
    stamps = []
    brief = None
    for r in rows:
        t = r.get("type")
        ts = ts_ms(r["timestamp"]) if r.get("timestamp") and t in ROW_TYPES else None
        if ts:
            stamps.append(ts)
        if t == "assistant":
            m = r["message"]
            mid = m.get("id") or r.get("uuid")
            if mid not in msgs:
                msgs[mid] = {"id": mid, "model": m.get("model"), "ts": ts, "usage": {}, "blocks": [], "think": 0}
                seq.append(("msg", mid))
            mm = msgs[mid]
            u = m.get("usage") or {}
            if u and u.get("output_tokens", 0) >= mm["usage"].get("output_tokens", -1):
                mm["usage"] = u
            if m.get("model"):
                mm["model"] = m["model"]
            mm["think"] += r.get("thinkingDurationMs") or 0
            for b in m.get("content") or []:
                if b.get("type") in ("text", "tool_use"):
                    mm["blocks"].append(dict(b, ts=ts, cwd=r.get("cwd") or ""))
        elif t == "user":
            content = r.get("message", {}).get("content")
            if isinstance(content, list):
                for b in content:
                    if b.get("type") == "tool_result":
                        results[b.get("tool_use_id")] = {"ts": ts, "content": flat(b.get("content")), "err": bool(b.get("is_error"))}
            if r.get("isCompactSummary"):
                seq.append(("ev", {"k": "compactsum", "ts": ts, "text": cut("\n".join(user_texts(r)), 3000)}))
                continue
            for tx in user_texts(r):
                if aid != "main" and brief is None and not tx.lstrip().startswith("<system-reminder>"):
                    brief = tx
                    seq.append(("ev", {"k": "brief", "ts": ts, "text": tx}))
                    continue
                ev = classify_text(tx, meta=bool(r.get("isMeta")))
                if ev:
                    if aid != "main" and ev["k"] == "human":
                        ev["k"] = "followup"
                    ev["ts"] = ts
                    seq.append(("ev", ev))
        elif t == "attachment":
            a = r.get("attachment", {})
            at = a.get("type")
            ev = None
            if at == "queued_command":
                p = a.get("prompt")
                if isinstance(p, list):
                    p = "\n".join(b.get("text", "") for b in p if isinstance(b, dict))
                ev = classify_text(p or "", meta=False)
            elif at == "hook_additional_context":
                ev = {"k": "hookctx", "text": "\n".join(a.get("content") or []), "name": a.get("hookName", "")}
            elif at == "goal_status":
                ev = {"k": "goalstatus", "met": bool(a.get("met")), "text": a.get("reason") or a.get("condition", "")}
            elif at == "silent_turn_reminder":
                ev = {"k": "silent", "text": a.get("text", "")}
            elif at == "task_status":
                ev = {"k": "taskstat", "text": "%s：%s" % (a.get("description", ""), a.get("status", ""))}
            if ev:
                ev["ts"] = ts
                seq.append(("ev", ev))
        elif t == "system":
            st = r.get("subtype")
            ev = None
            if st == "compact_boundary":
                cm = r.get("compactMetadata") or {}
                ev = {"k": "compact", "trigger": cm.get("trigger"), "pre": cm.get("preTokens"), "text": "上下文压缩"}
            elif st == "stop_hook_summary" and (r.get("hookErrors") or r.get("preventedContinuation") or r.get("hasOutput")):
                ev = {"k": "stophook", "text": r.get("stopReason") or "; ".join(map(str, r.get("hookErrors") or [])) or "Stop 钩子有输出",
                      "prevented": bool(r.get("preventedContinuation"))}
            elif st == "informational":
                ev = {"k": "info", "text": r.get("content", "")}
            elif st == "local_command":
                ev = {"k": "localout", "text": re.sub(r"</?[\w-]+>", " ", r.get("content", "")).strip()}
            if ev:
                ev["ts"] = ts
                seq.append(("ev", ev))

    steps_flat, turns = [], []
    cur = None
    pending = []
    last_kind = None  # None | "text" | "tool"
    prev_text = None
    last_act = None
    for kind, x in seq:
        if kind == "ev":
            ev = x
            if ev["k"] in TURN_KINDS or (ev["k"] in IDLE_KINDS and last_kind in (None, "text")) or cur is None:
                carried = []
                if cur is not None and not cur["steps"]:
                    # An empty turn (no agent steps) folds into the new one as inline events.
                    old = turns.pop()
                    carried = [dict(old["trig"], at=0)] + old["evs"]
                cur = {"trig": ev, "evs": carried, "steps": []}
                turns.append(cur)
                pending = []
                prev_text = None
                last_kind = "ev"
            else:
                cur["evs"].append(dict(ev, at=len(cur["steps"])))
                pending.append({"k": ev["k"], "text": cut(ev.get("text", ""), 240), "ts": ev["ts"], "tu": ev.get("tu"), "from": ev.get("from")})
            if ev.get("ts"):
                last_act = max(last_act or 0, ev["ts"])
            continue
        mm = msgs[x]
        u = mm["usage"]
        uu = [u.get("input_tokens", 0) or 0, u.get("output_tokens", 0) or 0,
              u.get("cache_creation_input_tokens", 0) or 0, u.get("cache_read_input_tokens", 0) or 0]
        fam = family(mm["model"])
        texts_before, texts_all, calls_raw, seen_tool = [], [], [], False
        for b in mm["blocks"]:
            if b["type"] == "text":
                if b.get("text", "").strip():
                    texts_all.append(b["text"].strip())
                    if not seen_tool:
                        texts_before.append(b["text"].strip())
            else:
                seen_tool = True
                calls_raw.append(b)
        said, src = "\n\n".join(texts_before), "same"
        if not said and calls_raw and prev_text:
            said, src = prev_text, "prev"
        elif not said:
            src = ""
        calls, end_ts = [], mm["ts"]
        for b in calls_raw:
            calls.append(make_call(b, results.get(b["id"]), ctx))
            end_ts = max(end_ts, b["ts"] + calls[-1]["dur"]) if not calls[-1]["bg"] else end_ts
        cost = msg_cost(fam, uu)
        step = {"n": len(steps_flat), "ts": mm["ts"], "end": end_ts, "fam": fam, "model": mm["model"] or "",
                "cost": cost, "ctx": uu[0] + uu[2] + uu[3], "u": uu, "think": mm["think"],
                "gap": max(0, mm["ts"] - last_act) if last_act else 0,
                "said": said, "saidSrc": src, "says": "\n\n".join(texts_all) if not calls_raw else "",
                "cause": pending, "after": steps_flat[-1]["n"] if steps_flat and not pending else None,
                "calls": calls}
        pending = []
        steps_flat.append(step)
        cur["steps"].append(step)
        last_kind = "tool" if calls_raw else "text"
        prev_text = "\n\n".join(texts_all) if texts_all else None
        last_act = max([mm["ts"]] + [c["ts"] + c["dur"] for c in calls if not c["bg"]])

    return finish_agent(aid, turns, steps_flat, stamps, brief, meta, ctx)


def make_call(b, res, ctx):
    name, inp = b["name"], b.get("input") or {}
    cat = categorize(name, inp)
    st, text, dur, hook = "pend", "", 0, ""
    if res is not None:
        text = res["content"]
        dur = max(0, (res["ts"] or b["ts"]) - b["ts"])
        m = re.match(r"\s*PreToolUse:\S+ hook error:\s*", text)
        if res["err"] and m:
            st, hook = "hook", text[m.end():].strip()
        else:
            st = "err" if res["err"] else "ok"
    bg = bool(inp.get("run_in_background")) if name in ("Bash", "Agent", "Task") else False
    call = {"name": name, "cat": cat, "ts": b["ts"], "dur": dur, "st": st, "bg": bg,
            "desc": str(inp.get("description", "") or ""), "sum": cut(summarize(name, inp), 400),
            "res": cut(text, ctx["out"]), "rlen": len(text), "hook": hook[:8000]}
    if name == "Bash":
        cmd = inp.get("command", "") or ""
        # Short one-line commands are fully contained in "sum"; skip the duplicate copy.
        call["inp"] = "" if ("\n" not in cmd and len(cmd.strip()) <= 200) else cut(cmd, ctx["inp"])
    elif name in ("Agent", "Task"):
        call["agent"] = ctx["tu_agent"].get(b["id"])
        call["disp"] = {"model": inp.get("model", ""), "effort": inp.get("effort", ""), "bg": bool(inp.get("run_in_background")),
                        "type": inp.get("subagent_type", "")}
        prompt = str(inp.get("prompt", ""))
        mo = re.search(r"^[\s>*\-]*(选档理由：.*)$", prompt, re.M)
        call["disp"]["reason"] = mo.group(1).strip() if mo else ""
        if not call["agent"]:
            call["inp"] = cut(prompt, ctx["inp"])
    else:
        try:
            call["inp"] = cut(json.dumps(inp, ensure_ascii=False, indent=1), ctx["inp"])
        except (TypeError, ValueError):
            call["inp"] = ""
    if name == "SubagentHandback":
        call["_msg"] = str(inp.get("message", ""))
    call["long"] = bool(name == "Bash" and not bg and dur > LONG_MS)
    if name == "Bash" and st == "ok" and cat == "git":
        mk = merge_kind(inp.get("command", ""), b.get("cwd", ""))
        if mk:
            call["merge"] = mk
    n = ctx["notifs"].get(b["id"])
    if n and bg:
        call["bgDone"] = n[0]["ts"]
        call["bgDur"] = max(0, n[0]["ts"] - b["ts"])
        call["notif"] = {"status": n[0]["status"], "text": n[0]["text"], "durMs": n[0].get("durMs"), "n": len(n)}
        call["bgLong"] = name == "Bash" and call["bgDur"] > LONG_MS
    return call


# ---------------------------------------------------------------- whole session

def scan_notifs(all_rows):
    """tool_use_id -> list of completion notifications (task-notification texts), earliest first."""
    out = {}
    for rows in all_rows:
        for r in rows:
            a = r.get("attachment") or {}
            texts = []
            if r.get("type") == "attachment" and a.get("type") == "queued_command":
                p = a.get("prompt")
                texts = [p] if isinstance(p, str) else [b.get("text", "") for b in (p or []) if isinstance(b, dict)]
            elif r.get("type") == "user":
                texts = user_texts(r)
            for t in texts:
                if t.lstrip().startswith("<task-notification>") and r.get("timestamp"):
                    ev = parse_notify(t.strip())
                    ev["ts"] = ts_ms(r["timestamp"])
                    if ev["tu"]:
                        out.setdefault(ev["tu"], []).append(ev)
    for v in out.values():
        v.sort(key=lambda e: e["ts"])
    return out


def parse_session(jsonl_path, session_name="", out_chars=600, inp_chars=6000, progress=None):
    """progress(done_bytes, total_bytes, label) is called while reading files; it may be None."""
    sid = os.path.basename(jsonl_path)[:-6]
    sdir = os.path.join(os.path.dirname(jsonl_path), sid)
    subdir = os.path.join(sdir, "subagents")
    sub_files = []
    if os.path.isdir(subdir):
        sub_files = [fn for fn in sorted(os.listdir(subdir)) if fn.startswith("agent-") and fn.endswith(".jsonl")]
    tracker = Progress(progress, os.path.getsize(jsonl_path) + sum(os.path.getsize(os.path.join(subdir, fn)) for fn in sub_files))
    main_rows = read_rows(jsonl_path, tracker.add)
    subs = []  # (agent id, meta, rows)
    for fn in sub_files:
        aid = fn[6:-6]
        meta = {}
        mp = os.path.join(subdir, "agent-%s.meta.json" % aid)
        if os.path.exists(mp):
            try:
                with open(mp, encoding="utf-8") as mf:
                    meta = json.load(mf)
            except ValueError:
                pass
        subs.append((aid, meta, read_rows(os.path.join(subdir, fn), tracker.add)))
    tracker.label("整理步骤")
    ctx = {"out": out_chars, "inp": inp_chars, "family": family,
           "tu_agent": {m.get("toolUseId"): aid for aid, m, _ in subs if m.get("toolUseId")},
           "notifs": scan_notifs([main_rows] + [r for _, _, r in subs])}
    main = build_agent("main", main_rows, ctx, {"description": "主代理", "model": next(
        (r["message"].get("model") for r in main_rows if r.get("type") == "assistant"), "")})
    agents = [main]
    for aid, meta, rows in subs:
        agents.append(build_agent(aid, rows, ctx, meta))
    link_agents(agents)
    meta_out = {"tool": "claude", "unit": "quota", "priced": True, "sid": sid, "name": session_name or sid[:8],
                "start": main["start"], "end": max(a["end"] for a in agents),
                "outChars": out_chars, "inpChars": inp_chars, "project": next(
                    (r.get("cwd") for r in main_rows if r.get("cwd")), ""),
                "prices": {k: list(v) for k, v in prices.load("claude")["models"].items()}, "rows": len(main_rows)}
    return {"meta": meta_out, "agents": agents, "totals": totals(agents)}
