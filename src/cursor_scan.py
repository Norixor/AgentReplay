"""Read-only access to Cursor's SQLite store: database discovery, virtual session paths, stat(), cheap index scans and the
full per-session read used by the parser.

Cursor keeps every chat of every workspace in one key-value table, <root>/User/globalStorage/state.vscdb (WAL mode, written
by the running editor). The tool never writes to it:
  * connections are opened with mode=ro and query_only; immutable=1 is deliberately not used, it would hide everything that
    still sits in the -wal file
  * only table cursorDiskKV is queried, and only keys that start with "composerData:" or "bubbleId:". The neighbouring
    table ItemTable holds sign-in tokens and is never touched
  * composerData holds encryption keys (blobEncryptionKey, ...). They are never selected; the full read keeps an explicit
    whitelist of fields, so everything else is dropped the moment a row is parsed
  * a connection lives only for one query batch; an unreadable or foreign database is treated as holding no sessions

Rows:  composerData:<composerId>             one chat (JSON): name, status, model, the ordered message headers, sub-agent ids
       bubbleId:<composerId>:<bubbleId>      one message (JSON); a value may be NULL once Cursor has cleaned it up

Virtual paths: a session is "<db path>#<composerId>" (see sources.py, "Paths"). The listed sessions are
  * top-level: not a sub-agent (not named by another chat's subagentComposerIds, no existing parentComposerId)
  * not a placeholder: Cursor creates empty chats at start-up (no message headers)
  * time-stamped: at least one message body carries createdAt. Chats written by Cursor versions before about 2025-12 have
    no per-message time, so there is nothing to build a timeline from and no time is invented for them
A sub-agent chat is a composerData of its own; the top-level path stands for its whole tree:
  size   total bytes of every message value in the tree (grows with the conversation)
  mtime  newest message createdAt in the tree, in seconds (composerData.lastUpdatedAt does not follow the conversation)
Both come from one grouped query per database that is cached until the database or its -wal file changes.
"""
import json
import os
import re
import sqlite3
import threading
import urllib.parse

from datetime import datetime

from scan_util import clip

SEP = "#"
DB_REL = os.path.join("User", "globalStorage", "state.vscdb")
_LOCK = threading.Lock()
_SNAP = {}  # db path -> (fingerprint, Snapshot)
_SID = "substr(key, 10, instr(substr(key, 10), ':') - 1)"  # composerId inside "bubbleId:<composerId>:<bubbleId>"
_COMPOSER_RANGE = "key >= 'composerData:' AND key < 'composerData;' AND value IS NOT NULL"  # ';' is the character after ':'
_BUBBLE_RANGE = "key >= 'bubbleId:' AND key < 'bubbleId;' AND value IS NOT NULL"

# Fields kept from a composerData / bubble row; anything else (keys, caches, attachments) is dropped at parse time.
_COMPOSER_KEEP = ("composerId", "name", "subtitle", "createdAt", "status", "unifiedMode", "modelConfig", "contextTokensUsed",
                  "contextTokenLimit", "subagentComposerIds", "subagentInfo", "workspaceIdentifier", "fullConversationHeadersOnly")
_TOOL_KEEP = ("name", "status", "params", "rawArgs", "result", "error", "toolCallId", "modelCallId", "toolIndex")
_AD_KEEP = ("status", "subagentComposerId", "terminationReason")


def db_file(root):
    return os.path.join(root, DB_REL)


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


