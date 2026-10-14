"""Read-only access to opencode's SQLite store: database discovery, virtual session paths, stat(), cheap index scans and
the full per-session read used by the parser.

opencode keeps every session of every project in one database (<root>/opencode*.db, WAL mode, usually being written by a
running opencode). The tool never writes to it:
  * connections are opened with mode=ro and query_only; immutable=1 is deliberately not used, it would hide everything
    that still sits in the -wal file
  * a connection lives only for one query batch; nothing is held between calls
  * an unreadable or foreign database is treated as holding no sessions

Virtual paths: a session is addressed as "<db path>#<session id>" (see sources.py, "Paths"). Sub-sessions (rows with a
parent_id) are not listed on their own; the top-level session's path stands for its whole tree:
  size   total bytes of the JSON of every message and part in the tree (grows with the conversation)
  mtime  newest time_updated of the session, its messages and parts in the tree, in seconds
Both come from one grouped query per database that is cached until the database or its -wal file changes.
"""
import glob
import json
import os
import re
import sqlite3
import threading
import urllib.parse

from scan_util import clip

SEP = "#"
DB_GLOB = "opencode*.db"  # opencode.db, or opencode-<channel>.db for non-stable builds
_DEFAULT_TITLE = re.compile(r"^(New|Child) session - ")
_SESSION_COLS = ("id", "parent_id", "directory", "title", "agent", "model", "time_created", "time_updated", "time_archived")
_LOCK = threading.Lock()
_SNAP = {}  # db path -> (fingerprint, Snapshot)


def db_files(root):
    return sorted(glob.glob(os.path.join(root, DB_GLOB)))


def vpath(db, sid):
    return db + SEP + sid


def split(path):
    """Virtual path -> (db path, session id)."""
    db, _, sid = path.rpartition(SEP)
    return db, sid


def connect(db):
    """A read-only connection (sqlite3.Error / OSError when the database cannot be opened this way)."""
    if not os.path.isfile(db):
        raise FileNotFoundError(db)
    uri = "file:" + urllib.parse.quote(os.path.abspath(db), safe="/:") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=3, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=ON")
    return con


def _fingerprint(db):
    out = []
    for suffix in ("", "-wal"):
        try:
            st = os.stat(db + suffix)
            out.append((st.st_size, st.st_mtime_ns))
        except OSError:
            out.append(None)
    return tuple(out)


class Snapshot:
    """Sessions of one database with their tree statistics; see the module docstring for size and mtime."""

    def __init__(self, con):
        cols = {r["name"] for r in con.execute("PRAGMA table_info(session)")}
        pick = [c for c in _SESSION_COLS if c in cols]
        if "id" not in pick:
            raise sqlite3.DatabaseError("no session table")
        self.sessions = {}
        for r in con.execute("SELECT %s FROM session" % ", ".join(pick)):
            d = {c: None for c in _SESSION_COLS}
            d.update(dict(r))
            self.sessions[d["id"]] = d
        own = {sid: [0, int(s["time_updated"] or s["time_created"] or 0)] for sid, s in self.sessions.items()}
        for table in ("message", "part"):
            for r in con.execute("SELECT session_id, SUM(LENGTH(data)) AS n, MAX(time_updated) AS t FROM %s GROUP BY session_id" % table):
                o = own.get(r["session_id"])
                if o is not None:
                    o[0] += int(r["n"] or 0)
                    o[1] = max(o[1], int(r["t"] or 0))
        self.kids = {}
        for sid, s in sorted(self.sessions.items(), key=lambda kv: (kv[1]["time_created"] or 0, kv[0])):
            if s["parent_id"] in self.sessions:
                self.kids.setdefault(s["parent_id"], []).append(sid)
        self.tree_stat = {sid: self._fold(sid, own, set()) for sid in self.sessions}

    def _fold(self, sid, own, seen):
        size, mt = own[sid]
        n = 0
        seen.add(sid)
        for k in self.kids.get(sid, ()):
            if k not in seen:
                ks, km, kn = self._fold(k, own, seen)
                size, mt, n = size + ks, max(mt, km), n + kn + 1
        return size, mt, n

    def top_level(self):
        return [sid for sid, s in self.sessions.items() if s["parent_id"] not in self.sessions]

    def descendants(self, sid):
        """Every session below sid, parents before children."""
        out, stack, seen = [], list(reversed(self.kids.get(sid, ()))), {sid}
        while stack:
            k = stack.pop()
            if k in seen:
                continue
            seen.add(k)
            out.append(k)
            stack.extend(reversed(self.kids.get(k, ())))
        return out


