#!/usr/bin/env python3
"""Tests of the Cursor source (src/source_cursor.py, cursor_scan.py, cursor_calls.py, parse_cursor.py) on small synthetic
SQLite databases created here (WAL mode, like Cursor's own); no real session data is read or stored.

Covers: virtual session paths and their stat() following new messages (also from sub-agent chats), which chats are listed
(placeholders, sub-agents and chats without per-message times are not), the session tree, the page model (turns, steps merged
from separate messages, calls with their times, failed / cancelled / refused calls, sub-agent link and report), time estimates,
no tokens and no amounts, secrets staying out of the result, that only cursorDiskKV is ever read, a damaged row, missing or
foreign databases, project folders, and that the database is only ever read. Run directly, or import run() from
scripts/check.py; run() returns (cases, failures).
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import config  # noqa: E402
import cursor_scan  # noqa: E402
import index  # noqa: E402
import sources  # noqa: E402

T0 = 1_760_000_000_000
SECRETS = ("SECRET-BLOB-KEY-123", "SECRET-SPECULATIVE-KEY-456", "SIGNATURE-SENTINEL-789", "TOKEN-IN-ITEMTABLE-000")


def iso(ms):
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)


class Db:
    """Writer side of a synthetic Cursor database; it stays open (WAL, no auto-checkpoint) like a running editor."""

    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.con = sqlite3.connect(path, isolation_level=None)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA wal_autocheckpoint=0")
        self.con.execute("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        self.con.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        self.con.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", (SECRETS[3],))
        self.headers, self._composer = {}, {}

    def put(self, key, value):
        self.con.execute("INSERT INTO cursorDiskKV VALUES (?, ?)", (key, value if isinstance(value, str) else json.dumps(value)))

    def composer(self, sid, name="", status="completed", created=T0, model="model-x", effort="medium", subs=None, parent=None, ws=None,
                 ctx=None, subtitle="", stamped=True):
        d = {"_v": 18, "composerId": sid, "name": name, "subtitle": subtitle, "createdAt": created, "status": status,
             "blobEncryptionKey": SECRETS[0], "speculativeSummarizationEncryptionKey": SECRETS[1],
             "fullConversationHeadersOnly": self.headers.setdefault(sid, [])}
        if model:
            d["modelConfig"] = {"modelName": model, "selectedModels": [{"modelId": model, "parameters": [{"id": "effort", "value": effort}]}]}
        if subs:
            d["subagentComposerIds"] = subs
        if parent:
            d["subagentInfo"] = {"subagentType": 3, "parentComposerId": parent}
        if ws:
            d["workspaceIdentifier"] = {"id": ws}
        if ctx:
            d["contextTokensUsed"], d["contextTokenLimit"] = ctx, 256000
        self._composer[sid] = d
        self.put("composerData:" + sid, d)

    def bubble(self, sid, bid, type_, t, text="", think=None, tdur=None, tool=None, done=None, turn_ms=None, stamped=True):
        b = {"_v": 3, "type": type_, "bubbleId": bid, "text": text, "tokenCount": {"inputTokens": 0, "outputTokens": 0}}
        if stamped:
            b["createdAt"] = iso(t)
        if think is not None:
            b["thinking"] = {"text": think, "signature": SECRETS[2]}
        if tdur is not None:
            b["thinkingDurationMs"] = tdur
        if tool:
            b["toolFormerData"] = tool
        self.put("bubbleId:%s:%s" % (sid, bid), b)
        h = {"bubbleId": bid, "type": type_}
        if stamped:
            h["startedAtMs"] = t
        if done is not None:
            h["completedAtMs"] = done
        if turn_ms:
            h["grouping"] = {"turnDurationMs": turn_ms}
        self.headers.setdefault(sid, []).append(h)
        if sid in self._composer:
            self.put("composerData:" + sid, self._composer[sid])

    def close(self):
        self.con.close()


def tool(name, status, params=None, raw=None, result=None, error=None, call=None, extra=None):
    t = {"name": name, "status": status, "tool": 1, "toolIndex": 0}
    if params is not None:
        t["params"] = json.dumps(params)
    if raw is not None:
        t["rawArgs"] = json.dumps(raw)
    if result is not None:
        t["result"] = json.dumps(result)
    if error is not None:
        t["error"] = json.dumps(error)
    if call:
        t["toolCallId"] = "call-%s-%d\nfc_x_0" % call
    t["additionalData"] = dict(extra or {}, status="x")
    return t


def sha(path):
    try:
        with open(path, "rb") as f:
            return hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None


def build(db, root):
    """A: top-level, two turns, sub-agent C. B: placeholder. D: old chat without per-message times. E: unnamed. C: sub-agent."""
    A, B, C, D, E = "chat-A", "chat-B", "chat-C", "chat-D", "chat-E"
    os.makedirs(os.path.join(root, "User", "workspaceStorage", "ws1"))
    with open(os.path.join(root, "User", "workspaceStorage", "ws1", "workspace.json"), "w") as f:
        json.dump({"folder": "file:///work/proj%20x"}, f)
    db.composer(A, name="Fix login", status="aborted", ws="ws1", ctx=5000, subs=[C])
    db.bubble(A, "a1", 1, T0, "do the thing")
    db.bubble(A, "a2", 2, T0 + 1000, think="plan it", tdur=1500)
    db.bubble(A, "a3", 2, T0 + 2500, "Let me look")
    db.bubble(A, "a4", 2, T0 + 2600, tool=tool("read_file", "completed", {"relativeWorkspacePath": "a.py", "startLineOneIndexed": 1, "endLineOneIndexedInclusive": 20},
                                              result={"contents": "print(1)"}, call=("u1", 0)), done=T0 + 2900)
    db.bubble(A, "a5", 2, T0 + 2900, tool=tool("run_terminal_command_v2", "completed", {"command": "pytest -q", "commandDescription": "run tests"},
                                              result={"output": "1 failed", "exitCodeV2": 1}, call=("u1", 1)), done=T0 + 4900)
    db.bubble(A, "a6", 2, T0 + 6000, think="retry", tdur=800)
    db.bubble(A, "a7", 2, T0 + 6800, tool=tool("search_replace", "error", {"relativeWorkspacePath": "a.py"}, raw={"file_path": "a.py", "old_string": "x", "new_string": "y"},
                                              error={"modelVisibleErrorMessage": "no match", "clientVisibleErrorMessage": "no match"}, call=("u2", 2)))
    db.bubble(A, "a8", 2, T0 + 9000, tool=tool("todo_write", "completed", {"todos": [{"content": "x", "status": "pending", "id": "1"}]},
                                              result={"success": True, "finalTodos": [{"content": "x", "status": "pending"}]}, call=("u3", 3)))
    db.bubble(A, "a9", 2, T0 + 9500, tool=tool("task_v2", "completed", {"description": "scan", "prompt": "look around", "subagentType": "explore", "model": "m", "name": "gp"},
                                              result={"agentId": C}, call=("u4", 4), extra={"subagentComposerId": C, "terminationReason": "completed"}), done=T0 + 19000)
    db.bubble(A, "a10", 2, T0 + 20000, "done", turn_ms=21000)
    db.bubble(A, "a11", 1, T0 + 30000, "again")
    db.bubble(A, "a12", 2, T0 + 31000, tool=tool("run_terminal_cmd", "completed", {"command": "rm -rf build"}, result={"rejected": True}, call=("u5", 5)))
    db.bubble(A, "a13", 2, T0 + 32000, tool=tool("search_replace", "cancelled", {"relativeWorkspacePath": "a.py"}, call=("u6", 6)))

    db.composer(C, name="scan", status="none", created=T0 + 9600, parent=A, subtitle="short sub summary", model="model-sub")
    db.bubble(C, "c1", 1, T0 + 9700, "look around")
    db.bubble(C, "c2", 2, T0 + 10000, think="listing", tdur=400)
    db.bubble(C, "c3", 2, T0 + 10500, tool=tool("run_terminal_command_v2", "completed", {"command": "ls"}, result={"output": "a b", "exitCodeV2": 0}), done=T0 + 11000)
    db.bubble(C, "c4", 2, T0 + 11100, tool=tool("run_terminal_command_v2", "completed", {"command": "ls -la"}, result={"output": "a b", "exitCodeV2": 0}), done=T0 + 11300)
    db.bubble(C, "c5", 2, T0 + 13000, tool=tool("grep_search", "completed", {"patternInfo": {"pattern": "needle"}}, result={"internal": {"results": []}}), done=T0 + 13200)
    db.bubble(C, "c6", 2, T0 + 14000, "found it")

    db.composer(B, name="")  # placeholder: no headers, no name
    db.composer(D, name="old chat")
    db.bubble(D, "d1", 1, 0, "old question", stamped=False)
    db.bubble(D, "d2", 2, 0, "old answer", stamped=False)
    db.composer(E, name="", created=T0 + 50000, model="")
    db.bubble(E, "e2", 2, T0 + 50500, "later reply")
    db.bubble(E, "e1", 1, T0 + 50000, "hello world question")
    return A, B, C, D, E


def cases():
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    tmp = tempfile.mkdtemp(prefix="agent-replay-cursor-")
    saved = (dict(config.DIRS), config.HOME_DIR)
    orig_connect = cursor_scan.connect
    db = None
    try:
        root = os.path.join(tmp, "data")
        dbfile = cursor_scan.db_file(root)
        src = sources.get("cursor")

        # --- nothing there / not a database / no table / no rows
        case("registered without a live view", src.live_supported is False and "cursor" in sources.ids())
        case("missing data directory -> no files", cursor_scan.files(os.path.join(tmp, "absent")) == [])
        os.makedirs(os.path.dirname(dbfile))
        with open(dbfile, "wb") as f:
            f.write(b"this is not an sqlite database " * 20)
        case("a file that is not a database is ignored without an error", cursor_scan.files(root) == [])
        os.remove(dbfile)
        other = sqlite3.connect(dbfile)
        other.execute("CREATE TABLE other (a)")
        other.commit()
        other.close()
        case("a database without cursorDiskKV is ignored without an error", cursor_scan.files(root) == [])
        os.remove(dbfile)
        db = Db(dbfile)
        case("database without chats -> no files", cursor_scan.files(root) == [])

        A, B, C, D, E = build(db, root)
        pa, pc, pe = (cursor_scan.vpath(dbfile, s) for s in (A, C, E))
        sha0 = (sha(dbfile), sha(dbfile + "-wal"))
        case("the data is still in the -wal file (WAL read is exercised)", os.path.getsize(dbfile + "-wal") > 0)

        # --- which chats are listed
        files = cursor_scan.files(root)
        case("top-level chats with message times are listed, one virtual path each", sorted(files) == sorted([pa, pe]))
        case("not listed: placeholder, sub-agent chat, chat without per-message times", all(cursor_scan.vpath(dbfile, s) not in files for s in (B, C, D)))
        sa, se = cursor_scan.stat(pa), cursor_scan.stat(pe)
        case("stat mtime is the newest message time in the tree, in seconds", sa[1] == (T0 + 32000) / 1000.0 and se[1] == (T0 + 50500) / 1000.0)
        sizes = {s: sum(len(v) for (v,) in db.con.execute("SELECT value FROM cursorDiskKV WHERE key LIKE ?", ("bubbleId:%s:%%" % s,))) for s in (A, C, E)}
        case("stat size counts the bytes of every message in the tree (sub-agent chats included)", sa[0] == sizes[A] + sizes[C] and se[0] == sizes[E])
        try:
            cursor_scan.stat(dbfile + "#nope")
            gone = False
        except OSError:
            gone = True
        case("stat of an unknown chat raises OSError", gone)
        tree = src.tree({}, A, pa)
        case("tree: main plus the sub-agent chat by its id; tree_for_path resolves the root id",
             tree == {"main": pa, C: pc} and src.tree_for_path(pa, None) == (A, tree))

        # --- scan
        rec = src.scan(pa)
        case("scan: id, project folder from workspaceStorage, start, model, folded sub-agent count",
             rec["id"] == A and rec["cwd"] == "/work/proj x" and rec["start"] == T0 and rec["model"] == "model-x" and rec["subs"] == 1 and rec["title0"] == "Fix login")
        rece = src.scan(pe)
        case("scan: no name falls back to the first user message; unknown project stays empty", rece["title0"] == "hello world question" and rece["cwd"] == "")

        # --- the page model
        data = src.parse(A, tree, "Fix login", 600, 4000)
        ag = {a["id"]: a for a in data["agents"]}
        main, sub = ag["main"], ag[C]
        case("agents: main and the sub-agent, linked by the task call", list(ag) == ["main", C] and sub["parent"] == "main" and main["children"] == [C] and sub["depth"] == 1)
        steps = [s for t in main["turns"] for s in t["steps"]]
        case("user messages open turns; separate thinking / text / tool messages merge into steps by response id",
             [t["trig"]["k"] for t in main["turns"]] == ["human", "human"] and [len(t["steps"]) for t in main["turns"]] == [5, 2] and [len(s["calls"]) for s in steps[:5]] == [2, 1, 1, 1, 0])
        s0, s1, s2, s3, s4 = steps[:5]
        case("step times: first message stamp, wait since the user message, thinking from thinkingDurationMs, end at the last call",
             s0["ts"] == T0 + 1000 and s0["gap"] == 1000 and s0["think"] == 1500 and s0["fin"] == T0 + 2900 and s0["end"] == T0 + 4900)
        case("thinking text and the reply before the calls become rsum and said", s0["rsum"] == "plan it" and s0["said"] == "Let me look" and s0["saidSrc"] == "same")
        case("a step without its own reply takes the previous one as said", s1["said"] == "Let me look" and s1["saidSrc"] == "prev" and s1["rsum"] == "retry")
        read, shell = s0["calls"]
        case("read call: category, summary with line range, result text, duration from completedAtMs",
             read["name"] == "read_file" and read["cat"] == "read" and read["sum"] == "a.py @1-20" and read["res"] == "print(1)" and read["dur"] == 300 and read["st"] == "ok")
        case("shell call: classified like a command, description kept, non-zero exit is a failed call",
             shell["cat"] == "test" and shell["sum"] == "pytest -q" and shell["desc"] == "run tests" and shell["st"] == "err" and shell["dur"] == 2000 and shell["res"] == "1 failed")
        bad = s1["calls"][0]
        case("error status: failed call with the model-visible message; unknown end = next message's stamp",
             bad["st"] == "err" and bad["cat"] == "write" and "no match" in bad["res"] and bad["dur"] == 2200 and '"old_string"' in bad["inp"])
        todo = s2["calls"][0]
        case("tool names outside the read / write / shell / agent sets fall into other", todo["cat"] == "other" and todo["sum"] == "更新待办（1 项）")
        task = s3["calls"][0]
        case("task call links the sub-agent chat, blocks the parent, hands the prompt to the briefing",
             task["agent"] == C and task["cat"] == "agent" and task["disp"]["block"] is True and task["disp"]["type"] == "explore" and task["dur"] == 9500 and not task.get("inp")
             and sub["briefing"] == "look around" and sub["type"] == "explore" and sub["desc"] == "explore · scan")
        case("sub-agent summary on the call", task.get("child", {}).get("steps") == 3)
        case("final reply: step without calls, turn ends at the user stamp + turnDurationMs",
             s4["says"] == "done" and s4["stop"] == "end_turn" and s4["end"] == T0 + 21000 and main["turns"][0]["end"] == T0 + 21000 and main["turns"][0]["endKind"] == "complete")
        t2 = main["turns"][1]["steps"]
        case("refused shell command and a cancelled edit are failed calls", t2[0]["calls"][0]["st"] == "err" and "拒绝" in t2[0]["calls"][0]["res"] and t2[1]["calls"][0]["st"] == "err")
        case("an aborted chat ends its last turn as aborted", main["turns"][1]["endKind"] == "abort")
        case("context snapshot becomes the last step's context size", t2[-1]["ctx"] == 5000 and s0["ctx"] == 0)
        case("model and effort come from modelConfig", main["model"] == "model-x" and main["effort"] == "medium" and s0["model"] == "model-x" and sub["model"] == "model-sub")
        ss = [s for t in sub["turns"] for s in t["steps"]]
        case("sub-agent: briefing turn; calls without ids merge when back to back, split after a model round trip",
             sub["turns"][0]["trig"]["k"] == "brief" and [len(s["calls"]) for s in ss] == [2, 1, 0] and ss[0]["think"] == 400 and ss[1]["gap"] == 1700)
        case("sub-agent report is its last reply without calls", sub["report"] == "found it" and sub["reportSrc"] == "lasttext" and sub["doneTs"] == ss[-1]["end"])

        # --- no tokens, no amounts
        tot = data["totals"]
        nst = sum(a["nsteps"] for a in data["agents"])
        case("every step is unpriced with zero tokens (no $0.00 amounts)",
             all(s["cost"] is None and not s["priced"] and not any(s["tok"].values()) for a in data["agents"] for t in a["turns"] for s in t["steps"]) and tot["nUnp"] == nst == 10)
        case("totals: nothing summed, the model is listed as unpriced", tot["cost"] == 0.0 and tot["unpModels"] == ["model-sub", "model-x"] and not any(tot["tok"].values()))
        pr = src.price_step("model-x", {"in": 5})
        case("price_step ignores any usage", pr["cost"] is None and pr["priced"] is False and not any(pr["tok"].values()))
        case("meta: tool, models, project, rows", data["meta"]["tool"] == "cursor" and data["meta"]["models"] == ["model-sub", "model-x"] and data["meta"]["project"] == "/work/proj x"
             and data["meta"]["rows"] == 19)

        # --- secrets
        blob = json.dumps(data, ensure_ascii=False) + json.dumps(rec) + json.dumps(rece)
        case("encryption keys, thinking signatures and ItemTable values never reach the result", not any(s in blob for s in SECRETS))

        # --- read-only, and only cursorDiskKV
        reads = set()

        def spy(path):
            con = orig_connect(path)

            def auth(action, a1, a2, dbn, src_):
                if action == sqlite3.SQLITE_READ:
                    reads.add(a1)
                return sqlite3.SQLITE_OK
            con.set_authorizer(auth)
            return con
        cursor_scan.connect = spy
        cursor_scan._SNAP.clear()
        cursor_scan.files(root)
        src.scan(pa)
        src.scan(pe)
        src.parse(A, tree, "x", 600, 4000)
        cursor_scan.connect = orig_connect
        case("only the table cursorDiskKV is read (ItemTable holds credentials)", reads == {"cursorDiskKV"})
        try:
            c = orig_connect(dbfile)
            c.execute("INSERT INTO cursorDiskKV VALUES ('x','y')")
            writable = True
        except sqlite3.Error:
            writable = False
        case("the connection refuses writes", not writable)
        sha1 = (sha(dbfile), sha(dbfile + "-wal"))
        case("reading (files, stat, scan, tree, parse) left the database and its -wal file byte-identical", sha0 == sha1)

        # --- list rows through the index; changes invalidate the cache
        empty = {s.id: os.path.join(tmp, "none-" + s.id) for s in sources.all() if s.id != "cursor"}
        config.configure(dict(empty, cursor=root), home=os.path.join(tmp, "home"))
        recs, st1 = index.build_index()
        rows = [r for r in index.list_sessions(recs) if r["tool"] == "cursor"]
        ra = next(r for r in rows if r["id"] == A)
        case("list: one row per listed chat, sub-agent folded in, project from the folder name",
             len(rows) == 2 and ra["subs"] == 1 and ra["name"] == "Fix login" and ra["project"] == "proj x" and ra["size"] == sa[0])
        _, st2 = index.build_index()
        case("second index pass rescans nothing", st1["scanned"] == 2 and st2["scanned"] == 0)
        db.bubble(C, "c7", 2, T0 + 40000, "one more")
        sa2 = cursor_scan.stat(pa)
        case("a new message in a sub-agent chat changes the parent's stat only", sa2[0] > sa[0] and sa2[1] == (T0 + 40000) / 1000.0 and cursor_scan.stat(pe) == se)
        _, st3 = index.build_index()
        case("index rescans only the changed chat", st3["scanned"] == 1)
        db.bubble(A, "a14", 2, T0 + 100, "late")
        sa3 = cursor_scan.stat(pa)
        case("a message with an old time still changes the size", sa3[0] > sa2[0] and sa3[1] == sa2[1])

        # --- a damaged row does not hide the others
        db.put("composerData:chat-bad", "not json {")
        db.put("bubbleId:chat-bad:x", "{broken")
        case("a damaged row is skipped and the other chats stay listed",
             sorted(cursor_scan.files(root)) == sorted([pa, pe]))
        db.put("composerData:chat-bad", "{}")
        case("a composer row without messages is not listed", sorted(cursor_scan.files(root)) == sorted([pa, pe]))
        case("default data directory names Cursor", "Cursor" in src.dir_default)
    finally:
        cursor_scan.connect = orig_connect
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
