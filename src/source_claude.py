"""Claude Code source: <root>/projects/<project>/<session>.jsonl, sub-agents in <session>/subagents/agent-*.jsonl."""
import glob
import json
import os
import re

import prices
from common import ts_ms
from scan_util import HEAD_BYTES, TS_ANY, clip, make_row, tail_ts, text_of
from sources import Source

US_GEO_FACTOR = 1.1
_TITLE = re.compile(rb'"type":"(?:custom-title|ai-title)"[^\n]*?"(?:customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"')


# ---------------------------------------------------------------- index

def session_names(root):
    """session id -> name from <claude dir>/sessions/*.json (running or recent sessions)."""
    out = {}
    for f in glob.glob(os.path.join(root, "sessions", "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and d.get("sessionId") and d.get("name"):
            out[d["sessionId"]] = d["name"]
    return out


def title_file(jsonl):
    sid = os.path.basename(jsonl)[:-6]
    try:
        with open(os.path.join(os.path.dirname(jsonl), sid, "custom-title.json"), encoding="utf-8") as f:
            return json.load(f).get("customTitle") or ""
    except (OSError, ValueError):
        return ""


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


def scan(path):
    rec = {"tool": "claude", "path": path, "archived": False, "id": os.path.basename(path)[:-6], "parent": None, "agentPath": "",
           "cwd": "", "start": None, "model": "", "title0": "", "title": ""}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            used = 0
            for i, line in enumerate(f):
                used += len(line)
                if rec["start"] is None:
                    m = TS_ANY.search(line.encode("utf-8", "replace")[:3000])
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
                    txt = r.get("content") if r.get("type") == "queue-operation" else text_of((r.get("message") or {}).get("content"))
                    txt = (txt or "").strip()
                    if txt and not txt.startswith("<"):
                        rec["title0"] = clip(txt, 80)
                if (rec["title0"] and rec["cwd"] and rec["start"]) or i >= 300 or used > HEAD_BYTES:
                    break
    except OSError:
        pass
    rec["end"] = tail_ts(path, TS_ANY)
    rec["title"] = _tail_title(path)
    return rec


# ---------------------------------------------------------------- pricing

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


def price_step(model, u):
    """Price one Claude response from its usage block."""
    u = u or {}
    tok = claude_tokens(u)
    name = prices.norm_model(model)
    if name == "<synthetic>":
        return prices.result(0.0, tok, True)
    if prices.is_local(name):
        return prices.result(0.0, tok, True, local=True)
    entry = (prices.load().get("claude") or {}).get("models", {}).get(name)
    if not entry:
        return prices.result(None, tok, False)
    p = _tier(entry, tok["in"] + tok["cr"] + tok["cw5"] + tok["cw1"])
    cost = (tok["in"] * p["input"] + tok["cw5"] * p["cache_write_5m"] + tok["cw1"] * p["cache_write_1h"] +
            tok["cr"] * p["cache_read"] + tok["out"] * p["output"]) / 1e6
    if u.get("inference_geo") == "us":
        cost *= US_GEO_FACTOR
    return prices.result(cost, tok, True, fast=u.get("service_tier") not in (None, "", "standard"))


# ---------------------------------------------------------------- adapter

class ClaudeSource(Source):
    id = "claude"
    label = "Claude Code"
    color = "var(--opus-bg)"
    default = True  # transcripts have no distinctive first row
    dir_flag = "--claude-dir"
    dir_envs = ("AGENT_REPLAY_CLAUDE_DIR", "CLAUDE_CONFIG_DIR")
    dir_default = os.path.join("~", ".claude")
    dir_help = "Claude Code 数据目录（含 projects/），默认 $CLAUDE_CONFIG_DIR 或 ~/.claude"
    ctx_limit_key = "ctxLimit"
    reparse_gap = 5.0

    def files(self):
        return glob.glob(os.path.join(self.root, "projects", "*", "*.jsonl"))

    def scan(self, path):
        return scan(path)

    def rows(self, recs, now_ms):
        names = session_names(self.root)
        rows = []
        for r in recs:
            sub_dir = os.path.join(os.path.dirname(r["path"]), r["id"], "subagents")
            subs, sub_size, mt = 0, 0, r["mtime"]
            try:
                for fn in os.listdir(sub_dir):
                    if fn.startswith("agent-") and fn.endswith(".jsonl"):
                        st = os.stat(os.path.join(sub_dir, fn))
                        subs, sub_size, mt = subs + 1, sub_size + st.st_size, max(mt, st.st_mtime)
            except OSError:
                pass
            name = title_file(r["path"]) or names.get(r["id"]) or r.get("title") or r.get("title0") or ""
            if not r["cwd"]:
                r = dict(r, cwd=os.path.basename(os.path.dirname(r["path"])))
            rows.append(make_row(r, name, subs, sub_size, mt, now_ms))
        return rows

    def tree_for_path(self, path, root_id):
        return root_id, {root_id: path}  # the transcript path is the session; sub-agents are found next to it

    def session_files(self, recs, row):
        base = row["path"]
        files = [base]
        sub = os.path.join(os.path.dirname(base), row["id"], "subagents")
        if os.path.isdir(sub):
            files += [os.path.join(sub, fn) for fn in sorted(os.listdir(sub))]
        return files

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        from parse import parse_session
        return parse_session(tree[root_id], name, out_chars, inp_chars, progress, rows_cache=cache)

    def live(self, lv):
        import live_claude
        return live_claude.ClaudeLive(lv)

    def price_step(self, model, usage):
        return price_step(model, usage)


SOURCE = ClaudeSource()
