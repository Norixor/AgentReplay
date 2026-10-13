"""Local web app: session list on /, replay pages on /r/<tool>/<id>. Binds 127.0.0.1 only and never writes session files.

Opening a session parses it in a background job; the loading page polls /api/job/... for byte-level progress and
redirects to the finished page. Finished pages of idle sessions are cached under <replays>/.cache/html keyed by
the sizes and mtimes of every file in the session tree plus the tool's own source files.
"""
import hashlib
import json
import os
import re
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import config
import index
import costcache
import live
from live_steps import StepFeed
from render import build_html

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_MAX_FILES, CACHE_MAX_BYTES = 60, 1_500_000_000
_KEY = re.compile(r"^[A-Za-z0-9_.\-]+$")
POOL = ThreadPoolExecutor(2)


def _read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def code_signature():
    """Changes whenever the tool's own source changes, so cached pages from older code are not reused."""
    h = hashlib.sha1()
    for fn in sorted(os.listdir(HERE)):
        if fn.endswith((".py", ".js", ".css", ".html", ".json")):
            st = os.stat(os.path.join(HERE, fn))
            h.update(("%s|%d|%d" % (fn, st.st_size, st.st_mtime_ns)).encode())
    return h.hexdigest()[:8]


# ---------------------------------------------------------------- code self-check
# A long-running server keeps the modules it imported at start-up (for example render.JS_FILES) while pages read the
# source files from disk on every render. When src/ changes underneath it the two disagree, so the server compares the
# code signature on each request and re-executes itself in place (same interpreter, arguments and port).

BOOT_SIG = code_signature()
SIG_TTL = 1.0           # seconds a comparison result is reused when requests arrive in bursts
RESTART_WAIT = 30       # seconds to let running parse jobs finish before restarting
_sig_state = {"at": 0.0, "changed": False}
_sig_lock = threading.Lock()
_restart = {"requested": False, "exec": False}


def code_changed():
    """True once src/ differs from what this process started with. The comparison is cached for SIG_TTL seconds."""
    now = time.monotonic()
    with _sig_lock:
        if now - _sig_state["at"] >= SIG_TTL:
            _sig_state["changed"] = code_signature() != BOOT_SIG
            _sig_state["at"] = now
        return _sig_state["changed"]


def request_restart(app, httpd):
    """Start the one background restart: wait for running parse jobs, then stop the serve loop so run() can re-exec."""
    with _sig_lock:
        if _restart["requested"] or httpd is None:
            return
        _restart["requested"] = True

    def worker():
        time.sleep(0.5)  # let the "restarting" notice reach the browser
        end = time.time() + RESTART_WAIT
        while time.time() < end and any(j.get("state") == "running" for j in list(app.jobs.values())):
            time.sleep(0.25)
        _restart["exec"] = True
        httpd.shutdown()  # returns once serve_forever() has exited in the main thread

    threading.Thread(target=worker, daemon=True, name="code-restart").start()


RESTART_PAGE = (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    '<noscript><meta http-equiv="refresh" content="2"></noscript><title>正在重启</title>'
    '<style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;margin:18vh auto;max-width:420px;padding:0 20px;'
    'color:#1c2128;background:#f6f7f9}@media(prefers-color-scheme:dark){body{color:#dde3ea;background:#0f1318}}</style></head>'
    '<body data-restarting="1"><b>服务代码已更新，正在重启…</b><p>页面会自动刷新；若长时间没有恢复，请检查启动 agent-replay 的终端。</p>'
    '<script>setTimeout(function tick(){fetch(location.href,{cache:"no-store"}).then(function(r){return r.text()}).then(function(t){'
    'if(t.indexOf("data-restarting")<0)location.reload();else setTimeout(tick,1500)}).catch(function(){setTimeout(tick,1500)})},2000)</script>'
    '</body></html>')


