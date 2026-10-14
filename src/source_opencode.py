"""opencode source: sessions live in one SQLite database (<root>/opencode*.db), opened strictly read-only.

Every top-level session is one virtual path "<db>#<session id>" (see opencode_scan.py); sub-sessions are folded into the
row of their top-level session and into its tree. There is no live view: the database is another program's working
store, and polling it is left out of this first version (live_supported = False).

Pricing: opencode talks to many providers, so a step is priced by its model name from the tables the tool already has
(the "claude", "codex" and "gemini" sections of prices.json, in that order). A model found in none is unpriced: its tokens
count, its amount does not. The session's own cost column is not used (opencode leaves it at 0 for many setups).
"""
import os
import re

import prices
import opencode_scan
import source_claude
import source_codex
import source_gemini
from scan_util import make_row
from sources import Source

LOCAL_PROVIDERS = ("ollama", "lmstudio", "llama.cpp", "llamacpp")  # providers that run models on this machine: cost 0
_VENDOR_PREFIX = re.compile(r"^(?:[a-z0-9_.-]+/)+")  # openrouter / gateway style "anthropic/claude-..."
_BEDROCK = re.compile(r"^(?:(?:us|eu|apac|global)\.)?anthropic\.|-v\d+(?::\d+)?$")


def opencode_tokens(usage):
    """Token vector of an opencode step. opencode reports reasoning separately from output and input without the cached
    part; the vector follows the Codex shape: out includes the reasoning tokens, rsn tells how many of them there were."""
    out = (usage.get("out", 0) or 0) + (usage.get("rsn", 0) or 0)
    return {"in": usage.get("in", 0) or 0, "cw5": usage.get("cw", 0) or 0, "cw1": 0, "cr": usage.get("cr", 0) or 0, "out": out, "rsn": usage.get("rsn", 0) or 0}


def lookup_names(model):
    """Candidate price table keys of a model name: provider prefixes, Bedrock affixes and a date suffix removed."""
    m = _BEDROCK.sub("", _VENDOR_PREFIX.sub("", (model or "").strip().lower()))
    m = prices.norm_model(m)
    return [m] if "." not in m else [m, re.sub(r"(\d)\.(\d)", r"\1-\2", m)]


def price_step(model, usage):
    """Price one assistant message. usage = {in, cw, cr, out, rsn, provider, day}; see opencode_tokens. day (UTC, YYYY-MM-DD)
    only matters for Gemini models, whose table can carry dated price changes."""
    tok = opencode_tokens(usage)
    if (usage.get("provider") or "").lower() in LOCAL_PROVIDERS:
        return prices.result(0.0, tok, True, local=True)
    table = prices.load()
    for name in lookup_names(model):
        if name in ((table.get("claude") or {}).get("models") or {}):
            r = source_claude.price_step(name, {"input_tokens": tok["in"], "cache_creation_input_tokens": tok["cw5"],
                                                "cache_read_input_tokens": tok["cr"], "output_tokens": tok["out"]})
            return prices.result(r["cost"], tok, r["priced"])
        if name in ((table.get("codex") or {}).get("models") or {}):
            r = source_codex.price_step(name, {"in": tok["in"] + tok["cw5"] + tok["cr"], "cached": tok["cr"], "cw": tok["cw5"], "out": tok["out"], "rsn": tok["rsn"]})
            return prices.result(r["cost"], tok, r["priced"])
        if name in ((table.get("gemini") or {}).get("models") or {}):
            # the gemini section expects input to contain the cached part, and thoughts apart from output
            r = source_gemini.price_step(name, {"input": tok["in"] + tok["cw5"] + tok["cr"], "cached": tok["cr"],
                                                "output": tok["out"] - tok["rsn"], "thoughts": tok["rsn"], "day": usage.get("day") or ""})
            return prices.result(r["cost"], tok, r["priced"])
    return prices.result(None, tok, False)


class OpencodeSource(Source):
    id = "opencode"
    label = "opencode"
    color = "var(--c-write)"
    dir_flag = "--opencode-dir"
    dir_envs = ("AGENT_REPLAY_OPENCODE_DIR",)
    dir_default = os.path.join("~", ".local", "share", "opencode")
    dir_help = "opencode 数据目录（含 opencode*.db），默认 $XDG_DATA_HOME/opencode 或 ~/.local/share/opencode"
    live_supported = False
    page = {"fams": False, "notes": {
        "why": "推理摘要来自 reasoning 部分（部分模型不提供）；工具调用前的说明取自同一条消息里的文字",
        "mainSteps": "一条助手消息算一步（每次模型调用一条）",
        "hooks": "opencode 没有结构化的拦截记录",
        "lastText": "取该子会话最后一条不带工具调用的回复"}}

    @property
    def root(self):
        """The configured root; with XDG_DATA_HOME set and no explicit option or variable, opencode's own data directory."""
        root = super().root
        xdg = os.environ.get("XDG_DATA_HOME", "").strip()
        if xdg and root == os.path.abspath(os.path.expanduser(self.dir_default)):
            return os.path.abspath(os.path.join(os.path.expanduser(xdg), "opencode"))
        return root

    def files(self):
        return opencode_scan.files(self.root)

    def stat(self, path):
        return opencode_scan.stat(path)

    def scan(self, path):
        return opencode_scan.scan(path)

    def rows(self, recs, now_ms):
        """Sub-sessions are already folded into each record (subs, and the tree size / mtime in stat)."""
        return [make_row(r, r.get("title0") or "", r.get("subs", 0), 0, r["mtime"], now_ms) for r in recs]

    def tree(self, recs, root_id, path):
        return opencode_scan.tree(path)

    def tree_for_path(self, path, root_id):
        return opencode_scan.split(path)[1], opencode_scan.tree(path)

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        from parse_opencode import parse_opencode
        return parse_opencode(root_id, tree, name, out_chars, inp_chars, progress)

    def price_step(self, model, usage):
        return price_step(model, usage)


SOURCE = OpencodeSource()