def snapshot(db):
    """Cached Snapshot of a database, None when it cannot be read."""
    fp = _fingerprint(db)
    if fp[0] is None:
        return None
    with _LOCK:
        hit = _SNAP.get(db)
        if hit and hit[0] == fp:
            return hit[1]
        try:
            con = connect(db)
            try:
                snap = Snapshot(con)
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            _SNAP.pop(db, None)
            return None
        _SNAP[db] = (fp, snap)
        return snap


def files(root):
    out = []
    for db in db_files(root):
        snap = snapshot(db)
        if snap:
            out.extend(vpath(db, sid) for sid in snap.top_level())
    return out


def stat(path):
    """(size, mtime seconds) of a session tree; OSError when the database or the session is gone."""
    db, sid = split(path)
    snap = snapshot(db)
    if snap is None or sid not in snap.tree_stat:
        raise FileNotFoundError(path)
    size, mt, _ = snap.tree_stat[sid]
    return size, mt / 1000.0


def tree(path):
    """{agent id: virtual path} of a session: "main" first, then every sub-session by its session id."""
    db, sid = split(path)
    snap = snapshot(db)
    out = {"main": path}
    if snap and sid in snap.sessions:
        for k in snap.descendants(sid):
            out[k] = vpath(db, k)
    return out


def model_id(raw):
    """Model id of a session.model / message value: {"id" | "modelID": ...} as JSON text or dict, or a plain string."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return raw
    if isinstance(raw, dict):
        return str(raw.get("id") or raw.get("modelID") or "")
    return ""


def _first_user_text(con, sid):
    for r in con.execute(
            "SELECT p.data FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = ? "
            "ORDER BY m.time_created, m.id, p.time_created, p.id LIMIT 12", (sid,)):
        try:
            d = json.loads(r["data"])
        except ValueError:
            continue
        if d.get("type") == "text" and d.get("text"):
            return d["text"]
    return ""


def scan(path):
    """Index record of a top-level session: metadata only, no message content except a title fallback."""
    db, sid = split(path)
    rec = {"tool": "opencode", "path": path, "id": sid, "parent": None, "archived": False, "cwd": "", "start": None, "end": None,
           "model": "", "title0": "", "subs": 0}
    snap = snapshot(db)
    s = (snap.sessions.get(sid) if snap else None)
    if s is None:
        return rec
    rec.update(archived=bool(s["time_archived"]), cwd=s["directory"] or "", start=s["time_created"], model=model_id(s["model"]),
               title0=clip(s["title"] or "", 80))
    _, mt, nsubs = snap.tree_stat[sid]
    rec.update(end=mt or s["time_updated"], subs=nsubs)
    if _DEFAULT_TITLE.match(rec["title0"]) or not rec["model"]:
        try:
            con = connect(db)
            try:
                if _DEFAULT_TITLE.match(rec["title0"]) or not rec["title0"]:
                    rec["title0"] = clip(_first_user_text(con, sid), 80)
                if not rec["model"]:
                    for r in con.execute("SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 20", (sid,)):
                        d = json.loads(r["data"])
                        mid = model_id(d.get("modelID") or d.get("model"))
                        if mid:
                            rec["model"] = mid
                            break
            finally:
                con.close()
        except (sqlite3.Error, OSError, ValueError):
            pass
    return rec


def load_session(path):
    """-> (session row dict, [message dict with "parts" list]) read in one consistent snapshot of the database.

    A message dict is {"id", "created", "updated", "data": parsed message JSON, "parts": [{"id", "created", "updated",
    "data": parsed part JSON}]} in conversation order; rows whose JSON is unreadable are skipped."""
    db, sid = split(path)
    snap = snapshot(db)
    sess = dict(snap.sessions[sid]) if snap and sid in snap.sessions else {"id": sid}
    con = connect(db)
    msgs, by_id = [], {}
    try:
        con.execute("BEGIN")
        for r in con.execute("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id", (sid,)):
            try:
                m = {"id": r["id"], "created": r["time_created"], "updated": r["time_updated"], "data": json.loads(r["data"]), "parts": [], "bytes": len(r["data"])}
            except (ValueError, TypeError):
                continue
            msgs.append(m)
            by_id[m["id"]] = m
        for r in con.execute("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? ORDER BY time_created, id", (sid,)):
            m = by_id.get(r["message_id"])
            if m is None:
                continue
            try:
                m["parts"].append({"id": r["id"], "created": r["time_created"], "updated": r["time_updated"], "data": json.loads(r["data"]), "bytes": len(r["data"])})
            except (ValueError, TypeError):
                continue
        con.execute("COMMIT")
    finally:
        con.close()
    return sess, msgs
