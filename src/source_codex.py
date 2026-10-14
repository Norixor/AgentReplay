"""Codex source: rollouts in <root>/sessions/YYYY/MM/DD/ and <root>/archived_sessions/; sub-agent threads are rollouts
of their own whose session_meta names the parent thread."""
import glob
import json
import os
import re

import prices
from common import ts_ms
from scan_util import HEAD_BYTES, HEAD_LINES, clip, make_row, tail_ts, text_of
from sources import Source

CACHED_LONG_RATIO = 0.1  # cached input in long context = 10% of the long-context input rate (an assumption, see prices.json)
_TS_TAIL = re.compile(rb'\{"timestamp":"([^"]+)","ordinal"')


def sessions_dir(root):
    return os.path.join(root, "sessions")


def archived_dir(root):
    return os.path.join(root, "archived_sessions")


# ---------------------------------------------------------------- index

def scan(path, root):
    rec = {"tool": "codex", "path": path, "archived": os.path.dirname(path) == archived_dir(root), "id": "", "parent": None,
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
                        rec["title0"] = clip(text_of(it.get("content")).replace("<codex_delegation>", ""), 80)
                    except (ValueError, KeyError):
                        pass
                if rec["title0"] or i >= HEAD_LINES or used > HEAD_BYTES:
                    break
    except (OSError, ValueError):
        pass
    rec["end"] = tail_ts(path, _TS_TAIL)
    if not rec["id"]:  # file name fallback: rollout-<date>T<time>-<uuid>.jsonl
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$", path)
        rec["id"] = m.group(1) if m else os.path.basename(path)
    return rec


def thread_names(root):
    names = {}
    try:
        with open(os.path.join(root, "session_index.jsonl"), encoding="utf-8", errors="replace") as f:
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


def _newest_by_id(recs):
    by_id = {}
    for r in recs:
        if r["id"] not in by_id or r["mtime"] > by_id[r["id"]]["mtime"]:
            by_id[r["id"]] = r
    return by_id


def thread_tree(recs, root_id):
    """{thread id: path} for a root thread and all its descendants. recs: any records (other sources are skipped)."""
    by_id, kids = _newest_by_id(r for r in recs if r["tool"] == "codex"), {}
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


# ---------------------------------------------------------------- pricing

def codex_tokens(last):
    """Token vector of a Codex last_token_usage: input already contains the cached and cache-written tokens."""
    inp, cached, cw = last.get("in", 0) or 0, last.get("cached", 0) or 0, last.get("cw", 0) or 0
    return {"in": max(0, inp - cached - cw), "cw5": cw, "cw1": 0, "cr": cached, "out": last.get("out", 0) or 0, "rsn": last.get("rsn", 0) or 0}


def price_step(model, last):
    """Price one Codex response. last = {in, cached, cw, out, rsn} from token_count.last_token_usage."""
    tok = codex_tokens(last)
    name = prices.norm_model(model)
    if prices.is_local(name):
        return prices.result(0.0, tok, True, local=True)
    p = (prices.load().get("codex") or {}).get("models", {}).get(name)
    if not p:
        return prices.result(None, tok, False)
    inp = last.get("in", 0) or 0
    rin, rout = p["input"], p["output"]
    rcached = p["cached_input"] if p.get("cached_input") is not None else rin  # null: no cache discount listed (pro models)
    rcw = p["cache_write"] if p.get("cache_write") is not None else rin
    lc = p.get("long_context")
    if lc and inp > lc["over_input_tokens"]:
        # cached_input / cache_write of the long tier are used when the page lists them, else the scaled assumptions below
        rcw = lc["cache_write"] if lc.get("cache_write") is not None else (rcw * lc["input"] / rin) if p.get("cache_write") is not None else lc["input"]
        rcached = lc["cached_input"] if lc.get("cached_input") is not None else (rcached if p.get("cached_input") is None else lc["input"] * CACHED_LONG_RATIO)
        rin, rout = lc["input"], lc["output"]
    cost = (tok["in"] * rin + tok["cw5"] * rcw + tok["cr"] * rcached + tok["out"] * rout) / 1e6
    return prices.result(cost, tok, True)


# ---------------------------------------------------------------- adapter

class CodexSource(Source):
    id = "codex"
    label = "Codex"
    color = "var(--c-test)"
    dir_flag = "--codex-dir"
    dir_envs = ("AGENT_REPLAY_CODEX_DIR", "CODEX_HOME")
    dir_default = os.path.join("~", ".codex")
    dir_help = "Codex 数据目录（含 sessions/），默认 $CODEX_HOME 或 ~/.codex"
    ctx_limit_key = "ctxLimitCodex"
    reparse_gap = 30.0  # no incremental reader: every re-parse reads whole rollouts
    page = {"fams": False, "notes": {
        "why": "Codex 的原始推理是加密的，只有摘要可用",
        "mainSteps": "一次模型响应算一步（按 token_count 切分）",
        "hooks": "按输出文本识别（Codex 没有结构化的拦截记录）",
        "lastText": "取该线程最后一条不带工具调用的回复"}}

    def files(self):
        root = self.root
        return (glob.glob(os.path.join(sessions_dir(root), "*", "*", "*", "rollout-*.jsonl")) +
                glob.glob(os.path.join(archived_dir(root), "rollout-*.jsonl")))

    def sniff(self, head):
        """Codex rollouts start with a session_meta row carrying an ordinal; Claude transcripts do not."""
        return head.startswith(b'{"timestamp":') and b'"type":"session_meta"' in head

    def scan(self, path):
        return scan(path, self.root)

    def rows(self, recs, now_ms):
        """Sub-agent threads are folded into the row of their top-level thread."""
        names = thread_names(self.root)
        by_id, kids = _newest_by_id(recs), {}
        for r in by_id.values():
            if r["parent"] and r["parent"] in by_id:
                kids.setdefault(r["parent"], []).append(r)

        def descendants(tid):
            out, stack = [], list(kids.get(tid, []))
            while stack:
                r = stack.pop()
                out.append(r)
                stack.extend(kids.get(r["id"], []))
            return out

        rows = []
        for r in by_id.values():
            if r["parent"] and r["parent"] in by_id:
                continue  # nested under its parent session
            d = descendants(r["id"])
            mt = max([r["mtime"]] + [x["mtime"] for x in d])
            name = names.get(r["id"]) or r.get("title0") or ""
            rows.append(make_row(r, name, d and len(d) or 0, sum(x["size"] for x in d), mt, now_ms, orphan=bool(r["parent"])))
        return rows

    def tree(self, recs, root_id, path):
        return thread_tree(recs.values(), root_id)

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        from parse_codex import parse_codex
        return parse_codex(root_id, tree, name, out_chars, inp_chars, progress)

    def live(self, lv):
        import live_codex
        return live_codex.CodexLive(lv)

    def price_step(self, model, usage):
        return price_step(model, usage)


SOURCE = CodexSource()
