#!/usr/bin/env python3
"""Project checks: compile every .py, syntax-check every .js (when node exists) and smoke-test the demo data and server.

Usage: python3 scripts/check.py
Uses only the standard library. The server runs as a subprocess on a free port with a hard time limit and is always
stopped (and its temporary data removed) before this script exits.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
# (sub-agents, total steps) of the finished demo sessions; the demo data is deterministic apart from its timestamps.
EXPECT = {"claude": (6, 76), "codex": (3, 24)}
READY_TIMEOUT, LIVE_TIMEOUT = 40, 25
failures = []


def report(ok, what):
    print("[%s] %s" % ("ok" if ok else "FAIL", what), flush=True)
    if not ok:
        failures.append(what)


def files(root, ext):
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git", "replays", "node_modules")]
        for n in sorted(names):
            if n.endswith(ext):
                yield os.path.join(base, n)


def check_python():
    n = 0
    for p in files(ROOT, ".py"):
        try:
            with open(p, encoding="utf-8") as f:
                compile(f.read(), p, "exec")
            n += 1
        except SyntaxError as e:
            report(False, "compile %s: %s" % (os.path.relpath(p, ROOT), e))
    report(True, "compiled %d Python files (Python %s)" % (n, sys.version.split()[0]))


def check_js():
    node = shutil.which("node")
    if not node:
        print("[skip] node not found, JavaScript syntax not checked", flush=True)
        return
    bad = n = 0
    for p in files(SRC, ".js"):
        n += 1
        r = subprocess.run([node, "--check", p], capture_output=True, text=True, timeout=60)
        if r.returncode:
            bad += 1
            report(False, "node --check %s: %s" % (os.path.relpath(p, ROOT), r.stderr.strip().splitlines()[-1] if r.stderr.strip() else "error"))
    if not bad:
        report(True, "node --check passed for %d JavaScript files" % n)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def get_json(port, path):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=20) as r:
        return r.status, json.loads(r.read().decode("utf-8"))


def check_render(tmp):
    """Generate the demo data and render the two finished sessions with the real parsers."""
    sys.path.insert(0, SRC)
    import config
    import demo
    import index
    from render import build_html
    config.configure(home=tmp)
    info = demo.generate(os.path.join(tmp, "demo"))
    config.configure(info["claude_dir"], info["codex_dir"], home=info["base"])
    recs, _ = index.build_index()
    rows = index.list_sessions(recs)
    report(len(rows) == 3, "demo index lists 3 sessions (got %d)" % len(rows))
    for tool in ("claude", "codex"):
        row = next(r for r in rows if r["tool"] == tool and r["status"] != "active")
        tree = index.codex_tree(recs, row["id"]) if tool == "codex" else None
        _, i = build_html(row["path"], row["name"], tool=tool, root_id=row["id"], tree=tree)
        got = (i["agents"], i["steps"])
        report(got == EXPECT[tool], "%s demo session: %d sub-agents, %d steps (expected %d, %d)" % ((tool,) + got + EXPECT[tool]))


def check_server(tmp):
    port = free_port()
    env = dict(os.environ, AGENT_REPLAY_HOME=tmp)
    log = open(os.path.join(tmp, "server.log"), "w")
    proc = subprocess.Popen([sys.executable, os.path.join(SRC, "cli.py"), "demo", "--no-open", "--port", str(port)], stdout=log, stderr=log, env=env)
    try:
        deadline = time.time() + READY_TIMEOUT
        rows = None
        while time.time() < deadline and proc.poll() is None:
            try:
                status, d = get_json(port, "/api/sessions")
                rows = d["rows"]
                break
            except Exception:
                time.sleep(0.5)
        if rows is None:
            return report(False, "demo server did not answer within %ds (see %s)" % (READY_TIMEOUT, os.path.join(tmp, "server.log")))
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=20) as r:
            report(r.status == 200, "GET / returns 200")
        report(status == 200 and len(rows) == 3, "GET /api/sessions returns 200 with 3 demo sessions (got %d)" % len(rows))
        live = [r for r in rows if r["status"] == "active"]
        if len(live) != 1:
            return report(False, "exactly one in-progress demo session expected (got %d)" % len(live))
        path = "/api/live/%s/%s" % (live[0]["tool"], live[0]["id"])

        def steps():
            return sum(c["steps"] for c in get_json(port, path)[1]["cards"])
        first, now_steps, end = steps(), 0, time.time() + LIVE_TIMEOUT
        while time.time() < end:
            time.sleep(1.5)
            now_steps = steps()
            if now_steps > first:
                break
        report(now_steps > first, "live session keeps growing (%d -> %d steps)" % (first, now_steps))
        cards = get_json(port, path)[1]["cards"]
        report(any(a["k"] == "longcmd" for c in cards for a in c["alerts"]), "live page raises the long-command alert")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(10)
        log.close()


def main():
    check_python()
    check_js()
    tmp = tempfile.mkdtemp(prefix="agent-replay-check-")
    try:
        check_render(tmp)
        check_server(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("FAILED: %d check(s)" % len(failures) if failures else "All checks passed", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
