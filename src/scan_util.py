"""Helpers shared by the source adapters' cheap index scans and list rows (see sources.py)."""
import os
import re

from common import ts_ms

ACTIVE_MS = 10 * 60 * 1000
HEAD_LINES, HEAD_BYTES = 60, 4_000_000
TS_ANY = re.compile(rb'"timestamp":"([^"]+)"')


def clip(s, n=60):
    s = " ".join((s or "").split())
    return s if len(s) <= n else s[:n] + "…"


def tail_ts(path, pattern):
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


def text_of(content):
    if isinstance(content, str):
        return content
    return " ".join(b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") in ("text", "input_text"))


def make_row(r, name, subs, sub_size, mtime, now_ms, orphan=False):
    """One session list row from its top-level record, folded sub-agent counts and the newest mtime of the tree."""
    end = max(r.get("end") or 0, int(mtime * 1000)) if r.get("end") or mtime else 0
    active = now_ms - int(mtime * 1000) < ACTIVE_MS
    return {"key": "%s:%s" % (r["tool"], r["id"]), "tool": r["tool"], "id": r["id"], "name": name, "named": bool(name),
            "cwd": r.get("cwd") or "", "project": os.path.basename((r.get("cwd") or "").rstrip("/")) or r.get("cwd") or "",
            "start": r.get("start"), "end": end, "size": r["size"] + sub_size, "subs": subs, "model": r.get("model") or "",
            "status": "active" if active else ("archived" if r.get("archived") else ""), "archived": bool(r.get("archived")),
            "path": r["path"], "orphan": orphan}
