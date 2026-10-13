"""Shared building blocks for the Claude and Codex parsers: time/length helpers, command
categories, per-agent aggregation, parent/child linking and session totals.

Every parser produces the same agent model (turns -> steps -> calls); the page code only sees that model.
"""
import json
import re
import time
from datetime import datetime

CATS = ["read", "test", "write", "git", "wait", "agent", "other"]
LONG_MS = 60_000


class Progress:
    """Byte-based progress reporter: cb(done_bytes, total_bytes, label) is invoked at most every 0.25 s."""

    def __init__(self, cb, total):
        self.cb, self.total, self.done, self.text, self._last = cb, max(1, total), 0, "读取文件", 0.0

    def add(self, n):
        self.done += n
        self._emit(False)

    def label(self, text):
        self.text = text
        self._emit(True)

    def _emit(self, force):
        if not self.cb:
            return
        now = time.monotonic()
        if force or now - self._last > 0.25:
            self._last = now
            self.cb(min(self.done, self.total), self.total, self.text)


def ts_ms(s):
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)



def cut(s, n):
    if s is None:
        return ""
    if len(s) <= n:
        return s
    return s[:n] + "\n… [已省略 %d 字符]" % (len(s) - n)


_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2\b", re.S)
_QUOTED = re.compile(r"\"(?:\\.|[^\"\\])*\"|'[^']*'", re.S)
_WAIT = re.compile(r"(^|[\s;&|(])(until|while|sleep|pgrep|watch)\b|tail\s+(-\w*f|--follow)")
_TEST = re.compile(
    r"paratest|phpunit|phpstan|\bstan\b|deptrac|vitest|\bjest\b|"
    r"(npm|pnpm|yarn)\s+(run\s+)?(test|typecheck|lint|check)|\btsc\b|eslint|pytest|"
    r"composer\s+(run\s+)?\S*(test|stan|lint|check)|artisan\s+test|go\s+test|cargo\s+(test|clippy)|"
    r"node\s+--check|php\s+-l\b")
_WRITE = re.compile(
    r"\bsed\s+(-\w*i\b|--in-place)|(^|[\s;&|(])(cat|tee|echo|printf)\b[^|;&\n]*>{1,2}\s*[^\s&|]|"
    r"(^|[\s;&|(])(mv|cp|rm|mkdir|touch|ln|chmod|patch)\s|(npm|pnpm|yarn)\s+(install|add)|composer\s+(install|update|require)")
_READ = {"cat", "head", "tail", "ls", "find", "grep", "rg", "wc", "awk", "stat", "file", "diff", "jq",
         "tree", "cut", "sort", "uniq", "echo", "pwd", "which", "du", "df", "xxd", "nl", "sed", "cd", "test", "["}


def classify_bash(cmd):
    c = _QUOTED.sub('""', _HEREDOC.sub(" ", cmd or ""))
    if _WAIT.search(c):
        return "wait"
    if _TEST.search(c):
        return "test"
    segs = [s.strip() for s in re.split(r"&&|\|\||;|\n|\|", c) if s.strip()]
    firsts = [s.split()[0] for s in segs]
    if any(f in ("git", "gh") for f in firsts):
        return "git"
    if _WRITE.search(c):
        return "write"
    real = [f for f in firsts if f != "cd"]
    if real and all(f in _READ for f in real):
        return "read"
    return "other"


_SEG_SPLIT = re.compile(r"&&|\|\||;|\n|\|")


def merge_kind(cmd, cwd=""):
    """'merge' | 'cherry-pick' | 'ff' when a shell command integrates work into the main workspace, else ''.

    Matches `git merge`, `git cherry-pick`, and fast-forwards such as `git fetch . x:main`. Commands run inside a
    worktree (cwd, a leading `cd`, or `git -C`) do not count: the marker is about the main workspace moving forward.
    """
    c = _QUOTED.sub('""', _HEREDOC.sub(" ", cmd or ""))
    if "git" not in c:
        return ""
    in_wt = "worktree" in (cwd or "")
    for seg in _SEG_SPLIT.split(c):
        w = seg.split()
        if not w:
            continue
        if w[0] == "cd" and len(w) > 1:
            in_wt = "worktree" in w[1]
            continue
        if w[0] != "git":
            continue
        i, wt = 1, in_wt
        while i < len(w) and w[i].startswith("-"):
            if w[i] in ("-C", "-c") and i + 1 < len(w):
                wt = wt or (w[i] == "-C" and "worktree" in w[i + 1])
                i += 1
            i += 1
        if wt or i >= len(w):
            continue
        sub, rest = w[i], w[i + 1:]
        if sub in ("merge", "cherry-pick"):
            if not any(a in ("--abort", "--quit") for a in rest):
                return sub
        elif sub in ("fetch", "push") and "." in rest and any(re.search(r":(refs/heads/)?main$", a) for a in rest):
            return "ff"
    return ""


