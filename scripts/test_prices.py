#!/usr/bin/env python3
"""Unit tests for the per-step pricing of the sources (src/source_claude.py, src/source_codex.py) (pure Python, no session data).

Every expected amount is worked out by hand from the rates in src/prices.json, which are quoted next to each case.
Run directly, or import run() from scripts/check.py; run() returns (cases, failures).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import prices  # noqa: E402
import source_claude  # noqa: E402
import source_codex  # noqa: E402
import source_opencode  # noqa: E402

EPS = 1e-9


def near(a, b):
    return a is not None and abs(a - b) < EPS


def with_other(section, fn):
    """Run fn with a synthetic "other" price section in place of the real one (the real numbers change whenever vendors do)."""
    table = prices.load()
    saved = table.get("other")
    table["other"] = section
    try:
        return fn()
    finally:
        if saved is None:
            table.pop("other", None)
        else:
            table["other"] = saved


def cases():
    out = []

    def case(name, ok):
        out.append((name, bool(ok)))

    # sonnet-5-5: in 2, cache write 5m 2.5, 1h 4, read 0.1, out 10 per million
    u = {"input_tokens": 1000, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 10000, "output_tokens": 500,
         "cache_creation": {"ephemeral_5m_input_tokens": 2000, "ephemeral_1h_input_tokens": 3000}}
    r = source_claude.price_step("claude-sonnet-5-5", u)
    case("claude: cache write split into 5m and 1h", near(r["cost"], (1000 * 2 + 2000 * 2.5 + 3000 * 4 + 10000 * 0.1 + 500 * 10) / 1e6) and
         r["tok"]["cw5"] == 2000 and r["tok"]["cw1"] == 3000)
    r = source_claude.price_step("claude-sonnet-5-5", {"input_tokens": 1000, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 10000, "output_tokens": 500})
    case("claude: no breakdown -> whole cache write at the 5m rate", near(r["cost"], (1000 * 2 + 5000 * 2.5 + 10000 * 0.1 + 500 * 10) / 1e6) and r["tok"]["cw1"] == 0)
    # haiku-5-5 tiers by prompt = input + cache read + cache write: <= 100000 -> (0.1, 0.01, 0.5), above -> (0.5, 0.05, 2.5)
    low = source_claude.price_step("claude-haiku-5-5", {"input_tokens": 1000, "cache_read_input_tokens": 50000, "output_tokens": 1000})
    case("claude: haiku 5.5 first tier", near(low["cost"], (1000 * 0.1 + 50000 * 0.01 + 1000 * 0.5) / 1e6))
    edge = source_claude.price_step("claude-haiku-5-5", {"input_tokens": 1000, "cache_read_input_tokens": 99000, "output_tokens": 0})
    case("claude: haiku 5.5 prompt of exactly 100000 stays in the first tier", near(edge["cost"], (1000 * 0.1 + 99000 * 0.01) / 1e6))
    high = source_claude.price_step("claude-haiku-5-5", {"input_tokens": 1000, "cache_read_input_tokens": 150000, "output_tokens": 1000})
    case("claude: haiku 5.5 second tier", near(high["cost"], (1000 * 0.5 + 150000 * 0.05 + 1000 * 2.5) / 1e6))
    us = source_claude.price_step("claude-sonnet-5-5", dict(u, inference_geo="us"))
    case("claude: inference_geo us multiplies by 1.1", near(us["cost"], 1.1 * (1000 * 2 + 2000 * 2.5 + 3000 * 4 + 10000 * 0.1 + 500 * 10) / 1e6))
    case("claude: inference_geo not_available is not multiplied", near(source_claude.price_step("claude-sonnet-5-5", dict(u, inference_geo="not_available"))["cost"], 0.025))
    dated = source_claude.price_step("claude-haiku-4-5-20251001", {"input_tokens": 1000000, "output_tokens": 1000000})
    case("claude: date suffix is stripped before the lookup", near(dated["cost"], 1 + 5))
    fast = source_claude.price_step("claude-opus-5-5", {"input_tokens": 1000000, "service_tier": "priority"})
    case("claude: non-standard service tier is priced at standard rates and flagged", near(fast["cost"], 4.0) and fast["fast"] is True)
    case("claude: standard tier is not flagged", source_claude.price_step("claude-opus-5-5", {"input_tokens": 10, "service_tier": "standard"})["fast"] is False)
    syn = source_claude.price_step("<synthetic>", {"input_tokens": 5})
    case("claude: <synthetic> costs nothing", syn["cost"] == 0.0 and syn["priced"])
    unk = source_claude.price_step("claude-sonnet-3-7", {"input_tokens": 1000, "output_tokens": 10})
    case("claude: unknown model has no amount but its tokens are counted", unk["cost"] is None and not unk["priced"] and unk["tok"]["in"] == 1000)

    # gpt-6-sol: in 2, cached 0.2, cache write 2.5, out 10; long context (input over 272000): in 4, out 15
    last = {"in": 10000, "cached": 6000, "cw": 1000, "out": 500, "rsn": 200}
    r = source_codex.price_step("gpt-6-sol", last)
    case("codex: cached input and cache write are taken out of the uncached input",
         r["tok"]["in"] == 3000 and near(r["cost"], (3000 * 2 + 1000 * 2.5 + 6000 * 0.2 + 500 * 10) / 1e6))
    case("codex: reasoning tokens are reported but not billed twice", r["tok"]["rsn"] == 200 and r["tok"]["out"] == 500)
    case("codex: uncached input never goes below zero", source_codex.price_step("gpt-6-sol", {"in": 100, "cached": 80, "cw": 50, "out": 0})["tok"]["in"] == 0)
    # gpt-5.5 has no cache write price: those tokens bill as uncached input (5 per million)
    r = source_codex.price_step("gpt-5.5", {"in": 1000, "cached": 200, "cw": 300, "out": 100})
    case("codex: no cache write price -> billed as uncached input", near(r["cost"], (500 * 5 + 300 * 5 + 200 * 0.5 + 100 * 30) / 1e6))
    r = source_codex.price_step("gpt-6-sol", {"in": 300000, "cached": 100000, "cw": 0, "out": 1000})
    case("codex: long context uses the long rates and 10% of the long input rate for cached input",
         near(r["cost"], (200000 * 4 + 100000 * 0.4 + 1000 * 15) / 1e6))
    r = source_codex.price_step("gpt-6-sol", {"in": 272000, "cached": 0, "cw": 0, "out": 0})
    case("codex: exactly 272000 input tokens is not long context", near(r["cost"], 272000 * 2 / 1e6))
    r = source_codex.price_step("gpt-6-sol", {"in": 300000, "cached": 0, "cw": 10000, "out": 0})
    case("codex: long context cache write keeps its premium (rate scaled by long / base input)", near(r["cost"], (290000 * 4 + 10000 * 5) / 1e6))
    r = source_codex.price_step("gpt-6-luna", {"in": 300000, "cached": 0, "cw": 0, "out": 0})
    case("codex: a model without long-context rates keeps the base rates", near(r["cost"], 300000 * 0.1 / 1e6))
    for m in ("gpt-5.3-codex-spark", "gpt-4.5", ""):
        r = source_codex.price_step(m, {"in": 100, "cached": 0, "cw": 0, "out": 10})
        case("codex: unpriced model %r has no amount, tokens counted" % m, r["cost"] is None and not r["priced"] and r["tok"]["out"] == 10)
    for m in ("deepseek/coder-v2", "qwen2.5-coder:7b", "ollama-llama3"):
        r = source_codex.price_step(m, {"in": 1000, "cached": 0, "cw": 0, "out": 10})
        case("local model %r costs 0 and is marked local" % m, r["cost"] == 0.0 and r["local"] and r["priced"])
    case("claude: a local model name costs 0", source_claude.price_step("org/model", {"input_tokens": 5})["local"])

    t = prices.zero_tok(codex=True)
    prices.add_tok(t, {"in": 1, "cw5": 2, "cw1": 3, "cr": 4, "out": 5, "rsn": 6}, 2)
    case("token vectors add and total", t["in"] == 2 and t["rsn"] == 12 and prices.tok_total(t) == 2 * (1 + 2 + 3 + 4 + 5))
    # "other" section (every vendor that has no section of its own), on a synthetic table: rates per million tokens
    syn = {"models": {
        "vend-a": {"input": 1, "cached_input": 0.1, "cache_write": 1.25, "output": 4, "aliases": ["vend-a-latest"]},
        "vend-b": {"input": 2, "cached_input": None, "cache_write": None, "output": 8,
                   "long_context": {"over_input_tokens": 200000, "input": 4, "cached_input": None, "output": 12},
                   "changes": [{"from": "2027-01-01", "input": 3, "output": 9}]}}}
    tok = {"in": 1000, "cw5": 2000, "cw1": 0, "cr": 10000, "out": 500}

    def other():
        res = {}
        res["a"] = prices.other_step("vend-a", tok)
        res["alias"] = prices.other_step("VEND-A-LATEST", tok)
        res["dated"] = prices.other_step("vend-a-20260101", tok)
        res["b"] = prices.other_step("vend-b", tok)
        res["b_long"] = prices.other_step("vend-b", {"in": 100000, "cw5": 0, "cw1": 0, "cr": 150000, "out": 1000})
        res["b_edge"] = prices.other_step("vend-b", {"in": 100000, "cw5": 0, "cw1": 0, "cr": 100000, "out": 0})
        res["b_new"] = prices.other_step("vend-b", tok, "2027-01-01")
        res["b_old"] = prices.other_step("vend-b", tok, "2026-12-31")
        res["unknown"] = prices.other_step("nobody", tok)
        res["oc"] = source_opencode.price_step("vend-a", {"in": 1000, "cw": 2000, "cr": 10000, "out": 400, "rsn": 100, "provider": "x"})
        res["oc_prefix"] = source_opencode.price_step("vendor/vend-a-latest", {"in": 1000, "out": 10, "provider": "x"})
        return res
    r = with_other(syn, other)
    a_cost = (1000 * 1 + 2000 * 1.25 + 10000 * 0.1 + 500 * 4) / 1e6
    case("other: input, cache write, cache read and output at their own rates", near(r["a"], a_cost))
    case("other: aliases and a date suffix find the same entry", near(r["alias"], a_cost) and near(r["dated"], a_cost))
    case("other: a rate the vendor does not list (null) bills those tokens as uncached input", near(r["b"], (1000 * 2 + 2000 * 2 + 10000 * 2 + 500 * 8) / 1e6))
    case("other: long context (prompt = input + cache read + cache write over the limit) replaces the listed rates",
         near(r["b_long"], (100000 * 4 + 150000 * 4 + 1000 * 12) / 1e6))
    case("other: a prompt of exactly the limit stays on the base rates", near(r["b_edge"], 200000 * 2 / 1e6))
    case("other: a dated price change applies from its day on", near(r["b_new"], (3000 * 3 + 10000 * 3 + 500 * 9) / 1e6) and near(r["b_old"], r["b"]))
    case("other: unknown model has no amount", r["unknown"] is None)
    case("other: opencode prices a model that only the other section lists (reasoning billed as output)",
         r["oc"]["priced"] and near(r["oc"]["cost"], (1000 * 1 + 2000 * 1.25 + 10000 * 0.1 + 500 * 4) / 1e6) and r["oc"]["tok"]["rsn"] == 100)
    case("other: opencode finds it through a gateway prefix and an alias", r["oc_prefix"]["priced"] and near(r["oc_prefix"]["cost"], (1000 * 1 + 10 * 4) / 1e6))
    case("other: the real table is untouched after the synthetic one", prices.other_step("vend-a", tok) is None)
    return out


def run():
    res = cases()
    return res, [n for n, ok in res if not ok]


if __name__ == "__main__":
    allc, bad = run()
    for n, ok in allc:
        print("[%s] %s" % ("ok" if ok else "FAIL", n))
    print("%d cases, %d failed" % (len(allc), len(bad)))
    sys.exit(1 if bad else 0)
