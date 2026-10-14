#!/usr/bin/env python3
"""Tests of the Gemini CLI source (src/source_gemini.py, parse_gemini.py, gemini_scan.py) on small synthetic sessions that
are generated in a temporary directory (no real session content).

Covers merging of records written twice, the shapes of user content, $set / $rewindTo patches, the main session with its
sub-agent session, the session_context record, which sessions the list shows, the legacy .json format, failed tool calls,
token pricing (cache, thoughts, long prompts, dated rates) and unpriced models.
Run directly, or import run() from scripts/check.py; run() returns (cases, failures).
"""
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import config  # noqa: E402
import index  # noqa: E402
import sources  # noqa: E402

MAIN, SUB, A2A, OLD = "aaaa1111-0000-4000-8000-000000000001", "bbbb2222-0000-4000-8000-000000000002", \
    "cccc3333-0000-4000-8000-000000000003", "dddd4444-0000-4000-8000-000000000004"
PHASH = "0" * 64
EPS = 1e-9


def ts(sec, ms=0):
    return "2026-10-14T02:%02d:%02d.%03dZ" % (sec // 60, sec % 60, ms)


def user(i, sec, content):
    return {"id": i, "timestamp": ts(sec), "type": "user", "content": content}


def gem(i, sec, text="", tokens=None, model="gemini-3-flash-preview", calls=None, thoughts=None):
    m = {"id": i, "timestamp": ts(sec), "type": "gemini", "content": text, "model": model}
    if tokens is not None:
        m["tokens"] = dict({"input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0}, **tokens)
    if thoughts:
        m["thoughts"] = [{"subject": s, "description": d, "timestamp": ts(sec)} for s, d in thoughts]
    if calls:
        m["toolCalls"] = calls
    return m


def tool(name, args, sec, ms=0, status="success", output="ok", **extra):
    return dict({"id": "%s-%d" % (name, sec), "name": name, "args": args, "status": status, "timestamp": ts(sec, ms),
                 "result": [{"functionResponse": {"id": "r", "name": name, "response": {"output": output}}}]}, **extra)


def write_jsonl(path, meta, records):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in [meta] + records:
            f.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")


def meta_rec(sid, kind="main"):
    return {"sessionId": sid, "projectHash": PHASH, "startTime": ts(0), "lastUpdated": ts(0), "kind": kind}


def build_data(root):
    """A data directory with: a main session + sub-agent, an a2a-style user-only session, a legacy .json session."""
    chats = os.path.join(root, "tmp", "demo", "chats")
    write_jsonl(os.path.join(chats, "session-2026-10-14T02-00-aaaa1111.jsonl"), meta_rec(MAIN), [
        user("c0", 0, [{"text": "<session_context>\nThis is the Gemini CLI.\n</session_context>"}]),
        {"$set": {"lastUpdated": ts(1)}},
        user("u1", 10, [{"text": "list the desktop"}]),
        gem("g1", 14, "I will delegate.", {"input": 1000, "output": 40, "cached": 400, "thoughts": 60, "total": 1100},
            thoughts=[("Planning", "Decide to delegate")]),
        # the same message is written a second time, now with its tool calls; tokens are identical
        gem("g1", 14, "I will delegate.", {"input": 1000, "output": 40, "cached": 400, "thoughts": 60, "total": 1100},
            thoughts=[("Planning", "Decide to delegate")], calls=[
                tool("invoke_agent", {"agent_name": "generalist", "prompt": "List the files.\n选档理由：simple lookup"}, 30, 500,
                     agentId=SUB, resultDisplay={"result": json.dumps({"response": "three files"}), "state": "completed"},
                     output="Subagent 'generalist' finished.\nResult:\n{}"),
                tool("run_shell_command", {"command": "false", "description": "fail on purpose"}, 18, 0,
                     output="Output: x\nExit Code: 1\n")]),
        user("fr", 31, [{"functionResponse": {"id": "r", "name": "invoke_agent", "response": {"output": "x"}}}]),
        {"$set": {"lastUpdated": ts(31)}},
        gem("g2", 36, "Done: three files.", {"input": 1500, "output": 20, "cached": 0, "thoughts": 0, "total": 1520}),
        user("u2", 50, "second question as a plain string"),
        gem("g3", 52, "", {"input": 2000, "output": 10, "cached": 0, "thoughts": 0, "total": 2010}, calls=[
            tool("read_file", {"file_path": "/nope"}, 53, 0, status="error", output="no such file")]),
        {"id": "i1", "timestamp": ts(55), "type": "info", "content": "Request cancelled."},
    ])
    write_jsonl(os.path.join(chats, MAIN, SUB + ".jsonl"), dict(meta_rec(SUB, "subagent"), directories=["/work/demo"]), [
        user("s0", 20, [{"text": "List the files.\n选档理由：simple lookup"}]),
        gem("s1", 24, "", {"input": 3000, "output": 30, "cached": 1000, "thoughts": 10, "total": 3040},
            calls=[tool("run_shell_command", {"command": "ls", "description": "list"}, 25)]),
        gem("s2", 28, "three files", {"input": 3100, "output": 5, "cached": 0, "thoughts": 0, "total": 3105}, calls=[
            tool("complete_task", {"result": "three files"}, 28, 100, output="submitted")]),
        {"$set": {"summary": json.dumps({"response": "summary text"})}},
    ])
    # a2a-server style: only user messages, written through $set.messages
    write_jsonl(os.path.join(chats, "session-2026-10-14T02-05-a2a-serv.jsonl"), meta_rec(A2A), [
        {"$set": {"messages": [user("a1", 1, [{"text": "ping"}]), user("a2", 2, [{"text": "ping again"}])]}},
    ])
    with open(os.path.join(root, "tmp", "demo", ".project_root"), "w", encoding="utf-8") as f:
        f.write("/work/demo")
    # legacy single-document format in another project directory (project from projects.json)
    old = {"sessionId": OLD, "projectHash": PHASH, "startTime": ts(0), "lastUpdated": ts(40), "messages": [
        user("o1", 1, "legacy question"),
        gem("o2", 5, "reading", {"input": 500, "output": 5, "cached": 100, "thoughts": 0, "total": 505},
            calls=[tool("read_file", {"file_path": "/x"}, 6, 0, status="error", output="denied")]),
        gem("o3", 9, "answer", {"input": 600, "output": 5, "cached": 0, "thoughts": 0, "total": 605}),
    ]}
    os.makedirs(os.path.join(root, "tmp", "legacy", "chats"), exist_ok=True)
    with open(os.path.join(root, "tmp", "legacy", "chats", "session-2026-02-27T10-43-dddd4444.json"), "w", encoding="utf-8") as f:
        json.dump(old, f)
    with open(os.path.join(root, "projects.json"), "w", encoding="utf-8") as f:
        json.dump({"projects": {"/work/legacy": "legacy"}}, f)
    return chats


def agent(data, aid):
    return next(a for a in data["agents"] if a["id"] == aid)


def steps(a):
    return [s for t in a["turns"] for s in t["steps"]]


def near(a, b):
    return a is not None and abs(a - b) < EPS


def cases():
    import source_gemini as sg
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    tmp = tempfile.mkdtemp(prefix="agent-replay-gemini-")
    saved = dict(config.DIRS), config.HOME_DIR
    try:
        root = os.path.join(tmp, "gemini")
        chats = build_data(root)
        empty = {s.id: os.path.join(tmp, "none-" + s.id) for s in sources.all() if s.id != "gemini"}
        config.configure(dict(empty, gemini=root), home=os.path.join(tmp, "home"))
        src = sources.get("gemini")
        now = time.time()
        for f in ("session-2026-10-14T02-05-a2a-serv.jsonl",):  # a user-only session that has been idle for a day
            os.utime(os.path.join(chats, f), (now - 86400, now - 86400))
        recs, _ = index.build_index()
        rows = {r["id"]: r for r in index.list_sessions(recs) if r["tool"] == "gemini"}

        # ---- list rows
        case("main session is listed with its sub-agent folded in", MAIN in rows and rows[MAIN]["subs"] == 1 and SUB not in rows)
        case("title is the first real user message, not the injected session_context", rows[MAIN]["name"] == "list the desktop")
        case("project comes from .project_root", rows[MAIN]["cwd"] == "/work/demo" and rows[MAIN]["project"] == "demo")
        case("project of a legacy file comes from projects.json by directory name", rows[OLD]["cwd"] == "/work/legacy")
        case("a session without any model reply that is not in progress is not listed", A2A not in rows)
        p = os.path.join(chats, "session-2026-10-14T02-05-a2a-serv.jsonl")
        os.utime(p, (now, now))
        recs2, _ = index.build_index()
        fresh = {r["id"] for r in index.list_sessions(recs2) if r["tool"] == "gemini"}
        case("the same session is listed while it is in progress", A2A in fresh)
        case("sub-agent file belongs to the main session's tree",
             list(src.tree(recs2, MAIN, rows[MAIN]["path"])) == [MAIN, SUB])

        # ---- parse main + sub-agent
        tree = src.tree(recs2, MAIN, rows[MAIN]["path"])
        d = src.parse(MAIN, tree, "", 600, 4000)
        main, sub = agent(d, "main"), agent(d, SUB)
        case("a message written twice is one step", [s["n"] for s in steps(main)] == [0, 1, 2] and len(steps(main)) == 3)
        t = d["totals"]
        # input 1000+1500+2000 (main) + 3000+3100 (sub); cached 400 + 1000; output 40+20+10 + 30+5 plus thoughts 60 + 10
        case("tokens are counted once per message", t["tok"]["cr"] == 1400 and t["tok"]["in"] == 10600 - 1400 and t["tok"]["out"] == 105 + 70 and t["tok"]["rsn"] == 70)
        case("session_context is folded into the first turn, not a turn of its own",
             len(main["turns"]) == 2 and main["turns"][0]["trig"]["k"] == "human" and main["turns"][0]["evs"][0]["k"] == "meta")
        case("user content as a list of text parts and as a plain string both open turns",
             main["turns"][0]["trig"]["text"] == "list the desktop" and main["turns"][1]["trig"]["text"] == "second question as a plain string")
        case("a user record whose parts have no text (tool result) opens no turn and adds no event", all(e["k"] != "human" for t in main["turns"] for e in t["evs"]))
        case("info record becomes an inline event of the last turn", any(e["k"] == "info" for e in main["turns"][1]["evs"]))
        inv = next(c for s in steps(main) for c in s["calls"] if c["name"] == "invoke_agent")
        case("invoke_agent links to the sub-agent session by agentId", inv.get("agent") == SUB and sub["parent"] == "main" and main["children"] == [SUB])
        case("dispatch is a blocking call whose duration is the child's run", inv["disp"]["block"] and inv["dur"] == 16500)
        case("briefing is the dispatch prompt and the reason line is picked up",
             sub["briefing"].startswith("List the files") and sub["reason"] == "选档理由：simple lookup")
        case("sub-agent report is the invoke_agent result", sub["report"] == "three files")
        case("tool call duration is its own stamp minus the issuing message's stamp",
             next(c for s in steps(main) for c in s["calls"] if c["name"] == "run_shell_command")["dur"] == 4000)
        case("model wait of a step is the stamp minus the previous record's", steps(main)[0]["gap"] == 4000)
        case("thoughts become the reasoning summary", "Planning" in steps(main)[0]["rsum"] and steps(main)[0]["said"] == "I will delegate.")
        calls = {c["name"]: c for s in steps(main) for c in s["calls"]}
        case("a shell command with a non-zero exit code is a failure", calls["run_shell_command"]["st"] == "err")
        case("a tool call with status error is a failure", calls["read_file"]["st"] == "err" and calls["invoke_agent"]["st"] == "ok")
        case("sub-agent file: first user record is the briefing, call steps are priced",
             sub["turns"][0]["trig"]["k"] == "brief" and sub["nsteps"] == 2 and sub["cost"] > 0)

        # ---- legacy format
        rec_old = next(r for r in recs2.values() if r["id"] == OLD)
        od = src.parse(OLD, src.tree(recs2, OLD, rec_old["path"]), "", 600, 4000)
        oa = agent(od, "main")
        case("legacy .json session parses (2 steps) with its failed tool call", oa["nsteps"] == 2 and steps(oa)[0]["calls"][0]["st"] == "err")

        # ---- patches
        pd = os.path.join(chats, "session-patch.jsonl")
        write_jsonl(pd, meta_rec("eeee5555-0000-4000-8000-000000000005"), [
            user("p1", 1, "keep"), gem("p2", 3, "answer one", {"input": 10, "output": 1, "total": 11}),
            user("p3", 5, "rewound away"), gem("p4", 7, "answer two", {"input": 10, "output": 1, "total": 11}),
            {"$rewindTo": "p3"}, {"$set": {"summary": "s"}},
        ])
        import gemini_scan
        sess = gemini_scan.read_session(pd)
        case("$rewindTo drops that message and everything after it", [m["id"] for m in sess["msgs"]] == ["p1", "p2"] and sess["meta"]["summary"] == "s")
        write_jsonl(pd, meta_rec("eeee5555-0000-4000-8000-000000000005"), [user("p1", 1, "old"), {"$set": {"messages": [user("n1", 2, "new")]}}])
        case("$set.messages replaces the message list", [m["id"] for m in gemini_scan.read_session(pd)["msgs"]] == ["n1"])

        # ---- pricing
        r = sg.price_step("gemini-3-flash-preview", {"input": 1000, "cached": 400, "output": 100, "thoughts": 50, "tool": 0})
        case("cached tokens are priced at the cache rate, thoughts at the output rate",
             near(r["cost"], (600 * 0.5 + 400 * 0.05 + 150 * 3) / 1e6) and r["tok"]["in"] == 600 and r["tok"]["cr"] == 400 and r["tok"]["out"] == 150)
        r = sg.price_step("gemini-2.5-pro", {"input": 250000, "cached": 0, "output": 1000})
        case("a prompt above 200k tokens uses the long-prompt rates", near(r["cost"], (250000 * 2.5 + 1000 * 15) / 1e6))
        a, b = (sg.price_step("gemini-3.8-flash", {"input": 1000000, "day": day})["cost"] for day in ("2026-12-31", "2027-01-01"))
        case("a dated rate change applies from its date", near(a, 0.75) and near(b, 1.5))
        r = sg.price_step("gemini-9-unknown", {"input": 1000, "cached": 100, "output": 10})
        case("an unknown model has no amount but its tokens are counted", r["cost"] is None and not r["priced"] and r["tok"]["in"] == 900)
        u = os.path.join(chats, "session-unpriced.jsonl")
        write_jsonl(u, meta_rec("ffff6666-0000-4000-8000-000000000006"), [
            user("q1", 1, "hi"), gem("q2", 3, "hello", {"input": 100, "output": 5, "total": 105}, model="gemini-9-unknown")])
        ud = src.parse("ffff6666-0000-4000-8000-000000000006", {"ffff6666-0000-4000-8000-000000000006": u}, "", 600, 4000)
        case("unpriced steps are reported in the totals", ud["totals"]["nUnp"] == 1 and ud["totals"]["unpModels"] == ["gemini-9-unknown"] and ud["totals"]["tok"]["in"] == 100)
        case("page pricing notes carry the Gemini read date and source", d["meta"]["pricing"]["source"].startswith("https://ai.google.dev/") and d["meta"]["pricing"]["readDate"])
    finally:
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