def finish_agent(aid, turns, steps, stamps, brief, meta, ctx):
    meta = meta or {}
    fam_of = ctx["family"]
    by_fam, by_cat, tok = {}, {c: {"c": 0.0, "t": 0, "n": 0} for c in CATS}, [0, 0, 0, 0]
    cost = 0.0
    hooks = long_t = long_n = test_t = wait_t = 0
    report, rsrc = None, ""
    last_text = ""
    for s in steps:
        cost += s["cost"]
        by_fam[s["fam"]] = by_fam.get(s["fam"], 0) + s["cost"]
        for i in range(4):
            tok[i] += s["u"][i]
        cats = [c["cat"] for c in s["calls"]] or ["other"]
        for c in cats:
            by_cat[c]["c"] += s["cost"] / len(cats)
        for c in s["calls"]:
            by_cat[c["cat"]]["n"] += 1
            d = c["dur"]
            if c.get("shell", c["name"] in ("Bash", "Monitor")) and not c["bg"]:
                by_cat[c["cat"]]["t"] += d
                if c["cat"] == "test":
                    test_t += d
                if c["cat"] == "wait":
                    wait_t += d
            if c["st"] == "hook":
                hooks += 1
            if c["long"]:
                long_t += c["dur"]
                long_n += 1
            if c["name"] == "SubagentHandback":
                report, rsrc = c.pop("_msg", ""), "handback"
        if s["says"]:
            last_text = s["says"]
    if report is None and last_text and aid != "main":
        report, rsrc = last_text, "lasttext"
    fam_main = max(by_fam, key=by_fam.get) if by_fam else fam_of(meta.get("model"))
    a = {"id": aid, "desc": meta.get("description") or ("主代理" if aid == "main" else aid), "model": meta.get("model") or "",
         "effort": meta.get("effort") or "", "fam": fam_of(meta.get("model")) if meta.get("model") else fam_main,
         "depth": meta.get("spawnDepth", 0 if aid == "main" else 1), "parentTu": meta.get("toolUseId"),
         "wt": meta.get("worktreePath") or "", "bg": meta.get("requestShape") == "background", "type": meta.get("agentType") or "",
         "start": min(stamps) if stamps else 0, "end": max(stamps) if stamps else 0, "nsteps": len(steps),
         "cost": cost, "byFam": by_fam, "byCat": by_cat, "tok": tok, "briefing": brief or "",
         "lastText": last_text, "turns": turns,
         "stats": {"steps": len(steps), "hooks": hooks, "longT": long_t, "longN": long_n, "testT": test_t, "waitT": wait_t}}
    a["reason"] = ""
    if brief:
        mo = re.search(r"^[\s>*\-]*(选档理由：.*)$", brief, re.M)
        a["reason"] = mo.group(1).strip() if mo else ""
    a["report"], a["reportSrc"] = report, rsrc
    for t in turns:
        if t["trig"]["k"] == "brief":
            t["trig"]["text"] = ""  # the full briefing lives in a["briefing"]
    return a


def link_agents(agents):
    """Set parent/children from dispatch tool_use ids; sort subagents by start time."""
    owner = {}
    for a in agents:
        for t in a["turns"]:
            for s in t["steps"]:
                for c in s["calls"]:
                    if c.get("agent"):
                        owner[c["agent"]] = a["id"]
    by_id = {a["id"]: a for a in agents}
    for a in agents:
        a["children"] = []
        # A parser may preset "parent" (Codex records it in session_meta); otherwise derive it from the dispatch call.
        a["parent"] = (a.get("parent") or owner.get(a["id"])) if a["id"] != "main" else None
        if a["id"] != "main" and not a["parent"]:
            a["parent"] = "main"
    for a in agents:
        if a["parent"] in by_id:
            by_id[a["parent"]]["children"].append(a["id"])
    for a in agents:
        for t in a["turns"]:
            for s in t["steps"]:
                for c in s["calls"]:
                    ch = by_id.get(c.get("agent"))
                    if ch:
                        c["child"] = {"start": ch["start"], "end": ch["end"], "cost": ch["cost"], "steps": ch["nsteps"]}
    for a in agents:
        for t in a["turns"]:
            tr = t["trig"]
            if tr["k"] == "handback" and by_id.get(tr.get("from"), {}).get("report"):
                tr["ref"] = True  # full report is shown in the subagent detail
                tr["text"] = ""
    agents[1:] = sorted(agents[1:], key=lambda x: x["start"])


def totals(agents):
    main, subs = agents[0], agents[1:]
    by_fam = {}
    by_cat = {c: {"c": 0.0, "t": 0, "n": 0} for c in CATS}
    compacts, hooks, stops, long_t, long_n, bg_long_t = [], 0, 0, 0, 0, 0
    groups = {}
    for a in agents:
        for f, v in a["byFam"].items():
            by_fam[f] = by_fam.get(f, 0) + v
        for c, v in a["byCat"].items():
            for k in ("c", "t", "n"):
                by_cat[c][k] += v[k]
        hooks += a["stats"]["hooks"]
        long_t += a["stats"]["longT"]
        long_n += a["stats"]["longN"]
        for t in a["turns"]:
            for e in [t["trig"]] + t["evs"]:
                if e["k"] == "compact":
                    compacts.append({"agent": a["id"], "ts": e["ts"], "trigger": e.get("trigger"), "pre": e.get("pre")})
                if e["k"] == "info" and "blocked the turn" in e.get("text", ""):
                    stops += 1
                if e["k"] == "goal" and e["text"].startswith("Stop hook feedback"):
                    stops += 1
            for s in t["steps"]:
                for c in s["calls"]:
                    if c.get("bgLong"):
                        bg_long_t += c["bgDur"]
        if a["id"] != "main":
            key = (a["model"] or a["fam"], a["effort"] or "-")
            g = groups.setdefault(key, {"model": key[0], "effort": key[1], "n": 0, "cost": 0.0})
            g["n"] += 1
            g["cost"] += a["cost"]
    return {"cost": main["cost"] + sum(a["cost"] for a in subs), "mainCost": main["cost"], "subCost": sum(a["cost"] for a in subs),
            "byFam": by_fam, "byCat": by_cat, "compacts": compacts, "hooks": hooks, "stopBlocks": stops,
            "longT": long_t, "longN": long_n, "bgLongT": bg_long_t, "nsub": len(subs),
            "groups": sorted(groups.values(), key=lambda g: -g["cost"]), "mainSteps": main["nsteps"],
            "tok": [sum(a["tok"][i] for a in agents) for i in range(4)]}
