"""Command-line helpers: resolve a session argument and print the unified session list of every source."""
import os

import index
import sources


def _rows(limit=None, project=None):
    recs, _ = index.build_index()
    rows = index.list_sessions(recs)
    if project:
        p = os.path.abspath(os.path.expanduser(project)) if (os.path.sep in project or project.startswith("~")) else project
        rows = [r for r in rows if p in r["cwd"] or p in r["project"]]
        if not rows:
            raise SystemExit("找不到项目目录：%s" % project)
    return recs, (rows[:limit] if limit else rows)


def resolve(arg):
    """-> (tool, jsonl path, root id, display name). Accepts a .jsonl path or an id prefix of any source."""
    recs, rows = _rows()
    names = {r["path"]: r["name"] for r in rows}
    if arg.endswith(".jsonl") or os.path.sep in arg:
        p = os.path.abspath(os.path.expanduser(arg))
        if not os.path.isfile(p):
            raise SystemExit("找不到文件：%s" % p)
        rec = recs.get(p)
        tool = rec["tool"] if rec else sources.detect(p)
        rid = rec["id"] if rec else os.path.basename(p)[:-6]
        return tool, p, rid, names.get(p, "")
    ids = {(r["tool"], r["id"]) for r in recs.values()}  # sub-agent records (parent is a record of the same source) are not listed
    hits = [r for r in recs.values() if r["id"].startswith(arg) and (r["tool"], r["parent"]) not in ids]
    if not hits:
        raise SystemExit("没有以 %s 开头的会话（已查找 %s，子代理线程不单独列出）" % (arg, " 与 ".join(s.label for s in sources.all())))
    if len({r["id"] for r in hits}) > 1:
        raise SystemExit("前缀 %s 匹配多个会话，请写长一些：\n  " % arg + "\n  ".join("%s:%s" % (r["tool"], r["id"]) for r in hits[:10]))
    r = max(hits, key=lambda x: x["mtime"])
    return r["tool"], r["path"], r["id"], names.get(r["path"], "")


def print_list(project=None, limit=30):
    _, rows = _rows(limit, project)
    if not rows:
        print("没有找到会话")
        return
    for r in rows:
        size = "%.1fMB" % (r["size"] / 1e6) if r["size"] >= 1e6 else "%.0fKB" % (r["size"] / 1e3)
        print("%-6s %s  %-28s  %s → %s  %8s  子代理 %3d  %s%s" % (
            r["tool"], r["id"][:8], (r["name"] or "(无名)")[:28], index.fmt_ms(r["start"]), index.fmt_ms(r["end"]), size,
            r["subs"], r["project"], "  [进行中]" if r["status"] == "active" else "  [已归档]" if r["archived"] else ""))
