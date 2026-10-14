"""Gemini CLI session files: reading one session, resolving its project and the cheap index scan.

Layout under the data root (default ~/.gemini):
  projects.json                                   {"projects": {"<absolute path>": "<short name>"}}
  tmp/<short name | sha256 of the path>/.project_root
  tmp/<...>/chats/session-<date>-<id8>.jsonl      main session (current format)
  tmp/<...>/chats/session-<date>-<id8>.json       main session (legacy format: one JSON document)
  tmp/<...>/chats/<main session id>/<id>.jsonl    sub-agent session (first record has kind "subagent")

A .jsonl file is an append-only log: a metadata record, message records and {"$set": ...} patches. It is replayed the way
Gemini CLI itself loads it: a message that is written again under the same id replaces the earlier copy in place (the
second write is the one that carries the tool calls), {"$set": {"messages": [...]}} replaces the whole message list,
{"$rewindTo": id} drops that message and everything after it, and any other $set key updates the metadata.
Records of unknown shape (for example $patch) are ignored.
"""
import hashlib
import json
import os
import re

from common import ts_ms
from scan_util import HEAD_BYTES, HEAD_LINES, clip, tail_ts

CONTEXT_PREFIX = "<session_context>"  # the first "user" record is injected by the CLI, it is not something the user typed
_TS_TAIL = re.compile(rb'"(?:timestamp|lastUpdated)":"([^"]+)"')
_REPLY = b'"type":"gemini"'


# ---------------------------------------------------------------- reading

def _put(msgs, m, n):
    """Store a message under its id (the later copy wins, the first position stays); messages without an id never merge."""
    if isinstance(m, dict) and m.get("type"):
        msgs[m["id"] if m.get("id") else "#%d" % n] = m


def read_session(path, on_bytes=None):
    """-> {"meta": {...}, "msgs": [message dicts in order, one per id]}. Unreadable lines and files give less, never an error."""
    meta, msgs = {}, {}
    try:
        if path.endswith(".json"):
            with open(path, encoding="utf-8", errors="replace") as f:
                doc = json.load(f)
            if on_bytes:
                on_bytes(os.path.getsize(path))
            if isinstance(doc, dict):
                meta = {k: v for k, v in doc.items() if k != "messages"}
                for n, m in enumerate(doc.get("messages") or []):
                    _put(msgs, m, n)
        else:
            _replay(path, meta, msgs, on_bytes)
    except (OSError, ValueError):
        pass
    return {"meta": meta, "msgs": list(msgs.values())}


def _replay(path, meta, msgs, on_bytes):
    n = acc = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            n += 1
            acc += len(line)
            if on_bytes and n % 400 == 0:
                on_bytes(acc)
                acc = 0
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if not isinstance(r, dict):
                continue
            if isinstance(r.get("$set"), dict):
                s = r["$set"]
                if isinstance(s.get("messages"), list):
                    msgs.clear()
                    for i, m in enumerate(s["messages"]):
                        _put(msgs, m, n * 1000 + i)
                meta.update({k: v for k, v in s.items() if k != "messages"})
            elif "$rewindTo" in r:
                keys = list(msgs)
                at = r["$rewindTo"]
                for k in (keys[keys.index(at):] if at in msgs else keys):
                    msgs.pop(k, None)
            elif "sessionId" in r and "type" not in r:
                meta.update(r)
            else:
                _put(msgs, r, n)
    if on_bytes and acc:
        on_bytes(acc)


def user_text(content):
    """Text of a user message: a string, or a list of parts of which only some carry a "text" (the rest are tool results)."""
    if isinstance(content, str):
        return content
    out = []
    for p in content or []:
        if isinstance(p, str):
            out.append(p)
        elif isinstance(p, dict) and isinstance(p.get("text"), str):
            out.append(p["text"])
    return "\n".join(out)


def is_context(text):
    return text.lstrip().startswith(CONTEXT_PREFIX)


# ---------------------------------------------------------------- project of a session

def chats_dir(path):
    """The chats directory a session file lives in (a sub-agent file is one level deeper)."""
    d = os.path.dirname(path)
    return os.path.dirname(d) if os.path.basename(d) != "chats" else d


