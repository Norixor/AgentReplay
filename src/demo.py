"""`agent-replay demo`: generate synthetic sessions under <replays>/demo and serve them.

Three invented sessions on a fictional shop project (paths under /home/demo): a finished Claude Code session with six
sub-agents, a finished Codex session with three sub-threads, and an in-progress Claude Code session that a background
thread keeps extending while the demo runs. The data is regenerated on every run, relative to the current time.
"""
import os
import shutil
import time

import config
import demo_claude
import demo_codex
import demo_live


def generate(base=None, now_ms=None):
    """Write all demo sessions below `base` (default <replays>/demo); -> dict with the directories and the live session."""
    base = os.path.abspath(base or os.path.join(config.HOME_DIR, "demo"))
    if os.path.basename(base) != "demo":  # the directory is wiped first: only ever touch a folder named "demo"
        raise ValueError("demo data directory must be named 'demo': %s" % base)
    now = now_ms or int(time.time() * 1000)
    shutil.rmtree(base, ignore_errors=True)
    claude_dir, codex_dir = os.path.join(base, "claude"), os.path.join(base, "codex")
    finished = demo_claude.build(claude_dir, now)
    codex = demo_codex.build(codex_dir, now)
    live = demo_live.build(claude_dir, now)
    return {"base": base, "claude_dir": claude_dir, "codex_dir": codex_dir, "finished": finished, "codex": codex, "live": live}


def run(port=8791, open_browser=True):
    import server
    info = generate()
    config.configure(info["claude_dir"], info["codex_dir"], home=info["base"])
    feeder = demo_live.LiveFeeder(info["live"])
    feeder.start()
    print("演示模式：以下都是合成的示例会话（虚构的电商项目），数据在 %s，每次启动都会重新生成。" % info["base"], flush=True)
    try:
        return server.run(port, open_browser, reuse=False)
    finally:
        feeder.stop()