class App:
    def __init__(self):
        self.lock = threading.Lock()
        self.recs, self.stats, self.rows = {}, {}, []
        self.jobs = {}  # key -> job dict
        self.feed = StepFeed(self.tree_files, lambda row: index.codex_tree(self.recs, row["id"]) if row["tool"] == "codex" else None)
        self.refresh()

    def refresh(self, force=False):
        with self.lock:
            self.recs, self.stats = index.build_index(refresh=force)
            self.rows = index.list_sessions(self.recs)
            self.stats["at"] = int(time.time() * 1000)
        return self.rows

    def row(self, key):
        return next((r for r in self.rows if r["key"] == key), None)

    def live_info(self, row):
        """{state, running} for an active session, None when the session cannot be followed."""
        try:
            return live.row_info(row, self.recs)
        except Exception:  # a broken live view must not break the list
            return None

    def rows_live(self):
        out = []
        for r in self.rows:
            if r["status"] == "active":
                r = dict(r, live=self.live_info(r))
            out.append(r)
        return out

    # ---------------------------------------------------------------- tree + cache

    def tree_files(self, row):
        """Every file whose change must invalidate the cached page."""
        if row["tool"] == "codex":
            return list(index.codex_tree(self.recs, row["id"]).values())
        base = row["path"]
        files = [base]
        sub = os.path.join(os.path.dirname(base), row["id"], "subagents")
        if os.path.isdir(sub):
            files += [os.path.join(sub, fn) for fn in sorted(os.listdir(sub))]
        return files

    def signature(self, row):
        h = hashlib.sha1(code_signature().encode())
        for p in sorted(self.tree_files(row)):
            try:
                st = os.stat(p)
                h.update(("%s|%d|%d" % (p, st.st_size, st.st_mtime_ns)).encode())
            except OSError:
                pass
        return h.hexdigest()[:16]

    def cache_path(self, row, sig):
        return os.path.join(config.HTML_CACHE, "%s-%s-%s.html" % (row["tool"], row["id"], sig))

    # ---------------------------------------------------------------- jobs

    def open_job(self, key):
        row = self.row(key)
        if row is None:
            return None
        sig = self.signature(row)
        active = row["status"] == "active"
        cp = self.cache_path(row, sig)
        with self.lock:
            job = self.jobs.get(key)
            if job and job["state"] == "running":
                return job
            if not active and os.path.isfile(cp):
                job = {"key": key, "state": "done", "done": 1, "total": 1, "label": "已有缓存", "t0": time.time(), "cached": True, "sig": sig}
                self.jobs[key] = job
                return job
            job = {"key": key, "state": "running", "done": 0, "total": 1, "label": "排队中", "t0": time.time(), "cached": False, "sig": sig,
                   "html": None, "error": ""}
            self.jobs[key] = job
        POOL.submit(self._run, job, row, cp, active)
        return job

    def _run(self, job, row, cp, active):
        def progress(done, total, label):
            job["done"], job["total"], job["label"] = done, total, label
        try:
            tree = index.codex_tree(self.recs, row["id"]) if row["tool"] == "codex" else None
            html, info = build_html(row["path"], row["name"], back=True, progress=progress, tool=row["tool"], root_id=row["id"], tree=tree, active=active)
            job["info"] = {"bytes": info["bytes"], "steps": info["steps"], "agents": info["agents"], "shrunk": info["shrunk"]}
            costcache.store(row["key"], row["size"], info["totals"])  # feeds the list's amount column; size = files at job start
            if active:
                job["html"] = html
            else:
                self.write_cache(cp, html, row)
            job["seconds"] = time.time() - job["t0"]
            job["state"] = "done"
        except Exception as e:  # surfaced to the loading page instead of killing the worker
            job["state"], job["error"] = "error", "%s: %s" % (type(e).__name__, e)

    def write_cache(self, cp, html, row):
        os.makedirs(config.HTML_CACHE, exist_ok=True)
        prefix = "%s-%s-" % (row["tool"], row["id"])
        for fn in os.listdir(config.HTML_CACHE):  # drop older pages of the same session
            if fn.startswith(prefix):
                try:
                    os.remove(os.path.join(config.HTML_CACHE, fn))
                except OSError:
                    pass
        tmp = cp + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(html)
        os.replace(tmp, cp)
        files = sorted(((os.stat(os.path.join(config.HTML_CACHE, fn)).st_mtime, fn) for fn in os.listdir(config.HTML_CACHE) if fn.endswith(".html")), reverse=True)
        total = 0
        for i, (_, fn) in enumerate(files):
            p = os.path.join(config.HTML_CACHE, fn)
            total += os.path.getsize(p)
            if i >= CACHE_MAX_FILES or total > CACHE_MAX_BYTES:
                try:
                    os.remove(p)
                except OSError:
                    pass

    def page(self, key):
        """HTML for a finished job, from memory (active sessions) or the disk cache; None when absent."""
        row = self.row(key)
        job = self.jobs.get(key)
        if row is None or job is None or job["state"] != "done":
            return None
        if job.get("html"):
            return job["html"]
        cp = self.cache_path(row, job["sig"])
        try:
            with open(cp, encoding="utf-8") as f:
                return f.read()
        except OSError:
            return None