def is_subagent_path(path):
    return os.path.basename(os.path.dirname(path)) != "chats"


def _projects(root):
    try:
        with open(os.path.join(root, "projects.json"), encoding="utf-8") as f:
            p = json.load(f).get("projects")
        return {k: v for k, v in p.items() if isinstance(k, str)} if isinstance(p, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def project_of(root, path, project_hash=""):
    """-> (working directory or "", label of the project directory the file lives in).

    The directory is named after the project's short name from projects.json, or after the sha256 of its path. The path
    comes from .project_root, else from projects.json (by short name or by hash)."""
    pdir = os.path.dirname(chats_dir(path))
    label = os.path.basename(pdir)
    try:
        with open(os.path.join(pdir, ".project_root"), encoding="utf-8") as f:
            cwd = f.read().strip()
        if cwd:
            return cwd, label
    except OSError:
        pass
    for p, short in _projects(root).items():
        if short == label or hashlib.sha256(p.encode("utf-8")).hexdigest() in (label, project_hash):
            return p, label
    return "", label


# ---------------------------------------------------------------- index scan

def _title_of(msgs):
    for m in msgs:
        if isinstance(m, dict) and m.get("type") == "user":
            t = user_text(m.get("content")).strip()
            if t and not is_context(t):
                return clip(t, 80)
    return ""


def scan(path, root):
    """Index record. Current-format files are read from the head (first user message, model) and the tail (last timestamp)
    only; legacy .json files are one document and are read whole."""
    sub = is_subagent_path(path)
    rec = {"tool": "gemini", "path": path, "archived": False, "id": "", "parent": os.path.basename(os.path.dirname(path)) if sub else None,
           "cwd": "", "proj": "", "start": None, "end": None, "model": "", "title0": "", "kind": "subagent" if sub else "main",
           "replies": False}
    meta, phash = {}, ""
    if path.endswith(".json"):
        d = read_session(path)
        meta = d["meta"]
        gem = [m for m in d["msgs"] if m.get("type") == "gemini"]
        rec["title0"], rec["replies"] = _title_of(d["msgs"]), bool(gem)
        rec["model"] = next((m.get("model") for m in gem if m.get("model")), "") or ""
        if meta.get("lastUpdated"):
            rec["end"] = to_ms(meta["lastUpdated"])
    else:
        meta = _scan_head(path, rec)
        rec["end"] = tail_ts(path, _TS_TAIL)
        if not rec["replies"]:
            rec["replies"] = _tail_has_reply(path)
    phash = meta.get("projectHash") or ""
    rec["id"] = meta.get("sessionId") or re.sub(r"\.jsonl?$", "", os.path.basename(path))
    rec["start"] = to_ms(meta.get("startTime"))
    rec["kind"] = meta.get("kind") or rec["kind"]
    rec["cwd"], rec["proj"] = project_of(root, path, phash)
    return rec


def to_ms(s):
    """Epoch ms of an ISO timestamp string; None when it is missing or not a timestamp."""
    try:
        return ts_ms(s) if s else None
    except (ValueError, TypeError, AttributeError):
        return None


def _scan_head(path, rec):
    meta = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            used = 0
            for i, line in enumerate(f):
                used += len(line)
                if i == 0:
                    try:
                        meta = json.loads(line)
                    except ValueError:
                        meta = {}
                elif '"$set":{"messages"' in line[:40] or '"type":"user"' in line[:300] or '"type":"gemini"' in line[:300]:
                    try:
                        r = json.loads(line)
                    except ValueError:
                        r = {}
                    batch = (r.get("$set") or {}).get("messages") if "$set" in r else [r]
                    batch = [m for m in batch or [] if isinstance(m, dict)]
                    if not rec["title0"]:
                        rec["title0"] = _title_of(batch)
                    for m in batch:
                        if m.get("type") == "gemini":
                            rec["replies"] = True
                            rec["model"] = rec["model"] or m.get("model") or ""
                if (rec["title0"] and rec["model"]) or i >= HEAD_LINES or used > HEAD_BYTES:
                    break
    except OSError:
        pass
    return meta if isinstance(meta, dict) else {}


def _tail_has_reply(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 131072))
            return _REPLY in f.read()
    except OSError:
        return False
