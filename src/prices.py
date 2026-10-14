"""Price table, token vectors and display rules shared by every source.

prices.json holds the official list prices (USD per million tokens) in one section per source id, its source links, the
read date (read_date, overridden per source by read_dates.<id>) and the rules that are applied. A step is priced from its own token usage by its source's price_step
(source_claude.py, source_codex.py); every aggregate in the tool sums those per-step results.

The "other" section is not a source of its own: it holds the models of every other vendor (xAI, DeepSeek, Moonshot, ...) that a
multi-provider tool such as opencode can use, found by model name (or one of its aliases) through other_step().

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
TOK_KEYS = ("in", "cw5", "cw1", "cr", "out")


def load():
    """The parsed prices.json (empty tables when the file is missing or broken)."""
    if not _CACHE:
        try:
            with open(os.path.join(_HERE, "prices.json"), encoding="utf-8") as f:
                _CACHE.update(json.load(f))
        except (OSError, ValueError):
            _CACHE.update({"_unavailable": True})  # every source section is missing: all models are unpriced
    return _CACHE


def meta(tool):
    """Small description of the price table for the page: read date, source link and the rules applied."""
    d = load()
    t = d.get(tool) or {}
    return {"readDate": (d.get("read_dates") or {}).get(tool) or d.get("read_date", ""), "source": (d.get("sources") or {}).get(tool, ""), "rules": list(t.get("_rules") or []),
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


def norm_model(model):
    """Price table key of a model name: lower case, without a trailing -YYYYMMDD date."""
    return _DATE_SUFFIX.sub("", (model or "").strip().lower())


def rates(entry, prompt, day=""):
    """Rates of a model entry for a prompt of this many tokens on this UTC day (YYYY-MM-DD, "" = today's table):
    the latest dated change (changes: [{from, ...rates}]) that already applies replaces the base rates, then the
    long-prompt tier (long_context: {over_prompt_tokens | over_input_tokens, ...rates}) replaces what it lists."""
    base = entry
    for ch in sorted(entry.get("changes") or (), key=lambda c: c["from"]):
        if day and day >= ch["from"]:
            base = dict(entry, **ch)
    lc = base.get("long_context")
    if lc and prompt > lc.get("over_prompt_tokens", lc.get("over_input_tokens", float("inf"))):
        return dict(base, **lc)
    return base


_ALIASES = {}  # alias -> model key of the "other" section; rebuilt when the section object changes


def other_entry(model):
    """The "other" section entry of a model name (its key or one of its aliases), None when it is not listed."""
    models = (load().get("other") or {}).get("models") or {}
    if _ALIASES.get("") is not models:
        _ALIASES.clear()
        _ALIASES[""] = models
        for key, e in models.items():
            for a in e.get("aliases") or ():
                _ALIASES.setdefault(norm_model(a), key)
    key = norm_model(model)
    return models.get(key) or models.get(_ALIASES.get(key))


def other_step(model, tok, day=""):
    """Price a step of a model of the "other" section, None when the model is not listed there.
    tok = {in (uncached), cw5 / cw1 (cache write), cr (cache read), out (reasoning included)}; day = UTC date of the message.
    A rate the vendor does not list (cached_input, cache_write: null) bills those tokens as uncached input."""
    e = other_entry(model)
    if e is None:
        return None
    cw = tok.get("cw5", 0) + tok.get("cw1", 0)
    p = rates(e, tok.get("in", 0) + cw + tok.get("cr", 0), day)
    inp = p["input"]
    cached = inp if p.get("cached_input") is None else p["cached_input"]
    write = inp if p.get("cache_write") is None else p["cache_write"]
    return (tok.get("in", 0) * inp + cw * write + tok.get("cr", 0) * cached + tok.get("out", 0) * p["output"]) / 1e6


def result(cost, tok, priced, local=False, fast=False):
    """A priced step (see the module docstring); the sources' price_step functions build theirs with this."""
    return {"cost": cost, "tok": tok, "priced": priced, "local": local, "fast": fast}


