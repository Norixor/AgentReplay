"""Price table and per-step pricing for Claude Code and Codex.

prices.json holds the official list prices (USD per million tokens), its source links, the read date and the rules that
are applied here. A step is priced from its own token usage; every aggregate in the tool sums those per-step results.

A priced step is {"cost": float|None, "tok": {...}, "priced": bool, "local": bool, "fast": bool}:
  cost    USD, None when the model is not in the table (its tokens are still counted, the amount is left out of all totals)
  tok     in (uncached input), cw5 / cw1 (cache write, 5 min / 1 h), cr (cache read), out (output); Codex adds rsn
          (reasoning tokens, already included in out)
  local   a local / open-weight model: costs 0
  fast    a Claude request whose service_tier is not "standard": priced at standard rates, flagged
"""
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
_CACHE = {}
_DATE_SUFFIX = re.compile(r"-\d{8}$")
US_GEO_FACTOR = 1.1
CODEX_CACHED_LONG_RATIO = 0.1  # cached input in long context = 10% of the long-context input rate (an assumption, see prices.json)
TOK_KEYS = ("in", "cw5", "cw1", "cr", "out")


def load():
    """The parsed prices.json (empty tables when the file is missing or broken)."""
    if not _CACHE:
        try:
            with open(os.path.join(_HERE, "prices.json"), encoding="utf-8") as f:
                _CACHE.update(json.load(f))
        except (OSError, ValueError):
            _CACHE.update({"claude": {"models": {}}, "codex": {"models": {}}})
    return _CACHE


def meta(tool):
    """Small description of the price table for the page: read date, source link and the rules applied."""
    d = load()
    t = d.get(tool) or {}
    return {"readDate": d.get("read_date", ""), "source": (d.get("sources") or {}).get(tool, ""), "rules": list(t.get("_rules") or []),
            "models": sorted((t.get("models") or {}).keys())}


# ---------------------------------------------------------------- token vectors

def zero_tok(codex=False):
    t = {k: 0 for k in TOK_KEYS}
    if codex:
        t["rsn"] = 0
    return t


def add_tok(dst, src, k=1.0):
    """dst += src * k, in place; dst gains "rsn" only when src has it."""
    for key in TOK_KEYS + (("rsn",) if "rsn" in src else ()):
        dst[key] = dst.get(key, 0) + (src.get(key, 0) if k == 1 else src.get(key, 0) * k)
    return dst


def tok_total(tok):
    """Total tokens: uncached input + cache writes + cache reads + output."""
    return sum(tok.get(k, 0) for k in TOK_KEYS)


# ---------------------------------------------------------------- display (the page has the same rules in replay.js)

def fmt_money(c):
    """USD for display: under one cent "<$0.01", under $100 two decimals, above that whole dollars with thousands separators."""
    if c is None:
        return "—"
    if c <= 0:
        return "$0.00"
    if c < 0.01:
        return "<$0.01"
    return "$%.2f" % c if c < 100 else "$" + format(int(round(c)), ",")


def fmt_tokens(n):
    n = int(round(n or 0))
    return "%.1fM" % (n / 1e6) if n >= 1e6 else "%.1fk" % (n / 1e3) if n >= 1e3 else str(n)


# ---------------------------------------------------------------- model names

def is_local(model):
    """Local or open-weight models: an org/model name, an Ollama style name:tag, or an explicit ollama prefix."""
    m = (model or "").lower()
    return "/" in m or ":" in m or m.startswith("ollama")


def _norm(model):
    return _DATE_SUFFIX.sub("", (model or "").strip().lower())


def _result(cost, tok, priced, local=False, fast=False):
    return {"cost": cost, "tok": tok, "priced": priced, "local": local, "fast": fast}


# ---------------------------------------------------------------- Claude

def _tier(entry, prompt):
    """A model entry is flat, or has "tiers" ordered by max_prompt_tokens (null = no upper bound)."""
    for t in entry.get("tiers") or ():
        cap = t.get("max_prompt_tokens")
        if cap is None or prompt <= cap:
            return t
    return entry


def claude_tokens(u):
    """Token vector of a Claude usage block; the cache write splits by TTL when the usage carries the breakdown."""
    cc = u.get("cache_creation")
    total = u.get("cache_creation_input_tokens") or 0
    if isinstance(cc, dict) and ("ephemeral_5m_input_tokens" in cc or "ephemeral_1h_input_tokens" in cc):
        w5, w1 = cc.get("ephemeral_5m_input_tokens") or 0, cc.get("ephemeral_1h_input_tokens") or 0
        w5 += max(0, total - w5 - w1)  # tokens the breakdown does not explain count as 5 minute writes
    else:
        w5, w1 = total, 0
    return {"in": u.get("input_tokens") or 0, "cw5": w5, "cw1": w1, "cr": u.get("cache_read_input_tokens") or 0,
            "out": u.get("output_tokens") or 0}


def claude_step(model, u):
    """Price one Claude response from its usage block."""
    u = u or {}
    tok = claude_tokens(u)
    name = _norm(model)
    if name == "<synthetic>":
        return _result(0.0, tok, True)
    if is_local(name):
        return _result(0.0, tok, True, local=True)
    entry = (load().get("claude") or {}).get("models", {}).get(name)
    if not entry:
        return _result(None, tok, False)
    p = _tier(entry, tok["in"] + tok["cr"] + tok["cw5"] + tok["cw1"])
    cost = (tok["in"] * p["input"] + tok["cw5"] * p["cache_write_5m"] + tok["cw1"] * p["cache_write_1h"] +
            tok["cr"] * p["cache_read"] + tok["out"] * p["output"]) / 1e6
    if u.get("inference_geo") == "us":
        cost *= US_GEO_FACTOR
    return _result(cost, tok, True, fast=u.get("service_tier") not in (None, "", "standard"))


# ---------------------------------------------------------------- Codex

def codex_tokens(last):
    """Token vector of a Codex last_token_usage: input already contains the cached and cache-written tokens."""
    inp, cached, cw = last.get("in", 0) or 0, last.get("cached", 0) or 0, last.get("cw", 0) or 0
    return {"in": max(0, inp - cached - cw), "cw5": cw, "cw1": 0, "cr": cached, "out": last.get("out", 0) or 0, "rsn": last.get("rsn", 0) or 0}


def codex_step(model, last):
    """Price one Codex response. last = {in, cached, cw, out, rsn} from token_count.last_token_usage."""
    tok = codex_tokens(last)
    name = _norm(model)
    if is_local(name):
        return _result(0.0, tok, True, local=True)
    p = (load().get("codex") or {}).get("models", {}).get(name)
    if not p:
        return _result(None, tok, False)
    inp = last.get("in", 0) or 0
    rin, rout = p["input"], p["output"]
    rcached = p["cached_input"]
    rcw = p["cache_write"] if p.get("cache_write") is not None else rin
    lc = p.get("long_context")
    if lc and inp > lc["over_input_tokens"]:
        rcw = (rcw * lc["input"] / rin) if p.get("cache_write") is not None else lc["input"]
        rin, rout = lc["input"], lc["output"]
        rcached = rin * CODEX_CACHED_LONG_RATIO
    cost = (tok["in"] * rin + tok["cw5"] * rcw + tok["cr"] * rcached + tok["out"] * rout) / 1e6
    return _result(cost, tok, True)
