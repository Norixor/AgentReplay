"""Local web app: session list on /, replay pages on /r/<tool>/<id>. Binds 127.0.0.1 only and never writes session files.

Opening a session parses it in a background job; the loading page polls /api/job/... for byte-level progress and
redirects to the finished page. Finished pages of idle sessions are cached under <replays>/.cache/html keyed by
the sizes and mtimes of every file in the session tree plus the tool's own source files.
"""
import hashlib
import json
import os
import re
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import config
import index
import live
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


class App:
    def __init__(self):
        self.lock = threading.Lock()
        self.recs, self.stats, self.rows = {}, {}, []
        self.jobs = {}  # key -> job dict
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

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def do_GET(self):
        host = (self.headers.get("Host") or "").lower()
        if host not in self.allowed_hosts:  # blocks DNS-rebinding style requests from other origins
            return self._send(403, "forbidden host")
        u = urlparse(self.path)
        path, q = unquote(u.path), parse_qs(u.query)
        try:
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
            m = re.match(r"^/(s|r|api/open|api/job)/(claude|codex)/([^/]+)$", path)
            if m and _KEY.match(m.group(3)):
                return self.session_route(m.group(1), "%s:%s" % (m.group(2), m.group(3)), m.group(2), m.group(3))
            return self._send(404, "not found", "text/plain; charset=utf-8")
        except BrokenPipeError:
            pass

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
            httpd = ThreadingHTTPServer(("127.0.0.1", cand), Handler)
            port = cand
            break
        except OSError as e:
            err = e
    if httpd is None:
        print("无法监听 127.0.0.1:%d–%d（%s）。用 --port 指定其他端口" % (first, first + 9, err))
        return 1
    if port != first:
        print("端口 %d 已被其他程序占用，改用 %d" % (first, port), flush=True)
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
        httpd.server_close()
    return 0
