#!/usr/bin/env python3
"""agent-replay command line: render one Claude Code / Codex session to a replay HTML page, or serve all of them."""
import argparse
import os
import re
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import sessions  # noqa: E402
from render import build_html  # noqa: E402


def serve_main(argv):
    ap = argparse.ArgumentParser(prog="agent-replay serve", description="在本机启动会话回放服务（只监听 127.0.0.1），首页列出所有 Claude Code 与 Codex 会话。")
    ap.add_argument("--port", type=int, default=8790, help="端口，默认 8790")
    ap.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    config.add_args(ap)
    args = ap.parse_args(argv)
    config.apply_args(args)
    from server import run
    return run(args.port, not args.no_open)


def demo_main(argv):
    ap = argparse.ArgumentParser(prog="agent-replay demo", description="用合成的示例会话（虚构项目）启动服务，不读取本机真实会话。")
    ap.add_argument("--port", type=int, default=8791, help="端口，默认 8791")
    ap.add_argument("--no-open", action="store_true", help="启动后不自动打开浏览器")
    args = ap.parse_args(argv)
    import demo
    return demo.run(args.port, not args.no_open)


def _safe_streams():
    """Console encodings (e.g. a Windows code page) may not cover the Chinese messages: replace instead of crashing."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(errors="replace")
            except (ValueError, OSError):
                pass


def main(argv=None):
    _safe_streams()
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "serve":
        return serve_main(argv[1:])
    if argv and argv[0] == "demo":
        return demo_main(argv[1:])
    ap = argparse.ArgumentParser(prog="agent-replay", description="把 Claude Code 或 Codex 会话（主会话加子代理）生成为可逐步回看的单文件 HTML；"
                                 "用 `agent-replay serve` 启动本地应用浏览全部会话，`agent-replay demo` 用示例数据体验。")
    ap.add_argument("session", nargs="?", help="会话 id 前缀或 .jsonl 路径（Claude 与 Codex 均可）")
    ap.add_argument("--list", nargs="?", const="", metavar="项目目录", help="列出最近的会话（可指定项目目录或名称片段）")
    ap.add_argument("-n", type=int, default=30, help="--list 显示的会话数，默认 30")
    ap.add_argument("-o", "--output", help="输出 HTML 路径")
    ap.add_argument("--output-chars", type=int, default=600, help="每个工具返回内容保留的字符数，默认 600")
    config.add_args(ap)
    args = ap.parse_args(argv)
    config.apply_args(args)
    if args.list is not None:
        sessions.print_list(args.list or None, args.n)
        return 0
    if not args.session:
        ap.error("请给出会话 id 前缀或 .jsonl 路径，或使用 --list / serve")
    tool, path, root_id, name = sessions.resolve(args.session)
    html, info = build_html(path, name, max(50, args.output_chars), tool=tool, root_id=root_id)
    out = args.output
    if not out:
        base = re.sub(r"[\\/:*?\"<>|\s]+", "_", name or root_id[:8]).strip("_") or root_id[:8]
        day = datetime.fromtimestamp((info["start"] or 0) / 1000).strftime("%Y%m%d")
        out = os.path.join(config.HOME_DIR, "%s-%s-%s.html" % (tool, base, day))
    out = os.path.abspath(os.path.expanduser(out))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    t = info["totals"]
    unit = "额度 %.1f 相对单位" % t["cost"] if info["tool"] == "claude" or t.get("rsn") is None else "token %d（未配置价格时不含缓存读取）" % t["cost"]
    print("已生成 %s（%.1f MB）" % (out, info["bytes"] / 1e6))
    print("来源 %s，主代理 %d 步，子代理 %d 个，总计 %s%s" % (tool, t["mainSteps"], info["agents"], unit, "，已缩短内容" if info["shrunk"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
