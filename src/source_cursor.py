"""Cursor source: the chats of the Cursor editor, kept in one SQLite database (<root>/User/globalStorage/state.vscdb) that is
opened strictly read-only (see cursor_scan.py for what is read and what is deliberately never touched).

Every top-level, time-stamped chat is one virtual path "<db>#<composerId>"; sub-agent chats are folded into the row of their
parent chat and into its tree. There is no live view (the database is the editor's working store, polling it is left out:
live_supported = False).

Cursor does not record token usage locally, so nothing here has a price: every step is "unpriced" (cost None) with zero tokens,
and the page shows that instead of a $0.00.
"""
import os
import sys

import prices
import cursor_scan
from scan_util import make_row
from sources import Source


def price_step(model, usage):
    """No usage is recorded: zero tokens, no amount."""
    return prices.result(None, prices.zero_tok(), False)


class CursorSource(Source):
    id = "cursor"
    label = "Cursor"
    color = "var(--c-git)"
    dir_flag = "--cursor-dir"
    dir_envs = ("AGENT_REPLAY_CURSOR_DIR",)
    dir_help = "Cursor 数据目录（含 User/globalStorage/state.vscdb），默认 macOS ~/Library/Application Support/Cursor、Linux ~/.config/Cursor、Windows %%APPDATA%%\\Cursor"
    live_supported = False
    page = {"fams": False, "notes": {
        "why": "思考摘要来自 thinking（Cursor 不一定保存文字）；工具调用前的说明取自同一次响应里的文字",
        "mainSteps": "一次模型响应算一步（文字、思考、每个工具调用在记录里是分开的消息，按同一次响应的调用 id 归并）；Cursor 不在本地记录 token 用量，所以没有金额",
        "hooks": "Cursor 的会话记录里没有钩子拦截",
        "lastText": "取该子代理最后一条不带工具调用的回复，没有时取它的 subtitle"}}

    @property
    def dir_default(self):
        """Cursor's per-user data directory on this platform (Windows is not tested)."""
        if sys.platform == "darwin":
            return os.path.join("~", "Library", "Application Support", "Cursor")
        if sys.platform.startswith("win"):
            return os.path.join(os.environ.get("APPDATA", "").strip() or os.path.join("~", "AppData", "Roaming"), "Cursor")
        return os.path.join(os.environ.get("XDG_CONFIG_HOME", "").strip() or os.path.join("~", ".config"), "Cursor")

    def files(self):
        return cursor_scan.files(self.root)

    def stat(self, path):
        return cursor_scan.stat(path)

    def scan(self, path):
        return cursor_scan.scan(path)

    def rows(self, recs, now_ms):
        """Sub-agent chats are already folded into each record (subs, and the tree size / mtime in stat)."""
        return [make_row(r, r.get("title0") or "", r.get("subs", 0), 0, r["mtime"], now_ms) for r in recs]

    def tree(self, recs, root_id, path):
        return cursor_scan.tree(path)

    def tree_for_path(self, path, root_id):
        return cursor_scan.split(path)[1], cursor_scan.tree(path)

    def parse(self, root_id, tree, name, out_chars, inp_chars, progress=None, cache=None):
        from parse_cursor import parse_cursor
        return parse_cursor(root_id, tree, name, out_chars, inp_chars, progress)

    def price_step(self, model, usage):
        return price_step(model, usage)


SOURCE = CursorSource()
