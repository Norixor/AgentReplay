"""Polling tail over one Cursor chat for the live view (read-only; the neighbour of live.Tail for a SQLite store).

Cursor keeps a chat as one composerData row (the ordered message headers, model, context size, sub-agent ids) plus one
bubbleId row per message. A message that is still being produced is rewritten in place (a tool call goes from running to
completed), so "new rows" alone is not enough: besides the headers that appeared since the last poll, the bubbles of calls that
had not finished are read again.

Cost control: the database is large (tens of MB) and written by the editor all the time, so a poll first compares the cheap
file fingerprint (size and mtime of the db and its -wal) and does nothing when it is unchanged. Otherwise it opens one
read-only connection and runs equality lookups only: composerData:<id>, then bubbleId:<id>:<bubbleId> for the new headers and
the still-open messages. There is no range scan over the chat.

Same safety rules as cursor_scan: only the cursorDiskKV keys composerData: / bubbleId:, never ItemTable, and every row goes
through cursor_scan's whitelist (_slim_composer / _slim_bubble) so encryption keys and thinking signatures are dropped
before anything leaves this module.

The lines handed to the feed are self-contained JSON documents (bytes):
  {"k": "c", ...}   chat state: status, model, effort, context size, sub-agent ids, name; sent first and again when it changes
  {"k": "m", ...}   one message: id, ts (ms), header fields, slim bubble; sent again when a still-open message changed
"""
import json
import sqlite3
import time

import cursor_scan as cs
from cursor_calls import is_finished

MAX_FIELD = 20_000      # a result / params string above this is reduced (the live view needs a summary, not the content)
GIVE_UP_S = 120         # a header whose body never shows up is dropped after this long
OPEN_MAX_S = 6 * 3600   # a call that never finishes (aborted chat) is no longer re-read after this long


def _shorten(v, n=2000):
    if isinstance(v, str):
        return v[:n]
    if isinstance(v, list):
        return [_shorten(x, n) for x in v[:200]]
    if isinstance(v, dict):
        return {k: _shorten(x, n) for k, x in v.items()}
    return v


def _reduce(tool):
    """Keep the tool message small: a huge result keeps only the few fields the live view reads, huge arguments are cut."""
    r = tool.get("result")
    if isinstance(r, str) and len(r) > MAX_FIELD:
        res = cs._json(r)
        tool["result"] = json.dumps({k: res[k] for k in ("exitCodeV2", "exitCode", "rejected", "agentId") if k in res} if isinstance(res, dict) else {})
    for k in ("params", "rawArgs"):
        v = tool.get(k)
        if isinstance(v, str) and len(v) > MAX_FIELD:
            parsed = cs._json(v)
            tool[k] = json.dumps(_shorten(parsed)) if isinstance(parsed, (dict, list)) else v[:MAX_FIELD]


def header_ms(h):
    """Start time of a message from its header alone (the opening window and the staleness check read no bodies)."""
    t = cs.ms_of(h.get("startedAtMs"))
    return t if t is not None else cs.ms_of(h.get("createdAt"))


def last_activity(db, sid):
    """Newest message time (ms) of a chat from its headers alone, None when the chat cannot be read or has no times."""
    try:
        con = cs.connect(db)
    except (sqlite3.Error, OSError):
        return None
    try:
        row = con.execute("SELECT value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL", ("composerData:" + sid,)).fetchone()
        d = cs._json(row["value"]) if row else None
    except sqlite3.Error:
        return None
    finally:
        con.close()
    if not isinstance(d, dict):
        return None
    times = [header_ms(h) for h in d.get("fullConversationHeadersOnly") or [] if isinstance(h, dict)]
    times = [t for t in times if t is not None]
    return max(times) if times else None