def ms_of(v):
    """Epoch ms of a Cursor time value: an ISO string (message createdAt) or a number (composer createdAt)."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(round(datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000))
    except (ValueError, TypeError, OverflowError):
        return None


def _json(raw):
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- the one-pass summaries

def _sql_composers(con):
    for r in con.execute(
            "SELECT substr(key, 14) AS sid, json_extract(value, '$.name') AS name, json_extract(value, '$.subtitle') AS subtitle,"
            " json_extract(value, '$.createdAt') AS created, json_extract(value, '$.status') AS status,"
            " json_array_length(value, '$.fullConversationHeadersOnly') AS nhdr, json_extract(value, '$.subagentComposerIds') AS subs,"
            " json_extract(value, '$.subagentInfo.parentComposerId') AS parent, json_extract(value, '$.workspaceIdentifier.id') AS wid,"
            " json_extract(value, '$.modelConfig.modelName') AS model FROM cursorDiskKV WHERE " + _COMPOSER_RANGE):
        yield dict(r)


def _py_composers(con):
    """Same rows as _sql_composers parsed in Python: used when SQLite's JSON functions reject a row (one damaged value
    would otherwise fail the whole query) or are not compiled in."""
    for r in con.execute("SELECT key, value FROM cursorDiskKV WHERE " + _COMPOSER_RANGE):
        d = _json(r["value"])
        if not isinstance(d, dict):
            continue
        hdr = d.get("fullConversationHeadersOnly")
        info = d.get("subagentInfo") if isinstance(d.get("subagentInfo"), dict) else {}
        ws = d.get("workspaceIdentifier") if isinstance(d.get("workspaceIdentifier"), dict) else {}
        mc = d.get("modelConfig") if isinstance(d.get("modelConfig"), dict) else {}
        subs = d.get("subagentComposerIds")
        yield {"sid": r["key"][len("composerData:"):], "name": d.get("name"), "subtitle": d.get("subtitle"), "created": d.get("createdAt"),
               "status": d.get("status"), "nhdr": len(hdr) if isinstance(hdr, list) else 0,
               "subs": json.dumps(subs) if isinstance(subs, list) else None, "parent": info.get("parentComposerId"),
               "wid": ws.get("id"), "model": mc.get("modelName")}


def _sql_bubbles(con):
    for r in con.execute(
            "SELECT %s AS sid, COUNT(*) AS n, SUM(LENGTH(value)) AS bytes, COUNT(json_extract(value, '$.createdAt')) AS nts,"
            " MAX(json_extract(value, '$.createdAt')) AS last FROM cursorDiskKV WHERE %s GROUP BY sid" % (_SID, _BUBBLE_RANGE)):
        yield dict(r)


def _py_bubbles(con):
    acc = {}
    for r in con.execute("SELECT key, value FROM cursorDiskKV WHERE " + _BUBBLE_RANGE):
        parts = r["key"].split(":")
        if len(parts) < 3:
            continue
        a = acc.setdefault(parts[1], {"sid": parts[1], "n": 0, "bytes": 0, "nts": 0, "last": None})
        a["n"] += 1
        a["bytes"] += len(r["value"])
        d = _json(r["value"])
        ms = ms_of(d.get("createdAt")) if isinstance(d, dict) else None
        if ms is not None:
            a["nts"] += 1
            a["last"] = max(a["last"] or 0, ms)
    return list(acc.values())


def _either(sql_fn, py_fn, con):
    try:
        return list(sql_fn(con))
    except sqlite3.Error:
        return list(py_fn(con))


class Snapshot:
    """Chats of one database with their tree statistics; see the module docstring for size and mtime."""

    def __init__(self, con):
        self.sessions = {}
        for r in _either(_sql_composers, _py_composers, con):
            subs = _json(r["subs"]) if isinstance(r["subs"], str) else None
            r["subs"] = [s for s in subs if isinstance(s, str)] if isinstance(subs, list) else []
            r["created"] = ms_of(r["created"])
            r["nhdr"] = int(r["nhdr"] or 0)
            r.update(bytes=0, nts=0, last=None)
            self.sessions[r["sid"]] = r
        for b in _either(_sql_bubbles, _py_bubbles, con):
            s = self.sessions.get(b["sid"])
            if s is not None:
                s["bytes"], s["nts"], s["last"] = int(b["bytes"] or 0), int(b["nts"] or 0), ms_of(b["last"])
        self.kids = {}
        for sid, s in self.sessions.items():
            ks = [k for k in s["subs"] if k in self.sessions and k != sid]
            self.kids[sid] = ks
        for sid, s in self.sessions.items():  # a chat that only names its parent (subagentInfo) is still its child
            p = s["parent"]
            if p in self.sessions and p != sid and sid not in self.kids[p]:
                self.kids[p].append(sid)
        for sid in self.kids:
            self.kids[sid].sort(key=lambda k: (self.sessions[k]["created"] or 0, k))
        self.child_ids = {k for ks in self.kids.values() for k in ks}
        self.tree_stat = {sid: self._fold(sid, set()) for sid in self.sessions}

    def _own(self, sid):
        s = self.sessions[sid]
        return s["bytes"], (s["last"] or s["created"] or 0)

    def _fold(self, sid, seen):
        size, mt = self._own(sid)
        n = 0
        seen.add(sid)
        for k in self.kids.get(sid, ()):
            if k not in seen:
                ks, km, kn = self._fold(k, seen)
                size, mt, n = size + ks, max(mt, km), n + kn + 1
        return size, mt, n

    def listed(self):
        """Top-level chats worth showing (see the module docstring)."""
        return [sid for sid, s in self.sessions.items() if sid not in self.child_ids and s["nhdr"] > 0 and s["nts"] > 0]

    def descendants(self, sid):
        """Every sub-agent chat below sid, parents before children."""
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
    db = db_file(root)
    snap = snapshot(db)
    return [vpath(db, sid) for sid in snap.listed()] if snap else []


def stat(path):
    """(size, mtime seconds) of a chat tree; OSError when the database or the chat is gone."""
    db, sid = split(path)
    snap = snapshot(db)
    if snap is None or sid not in snap.tree_stat:
        raise FileNotFoundError(path)
    size, mt, _ = snap.tree_stat[sid]
    return size, mt / 1000.0


def tree(path):
    """{agent id: virtual path} of a chat: "main" first, then every sub-agent chat by its composerId."""
    db, sid = split(path)
    snap = snapshot(db)
    out = {"main": path}
    if snap and sid in snap.sessions:
        for k in snap.descendants(sid):
            out[k] = vpath(db, k)
    return out


# ---------------------------------------------------------------- project folder

_WID = re.compile(r"^[A-Za-z0-9_.-]+$")


def project_dir(db, wid):
    """Local folder of a workspace id (composerData.workspaceIdentifier.id) from workspaceStorage/<id>/workspace.json, "" when
    it cannot be told: empty windows, multi-root workspaces, remote folders."""
    if not isinstance(wid, str) or not _WID.match(wid) or wid.startswith("."):
        return ""
    ws = os.path.join(os.path.dirname(os.path.dirname(db)), "workspaceStorage", wid, "workspace.json")  # <root>/User/workspaceStorage
    try:
        with open(ws, encoding="utf-8") as f:
            uri = (json.load(f) or {}).get("folder")
    except (OSError, ValueError, AttributeError):
        return ""
    if not isinstance(uri, str) or not uri.startswith("file://"):
        return ""
    p = urllib.parse.unquote(urllib.parse.urlparse(uri).path)
    return p[1:] if re.match(r"^/[A-Za-z]:", p) else p  # file:///c%3A/x on Windows


# ---------------------------------------------------------------- scan

def _first_user_text(con, sid):
    key = "bubbleId:" + sid + ":"
    for r in con.execute(
            "SELECT json_extract(value, '$.text') AS t FROM cursorDiskKV WHERE key >= ? AND key < ? AND value IS NOT NULL"
            " AND json_extract(value, '$.type') = 1 ORDER BY json_extract(value, '$.createdAt') LIMIT 1", (key, key[:-1] + ";")):
        return r["t"] or ""
    return ""


def scan(path):
    """Index record of a top-level chat: metadata only, no message content except a title fallback."""
    db, sid = split(path)
    rec = {"tool": "cursor", "path": path, "id": sid, "parent": None, "archived": False, "cwd": "", "start": None, "end": None,
           "model": "", "title0": "", "subs": 0}
    snap = snapshot(db)
    s = snap.sessions.get(sid) if snap else None
    if s is None:
        return rec
    _, mt, nsubs = snap.tree_stat[sid]
    rec.update(cwd=project_dir(db, s["wid"]), start=s["created"], end=mt or None, model=str(s["model"] or ""), subs=nsubs,
               title0=clip(str(s["name"] or ""), 80))
    if not rec["title0"]:
        try:
            con = connect(db)
            try:
                rec["title0"] = clip(str(_first_user_text(con, sid)), 80)
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            pass
        rec["title0"] = rec["title0"] or clip(str(s["subtitle"] or ""), 80)
    return rec


# ---------------------------------------------------------------- full read

def _slim_composer(d):
    c = {k: d[k] for k in _COMPOSER_KEEP if k in d}
    c["fullConversationHeadersOnly"] = [_slim_header(h) for h in c.get("fullConversationHeadersOnly") or [] if isinstance(h, dict) and h.get("bubbleId")]
    return c


def _slim_header(h):
    g = h.get("grouping") if isinstance(h.get("grouping"), dict) else {}
    return {"bubbleId": h["bubbleId"], "type": h.get("type"), "createdAt": h.get("createdAt"), "startedAtMs": h.get("startedAtMs"),
            "completedAtMs": h.get("completedAtMs"), "thinkingDurationMs": g.get("thinkingDurationMs"), "turnDurationMs": g.get("turnDurationMs")}


def _slim_bubble(d):
    b = {"type": d.get("type"), "text": d.get("text") if isinstance(d.get("text"), str) else "", "createdAt": d.get("createdAt"),
         "thinkingDurationMs": d.get("thinkingDurationMs"), "thinking": "", "tool": None}
    th = d.get("thinking")
    if isinstance(th, dict) and isinstance(th.get("text"), str):
        b["thinking"] = th["text"]  # the signature next to it is dropped
    t = d.get("toolFormerData")
    if isinstance(t, dict) and t.get("name"):
        b["tool"] = {k: t.get(k) for k in _TOOL_KEEP}
        ad = t.get("additionalData") if isinstance(t.get("additionalData"), dict) else {}
        b["tool"]["additionalData"] = {k: ad.get(k) for k in _AD_KEEP if k in ad}
    return b


def load_session(path):
    """-> (chat dict, [message dict]) read in one consistent snapshot of the database.

    A message is {"id", "type", "text", "thinking", "thinkingDurationMs", "createdAt", "tool", "h": header fields} in
    conversation order (the order of fullConversationHeadersOnly); headers whose body is gone are skipped."""
    db, sid = split(path)
    con = connect(db)
    try:
        con.execute("BEGIN")
        row = con.execute("SELECT value FROM cursorDiskKV WHERE key = ? AND value IS NOT NULL", ("composerData:" + sid,)).fetchone()
        d = _json(row["value"]) if row else None
        sess = _slim_composer(d) if isinstance(d, dict) else {"composerId": sid, "fullConversationHeadersOnly": []}
        key = "bubbleId:" + sid + ":"
        bodies = {}
        for r in con.execute("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ? AND value IS NOT NULL", (key, key[:-1] + ";")):
            b = _json(r["value"])
            if isinstance(b, dict):
                b = _slim_bubble(b)
                b["bytes"] = len(r["value"])
                bodies[r["key"][len(key):]] = b
        con.execute("COMMIT")
    finally:
        con.close()
    msgs = []
    for h in sess["fullConversationHeadersOnly"]:
        b = bodies.get(h["bubbleId"])
        if b is not None:
            msgs.append(dict(b, id=h["bubbleId"], h=h))
    sess["id"] = sid
    return sess, msgs
