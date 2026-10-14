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
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
# (sub-agents, total steps) of the finished demo sessions; the demo data is deterministic apart from its timestamps.
EXPECT = {"claude": (6, 76), "codex": (3, 24)}
READY_TIMEOUT, LIVE_TIMEOUT = 40, 25
SIG_WAIT = 1.2  # slightly more than the server's signature-cache window
failures = []
PAGES = []  # generated demo pages, rendered by check_pages() once the live snapshot is available


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
    # Unit test for the shared time segmentation (timeseg.js); it needs node, like the syntax check.
    t = os.path.join(ROOT, "scripts", "test_timeseg.mjs")
    if os.path.exists(t):
        r = subprocess.run([node, t], capture_output=True, text=True, timeout=120)
        tail = (r.stdout + r.stderr).strip().splitlines()
        report(r.returncode == 0, "timeseg unit test: %s" % (tail[-1] if tail else ("passed" if r.returncode == 0 else "failed")))
    t = os.path.join(ROOT, "scripts", "test_term.mjs")  # terminal view text model (term_format.js)
    if os.path.exists(t):
        r = subprocess.run([node, t], capture_output=True, text=True, timeout=120)
        tail = (r.stdout + r.stderr).strip().splitlines()
        report(r.returncode == 0, "terminal text unit test: %s" % (tail[-1] if tail else ("passed" if r.returncode == 0 else "failed")))
    t = os.path.join(ROOT, "scripts", "test_analysis.mjs")  # critical path and waste detectors (analysis_*.js)
    if os.path.exists(t):
        r = subprocess.run([node, t], capture_output=True, text=True, timeout=120)
        tail = (r.stdout + r.stderr).strip().splitlines()
        report(r.returncode == 0, "analysis unit test: %s" % (tail[-1] if tail else ("passed" if r.returncode == 0 else "failed")))
    t = os.path.join(ROOT, "scripts", "test_modal.mjs")  # detail dialog model (modal_model.js)
    if os.path.exists(t):
        r = subprocess.run([node, t], capture_output=True, text=True, timeout=120)
        tail = (r.stdout + r.stderr).strip().splitlines()
        report(r.returncode == 0, "detail dialog unit test: %s" % (tail[-1] if tail else ("passed" if r.returncode == 0 else "failed")))
    t = os.path.join(ROOT, "scripts", "test_route.mjs")  # fork-route map model, layout and live merging (route_*.js)
    if os.path.exists(t):
        r = subprocess.run([node, t], capture_output=True, text=True, timeout=180)
        tail = (r.stdout + r.stderr).strip().splitlines()
        report(r.returncode == 0, "route map unit test: %s" % (tail[-1] if tail else ("passed" if r.returncode == 0 else "failed")))


