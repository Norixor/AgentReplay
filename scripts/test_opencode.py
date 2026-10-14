#!/usr/bin/env python3
"""Tests of the opencode source (src/source_opencode.py, opencode_scan.py, parse_opencode.py) on small synthetic SQLite
databases created here (WAL mode, like opencode's own); no real session data is read or stored.

The live view (live_opencode.py, opencode_tail.py) is covered by live_cases().

Covers: virtual session paths and their stat() following new messages (also from sub-sessions), the folded index row,
the session tree, the page model (turns, steps, calls with measured durations, failed calls, sub-session link, error
events), tokens and prices (cost column ignored, claude, codex and gemini tables, unknown model, local provider), empty or
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
import live  # noqa: E402
import opencode_scan  # noqa: E402
import source_opencode  # noqa: E402
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
        pid = self._id("prt")
        self.con.execute("INSERT INTO part VALUES (?,?,?,?,?,?)", (pid, mid, sid, t, t, json.dumps(data)))
        return pid

    def rewrite(self, table, rid, fn, t):
        """Change a row in place the way a running opencode does (new JSON, new time_updated)."""
        d = json.loads(self.con.execute("SELECT data FROM %s WHERE id = ?" % table, (rid,)).fetchone()[0])
        fn(d)
        self.con.execute("UPDATE %s SET data = ?, time_updated = ? WHERE id = ?" % table, (json.dumps(d), t, rid))

    def part_ids(self, mid):
        return [r[0] for r in self.con.execute("SELECT id FROM part WHERE message_id = ? ORDER BY time_created, id", (mid,))]

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


def mk_live(dbfile, sid, model="gpt-5.6-terra", start=T0):
    return live.Live({"tool": "opencode", "id": sid, "path": opencode_scan.vpath(dbfile, sid), "key": "opencode:" + sid, "start": start, "model": model}, {})


def money(a):
    return sum(v[0] for v in a.buckets.values())


def end_tools(db, mid, t0, t1, t):
    """Complete every tool part of a message."""
    def done(d):
        if d.get("type") == "tool":
            d["state"].update(status="completed", output="ok", time={"start": t0, "end": t1})
    for pid in db.part_ids(mid):
        db.rewrite("part", pid, done, t)


def live_cases(case, tmp):
    """Live view on synthetic databases: parity with the replay parse, increments, in-place updates, sub-sessions, window."""
    src = sources.get("opencode")
    d1 = os.path.join(tmp, "live1")
    os.makedirs(d1)
    f1 = os.path.join(d1, "opencode-.db")
    db1 = Db(f1)
    orig_connect = opencode_scan.connect
    opened = []

    def counting(p):
        opened.append(p)
        return orig_connect(p)

    def locked(p):
        raise sqlite3.OperationalError("database is locked")

    opencode_scan.connect = counting
    try:
        A, B, C = build(db1)
        pa = opencode_scan.vpath(f1, A)
        lv = mk_live(f1, A)
        now = T0 + 30_000
        sha0 = (sha(f1), sha(f1 + "-wal"))
        lv.refresh(now)
        snap = lv.snapshot(now)
        data = src.parse(A, src.tree({}, A, pa), "Fix login", 600, 4000)
        ag = {a["id"]: a for a in data["agents"]}
        main, sub = lv.agents["main"], lv.agents[C]

        def same(st, a):
            return all(st.tok.get(k, 0) == a["tok"][k] for k in ("in", "cw5", "cr", "out", "rsn")) and near(money(st), a["cost"])

        case("live: first build follows the main session and its sub-session (parent_id)", list(lv.agents) == ["main", C] and sub.parent_tid == A and lv.parent_of(sub) == "main")
        case("live: tokens and amount of every agent equal the replay page's", same(main, ag["main"]) and same(sub, ag[C]))
        case("live: steps equal the replay page's (a failed empty message is no step)", main.steps == 3 and sub.steps == 1 and main.prefix_steps == 0 and not main.approx)
        case("live: sub-session named from its task call, linked by the task id", sub.desc == "explore · scan" and (sub.tu or "").startswith("prt_"))
        case("live: unpriced model reported, local model costs nothing", lv.unpriced == {"mystery-1"} and money(sub) == 0.0)
        case("live: a sub-session whose last response finished is done and handed back", sub.done and any(e["k"] == "handback" and e["agent"] == C for e in lv.events))
        case("live: dispatch, user message and failed calls are in the event stream",
             {e["k"] for e in lv.events} >= {"dispatch", "user", "handback", "fail"} and sum(1 for e in lv.events if e["k"] == "fail") == 2)
        case("live: snapshot answers like the other sources (cards, subs, rate, unpriced)", snap["ok"] and snap["tool"] == "opencode" and snap["cards"][0]["id"] == "main"
             and snap["cards"][0]["steps"] == 3 and snap["subs"][C]["state"] == "done" and snap["rate"]["c60"] > 0 and snap["unpriced"] == ["mystery-1"])
        case("live: reading left the database and its -wal file byte-identical", (sha(f1), sha(f1 + "-wal")) == sha0)
        n = len(opened)
        lv.refresh(now + 1000)
        case("live: a refresh with an unchanged database opens no connection", len(opened) == n)

        # --- a response that is still streaming: pending call, then completed with tokens; the same row written again
        t = T0 + 40_000
        m1 = db1.assistant(A, t, None, "gpt-5.6-terra", "p", None, [{"type": "step-start"}, {"type": "text", "text": "running it"}], finish=None)
        p1 = db1.part(A, m1, tool("bash", {"command": "sleep 30", "description": "wait"}, "", t + 500, None, status="running"), t + 500)
        db1.touch(A, t + 500)
        lv.refresh(t + 1000)
        card = lv.snapshot(t + 1000)["cards"][0]
        case("live: a new response is a step and its running call is pending", main.steps == 4 and p1 in main.pending and card["state"] == "exec" and card["detail"]["tool"] == "bash"
             and card["steps"] == 4)
        k = card["recent"][0]["calls"]
        case("live: the running call is on the card with its category and no result yet", card["detail"].get("cat") and k[0]["st"] == "pend" and k[0]["res"] == "")
        tok0, cost0 = dict(main.tok), money(main)

        def finish_msg(d):
            d["time"]["completed"] = t + 5000
            d["finish"] = "stop"
            d["tokens"] = {"input": 700, "output": 80, "reasoning": 20, "cache": {"read": 1000, "write": 0}}

        db1.rewrite("part", p1, lambda d: d["state"].update(status="completed", output="woke", time={"start": t + 500, "end": t + 4900}, metadata={"exit": 0}), t + 4900)
        db1.rewrite("message", m1, finish_msg, t + 5000)
        lv.refresh(t + 6000)
        want = source_opencode.price_step("gpt-5.6-terra", {"in": 700, "out": 80, "rsn": 20, "cr": 1000, "cw": 0, "provider": "p"})
        case("live: completing the call clears pending without a new step", not main.pending and main.steps == 4)
        case("live: tokens and amount of the completed message are added once (out includes reasoning)",
             main.tok["in"] - tok0["in"] == 700 and main.tok["cr"] - tok0["cr"] == 1000 and main.tok["out"] - tok0["out"] == 100 and near(money(main) - cost0, want["cost"]))
        case("live: after a final response the card waits for the user", lv.snapshot(t + 6000)["cards"][0]["state"] == "idle")
        k = lv.snapshot(t + 6000)["cards"][0]["recent"][0]["calls"][0]
        case("live: the finished call carries its result on the card", k["st"] == "ok" and "woke" in k["res"] and k["dur"] == 4400)
        tok1, cost1 = dict(main.tok), money(main)
        db1.rewrite("message", m1, lambda d: None, t + 5500)   # the same rows written again
        db1.rewrite("part", p1, lambda d: None, t + 5500)
        lv.refresh(t + 7000)
        case("live: the same message written again is not counted twice", main.tok == tok1 and near(money(main), cost1) and main.steps == 4)

        # --- the watermark: a row with the same stamp as the newest seen, and a late commit with an older one
        mark = lv.impl.tail_of["main"].mark
        db1.user(A, "same ms", mark)
        db1.user(A, "late commit", mark - 500)
        lv.refresh(t + 8000)
        texts = [e["text"] for e in lv.events if e["k"] == "user"]
        case("live: rows at the watermark and just behind it are not missed", "same ms" in texts and "late commit" in texts)

        # --- a database that cannot be read right now is retried, not dropped
        db1.user(A, "while locked", t + 9000)
        opencode_scan.connect = locked
        lv.refresh(t + 9500)
        locked_seen = any(e["text"] == "while locked" for e in lv.events)
        opencode_scan.connect = counting
        lv.refresh(t + 10_000)
        case("live: an unreadable database yields nothing and the next poll catches up", not locked_seen and any(e["text"] == "while locked" for e in lv.events))

        # --- sub-sessions appearing later: one ends by itself, one is returned by its parent's task call
        D, E = "ses_D", "ses_E"
        t2 = T0 + 50_000
        db1.session(D, "later child", parent=A, agent="general", model={"id": "gpt-5.6-terra", "providerID": "p"}, t=t2)
        db1.user(D, "do part one", t2)
        md = db1.assistant(D, t2 + 100, None, "gpt-5.6-terra", "p", None, [{"type": "step-start"}, tool("bash", {"command": "make"}, "", t2 + 200, None, status="running")], finish=None)
        db1.part(D, md, tool("read", {"filePath": "/x"}, "", t2 + 300, None, status="running"), t2 + 300)
        db1.session(E, "other child", parent=A, agent="general", model={"id": "gpt-5.6-terra", "providerID": "p"}, t=t2)
        db1.user(E, "do part two", t2)
        db1.assistant(E, t2 + 100, None, "gpt-5.6-terra", "p", None, [{"type": "step-start"}, {"type": "text", "text": "thinking"}], finish=None)
        mt = db1.assistant(A, t2, None, "gpt-5.6-terra", "p", None, [
            tool("task", {"subagent_type": "general", "description": "part one", "prompt": "line1\nline2"}, "", t2 + 50, None, status="running", meta={"sessionId": D}),
            tool("task", {"subagent_type": "general", "description": "part two", "prompt": "p2"}, "", t2 + 60, None, status="running", meta={"sessionId": E})], finish=None)
        db1.touch(A, t2 + 400)
        lv.refresh(t2 + 1000)
        sd, se = lv.agents.get(D), lv.agents.get(E)
        snap = lv.snapshot(t2 + 1000)
        case("live: sub-sessions created after the first build are discovered and linked to their task calls",
             sd is not None and se is not None and sd.desc == "general · part one" and se.desc == "general · part two" and lv.parent_of(sd) == "main")
        case("live: a running sub-session shows its pending calls", len(sd.pending) == 2 and snap["subs"][D]["state"] == "exec" and not sd.done
             and {c["id"] for c in snap["cards"]} >= {"main", D, E})
        case("live: task calls without a result keep the parent waiting", snap["cards"][0]["state"] == "waiting")
        case("live: dispatch events carry the brief", any(e["k"] == "dispatch" and "part one" in e["text"] for e in lv.events) and lv.briefs[sd.tu]["lines"] == ["line1", "line2"])

        end_tools(db1, md, t2 + 200, t2 + 2000, t2 + 2000)
        db1.rewrite("message", md, lambda d: d["time"].update(completed=t2 + 3000) or d.update(finish="stop", tokens={"input": 10, "output": 5}), t2 + 3000)
        task_e = db1.part_ids(mt)[1]
        db1.rewrite("part", task_e, lambda d: d["state"].update(status="completed", output="<task_result>b</task_result>", time={"start": t2 + 60, "end": t2 + 3500}), t2 + 3500)
        lv.refresh(t2 + 4000)
        case("live: a sub-session that finished by itself is done and hands back", sd.done and sd.done_ts == t2 + 3000 and not sd.pending)
        case("live: a sub-session whose parent's task call came back is done too", se.done and any(e["k"] == "handback" and e["agent"] == E for e in lv.events))
        case("live: the parent still waits for its other task call", len([c for c in main.pending.values() if c["cat"] == "agent"]) == 1)
        snap = lv.snapshot(t2 + 4000)
        case("live: returned sub-agents are listed as returned", {c["id"] for c in snap["returned"]} >= {C, D, E} and snap["subs"][E]["state"] == "done")
        sd_steps = sd.steps
        db1.user(D, "one more thing", t2 + 5000)
        lv.refresh(t2 + 5500)
        case("live: a follow-up message reopens a returned sub-session", not sd.done and sd.steps == sd_steps)
    finally:
        opencode_scan.connect = orig_connect
        db1.close()

    # --- opening window: older responses are only counted; old sub-sessions are not followed
    d2 = os.path.join(tmp, "live2")
    os.makedirs(d2)
    f2 = os.path.join(d2, "opencode-.db")
    db2 = Db(f2)
    try:
        NOW = T0 + 4 * 3600 * 1000
        W, OLD, STALE = "ses_W", "ses_OLD", "ses_STALE"
        db2.session(W, "long one", model={"id": "gpt-5.6-terra", "providerID": "p"}, t=T0)
        for i in range(3):
            db2.user(W, "old %d" % i, T0 + i * 1000)
            db2.assistant(W, T0 + i * 1000 + 100, T0 + i * 1000 + 500, "gpt-5.6-terra", "p", {"in": 100, "out": 10}, [{"type": "text", "text": "x"}], finish="stop")
        db2.user(W, "recent", NOW - 600_000)
        db2.assistant(W, NOW - 590_000, NOW - 580_000, "gpt-5.6-terra", "p", {"in": 1000, "out": 100}, [{"type": "text", "text": "y"}], finish="stop")
        for sid, ended in ((OLD, True), (STALE, False)):
            db2.session(sid, sid, parent=W, agent="general", model={"id": "gpt-5.6-terra", "providerID": "p"}, t=T0 + 5000)
            db2.user(sid, "go", T0 + 5000)
            db2.assistant(sid, T0 + 5100, T0 + 5900 if ended else None, "gpt-5.6-terra", "p", {"in": 5, "out": 5} if ended else None,
                          [{"type": "text", "text": "z"}], finish="stop" if ended else None)
        db2.touch(W, NOW - 580_000)
        lv2 = mk_live(f2, W)
        lv2.refresh(NOW)
        m2 = lv2.agents["main"]
        want = source_opencode.price_step("gpt-5.6-terra", {"in": 1000, "out": 100, "rsn": 0, "cr": 0, "cw": 0, "provider": "p"})
        case("live: responses before the window are only counted", m2.steps == 1 and m2.prefix_steps == 3 and m2.tok["in"] == 1000 and near(money(m2), want["cost"]))
        case("live: the snapshot adds the counted steps", lv2.snapshot(NOW)["cards"][0]["steps"] == 4)
        case("live: old sub-sessions are not followed; an unfinished one is reported as stale", list(lv2.agents) == ["main"] and lv2.stale_unreturned == 1)
    finally:
        db2.close()


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
        case("registered with a live view", src.live_supported is True and "opencode" in sources.ids())
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
        # gemini section: opencode's input excludes the cached part and reasoning is separate; the message day picks dated rates
        gem = {"in": 1000, "cw": 0, "cr": 4000, "out": 150, "rsn": 50, "provider": "google"}
        g1 = source_opencode.price_step("google/gemini-3.8-flash", dict(gem, day="2026-10-13"))
        case("gemini-table model priced through provider prefix (3.8-flash: 0.75 / cached 0.075 / out 3.75, reasoning billed as output)",
             g1["priced"] and near(g1["cost"], (1000 * 0.75 + 4000 * 0.075 + 200 * 3.75) / 1e6))
        g2 = source_opencode.price_step("gemini-3.8-flash", dict(gem, day="2027-01-02"))
        case("gemini price change applies from the message day on (2027-01-01: rates double)", near(g2["cost"], 2 * g1["cost"]))
        case("gemini model without a message day uses the base rates", near(source_opencode.price_step("gemini-3.8-flash", gem)["cost"], g1["cost"]))
        case("gemini tokens keep the opencode shape (out includes reasoning)", g1["tok"]["in"] == 1000 and g1["tok"]["cr"] == 4000 and g1["tok"]["out"] == 200 and g1["tok"]["rsn"] == 50)
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
        live_cases(case, tmp)
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
