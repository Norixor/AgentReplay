"""Session index for Claude Code and Codex: cheap per-file metadata, cached on disk.

Only the head (and a small tail) of each rollout is read, never the whole file. Records are cached in
<replays>/.cache/index.json keyed by path with (size, mtime); only files whose key changed are rescanned.
"""
import glob
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import config
from common import ts_ms

INDEX_VERSION = 3
ACTIVE_MS = 10 * 60 * 1000
HEAD_LINES, HEAD_BYTES = 60, 4_000_000
_TS_TAIL = re.compile(rb'\{"timestamp":"([^"]+)","ordinal"')
_TS_ANY = re.compile(rb'"timestamp":"([^"]+)"')


def _clip(s, n=60):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[:n] + "…"


def _tail_ts(path, pattern):
    """Timestamp of the last row, from the final 128 KB only."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 131072))
            hits = pattern.findall(f.read())
        return ts_ms(hits[-1].decode()) if hits else None
    except (OSError, ValueError):
        return None


def _text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") in ("text", "input_text"))


# ------------------------------------------------------------------ codex

def scan_codex(path):
    rec = {"tool": "codex", "path": path, "archived": os.path.dirname(path) == config.CODEX_ARCHIVED, "id": "", "parent": None,
           "agentPath": "", "cwd": "", "start": None, "model": "", "title0": "", "forked": None}
    seen_ctx = False
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            used = 0
            for i, line in enumerate(f):
                used += len(line)
                if i == 0:
                    p = json.loads(line).get("payload") or {}
                    rec.update(id=p.get("id") or "", parent=p.get("parent_thread_id"), agentPath=p.get("agent_path") or "",
                               cwd=p.get("cwd") or "", forked=p.get("forked_from_id"), nick=p.get("agent_nickname") or "")
                    if p.get("timestamp"):
                        rec["start"] = ts_ms(p["timestamp"])
                    continue
                if not seen_ctx and '"type":"turn_context"' in line[:120]:
                    try:
                        p = json.loads(line).get("payload") or {}
                        rec["model"] = p.get("model") or ""
                        seen_ctx = True
                    except ValueError:
                        pass
                elif '"UserMessage"' in line[:600] and '"item_completed"' in line[:200]:
                    try:
                        it = json.loads(line)["payload"]["item"]
                        rec["title0"] = _clip(_text_of(it.get("content")).replace("<codex_delegation>", ""), 80)
                    except (ValueError, KeyError):
                        pass
                if rec["title0"] or i >= HEAD_LINES or used > HEAD_BYTES:
                    break
    except (OSError, ValueError):
        pass
    rec["end"] = _tail_ts(path, _TS_TAIL)
    if not rec["id"]:  # file name fallback: rollout-<date>T<time>-<uuid>.jsonl
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path)
        rec["id"] = m.group(1) if m else os.path.basename(path)
    return rec


def codex_names():
    names = {}
    try:
        with open(os.path.join(config.CODEX_DIR, "session_index.jsonl"), encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                if d.get("id") and d.get("thread_name"):
                    names[d["id"]] = d["thread_name"]
    except OSError:
        pass
    return names


# ------------------------------------------------------------------ claude

def claude_names():
    """session id -> name from <claude dir>/sessions/*.json (running or recent sessions)."""
    out = {}
    for f in glob.glob(os.path.join(config.CLAUDE_SESSIONS, "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("sessionId") and d.get("name"):
            out[d["sessionId"]] = d["name"]
    return out


def claude_title_file(jsonl):
    sid = os.path.basename(jsonl)[:-6]
    try:
        with open(os.path.join(os.path.dirname(jsonl), sid, "custom-title.json"), encoding="utf-8") as f:
            return json.load(f).get("customTitle") or ""
    except (OSError, ValueError):
        return ""


def scan_claude(path):
    rec = {"tool": "claude", "path": path, "archived": False, "id": os.path.basename(path)[:-6], "parent": None, "agentPath": "",
           "cwd": "", "start": None, "model": "", "title0": "", "title": ""}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            used = 0
            for i, line in enumerate(f):
                used += len(line)
                if rec["start"] is None:
                    m = _TS_ANY.search(line.encode("utf-8", "replace")[:3000])
                    if m:
                        rec["start"] = ts_ms(m.group(1).decode())
                if not rec["cwd"]:
                    m = re.search(r'"cwd":"([^"]+)"', line[:20000])
                    if m:
                        rec["cwd"] = m.group(1)
                if not rec["title0"] and ('"type":"user"' in line[:300] or '"operation":"enqueue"' in line[:200]):
                    try:
                        r = json.loads(line)
                    except ValueError:
                        r = {}
                    txt = r.get("content") if r.get("type") == "queue-operation" else _text_of((r.get("message") or {}).get("content"))
                    txt = (txt or "").strip()
                    if txt and not txt.startswith("<"):
                        rec["title0"] = _clip(txt, 80)
                if (rec["title0"] and rec["cwd"] and rec["start"]) or i >= 300 or used > HEAD_BYTES:
                    break
    except OSError:
        pass
    rec["end"] = _tail_ts(path, _TS_ANY)
    rec["title"] = _tail_title(path)
    return rec


_TITLE = re.compile(rb'"type":"(?:custom-title|ai-title)"[^\n]*?"(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"')


def _tail_title(path):
    """Last title line within the final 2 MB (custom-title lines are appended on rename)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 2_000_000))
            hits = _TITLE.findall(f.read())
        return json.loads('"%s"' % hits[-1].decode("utf-8", "replace")) if hits else ""
    except (OSError, ValueError):
        return ""


# ------------------------------------------------------------------ cache + listing

def _files():
    out = []
    for p in glob.glob(os.path.join(config.CLAUDE_PROJECTS, "*", "*.jsonl")):
        out.append(("claude", p))
    for p in glob.glob(os.path.join(config.CODEX_SESSIONS, "*", "*", "*", "rollout-*.jsonl")):
        out.append(("codex", p))
    for p in glob.glob(os.path.join(config.CODEX_ARCHIVED, "rollout-*.jsonl")):
        out.append(("codex", p))
    return out


def _load_cache():
    try:
        with open(config.INDEX_FILE, encoding="utf-8") as f:
            d = json.load(f)
        if d.get("version") == INDEX_VERSION:
            return d.get("files", {})
    except (OSError, ValueError):
        pass
    return {}


def _save_cache(files):
    try:
        os.makedirs(config.CACHE_DIR, exist_ok=True)
        tmp = config.INDEX_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": INDEX_VERSION, "files": files}, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, config.INDEX_FILE)
    except OSError:
        pass


def build_index(refresh=False):
    """-> (records by path, stats). refresh=True ignores the cache and rescans every file."""
    t0 = time.time()
    cache = {} if refresh else _load_cache()
    todo, keep = [], {}
    for tool, p in _files():
        try:
            st = os.stat(p)
        except OSError:
            continue
        c = cache.get(p)
        if c and c["size"] == st.st_size and c["mtime"] == st.st_mtime:
            keep[p] = c
        else:
            todo.append((tool, p, st))

    def one(a):
        tool, p, st = a
        rec = scan_codex(p) if tool == "codex" else scan_claude(p)
        return p, {"size": st.st_size, "mtime": st.st_mtime, "rec": rec}

    with ThreadPoolExecutor(8) as ex:
        for p, c in ex.map(one, todo):
            keep[p] = c
    if todo or len(keep) != len(cache):
        _save_cache(keep)
    return {p: dict(c["rec"], size=c["size"], mtime=c["mtime"]) for p, c in keep.items()}, {"scanned": len(todo), "total": len(keep), "seconds": time.time() - t0}


def codex_tree(recs, root_id):
    """{thread id: path} for a root thread and all its descendants."""
    by_id, kids = {}, {}
    for r in recs.values():
        if r["tool"] != "codex":
            continue
        if r["id"] not in by_id or r["mtime"] > by_id[r["id"]]["mtime"]:
            by_id[r["id"]] = r
    for r in by_id.values():
        if r["parent"]:
            kids.setdefault(r["parent"], []).append(r["id"])
    tree, stack = {}, [root_id]
    while stack:
        tid = stack.pop()
        if tid in tree or tid not in by_id:
            continue
        tree[tid] = by_id[tid]["path"]
        stack.extend(kids.get(tid, []))
    return tree


def list_sessions(recs, now_ms=None):
    """One row per top-level session (Codex sub-agent threads and Claude subagent files are folded into `subs`)."""
    now_ms = now_ms or int(time.time() * 1000)
    cnames, xnames = codex_names(), claude_names()
    by_id, kids = {}, {}
    for r in recs.values():
        if r["tool"] == "codex" and (r["id"] not in by_id or r["mtime"] > by_id[r["id"]]["mtime"]):
            by_id[r["id"]] = r
    for r in by_id.values():
        if r["parent"] and r["parent"] in by_id:
            kids.setdefault(r["parent"], []).append(r)
    rows = []

    def descendants(tid):
        out, stack = [], list(kids.get(tid, []))
        while stack:
            r = stack.pop()
            out.append(r)
            stack.extend(kids.get(r["id"], []))
        return out

    for r in by_id.values():
        if r["parent"] and r["parent"] in by_id:
            continue  # nested under its parent session
        d = descendants(r["id"])
        mt = max([r["mtime"]] + [x["mtime"] for x in d])
        name = cnames.get(r["id"]) or r.get("title0") or ""
        rows.append(_row(r, name, d and len(d) or 0, sum(x["size"] for x in d), mt, now_ms, orphan=bool(r["parent"])))
    for r in recs.values():
        if r["tool"] != "claude":
            continue
        sub_dir = os.path.join(os.path.dirname(r["path"]), r["id"], "subagents")
        subs, sub_size, mt = 0, 0, r["mtime"]
        try:
            for fn in os.listdir(sub_dir):
                if fn.startswith("agent-") and fn.endswith(".jsonl"):
                    st = os.stat(os.path.join(sub_dir, fn))
                    subs, sub_size, mt = subs + 1, sub_size + st.st_size, max(mt, st.st_mtime)
        except OSError:
            pass
        name = claude_title_file(r["path"]) or xnames.get(r["id"]) or r.get("title") or r.get("title0") or ""
        if not r["cwd"]:
            r = dict(r, cwd=os.path.basename(os.path.dirname(r["path"])))
        rows.append(_row(r, name, subs, sub_size, mt, now_ms))
    rows.sort(key=lambda x: -(x["end"] or 0))
    return rows


def _row(r, name, subs, sub_size, mtime, now_ms, orphan=False):
    end = max(r.get("end") or 0, int(mtime * 1000)) if r.get("end") or mtime else 0
    active = now_ms - int(mtime * 1000) < ACTIVE_MS
    return {"key": "%s:%s" % (r["tool"], r["id"]), "tool": r["tool"], "id": r["id"], "name": name, "named": bool(name),
            "cwd": r.get("cwd") or "", "project": os.path.basename((r.get("cwd") or "").rstrip("/")) or r.get("cwd") or "",
            "start": r.get("start"), "end": end, "size": r["size"] + sub_size, "subs": subs, "model": r.get("model") or "",
            "status": "active" if active else ("archived" if r.get("archived") else ""), "archived": bool(r.get("archived")),
            "path": r["path"], "orphan": orphan}


def find(recs, key):
    """key 'tool:id' (or a bare id prefix) -> record or None; ambiguous prefixes return None."""
    tool, _, ident = key.partition(":") if ":" in key else ("", "", key)
    hits = [r for r in recs.values() if (not tool or r["tool"] == tool) and r["id"].startswith(ident)]
    exact = [r for r in hits if r["id"] == ident]
    hits = exact or hits
    if len(hits) > 1:
        hits = [max(hits, key=lambda r: r["mtime"])] if len({r["id"] for r in hits}) == 1 else []
    return hits[0] if len(hits) == 1 else None


def detect_tool(path):
    """Codex rollouts start with a session_meta row carrying an ordinal; Claude transcripts do not."""
    try:
        with open(path, "rb") as f:
            head = f.read(300)
        return "codex" if head.startswith(b'{"timestamp":') and b'"type":"session_meta"' in head else "claude"
    except OSError:
        return "claude"


def fmt_ms(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M") if ms else "-"
