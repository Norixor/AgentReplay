"""Estimated amount per session for the session list, remembered after a session has been opened and parsed once.

The list never parses sessions for this column: an entry is written when the server finishes a parse and is used only
while the session's total file size is unchanged, so a session that grew since (or was never opened) shows no amount.
Stored in <replays>/.cache/costs.json as {"claude:<id>": {"size": bytes, "cost": USD, "tok": tokens, "unp": steps}}.
"""
import json
import os
import threading

import config
from prices import tok_total

_LOCK = threading.Lock()
_MEM = {"path": None, "data": None}
MAX_ENTRIES = 5000


def _file():
    return os.path.join(config.CACHE_DIR, "costs.json")


def _load():
    path = _file()
    if _MEM["path"] != path:  # the data directory changed (tests, demo): start from that directory's file
        _MEM["path"], _MEM["data"] = path, {}
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                _MEM["data"] = d
        except (OSError, ValueError):
            pass
    return _MEM["data"]


def lookup(key, size):
    """{"cost", "tok", "unp"} for a session whose files still have this total size, else None."""
    with _LOCK:
        e = _load().get(key)
    return e if e and e.get("size") == size else None


def store(key, size, totals):
    """Remember the totals of a freshly parsed session (totals is the parser's "totals" block)."""
    entry = {"size": size, "cost": round(totals["cost"], 6), "tok": round(tok_total(totals["tok"])), "unp": totals.get("nUnp", 0)}
    with _LOCK:
        data = _load()
        data[key] = entry
        if len(data) > MAX_ENTRIES:
            for k in list(data)[:len(data) - MAX_ENTRIES]:
                del data[k]
        try:
            os.makedirs(config.CACHE_DIR, exist_ok=True)
            tmp = _file() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, separators=(",", ":"))
            os.replace(tmp, _file())
        except OSError:
            pass