def _status_json(job):
    return {"state": job["state"], "done": job["done"], "total": job["total"], "label": job["label"], "error": job.get("error", ""),
            "elapsed": round(time.time() - job["t0"], 1), "cached": job.get("cached", False), "info": job.get("info")}


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-replay"
    app = None
    httpd = None
    allowed_hosts = set()

    def log_message(self, fmt, *args):  # quiet: the console shows only the start-up lines
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, code=200, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8", extra)

    def do_GET(self):
        host = (self.headers.get("Host") or "").lower()
        if host not in self.allowed_hosts:  # blocks DNS-rebinding style requests from other origins
            return self._send(403, "forbidden host")
        u = urlparse(self.path)
        path, q = unquote(u.path), parse_qs(u.query)
        try:
            if self.code_gate(path):
                return
            if path == "/":
                return self._send(200, self.list_page())
            if path == "/api/sessions":
                self.app.refresh(force=q.get("refresh") == ["1"])
                return self._json({"rows": self.app.rows_live(), "stats": self.app.stats, "now": int(time.time() * 1000)})
            if path == "/api/live-list":  # light poll for the list page: only the sessions that are active right now
                self.app.refresh()
                act = {r["key"]: {"status": r["status"], "end": r["end"], "subs": r["subs"], "size": r["size"], "live": self.app.live_info(r)}
                       for r in self.app.rows if r["status"] == "active"}
                return self._json({"active": act, "now": int(time.time() * 1000)})
            m = re.match(r"^/api/live/(claude|codex)/([^/]+)$", path)
            if m and _KEY.match(m.group(2)):
                return self.live_route("%s:%s" % (m.group(1), m.group(2)))
            m = re.match(r"^/api/steps/(claude|codex)/([^/]+)$", path)
            if m and _KEY.match(m.group(2)):
                return self.steps_route("%s:%s" % (m.group(1), m.group(2)), q)
            m = re.match(r"^/(s|r|api/open|api/job)/(claude|codex)/([^/]+)$", path)
            if m and _KEY.match(m.group(3)):
                return self.session_route(m.group(1), "%s:%s" % (m.group(2), m.group(3)), m.group(2), m.group(3))
            return self._send(404, "not found", "text/plain; charset=utf-8")
        except BrokenPipeError:
            pass

    def code_gate(self, path):
        """Answer with a restart notice (and start the restart) when src/ changed since start-up; True when answered."""
        is_api, is_page = path.startswith("/api/"), path == "/" or path.startswith(("/s/", "/r/"))
        if not (is_api or is_page) or not code_changed():
            return False
        request_restart(self.app, self.httpd)
        if is_api:
            self._json({"ok": False, "restarting": True, "error": "服务更新中"}, 503, {"Retry-After": "3"})
        else:
            self._send(503, RESTART_PAGE, extra={"Retry-After": "3"})
        return True

    def live_route(self, key):
        app = self.app
        row = app.row(key)
        if row is None:
            app.refresh()
            row = app.row(key)
            if row is None:
                return self._json({"ok": False, "error": "没有这个会话：%s" % key}, 404)
        try:
            return self._json(live.snapshot(row, app.recs))
        except Exception as e:  # report instead of dropping the connection
            return self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 500)

    def steps_route(self, key, q):
        """New steps of one agent since the page was generated (see live_steps.py); only meaningful for active sessions."""
        app = self.app
        row = app.row(key)
        if row is None:
            app.refresh()
            row = app.row(key)
            if row is None:
                return self._json({"ok": False, "error": "没有这个会话：%s" % key}, 404)

        def num(name, default=0):
            try:
                return max(0, int(q.get(name, [default])[0]))
            except ValueError:
                return default
        pend = [int(x) for x in (q.get("pend", [""])[0]).split(",")[:400] if x.isdigit()]
        try:
            return self._json(app.feed.answer(row, (q.get("agent", ["main"])[0] or "main")[:80], num("after"), num("turns"), pend, num("known")))
        except Exception as e:  # report instead of dropping the connection
            return self._json({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 500)

    def session_route(self, kind, key, tool, ident):
        app = self.app
        if app.row(key) is None:
            app.refresh()
            if app.row(key) is None:
                return self._send(404, "没有这个会话：%s" % key, "text/plain; charset=utf-8")
        if kind == "s":
            row = app.row(key)
            return self._send(200, _read("loading.html").replace("{{TITLE}}", _esc(row["name"] or ident[:8])).replace(
                "{{NAME}}", _esc(row["name"] or ident[:8])).replace("{{KEY}}", "%s/%s" % (tool, ident)).replace(
                "{{TOOL}}", "Claude Code" if tool == "claude" else "Codex").replace("{{SIZE}}", "%.1f MB" % (row["size"] / 1e6)))
        if kind == "api/open":
            job = app.open_job(key)
            return self._json(_status_json(job))
        if kind == "api/job":
            job = app.jobs.get(key)
            return self._json(_status_json(job) if job else {"state": "none"})
        html = app.page(key)  # kind == "r"
        if html is None:
            return self._send(302, "", extra={"Location": "/s/%s/%s" % (tool, ident)})
        return self._send(200, html)

    def list_page(self):
        css = "\n".join(_read(n) for n in ("replay.css", "polish.css", "live.css", "list.css"))
        return _read("list.html").replace("{{CSS}}", css).replace("{{JS}}", _read("list.js"))


class Server(ThreadingHTTPServer):
    allow_reuse_address = True  # a restarted process must be able to bind the port right away


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _replay_server_at(port):
    """True when an agent-replay server already answers on this local port."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/sessions" % port, timeout=2) as r:
            return r.status == 200 and "json" in (r.headers.get("Content-Type") or "")
    except Exception:
        return False


def run(port=8790, open_browser=True, reuse=True):
    # Reuse a running instance instead of failing on "address already in use" (the demo never reuses: it serves its own data).
    if reuse and _replay_server_at(port):
        url = "http://127.0.0.1:%d/" % port
        print("会话回放已在运行：%s" % url, flush=True)
        if open_browser:
            webbrowser.open(url)
        return 0
    print("正在读取会话索引…", flush=True)
    t0 = time.time()
    app = App()
    print("索引完成：%d 个会话，%d 个文件，用时 %.1f 秒" % (len(app.rows), app.stats["total"], time.time() - t0), flush=True)
    Handler.app = app
    httpd, first = None, port
    # The port is taken by something else: try the next few before giving up.
    for cand in range(first, first + 10):
        try:
            httpd = Server(("127.0.0.1", cand), Handler)
            port = cand
            break
        except OSError as e:
            err = e
    if httpd is None:
        print("无法监听 127.0.0.1:%d–%d（%s）。用 --port 指定其他端口" % (first, first + 9, err))
        return 1
    if port != first:
        print("端口 %d 已被其他程序占用，改用 %d" % (first, port), flush=True)
    Handler.httpd = httpd
    Handler.allowed_hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}
    url = "http://127.0.0.1:%d/" % port
    print("会话回放已启动：%s（只监听本机，Ctrl+C 退出）" % url, flush=True)
    if open_browser:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        httpd.server_close()  # closes the listening socket before a possible re-exec
    if _restart["exec"]:
        print("源码已更新，正在重启…", flush=True)
        os.execv(sys.executable, [sys.executable] + sys.argv)
    return 0
