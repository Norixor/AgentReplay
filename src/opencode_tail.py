"""Live tail of one opencode session: polls the SQLite store for rows that changed since the last poll (read-only).

It implements the surface live.Live.follow expects from a tail (see live.Tail): `start`, `first(cutoff_ms)` and `read_new()`,
each returning complete JSON lines (bytes) that live_opencode.OpencodeFeed understands:
  {"k": "m", "id", "c", "u", "d"}            a message row (created / updated ms, slimmed JSON)
  {"k": "p", "id", "mid", "c", "u", "d"}     a part row of that message
Rules:
  * a poll costs two stat() calls while the database (and its -wal) is unchanged; only then is a short connection opened,
    used for one transaction and closed. Nothing is written and no handle is kept between polls.
  * the watermark is the newest time_updated seen; rows from the last SLACK_MS before it are asked for again (a writer can
    commit a row with a slightly older stamp after we looked) and skipped here when their (time_updated, size) is
    unchanged, so the feed sees every real change once. The feed is idempotent anyway.
  * rows are slimmed on the way (large tool inputs / outputs are cut, nothing the live view does not read is kept).
  * a failed read (locked database, torn file) yields no lines and is retried by the next poll.
"""
import json
import sqlite3

import opencode_scan

fingerprint = opencode_scan.fingerprint  # (size, mtime_ns) of the database and its -wal file
SLACK_MS = 2000
MAX_STR = 4000
CHUNK = 400  # ids per IN (...) query


def clip(s, n):
    return s[:n] if isinstance(s, str) else ""


def _slim_input(inp):
    out = {}
    for k, v in (inp if isinstance(inp, dict) else {}).items():
        if isinstance(v, str):
            out[k] = v[:MAX_STR]
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            try:
                small = len(json.dumps(v)) <= 2000
            except (TypeError, ValueError):
                small = False
            out[k] = v if small else ([None] * min(len(v), 1000) if isinstance(v, list) else {})
    return out


def slim_part(d):
    """The fields of a part JSON the live view reads."""
    t = d.get("type")
    if t == "tool":
        st = d.get("state") or {}
        meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
        sm = {k: meta[k] for k in ("exit", "sessionId", "sessionID", "parentSessionId") if k in meta}
        if isinstance(meta.get("files"), list):
            sm["files"] = [{"relativePath": f.get("relativePath"), "filePath": f.get("filePath")} for f in meta["files"][:50] if isinstance(f, dict)]
        state = {"status": st.get("status"), "input": _slim_input(st.get("input")), "title": clip(st.get("title"), 300), "metadata": sm,
                 "time": st.get("time") if isinstance(st.get("time"), dict) else {}}
        for k in ("output", "error"):
            if isinstance(st.get(k), str):
                state[k] = st[k][:400]
        return {"type": "tool", "tool": d.get("tool"), "callID": d.get("callID"), "state": state}
    if t == "text":
        return {"type": "text", "text": clip(d.get("text"), 2000), "ignored": bool(d.get("ignored"))}
    if t == "reasoning":
        return {"type": "reasoning", "text": clip(d.get("text"), 200)}
    if t == "step-finish":
        return {"type": t, "tokens": d.get("tokens"), "reason": d.get("reason")}
    if t == "compaction":
        return {"type": t, "auto": bool(d.get("auto"))}
    return {"type": t}


def slim_message(d):
    out = {k: d[k] for k in ("role", "modelID", "providerID", "time", "tokens", "finish", "agent", "mode") if k in d}
    if isinstance(d.get("model"), (dict, str)):
        out["model"] = d["model"]
    err = d.get("error")
    if isinstance(err, dict):
        data = err.get("data") if isinstance(err.get("data"), dict) else {}
        out["error"] = {"name": err.get("name"), "data": {"message": clip(str(data.get("message") or ""), 300)}}
    cwd = (d.get("path") or {}).get("cwd") if isinstance(d.get("path"), dict) else ""
    if cwd:
        out["path"] = {"cwd": cwd}
    return out


def read_sessions(con):
    """{session id: row dict} of every session (the table is small: one row per conversation)."""
    cols = {r["name"] for r in con.execute("PRAGMA table_info(session)")}
    pick = [c for c in opencode_scan._SESSION_COLS if c in cols]
    if "id" not in pick:
        raise sqlite3.DatabaseError("no session table")
    out = {}
    for r in con.execute("SELECT %s FROM session" % ", ".join(pick)):
        d = {c: None for c in opencode_scan._SESSION_COLS}
        d.update(dict(r))
        out[d["id"]] = d
    return out


def probe(con, sid):
    """(newest update in ms, ended) of a session: ended = its last assistant message finished for good. For old sub-sessions."""
    last = 0
    for table in ("message", "part"):
        row = con.execute("SELECT MAX(time_updated) FROM %s WHERE session_id = ?" % table, (sid,)).fetchone()
        last = max(last, int(row[0] or 0))
    ended = False
    for r in con.execute("SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 6", (sid,)):
        try:
            d = json.loads(r["data"])
        except (ValueError, TypeError):
            continue
        if d.get("role") == "assistant":
            ended = bool((d.get("time") or {}).get("completed")) and d.get("finish") not in ("tool-calls", "tool_use", "unknown", None, "")
            break
    return last, ended