class CursorTail:
    """The live.Tail surface for one chat: start, first(cutoff_ms), read_new(); plus poll() and the counters below."""

    def __init__(self, path):
        self.path = path
        self.db, self.sid = cs.split(path)
        self.start = 0           # kept for the Tail surface: nothing is addressed by byte offsets here
        self.prefix_msgs = 0     # assistant messages older than the opening window (counted, not read)
        self.error = ""          # last failed poll (retried on the next one); "" after a successful poll
        self.last_ms = None      # newest header time seen
        self._fp = None
        self._cut = None         # cutoff of the opening window while first() runs
        self._seen = set()       # bubble ids already handed out (or counted into prefix_msgs)
        self._open = {}          # bubble id -> monotonic time first seen unfinished: read again until it finishes
        self._sent = {}          # bubble id -> hash of the last line sent for an open message
        self._missing = {}       # bubble id -> monotonic time its header was first seen without a body
        self._meta_sig = None
        self._buf = []

    # ------------------------------------------------------------ Tail surface

    def first(self, cutoff_ms):
        """Lines of the opening window: the chat state, then every message at or after the cutoff."""
        self._cut = cutoff_ms
        try:
            self.poll()
        finally:
            self._cut = None
        return self._take()

    def read_new(self):
        self.poll()
        return self._take()

    def _take(self):
        out, self._buf = self._buf, []
        return out

    # ------------------------------------------------------------ one poll

    def poll(self):
        """Read what changed since the last successful poll into the buffer. Idempotent while the database is unchanged."""
        fp = cs._fingerprint(self.db)
        if fp == self._fp:
            return
        if fp[0] is None:
            self.error = "数据库不存在或不可读：%s" % self.db
            return
        try:
            con = cs.connect(self.db)
        except (sqlite3.Error, OSError) as e:
            self.error = "无法打开数据库：%s" % e
            return
        try:
            con.execute("BEGIN")
            lines = self._read(con)
            con.execute("COMMIT")
        except sqlite3.Error as e:
            self.error = "读取失败：%s" % e
            return
        finally:
            con.close()
        if lines is None:
            return
        self._buf.extend(lines)
        self._fp, self.error = fp, ""

    def _body(self, con, bid):
        row = con.execute("SELECT value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL", ("bubbleId:%s:%s" % (self.sid, bid),)).fetchone()
        d = cs._json(row["value"]) if row else None
        if not isinstance(d, dict):
            return None
        b = cs._slim_bubble(d)
        if b["tool"]:
            _reduce(b["tool"])
        return b

    def _read(self, con):
        row = con.execute("SELECT value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL", ("composerData:" + self.sid,)).fetchone()
        d = cs._json(row["value"]) if row else None
        if not isinstance(d, dict):
            self.error = "会话记录不存在或损坏：%s" % self.sid
            return None
        sess = cs._slim_composer(d)
        gen = {x for x in (d.get("generatingBubbleIds") or []) if isinstance(x, str)}
        hdrs = sess["fullConversationHeadersOnly"]
        by_id = {h["bubbleId"]: h for h in hdrs}
        meta = {"k": "c", "id": self.sid, "status": sess.get("status"), "name": sess.get("name") or "", "created": cs.ms_of(sess.get("createdAt")),
                "ctx": sess.get("contextTokensUsed"), "limit": sess.get("contextTokenLimit"), "gen": bool(gen),
                "subs": [x for x in sess.get("subagentComposerIds") or [] if isinstance(x, str)], "mc": sess.get("modelConfig")}
        lines = []
        sig = json.dumps(meta, sort_keys=True, default=str)
        if sig != self._meta_sig:
            lines.append(json.dumps(meta, ensure_ascii=False, default=str).encode("utf-8"))
            self._meta_sig = sig
        now, prev, fresh = time.monotonic(), None, []
        for h in hdrs:
            t = header_ms(h)
            t = prev if t is None else t
            prev = t if t is not None else prev
            if t is not None:
                self.last_ms = max(self.last_ms or 0, t)
            bid = h["bubbleId"]
            if bid in self._seen:
                continue
            if self._cut is not None and t is not None and t < self._cut:
                self._seen.add(bid)  # before the opening window: counted only
                self.prefix_msgs += 1 if h.get("type") == 2 else 0
                continue
            fresh.append(h)
        again = [by_id[b] for b in list(self._open) if b in by_id and b not in {h["bubbleId"] for h in fresh}]
        again += [by_id[b] for b in gen if b in by_id and b in self._seen and b not in self._open]
        for h in fresh + again:
            bid = h["bubbleId"]
            b = self._body(con, bid)
            if b is None:
                first_miss = self._missing.setdefault(bid, now)
                if now - first_miss > GIVE_UP_S:
                    self._seen.add(bid)
                    self._missing.pop(bid, None)
                    self._open.pop(bid, None)
                continue
            self._missing.pop(bid, None)
            ts = cs.stamp_of(b.get("createdAt"), h)
            if ts is None:
                ts = self.last_ms
            if ts is None:
                self._seen.add(bid)
                continue
            running = (bool(b["tool"]) and not is_finished(b["tool"])) or bid in gen
            line = json.dumps({"k": "m", "id": bid, "ts": ts, "h": h, "b": b, "gen": bid in gen}, ensure_ascii=False, default=str).encode("utf-8")
            if bid in self._seen and self._sent.get(bid) == hash(line):
                continue  # an open message that did not change
            self._seen.add(bid)
            lines.append(line)
            if running:
                self._open.setdefault(bid, now)
                self._sent[bid] = hash(line)
            else:
                self._open.pop(bid, None)
                self._sent.pop(bid, None)
        for bid in [b for b, t in self._open.items() if now - t > OPEN_MAX_S]:
            self._open.pop(bid, None)
            self._sent.pop(bid, None)
        return lines
