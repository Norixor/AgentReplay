"""Gemini CLI source: main sessions in <root>/tmp/<project>/chats/, sub-agent sessions one directory deeper (see gemini_scan).

Sessions without any model reply (the 139 "a2a-serv" files of the Gemini A2A server hold only user messages) would bury
the real ones, so the list leaves out a session that has no reply unless it is still in progress (see rows()).
"""
import glob
import os

import prices
from gemini_scan import scan
from scan_util import make_row
from sources import Source


# ---------------------------------------------------------------- pricing

def gemini_tokens(u):
    """Token vector of a Gemini tokens block {input, output, cached, thoughts, tool}.

    input already contains the cached tokens (total = input + output + thoughts + tool), thoughts are billed as output
    (rsn is the part of out that was thinking), tool-use prompt tokens are billed like input."""
    u = u or {}
    inp = max(0, int(u.get("input") or 0))
    cached = min(max(0, int(u.get("cached") or 0)), inp)
    th = max(0, int(u.get("thoughts") or 0))
    return {"in": inp - cached + max(0, int(u.get("tool") or 0)), "cw5": 0, "cw1": 0, "cr": cached,
            "out": max(0, int(u.get("output") or 0)) + th, "rsn": th}


def price_step(model, usage):
    """Price one Gemini response. usage = {input, output, cached, thoughts, tool} plus an optional "day" (the message date)."""
    tok = gemini_tokens(usage)
    entry = (prices.load().get("gemini") or {}).get("models", {}).get(prices.norm_model(model))
    if not entry:
        return prices.result(None, tok, False)
    p = prices.rates(entry, tok["in"] + tok["cr"], (usage or {}).get("day") or "")
    cost = (tok["in"] * p["input"] + tok["cr"] * p["cached_input"] + tok["out"] * p["output"]) / 1e6
    return prices.result(cost, tok, True)


# ---------------------------------------------------------------- adapter

class GeminiSource(Source):
    id = "gemini"
    label = "Gemini CLI"
    color = "var(--c-agent)"
    dir_flag = "--gemini-dir"
    dir_envs = ("AGENT_REPLAY_GEMINI_DIR",)
    dir_help = "Gemini CLI 数据目录（含 tmp/），默认 $GEMINI_CLI_HOME/.gemini 或 ~/.gemini"
    live_supported = False
    page = {"fams": False, "notes": {
        "why": "Gemini 只记录思考摘要（主题与说明），原始思考不在记录里",
        "mainSteps": "一条 gemini 消息算一步（同一 id 写了两遍的按 id 合并）",
        "hooks": "Gemini CLI 的会话文件不记录钩子拦截",
        "lastText": "取 invoke_agent 返回的结果，没有时取子代理的 complete_task 参数、summary 或最后一段文字"}}

    @property
    def dir_default(self):
        # GEMINI_CLI_HOME is the directory that contains .gemini, not the data directory itself.
        return os.path.join(os.environ.get("GEMINI_CLI_HOME", "").strip() or "~", ".gemini")

    def files(self):
        tmp = os.path.join(self.root, "tmp")
        return (glob.glob(os.path.join(tmp, "*", "chats", "session-*.json*")) +
                glob.glob(os.path.join(tmp, "*", "chats", "*", "*.jsonl")))

    def sniff(self, head):
        """Current-format files start with a metadata record that has a sessionId and a projectHash; legacy files are JSON documents."""
        return head.lstrip().startswith(b"{") and b'"sessionId"' in head and b'"projectHash"' in head

    def scan(self, path):
        return scan(path, self.root)

    @staticmethod
    def _newest_by_id(recs):
        by_id = {}
        for r in recs:
            if r["id"] not in by_id or r["mtime"] > by_id[r["id"]]["mtime"]:
                by_id[r["id"]] = r
        return by_id

    def rows(self, recs, now_ms):
        """Sub-agent sessions fold into their main session's row. A session that never got a model reply is listed only
        while it is in progress (its newest file changed within the activity window)."""
        by_id, kids = self._newest_by_id(recs), {}
        for r in by_id.values():
            if r["parent"] and r["parent"] in by_id:
                kids.setdefault(r["parent"], []).append(r)
        rows = []
        for r in by_id.values():
            if r["parent"] and r["parent"] in by_id:
                continue
            d = kids.get(r["id"], [])
            row = make_row(r, r.get("title0") or "", len(d), sum(x["size"] for x in d), max([r["mtime"]] + [x["mtime"] for x in d]),
                           now_ms, orphan=bool(r["parent"]))
            if not (r.get("replies") or any(x.get("replies") for x in d) or row["status"] == "active"):
                continue
            if not row["project"]:
                p = r.get("proj") or ""
                row["project"] = p[:8] if len(p) == 64 else p
            rows.append(row)
        return rows

    def tree(self, recs, root_id, path):
        """{session id: path}: the main session under its own id, then the sub-agent sessions stored under its directory."""
        tree = {root_id: path}
        subs = self._newest_by_id(r for r in recs.values() if r["tool"] == self.id and r["parent"] == root_id)
        for sid in sorted(subs, key=lambda s: subs[s].get("start") or 0):
            tree[sid] = subs[sid]["path"]
        return tree

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        from parse_gemini import parse_gemini
        return parse_gemini(root_id, tree, name, out_chars, inp_chars, progress)

    def price_step(self, model, usage):
        return price_step(model, usage)


SOURCE = GeminiSource()
