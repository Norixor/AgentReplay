#!/usr/bin/env python3
"""Live call briefs (src/live_brief.py): what the Claude and Codex feeds keep per call, and the compact form a card carries.

The feeds run against a stub Live (events only), so no session files are needed. The Gemini, Cursor and opencode feeds assert
the same fields in their own tests (test_gemini.py, test_cursor.py, test_opencode.py).
Run directly, or import run() from scripts/check.py; run() returns (cases, failures).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import live  # noqa: E402
import live_brief  # noqa: E402
from live import AgentState  # noqa: E402
from live_claude import ClaudeFeed  # noqa: E402
from live_codex import CodexFeed  # noqa: E402

MARK = 40   # room for the "… [已省略 N 字符]" marker `common.cut` appends


class StubLive:
    def __init__(self):
        self.events, self.tu_owner, self.briefs, self.unpriced, self.models = [], {}, {}, set(), set()

    def add_event(self, *a, **k):
        self.events.append((a, k))


def ts(n):
    return "2026-10-14T02:%02d:%02d.000Z" % (n // 60, n % 60)


def claude_call(feed, n, mid, calls, text=""):
    content = ([{"type": "text", "text": text}] if text else []) + [{"type": "tool_use", "id": cid, "name": name, "input": inp} for cid, name, inp in calls]
    feed.feed(json.dumps({"type": "assistant", "timestamp": ts(n), "message": {"id": mid, "model": "claude-sonnet-5-5", "content": content}}))


def claude_result(feed, n, cid, text, err=False):
    feed.feed(json.dumps({"type": "user", "timestamp": ts(n), "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": cid, "content": text, "is_error": err}]}}))


def cases():
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    # ---- Claude
    st = AgentState("main", "主代理")
    feed = ClaudeFeed(StubLive(), st, True)
    long_cmd = "cd /w && for i in 1 2 3; do echo $i; done\n" + "echo token=abcdefgh12345678 " + "x" * 3000
    claude_call(feed, 1, "msg_1", [("t1", "Bash", {"command": long_cmd, "description": "Loop"})], text="Checking the loop.\nmore")
    c = st.pending["t1"]
    case("claude: a running call keeps its full command (capped), category and a pend status",
         c["st"] == "pend" and c["inp"] == long_cmd[:live_brief.STORE_INP] and c["cat"] and c["res"] == "")
    snap = live.Live.recent_of(st)
    k = snap[0]["calls"][0]
    case("claude: the card step carries the call with a short input and no result yet",
         k["name"] == "Bash" and k["st"] == "pend" and len(k["inp"]) <= live_brief.CARD_INP + MARK and k["inp"].startswith("cd /w &&") and k["res"] == "")
    case("claude: secrets in the card input are masked", "abcdefgh12345678" not in json.dumps(snap) and "***" in k["inp"])
    d = live.Live.call_detail(c, 5000_000_000_000)
    case("claude: the running-call detail has cat and the input of a multi-line command", d["cat"] == c["cat"] and d["inp"].startswith("cd /w &&") and d["tool"] == "Bash")

    claude_result(feed, 3, "t1", "Exit code 1\n" + "boom " * 400, err=True)
    c = st.cur["calls"][0]
    case("claude: the result is kept (capped), with its length and duration",
         c["st"] == "err" and 0 < len(c["res"]) <= live_brief.STORE_RES + MARK and c["rlen"] > 2000 and c["dur"] == 2000)
    k = live.Live.recent_of(st)[0]["calls"][0]
    case("claude: the card result is shorter than the stored one", k["st"] == "err" and 0 < len(k["res"]) <= live_brief.CARD_RES + MARK and k["rlen"] == c["rlen"])

    st2 = AgentState("main", "主代理")
    f2 = ClaudeFeed(StubLive(), st2, True)
    for i in range(5):
        claude_call(f2, 10 + i, "msg_s%d" % i, [("u%d" % i, "Read", {"file_path": "/w/src/a%d.php" % i})])
        claude_result(f2, 10 + i, "u%d" % i, "line\n" * 5)
    rec = live.Live.recent_of(st2)
    case("only the newest steps carry calls", [("calls" in r) for r in rec] == [True, True, True, False, False] and rec[0]["n"] > rec[1]["n"])
    case("claude: a read keeps its path as the summary and the result length", rec[0]["calls"][0]["sum"] == "/w/src/a4.php" and rec[0]["calls"][0]["rlen"] == 25)
    case("claude: a call whose summary says it all has no copy in inp", rec[0]["calls"][0]["inp"] == "")

    st3 = AgentState("main", "主代理")
    f3 = ClaudeFeed(StubLive(), st3, True)
    claude_call(f3, 20, "msg_m", [("a", "Bash", {"command": "make a"}), ("b", "Bash", {"command": "make b"}), ("c", "Bash", {"command": "make c"})])
    claude_result(f3, 21, "a", "ok a")
    claude_result(f3, 21, "b", "ok b")
    two = live.Live.recent_of(st3)[0]["calls"]
    case("at most two calls per step, the unfinished call is always among them", len(two) == 2 and any(x["name"] == "Bash" and x["st"] == "pend" for x in two))
    case("said is capped and masked", len(live_brief.said_text(type("A", (), {"said": "token=abcdefgh12345678 " + "y" * 500})())) <= live_brief.CARD_SAID)

    # ---- Codex
    cs = AgentState("main", "主代理")
    cf = CodexFeed(StubLive(), cs, True, 0)

    def cx(n, ordinal, ptype, payload):
        cf.feed(json.dumps({"timestamp": ts(n), "ordinal": ordinal, "type": "response_item", "payload": dict({"type": ptype}, **payload)}, separators=(",", ":")).encode())

    cx(1, 1, "function_call", {"name": "exec_command", "call_id": "cc1", "arguments": json.dumps({"cmd": "cd /w\nnpm test -- --run", "workdir": "/w"})})
    c = cs.pending["cc1"]
    case("codex: a running shell call keeps its full command", c["st"] == "pend" and c["inp"] == "cd /w\nnpm test -- --run")
    cx(4, 2, "function_call_output", {"call_id": "cc1", "output": "Chunk ID: 1\nWall time: 3.0 seconds\nProcess exited with code 0\nOutput:\nTests  3 passed (3)\n"})
    c = cs.cur["calls"][0]
    case("codex: the result is kept with its duration", c["st"] == "ok" and "3 passed" in c["res"] and c["dur"] == 3000 and c["rlen"] > 40)
    k = live.Live.recent_of(cs)[0]["calls"][0]
    case("codex: the card call carries category, input and result", k["cat"] == c["cat"] and k["inp"].startswith("cd /w") and "3 passed" in k["res"] and k["st"] == "ok")
    return out


def run():
    res = cases()
    return res, [n for n, ok in res if not ok]


if __name__ == "__main__":
    allc, bad = run()
    for n, ok in allc:
        print("[%s] %s" % ("ok" if ok else "FAIL", n))
    print("%d cases, %d failed" % (len(allc), len(bad)))
    sys.exit(1 if bad else 0)
