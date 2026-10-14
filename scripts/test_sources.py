#!/usr/bin/env python3
"""Extensibility test of the source registry (src/sources.py): a fake source registered only here shows up in the data
directory options, the index and session list, CLI resolution, file detection and the server routes (session page,
render job, live API) without any change to the dispatching modules.

Runs an in-process server on a free 127.0.0.1 port with all data under a temporary directory; the fake source is
unregistered and the configuration restored before returning. Run directly, or import run() from scripts/check.py;
run() returns (cases, failures).
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import config  # noqa: E402
import index  # noqa: E402
import prices  # noqa: E402
import sessions  # noqa: E402
import sources  # noqa: E402
from scan_util import make_row  # noqa: E402

SID = "fk01-0000-test"


class FakeLive:
    def __init__(self, lv):
        self.lv = lv

    def build(self, now):
        from live import AgentState
        self.lv.agents["main"] = AgentState("main", "主代理")

    def discover(self, now):
        pass


class FakeSource(sources.Source):
    """Session files <root>/*.fake.jsonl whose first row is {"fake": {"id": ..., "cwd": ...}}."""
    id = "fake"
    label = "Fake Agent"
    color = "#123456"
    dir_flag = "--fake-dir"
    dir_envs = ("AGENT_REPLAY_FAKE_DIR",)
    dir_default = os.path.join("~", ".fake-agent-does-not-exist")
    dir_help = "fake source data root"
    ctx_limit_key = "ctxLimitFake"

    def files(self):
        root = self.root
        return [os.path.join(root, f) for f in sorted(os.listdir(root)) if f.endswith(".fake.jsonl")] if os.path.isdir(root) else []

    def sniff(self, head):
        return head.startswith(b'{"fake":')

    def scan(self, path):
        with open(path, encoding="utf-8") as f:
            head = json.loads(f.readline())["fake"]
        return {"tool": self.id, "path": path, "id": head["id"], "parent": None, "archived": False, "cwd": head["cwd"],
                "start": 1_000, "end": 2_000, "model": "fake-model", "title0": "fake title"}

    def rows(self, recs, now_ms):
        return [make_row(r, r["title0"], 0, 0, r["mtime"], now_ms) for r in recs]

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        meta = {"tool": self.id, "pricing": prices.meta(self.id), "sid": root_id, "name": name or root_id[:8], "start": 1_000,
                "end": 2_000, "outChars": out_chars, "inpChars": inp_chars, "project": "", "rows": 1}
        return {"meta": meta, "agents": [{"id": "main", "turns": [], "nsteps": 0}],
                "totals": {"cost": 0.0, "tok": prices.zero_tok(), "nUnp": 0, "mainSteps": 0}}

    def live(self, lv):
        return FakeLive(lv)

    def price_step(self, model, usage):
        return prices.result(None, prices.zero_tok(), False)


def _get(port, path):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path))
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def cases():
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    tmp = tempfile.mkdtemp(prefix="agent-replay-sources-")
    fake_root = os.path.join(tmp, "fake")
    os.makedirs(fake_root)
    path = os.path.join(fake_root, "one.fake.jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps({"fake": {"id": SID, "cwd": "/work/fakeproj"}}) + "\n")
    saved = dict(config.DIRS), config.HOME_DIR
    src = sources.register(FakeSource())
    httpd = None
    try:
        # data directory option: generated from the source's declaration, resolved by config
        ap = argparse.ArgumentParser()
        config.add_args(ap)
        args = ap.parse_args(["--fake-dir", fake_root, "--claude-dir", os.path.join(tmp, "none-c"), "--codex-dir", os.path.join(tmp, "none-x")])
        config.apply_args(args)
        config.configure(dict(config.DIRS), home=os.path.join(tmp, "home"))
        case("--fake-dir sets the fake source's data root", config.source_dir("fake") == fake_root)

        recs, _ = index.build_index()
        rows = index.list_sessions(recs)
        case("fake session appears in the session list", [r["key"] for r in rows] == ["fake:" + SID])
        case("CLI resolves an id prefix of the fake source", sessions.resolve("fk01")[:3] == ("fake", path, SID))
        case("file detection picks the fake source by its first bytes", sources.detect(path) == "fake")
        case("route pattern contains the fake source", "fake" in sources.route_pattern().split("|"))

        import server
        server.Handler.app = server.App()
        httpd = server.Server(("127.0.0.1", 0), server.Handler)
        port = httpd.server_address[1]
        server.Handler.allowed_hosts = {"127.0.0.1:%d" % port}
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        st, body = _get(port, "/api/sessions")
        case("GET /api/sessions lists the fake session", st == 200 and [r["tool"] for r in json.loads(body)["rows"]] == ["fake"])
        st, body = _get(port, "/s/fake/" + SID)
        case("GET /s/fake/<id> serves the loading page with the source label", st == 200 and "Fake Agent" in body)
        _get(port, "/api/open/fake/" + SID)
        state, end = "", time.time() + 20
        while time.time() < end and state not in ("done", "error"):
            time.sleep(0.1)
            state = json.loads(_get(port, "/api/job/fake/" + SID)[1]).get("state")
        st, body = _get(port, "/r/fake/" + SID)
        case("render job of the fake session finishes and /r/fake/<id> serves the page (state %s)" % state,
             state == "done" and st == 200 and '"tool":"fake"' in body)
        st, body = _get(port, "/api/live/fake/" + SID)
        case("GET /api/live/fake/<id> answers through the fake live feed", st == 200 and json.loads(body).get("tool") == "fake")
        st, _ = _get(port, "/s/nosuchsource/" + SID)
        case("an unregistered source segment is not routed", st == 404)
    finally:
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        sources.unregister(src.id)
        config.configure({k: v for k, v in saved[0].items() if k != "fake"}, home=saved[1])
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