def write_page(tmp, name, html):
    os.makedirs(os.path.join(tmp, "pages"), exist_ok=True)
    path = os.path.join(tmp, "pages", name + ".html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(html)
    return path


def check_pages(pages, snapshot=None):
    """Render every view of the generated pages against a stub DOM (no browser): no exceptions, no undefined / NaN in the markup.
    snapshot: a real /api/live answer to paint the live tab from."""
    node = shutil.which("node")
    if not node:
        print("[skip] node not found, page views not rendered", flush=True)
        return
    env = dict(os.environ, SNAPSHOT=snapshot) if snapshot else None
    r = subprocess.run([node, os.path.join(ROOT, "scripts", "test_pages.mjs")] + pages, capture_output=True, text=True, timeout=180, env=env)
    out = (r.stdout + r.stderr).strip().splitlines()
    for line in out[:-1]:
        print("    " + line, flush=True)
    report(r.returncode == 0, "page views render without errors: %s" % (out[-1] if out else "no output"))


def check_prices():
    """Pure-Python pricing unit tests (scripts/test_prices.py)."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import test_prices
    cases, bad = test_prices.run()
    for name in bad:
        report(False, "pricing: " + name)
    if not bad:
        report(True, "pricing unit tests passed (%d cases)" % len(cases))


def check_sources():
    """Source registry extensibility test with a fake source (scripts/test_sources.py)."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    import test_sources
    cases, bad = test_sources.run()
    for name in bad:
        report(False, "sources: " + name)
    if not bad:
        report(True, "source registry tests passed (%d cases)" % len(cases))


def raw_claude_messages(path):
    """[(model, usage)] of the main transcript in order of first appearance, one entry per message id (the row with the most output)."""
    order, best = [], {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r.get("type") != "assistant":
                continue
            m = r["message"]
            mid = m.get("id")
            if mid not in best:
                order.append(mid)
            u = m.get("usage") or {}
            if mid not in best or u.get("output_tokens", 0) >= best[mid][1].get("output_tokens", -1):
                best[mid] = (m.get("model"), u)
    return [best[i] for i in order]


def raw_codex_usage(path):
    """[(model, last_token_usage)] of the root rollout, one entry per model response (repeated token_count rows are skipped)."""
    out, model, prev = [], "", None
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            p = r.get("payload") or {}
            if r.get("type") == "turn_context":
                model = p.get("model") or model
            elif p.get("type") == "token_count" and p.get("info"):
                tot = (p["info"].get("total_token_usage") or {}).get("total_tokens")
                if tot != prev:
                    prev = tot
                    out.append((model, p["info"]["last_token_usage"]))
    return out


# Hand-entered list prices (USD per million tokens) of the demo models, from the official table in src/prices.json.
CLAUDE_RATES = {"claude-opus-5-5": (4, 5, 8, 0.20, 20), "claude-sonnet-5-5": (2, 2.5, 4, 0.10, 10)}  # in, cache write 5m, 1h, read, out
CODEX_RATES = {"gpt-6-sol": (2, 0.20, 2.5, 10), "gpt-6-luna": (0.10, 0.01, 0.125, 0.50)}  # in, cached, cache write, out


def check_amounts(tool, row, tree, data):
    """Totals are positive and one demo step equals a hand calculation from the raw transcript's token counts."""
    t = data["totals"]
    report(t["cost"] > 0 and t["nUnp"] == 0, "%s demo session has an estimated amount > 0 (%.4f USD, %d unpriced steps)" % (tool, t["cost"], t["nUnp"]))
    steps = [s for a in data["agents"][:1] for tn in a["turns"] for s in tn["steps"]]
    if tool == "claude":
        raw = raw_claude_messages(row["path"])
        n = next((i for i, (m, _) in enumerate(raw) if m in CLAUDE_RATES), None)
        model, u = raw[n]
        r = CLAUDE_RATES[model]
        cc = u["cache_creation"]
        want = (u["input_tokens"] * r[0] + cc["ephemeral_5m_input_tokens"] * r[1] + cc["ephemeral_1h_input_tokens"] * r[2] +
                u["cache_read_input_tokens"] * r[3] + u["output_tokens"] * r[4]) / 1e6
    else:
        raw = raw_codex_usage(row["path"])
        n = next((i for i, (m, _) in enumerate(raw) if m in CODEX_RATES), None)
        model, u = raw[n]
        r = CODEX_RATES[model]
        unc = u["input_tokens"] - u["cached_input_tokens"] - u.get("cache_write_input_tokens", 0)
        want = (unc * r[0] + u["cached_input_tokens"] * r[1] + u.get("cache_write_input_tokens", 0) * r[2] + u["output_tokens"] * r[3]) / 1e6
    got = steps[n]["cost"]
    report(got is not None and abs(got - want) < 1e-6, "%s step %d (%s) costs %.8f USD, hand calculation %.8f" % (tool, n, model, got or -1, want))
    # the aggregates add up from the steps
    all_steps = [s for a in data["agents"] for tn in a["turns"] for s in tn["steps"]]
    report(abs(sum(s["cost"] or 0 for s in all_steps) - t["cost"]) < 1e-9, "%s session total equals the sum of its steps" % tool)


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
    from render import build_html, load_data
    config.configure(home=tmp)
    info = demo.generate(os.path.join(tmp, "demo"))
    config.configure({"claude": info["claude_dir"], "codex": info["codex_dir"]}, home=info["base"])
    recs, _ = index.build_index()
    rows = index.list_sessions(recs)
    report(len(rows) == 3, "demo index lists 3 sessions (got %d)" % len(rows))
    pages = []
    for tool in ("claude", "codex"):
        row = next(r for r in rows if r["tool"] == tool and r["status"] != "active")
        tree = index.session_tree(recs, row)
        html, i = build_html(row["path"], row["name"], tool=tool, root_id=row["id"], tree=tree)
        pages.append(write_page(tmp, tool, html))
        got = (i["agents"], i["steps"])
        report(got == EXPECT[tool], "%s demo session: %d sub-agents, %d steps (expected %d, %d)" % ((tool,) + got + EXPECT[tool]))
        check_amounts(tool, row, tree, load_data(tool, row["path"], row["name"], 600, 4000, root_id=row["id"], tree=tree))
    live = next(r for r in rows if r["status"] == "active")
    pages.append(write_page(tmp, "live", build_html(live["path"], live["name"], tool=live["tool"], root_id=live["id"], active=True)[0]))
    PAGES.extend(pages)


STEP_FIELDS = ("n", "ts", "end", "fam", "model", "cost", "tok", "ctx", "gap", "said", "cause", "calls")
CALL_FIELDS = ("name", "cat", "ts", "dur", "st", "bg", "sum", "res", "rlen")
STAT_FIELDS = ("nsteps", "start", "end", "cost", "tok", "stats")


def fetch_steps(port, row, after, agent="main", wait=10):
    """/api/steps answer; the first request of a session may answer 'warming' while the server parses it in the background."""
    url = "/api/steps/%s/%s?agent=%s&after=%d" % (row["tool"], row["id"], agent, after)
    end, d = time.time() + wait, {}
    while time.time() < end:
        d = get_json(port, url)[1]
        if not d.get("warming"):
            break
        time.sleep(0.4)
    return d


def check_steps_api(port, live_row):
    """Live step feed of the in-progress demo session: structure of the steps, the second request continuing from the first,
    growth over time, and a fast answer when nothing needs parsing."""
    first = fetch_steps(port, live_row, 0)
    steps = first.get("steps") or []
    report(first.get("ok") and steps and first.get("total") == len(steps) and len(first.get("ti", [])) == len(steps),
           "/api/steps returns the whole step list for after=0 (%d steps)" % len(steps))
    miss = [k for s in steps for k in STEP_FIELDS if k not in s] + [k for s in steps for c in s["calls"] for k in CALL_FIELDS if k not in c]
    miss += [k for k in STAT_FIELDS if k not in first.get("stats", {})] + [k for k in ("state", "sinceWrite", "ended", "totals") if k not in first]
    report(not miss, "/api/steps steps, calls and statistics carry the page's fields (missing: %s)" % (sorted(set(miss)) or "none"))
    second = fetch_steps(port, live_row, first["total"])
    report(second.get("ok") and len(second.get("steps", [])) >= 0 and second["total"] >= first["total"] and not second.get("reset"),
           "/api/steps with after=<previous total> continues from it (%d new steps)" % len(second.get("steps", [])))
    t0 = time.time()
    get_json(port, "/api/steps/%s/%s?agent=main&after=%d" % (live_row["tool"], live_row["id"], second["total"]))
    ms = (time.time() - t0) * 1000
    report(ms < 50 or second.get("took", 0) < 50, "/api/steps answers without re-parsing in under 50 ms (%.0f ms)" % ms)
    total, grew, end = second["total"], False, time.time() + LIVE_TIMEOUT
    new_steps = []
    while time.time() < end and not grew:
        time.sleep(1.5)
        d = fetch_steps(port, live_row, total)
        if d.get("total", 0) > total:
            grew, new_steps = True, d["steps"]
    report(grew and all(k in new_steps[0] for k in STEP_FIELDS), "/api/steps shows new steps as the live session grows (%d -> %d)" % (total, total + len(new_steps)))


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
            d = get_json(port, path)[1]  # returned sub-agents count too, so a hand-back never makes the total drop
            return sum(c["steps"] for c in d["cards"] + d["returned"])
        first, now_steps, end = steps(), 0, time.time() + LIVE_TIMEOUT
        while time.time() < end:
            time.sleep(1.5)
            now_steps = steps()
            if now_steps > first:
                break
        report(now_steps > first, "live session keeps growing (%d -> %d steps)" % (first, now_steps))
        cards = get_json(port, path)[1]["cards"]
        report(any(a["k"] == "longcmd" for c in cards for a in c["alerts"]), "live page raises the long-command alert")
        # the flow graph needs a parent for every sub-agent card, the returned list and hand-back fields
        snap = get_json(port, path)[1]
        report(all(c["parent"] for c in snap["cards"][1:]) and "returned" in snap and all("done" in c for c in snap["cards"]),
               "live snapshot carries parent ids, done flags and the returned list")
        report(any(c["state"] == "exec" and c["id"] != "main" for c in snap["cards"]), "a sub-agent keeps executing a long command")
        report(all("tok" in c and "spm" in c for c in snap["cards"]) and snap["cards"][0]["tok"]["out"] > 0 and "lastUser" in snap and "tok15" in snap,
               "live snapshot carries token totals, step speed, last user message and the 15-minute token rate")
        rate = snap["rate"]
        report(all(k in rate for k in ("c15", "c60", "perHour15", "t15", "t60", "tPerHour15")) and rate["c60"] > 0 and rate["t60"] > 0 and all("cost15" in c and "tok15" in c for c in snap["cards"]),
               "live snapshot carries amounts and tokens for 15 min, 60 min and per hour")
        subs = snap["subs"]
        report(subs and all(v["state"] in ("exec", "think", "waiting", "idle", "done") for v in subs.values()) and any(v["state"] != "done" for v in subs.values()),
               "live snapshot carries a status for every followed sub-agent (%d)" % len(subs))
        check_steps_api(port, live[0])
        snap_file = os.path.join(tmp, "snapshot.json")
        with open(snap_file, "w", encoding="utf-8") as f:
            json.dump(snap, f)
        check_pages(PAGES, snap_file)
        # opening a session parses it, after which the list shows its estimated amount
        fin = next(r for r in rows if r["tool"] == "claude" and r["status"] != "active")
        get_json(port, "/api/open/claude/%s" % fin["id"])
        end = time.time() + 30
        while time.time() < end and get_json(port, "/api/job/claude/%s" % fin["id"])[1]["state"] == "running":
            time.sleep(0.3)
        row = next(r for r in get_json(port, "/api/sessions")[1]["rows"] if r["id"] == fin["id"])
        report(row.get("cost") and row["cost"] > 0 and row["tok"] > 0, "list row gets its estimated amount after the session is opened (%s)" % row.get("cost"))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(10)
        log.close()


def http_get(port, path):
    """(status, body) without raising on 4xx/5xx."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def check_restart(tmp):
    """A source change makes the server answer 'restarting' and re-exec itself on the same port.

    The server runs from a copy of src/ so that touching a file never disturbs a real server using the project's src/.
    """
    code = os.path.join(tmp, "restart-code")
    shutil.copytree(SRC, os.path.join(code, "src"), ignore=shutil.ignore_patterns("__pycache__"))
    home = os.path.join(tmp, "restart-home")
    os.makedirs(home)
    port = free_port()
    log = open(os.path.join(tmp, "restart.log"), "w")
    proc = subprocess.Popen([sys.executable, os.path.join(code, "src", "cli.py"), "demo", "--no-open", "--port", str(port)],
                            stdout=log, stderr=log, env=dict(os.environ, AGENT_REPLAY_HOME=home))
    target = os.path.join(code, "src", "template.html")
    st = None
    try:
        end = time.time() + READY_TIMEOUT
        while time.time() < end and proc.poll() is None:
            try:
                if http_get(port, "/")[0] == 200:
                    break
            except Exception:
                time.sleep(0.5)
        else:
            return report(False, "restart test: server did not start (see %s)" % os.path.join(tmp, "restart.log"))
        st = os.stat(target)
        os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))  # mtime only, content untouched
        time.sleep(SIG_WAIT)  # the server caches its signature comparison for one second
        code_page, body = http_get(port, "/")
        report(code_page == 503 and "data-restarting" in body and "正在重启" in body, "page request after a source change shows the restarting notice (HTTP %d)" % code_page)
        try:
            code_api, api = http_get(port, "/api/sessions")
            report(code_api == 503 and json.loads(api).get("restarting") is True, "API request after a source change returns 503 with restarting=true (HTTP %d)" % code_api)
        except Exception as e:  # the restart may already have begun
            report(False, "API request during restart failed: %s" % e)
        back, end = None, time.time() + READY_TIMEOUT
        while time.time() < end and proc.poll() is None:
            try:
                got = http_get(port, "/")
                if got[0] == 200 and "data-restarting" not in got[1]:
                    back = got[0]
                    break
            except Exception:
                pass
            time.sleep(0.5)
        report(back == 200, "server restarts itself and answers 200 again on the same port")
        if back != 200:
            log.flush()
            with open(os.path.join(tmp, "restart.log"), encoding="utf-8", errors="replace") as lf:
                print("    server log tail:\n    " + "\n    ".join(lf.read().splitlines()[-12:]), flush=True)
    finally:
        if st is not None:
            os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns))  # restore the original mtime
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
    check_prices()
    check_sources()
    tmp = tempfile.mkdtemp(prefix="agent-replay-check-")
    try:
        check_render(tmp)
        check_server(tmp)
        check_restart(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("FAILED: %d check(s)" % len(failures) if failures else "All checks passed", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