class OpencodeTail:
    """Tail of the messages and parts of one session (a virtual path "<db>#<session id>")."""

    def __init__(self, path):
        self.path = path
        self.db, self.sid = opencode_scan.split(path)
        self.start = 0       # assistant messages before the opening window (they are only counted)
        self.prefix = 0
        self.mark = 0        # newest time_updated seen
        self.fp = None       # fingerprint of the database at the last successful read
        self.sent = {}       # row id -> (time_updated, bytes) of rows near the watermark
        self.loaded = False
        self.cutoff = 0

    # ------------------------------------------------------------ queries

    def _count_before(self, con, cutoff):
        sql = "SELECT COUNT(*) FROM message WHERE session_id = ? AND time_created < ? AND time_updated < ? AND %s"
        try:
            return int(con.execute(sql % "json_extract(data, '$.role') = 'assistant'", (self.sid, cutoff, cutoff)).fetchone()[0])
        except sqlite3.Error:  # SQLite built without JSON functions
            return int(con.execute(sql % "data LIKE '%\"role\":\"assistant\"%'", (self.sid, cutoff, cutoff)).fetchone()[0])

    def _collect(self, con, where, args):
        """Lines of the changed rows matching `where` (a condition on time_created / time_updated), not yet sent."""
        msgs, parts, order = {}, [], []
        for r in con.execute("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? AND (%s) ORDER BY time_created, id" % where,
                             (self.sid,) + args):
            msgs[r["id"]] = r
            order.append(r["id"])
        for r in con.execute("SELECT id, message_id, time_created, time_updated, data FROM part WHERE session_id = ? AND (%s) ORDER BY time_created, id" % where,
                             (self.sid,) + args):
            parts.append(r)
        missing = sorted({p["message_id"] for p in parts if p["message_id"] not in msgs})
        for i in range(0, len(missing), CHUNK):
            chunk = missing[i:i + CHUNK]
            for r in con.execute("SELECT id, time_created, time_updated, data FROM message WHERE id IN (%s)" % ",".join("?" * len(chunk)), chunk):
                msgs[r["id"]] = r
                order.append(r["id"])
        order.sort(key=lambda i: (msgs[i]["time_created"], i))
        lines, seen_mark = [], 0

        def keep(r):
            size = len(r["data"])
            key = (r["time_updated"], size)
            seen = self.sent.get(r["id"])
            self.sent[r["id"]] = key
            return seen != key

        for mid in order:
            r = msgs[mid]
            seen_mark = max(seen_mark, int(r["time_updated"] or 0))
            if not keep(r):
                continue
            try:
                d = json.loads(r["data"])
            except (ValueError, TypeError):
                self.sent.pop(mid, None)
                continue
            lines.append(json.dumps({"k": "m", "id": mid, "c": r["time_created"], "u": r["time_updated"], "d": slim_message(d)}, ensure_ascii=False).encode())
        for r in parts:
            seen_mark = max(seen_mark, int(r["time_updated"] or 0))
            if not keep(r):
                continue
            try:
                d = json.loads(r["data"])
            except (ValueError, TypeError):
                self.sent.pop(r["id"], None)
                continue
            lines.append(json.dumps({"k": "p", "id": r["id"], "mid": r["message_id"], "c": r["time_created"], "u": r["time_updated"],
                                     "d": slim_part(d)}, ensure_ascii=False).encode())
        return lines, seen_mark

    def _session_mark(self, con):
        m = 0
        for table in ("message", "part"):
            m = max(m, int(con.execute("SELECT MAX(time_updated) FROM %s WHERE session_id = ?" % table, (self.sid,)).fetchone()[0] or 0))
        return m

    def _prune(self):
        floor = self.mark - SLACK_MS - 1000
        for k in [k for k, v in self.sent.items() if v[0] < floor]:
            del self.sent[k]

    # ------------------------------------------------------------ the Tail surface

    def first(self, cutoff_ms):
        """Opening window: every message / part created or updated since cutoff_ms; older assistant messages are counted."""
        self.cutoff = cutoff_ms
        return self._load()

    def _load(self):
        fp = fingerprint(self.db)
        if fp[0] is None:
            return []
        try:
            con = opencode_scan.connect(self.db)
            try:
                con.execute("BEGIN")
                self.prefix = self._count_before(con, self.cutoff)
                lines, mark = self._collect(con, "time_created >= ? OR time_updated >= ?", (self.cutoff, self.cutoff))
                self.mark = mark or self._session_mark(con)
                con.execute("COMMIT")
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            self.sent.clear()
            return []  # retried by the next read_new()
        self.start = self.prefix
        self.fp, self.loaded = fp, True
        self._prune()
        return lines

    def read_new(self):
        fp = fingerprint(self.db)
        if fp[0] is None or fp == self.fp:
            return []
        if not self.loaded:
            return self._load()
        try:
            con = opencode_scan.connect(self.db)
            try:
                con.execute("BEGIN")
                lines, mark = self._collect(con, "time_updated >= ?", (self.mark - SLACK_MS,))
                con.execute("COMMIT")
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            return []
        self.mark = max(self.mark, mark)
        self.fp = fp
        self._prune()
        return lines
