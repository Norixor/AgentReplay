"""Session index over every registered source (sources.py): cheap per-file metadata, cached on disk.

Each source's scan() reads only the head (and a small tail) of a file, never the whole file. Records are cached in
<replays>/.cache/index.json keyed by path with (size, mtime); only files whose key changed are rescanned.
"""
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import config
import costcache
import sources

INDEX_VERSION = 3


def _files():
    return [(src.id, p) for src in sources.all() for p in src.files()]


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
        rec = sources.get(tool).scan(p)
        return p, {"size": st.st_size, "mtime": st.st_mtime, "rec": rec}

    with ThreadPoolExecutor(8) as ex:
        for p, c in ex.map(one, todo):
            keep[p] = c
    if todo or len(keep) != len(cache):
        _save_cache(keep)
    return {p: dict(c["rec"], size=c["size"], mtime=c["mtime"]) for p, c in keep.items()}, {"scanned": len(todo), "total": len(keep), "seconds": time.time() - t0}


def list_sessions(recs, now_ms=None):
    """One row per top-level session; each source folds its sub-agent records or files into the row's `subs`."""
    now_ms = now_ms or int(time.time() * 1000)
    rows = []
    for src in sources.all():
        rows.extend(src.rows([r for r in recs.values() if r["tool"] == src.id], now_ms))
    for row in rows:  # amounts are only known for sessions parsed before and unchanged since (see costcache)
        c = costcache.lookup(row["key"], row["size"])
        row["cost"], row["tok"], row["unp"] = (c["cost"], c["tok"], c["unp"]) if c else (None, None, 0)
    rows.sort(key=lambda x: -(x["end"] or 0))
    return rows


def session_tree(recs, row):
    """{agent id: path} of a listed session (see Source.tree)."""
    return sources.get(row["tool"]).tree(recs, row["id"], row["path"])


def session_files(recs, row):
    """Every file whose change must invalidate the session's cached page (see Source.session_files)."""
    return sources.get(row["tool"]).session_files(recs, row)


def find(recs, key):
    """key 'tool:id' (or a bare id prefix) -> record or None; ambiguous prefixes return None."""
    tool, _, ident = key.partition(":") if ":" in key else ("", "", key)
    hits = [r for r in recs.values() if (not tool or r["tool"] == tool) and r["id"].startswith(ident)]
    exact = [r for r in hits if r["id"] == ident]
    hits = exact or hits
    if len(hits) > 1:
        hits = [max(hits, key=lambda r: r["mtime"])] if len({r["id"] for r in hits}) == 1 else []
    return hits[0] if len(hits) == 1 else None


def fmt_ms(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M") if ms else "-"
