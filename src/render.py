"""Assemble the single-file HTML page: parse, redact, embed JSON, inline CSS/JS, enforce the size budget."""
import json
import os
import re
import time

import index
from parse import parse_session
from parse_codex import parse_codex
from redact import walk

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE_LIMIT = 20_000_000
JS_FILES = ("replay.js", "util.js", "tl_model.js", "tl_draw.js", "overview.js", "timeline.js", "steps.js", "views.js", "live.js", "boot.js")
CSS_FILES = ("replay.css", "polish.css", "timeline.css", "live.css")
BACK_LINK = '<a class="back" href="/" title="回到会话列表">← 会话列表</a>'
_CUT_MARK = re.compile(r"\n… \[已省略 \d+ 字符\]$")


def _read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as f:
        return f.read()


def embed_json(data):
    """JSON safe inside a <script type=application/json>: '<' and line separators are escaped."""
    s = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def assemble(data, back=False):
    js = "\n".join(_read(n) for n in JS_FILES)
    html = _read("template.html")
    title = (data["meta"]["name"] or data["meta"]["sid"][:8]).replace("<", "&lt;")
    css = "\n".join(_read(n) for n in CSS_FILES)
    html = html.replace("{{TITLE}}", title).replace("{{CSS}}", css).replace("{{JS}}", js)
    html = html.replace("{{BACK}}", BACK_LINK if back else "")
    return html.replace("{{DATA}}", embed_json(data))


def _recut(s, n):
    s = _CUT_MARK.sub("", s)
    return s if len(s) <= n else s[:n] + "\n… [已省略 %d 字符]" % (len(s) - n)


def shrink(data, oc, ic):
    """Re-cap tool output / input strings in place (no re-parse needed)."""
    for a in data["agents"]:
        for t in a["turns"]:
            for s in t["steps"]:
                for c in s["calls"]:
                    if len(c.get("res", "")) > oc:
                        c["res"] = _recut(c["res"], oc)
                    if len(c.get("inp", "")) > ic:
                        c["inp"] = _recut(c["inp"], ic)


def load_data(tool, path, name, oc, ic, progress=None, root_id=None, tree=None):
    if tool == "codex":
        if tree is None:
            recs, _ = index.build_index()
            r = index.find(recs, "codex:" + (root_id or ""))
            if r is None:
                r = next((x for x in recs.values() if x["path"] == path), None)
            root_id = r["id"] if r else root_id
            tree = index.codex_tree(recs, root_id) if r else {root_id: path}
        return parse_codex(root_id, tree, name, oc, ic, progress)
    return parse_session(path, name, oc, ic, progress)


def build_html(path, name, out_chars=600, inp_chars=4000, limit=SIZE_LIMIT, progress=None, back=False,
               tool=None, root_id=None, tree=None, active=False):
    """Return (html, info). Parses once at the requested caps, then shrinks caps while the page exceeds `limit`."""
    tool = tool or index.detect_tool(path)
    oc, ic, shrunk = out_chars, inp_chars, False
    data = load_data(tool, path, name, oc, ic, progress, root_id, tree)
    if progress:
        progress(1, 1, "生成页面")
    data["meta"]["generated"] = int(time.time() * 1000)
    data["meta"]["active"] = bool(active)
    data["meta"]["liveKey"] = "%s/%s" % (tool, data["meta"]["sid"])
    data["meta"]["requestedOutChars"] = out_chars
    data["meta"]["note"] = ""
    data = walk(data)
    while True:
        data["meta"]["outChars"] = oc
        data["meta"]["inpChars"] = ic
        if shrunk:
            data["meta"]["note"] = "页面超过 %d MB，已把工具返回内容缩短到前 %d 字符、工具输入缩短到前 %d 字符。" % (limit // 1_000_000, oc, ic)
        html = assemble(data, back)
        size = len(html.encode("utf-8"))
        if size <= limit or (oc <= 100 and ic <= 500):
            return html, {"bytes": size, "outChars": oc, "inpChars": ic, "shrunk": shrunk, "agents": len(data["agents"]) - 1,
                          "totals": data["totals"], "start": data["meta"]["start"], "tool": tool,
                          "steps": sum(a["nsteps"] for a in data["agents"])}
        shrunk = True
        oc, ic = max(100, oc // 2), max(500, ic // 2)
        shrink(data, oc, ic)
