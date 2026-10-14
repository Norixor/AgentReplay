#!/usr/bin/env python3
"""Tests of the opencode source (src/source_opencode.py, opencode_scan.py, parse_opencode.py) on small synthetic SQLite
databases created here (WAL mode, like opencode's own); no real session data is read or stored.

Covers: virtual session paths and their stat() following new messages (also from sub-sessions), the folded index row,
the session tree, the page model (turns, steps, calls with measured durations, failed calls, sub-session link, error
events), tokens and prices (cost column ignored, claude and codex tables, unknown model, local provider), empty or
broken databases, and that the database is only ever read. Run directly, or import run() from scripts/check.py; run()
returns (cases, failures).
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import config  # noqa: E402
import index  # noqa: E402
import opencode_scan  # noqa: E402
import sources  # noqa: E402

T0 = 1_700_000_000_000
EPS = 1e-9
SCHEMA = [
    "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, model TEXT,"
    " cost REAL, tokens_input INTEGER, time_created INTEGER, time_updated INTEGER, time_archived INTEGER)",
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
]


class Db:
    """Writer side of a synthetic opencode database; it stays open (WAL, no auto-checkpoint) like a running opencode."""

    def __init__(self, path):
        self.path, self.n = path, 0
        self.con = sqlite3.connect(path, isolation_level=None)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA wal_autocheckpoint=0")
        for s in SCHEMA:
            self.con.execute(s)

    def _id(self, prefix):
        self.n += 1
        return "%s_%06d" % (prefix, self.n)

    def session(self, sid, title, parent=None, agent="build", model=None, t=T0, archived=None, directory="/work/proj"):
        m = json.dumps(model) if model else None
        self.con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (sid, "p1", parent, directory, title, agent, m, 0.0, 0, t, t, archived))

    def touch(self, sid, t):
        self.con.execute("UPDATE session SET time_updated = ? WHERE id = ?", (t, sid))

    def user(self, sid, text, t):
        mid = self._id("msg")
        self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)", (mid, sid, t, t, json.dumps({"role": "user", "time": {"created": t}})))
        self.part(sid, mid, {"type": "text", "text": text}, t)
        return mid

    def assistant(self, sid, t0, t1, model, provider, tokens=None, parts=(), finish="tool-calls", error=None):
        mid = self._id("msg")
        d = {"role": "assistant", "modelID": model, "providerID": provider, "cost": 0, "finish": finish, "time": {"created": t0}, "path": {"cwd": "/work/proj"}}
        if t1:
            d["time"]["completed"] = t1
        if tokens:
            d["tokens"] = {"input": tokens.get("in", 0), "output": tokens.get("out", 0), "reasoning": tokens.get("rsn", 0),
                           "cache": {"read": tokens.get("cr", 0), "write": tokens.get("cw", 0)}}
        if error:
            d["error"] = error
        self.con.execute("INSERT INTO message VALUES (?,?,?,?,?)", (mid, sid, t0, t1 or t0, json.dumps(d)))
        for p in parts:
            self.part(sid, mid, p, t0)
        return mid

    def part(self, sid, mid, data, t):
        self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (self._id("prt"), mid, sid, t, t, json.dumps(data)))

    def close(self):
        self.con.close()


def tool(name, inp, output, t0, t1, status="completed", meta=None, error=None):
    st = {"status": status, "input": inp, "time": {"start": t0, "end": t1}, "metadata": meta or {}}
    if status == "error":
        st["error"] = error or "failed"
    else:
        st["output"] = output
    return {"type": "tool", "tool": name, "callID": "c_%s_%d" % (name, t0), "state": st}


def sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def near(a, b):
    return a is not None and abs(a - b) < EPS


def build(db):
    """Session A (parent of C, two turns, one failed + one aborted message), B (default title, archived), child C."""
    A, B, C = "ses_A", "ses_B", "ses_C"
    db.session(A, "Fix login", model={"id": "gpt-5.6-terra", "providerID": "p"}, t=T0)
    db.user(A, "do the thing", T0)
    db.assistant(A, T0 + 1000, T0 + 9000, "gpt-5.6-terra", "p", {"in": 1000, "out": 100, "rsn": 50, "cr": 4000}, [
        {"type": "step-start"}, {"type": "reasoning", "text": "plan it"}, {"type": "text", "text": "Let me look"},
        tool("bash", {"command": "ls", "description": "list files"}, "a b", T0 + 2000, T0 + 3500, meta={"exit": 0}),
        tool("task", {"subagent_type": "explore", "description": "scan", "prompt": "look around"}, "<task_result>x</task_result>", T0 + 3600, T0 + 8800,
             meta={"sessionId": C, "parentSessionId": A}),
        {"type": "step-finish"}])
    db.assistant(A, T0 + 9000, T0 + 12000, "anthropic/claude-sonnet-5-5-20260101", "openrouter", {"in": 1000, "cw": 2000, "cr": 3000, "out": 100, "rsn": 50}, [
        {"type": "step-start"},
        tool("bash", {"command": "false"}, "", T0 + 10000, T0 + 10200, meta={"exit": 1}),
        tool("read", {"filePath": "/nope"}, "", T0 + 10300, T0 + 10310, status="error", error="file missing")])
    db.assistant(A, T0 + 12000, T0 + 13000, "mystery-1", "p", {"in": 500, "out": 20}, [{"type": "text", "text": "done"}], finish="stop")
    db.user(A, "again", T0 + 20000)
    db.assistant(A, T0 + 20100, T0 + 20500, "gpt-5.6-terra", "p", {}, [], finish=None,
                 error={"name": "MessageAbortedError", "data": {"message": "aborted"}})
    db.touch(A, T0 + 20500)
    db.session(C, "scan (@explore subagent)", parent=A, agent="explore", model={"id": "qwen3:8b", "providerID": "ollama"}, t=T0 + 3600)
    db.user(C, "look around", T0 + 3600)
    db.assistant(C, T0 + 3700, T0 + 8700, "qwen3:8b", "ollama", {"in": 100, "out": 10}, [{"type": "text", "text": "found it"}], finish="stop")
    db.touch(C, T0 + 8700)
    db.session(B, "New session - 2026-01-01T00:00:00.000Z", t=T0 + 50000, archived=T0 + 60000)
    db.user(B, "hello world question", T0 + 50000)
    return A, B, C


def cases():
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    tmp = tempfile.mkdtemp(prefix="agent-replay-opencode-")
    saved = (dict(config.DIRS), config.HOME_DIR)
    db = None
    try:
        root = os.path.join(tmp, "data")
        os.makedirs(root)
        dbfile = os.path.join(root, "opencode-.db")
        src = sources.get("opencode")

        # --- nothing there / not a database / no sessions
        case("registered without a live view", src.live_supported is False and "opencode" in sources.ids())
        case("missing data directory -> no files", opencode_scan.files(os.path.join(tmp, "absent")) == [])
        with open(os.path.join(root, "opencode.db"), "wb") as f:
            f.write(b"this is not an sqlite database " * 20)
        case("a file that is not a database is ignored without an error", opencode_scan.files(root) == [])
        os.remove(os.path.join(root, "opencode.db"))
        db = Db(dbfile)
        case("database without sessions -> no files", opencode_scan.files(root) == [])

        A, B, C = build(db)
        pa, pb, pc = (opencode_scan.vpath(dbfile, s) for s in (A, B, C))
        sha0 = (sha(dbfile), sha(dbfile + "-wal"))
        case("the data is still in the -wal file (WAL read is exercised)", os.path.getsize(dbfile + "-wal") > 0)

        # --- virtual paths, stat, scan, tree
        files = opencode_scan.files(root)
        case("one virtual path per top-level session, sub-sessions not listed", sorted(files) == sorted([pa, pb]))
        sa, sb = opencode_scan.stat(pa), opencode_scan.stat(pb)
        case("stat mtime is the newest update in the tree, in seconds", near(sa[1], (T0 + 20500) / 1000.0) and near(sb[1], (T0 + 50000) / 1000.0))
        case("stat size counts the JSON bytes of messages and parts", sa[0] > sb[0] > 0)
        try:
            opencode_scan.stat(dbfile + "#ses_missing")
            gone = False
        except OSError:
            gone = True
        case("stat of an unknown session raises OSError", gone)
        rec = src.scan(pa)
        case("scan: id, directory, start, model and the folded sub-session count",
             rec["id"] == A and rec["cwd"] == "/work/proj" and rec["start"] == T0 and rec["model"] == "gpt-5.6-terra" and rec["subs"] == 1 and rec["title0"] == "Fix login" and not rec["archived"])
        recb = src.scan(pb)
        case("scan: a default title falls back to the first user message; archived is carried", recb["title0"] == "hello world question" and recb["archived"])
        tree = src.tree({}, A, pa)
        case("tree: main plus the sub-session by its id", tree == {"main": pa, C: pc})
        case("tree_for_path resolves the root id from the virtual path", src.tree_for_path(pa, None) == (A, tree))

        # --- the page model
        data = src.parse(A, tree, "Fix login", 600, 4000)
        ag = {a["id"]: a for a in data["agents"]}
        main, sub = ag["main"], ag[C]
        case("agents: main and the sub-session, linked by parent_id", list(ag) == ["main", C] and sub["parent"] == "main" and main["children"] == [C] and sub["depth"] == 1)
        steps = [s for t in main["turns"] for s in t["steps"]]
        case("main: user messages open turns, each model response is a step", len(main["turns"]) == 2 and [len(t["steps"]) for t in main["turns"]] == [3, 0] and len(steps) == 3)
        case("failed message without output becomes an interruption event, not a step", main["turns"][1]["evs"] and main["turns"][1]["evs"][0]["k"] == "interrupt" and main["turns"][1]["endKind"] == "abort")
        case("turn end follows the last response", main["turns"][0]["endKind"] == "complete" and main["turns"][0]["end"] == T0 + 13000)
        s0, s1, s2 = steps
        case("step times come from the message and its tools", s0["ts"] == T0 + 1000 and s0["fin"] == T0 + 9000 and s0["think"] == 1000 and s0["end"] == T0 + 9000)
        case("reasoning and text parts become rsum and said", s0["rsum"] == "plan it" and s0["said"] == "Let me look" and s2["says"] == "done")
        bash, task = s0["calls"]
        case("tool call: measured duration, status, summary, description", bash["name"] == "bash" and bash["dur"] == 1500 and bash["st"] == "ok" and bash["sum"] == "ls" and bash["desc"] == "list files" and bash["res"] == "a b")
        case("task call links to its sub-session and hands the prompt to the briefing",
             task["agent"] == C and task["cat"] == "agent" and task["dur"] == 5200 and task["inp"] == "" and sub["briefing"] == "look around" and sub["type"] == "explore")
        case("sub-session child summary on the call", task.get("child", {}).get("steps") == 1)
        failed_exit, failed_read = s1["calls"]
        case("non-zero exit and tool errors are failed calls", failed_exit["st"] == "err" and failed_read["st"] == "err" and "file missing" in failed_read["res"])
        case("sub-session: briefing turn, one step, its reply is the report", sub["turns"][0]["trig"]["k"] == "brief" and sub["nsteps"] == 1 and sub["report"] == "found it")

        # --- tokens and prices (session.cost is 0 everywhere)
        t = main["tok"]
        case("tokens: out includes reasoning, input is uncached, cache parts kept",
             t["in"] == 2500 and t["cw5"] == 2000 and t["cr"] == 7000 and t["out"] == 320 and t["rsn"] == 100)
        case("codex-table model priced from tokens although cost is 0 (gpt-5.6-terra: 2 / 0.2 / out 12)", near(s0["cost"], (1000 * 2 + 4000 * 0.2 + 150 * 12) / 1e6))
        case("claude-table model found through provider prefix and date (sonnet-5-5: 2 / 2.5 / 0.1 / 10)",
             near(s1["cost"], (1000 * 2 + 2000 * 2.5 + 3000 * 0.1 + 150 * 10) / 1e6) and s1["priced"])
        case("unknown model: tokens counted, no amount, reported as unpriced", s2["cost"] is None and not s2["priced"] and s2["tok"]["in"] == 500 and data["totals"]["unpModels"] == ["mystery-1"] and data["totals"]["nUnp"] == 1)
        case("local provider costs nothing and is marked local", sub["cost"] == 0.0 and sub["nLocal"] == 1)
        case("total amount sums the priced steps only", near(data["totals"]["cost"], 0.0046 + 0.0088))
        case("meta: tool, models, project, pricing rules", data["meta"]["tool"] == "opencode" and data["meta"]["models"] == ["anthropic/claude-sonnet-5-5-20260101", "gpt-5.6-terra", "mystery-1", "qwen3:8b"]
             and data["meta"]["project"] == "/work/proj" and data["meta"]["pricing"]["rules"])
        json.dumps(data)
        sha1 = (sha(dbfile), sha(dbfile + "-wal"))
        case("reading (files, stat, scan, tree, parse) left the database and its -wal file byte-identical", sha0 == sha1)

        # --- list rows through the index; changes invalidate the cache
        # every other registered source gets an empty directory, so only the synthetic database is indexed
        empty = {s.id: os.path.join(tmp, "none-" + s.id) for s in sources.all() if s.id != "opencode"}
        config.configure(dict(empty, opencode=root), home=os.path.join(tmp, "home"))
        recs, st1 = index.build_index()
        rows = [r for r in index.list_sessions(recs) if r["tool"] == "opencode"]
        ra = next(r for r in rows if r["id"] == A)
        case("list: one row per top-level session, sub-session folded in", len(rows) == 2 and ra["subs"] == 1 and ra["name"] == "Fix login" and ra["project"] == "proj" and ra["size"] == sa[0])
        case("list: archived flag and status", next(r for r in rows if r["id"] == B)["archived"] is True)
        _, st2 = index.build_index()
        case("second index pass rescans nothing", st1["scanned"] == 2 and st2["scanned"] == 0)
        db.assistant(C, T0 + 24000, T0 + 25000, "qwen3:8b", "ollama", {"in": 5, "out": 5}, [{"type": "text", "text": "more"}], finish="stop")
        db.touch(C, T0 + 25000)
        sa2 = opencode_scan.stat(pa)
        case("a new message in a sub-session changes the parent's stat", sa2[0] > sa[0] and near(sa2[1], (T0 + 25000) / 1000.0) and opencode_scan.stat(pb) == sb)
        _, st3 = index.build_index()
        case("index rescans only the changed session", st3["scanned"] == 1)
        db.assistant(A, T0 + 50, T0 + 60, "gpt-5.6-terra", "p", {"in": 1}, [{"type": "text", "text": "late"}], finish="stop")
        sa3 = opencode_scan.stat(pa)
        case("a row with an old time_updated still changes the size", sa3[0] > sa2[0] and sa3[1] == sa2[1])
    finally:
        if db is not None:
            db.close()
        config.configure(saved[0], home=saved[1])
        shutil.rmtree(tmp, ignore_errors=True)
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
