"""Codex side of the live state: folds rollout rows into AgentState; child threads are found through their parent id."""
import json
import os
import re
import threading

import prices
import source_codex
from codex_calls import _HOOK, SHELL_TOOLS, _bad_exit, _desc, _short, _summary, _tool_cat, nested_calls
from codex_scan import content_text
from common import merge_kind, ts_ms
from live import WINDOW_MS, AgentState

_HDR = re.compile(r'^\{"timestamp":"([^"]+)","ordinal":(\d+),"type":"(\w+)","payload":\{(?:"type":"(\w+)")?')
_WAIT_NAMES = {"wait_agent", "wait", "wait_threads"}


def read_meta(path):
    """session_meta payload from the first line of a rollout (instructions dropped)."""
    try:
        with open(path, "rb") as f:
            line = f.readline(4_000_000)
        p = json.loads(line).get("payload") or {}
        return {k: v for k, v in p.items() if k not in ("base_instructions", "dynamic_tools")}
    except (OSError, ValueError):
        return {}


class CodexFeed:
    def __init__(self, lv, st, is_main, start_ord=0):
        self.lv, self.st, self.main, self.start_ord = lv, st, is_main, start_ord
        self.prev_total = -1
        self.tc_rows = 0

    def feed(self, raw):
        line = raw.decode("utf-8", "replace")
        m = _HDR.match(line)
        if not m:
            return
        tsr, ordinal, rtype, ptype = m.group(1), int(m.group(2)), m.group(3), m.group(4)
        if ordinal < self.start_ord:
            return
        st = self.st
        if rtype == "event_msg":
            if ptype not in ("task_started", "task_complete", "turn_aborted", "token_count", "item_completed"):
                return
            if ptype == "item_completed" and '"UserMessage"' not in line[:700]:
                return
        elif rtype == "response_item":
            if ptype not in ("function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "message",
                             "reasoning", "web_search_call"):
                return
            if ptype == "message" and '"role":"assistant"' not in line[:500]:
                return
        elif rtype not in ("turn_context", "compacted"):
            return
        try:
            r = json.loads(line)
        except ValueError:
            return
        ts = ts_ms(tsr)
        p = r.get("payload") or {}
        if st.start is None or ts < st.start:
            st.start = ts
        if ts > st.last_ts:
            st.last_ts = ts
        if rtype == "turn_context":
            cm = (p.get("collaboration_mode") or {}).get("settings") or {}
            st.model = p.get("model") or cm.get("model") or st.model
            st.effort = p.get("effort") or cm.get("reasoning_effort") or st.effort
            st.cwd = p.get("cwd") or st.cwd
            if st.model:
                self.lv.models.add(st.model)
        elif rtype == "compacted":
            self.lv.add_event(ts, "compact", st.id, "上下文压缩")
            st.ctx = 0
        elif rtype == "event_msg":
            self.event_msg(ptype, p, ts)
        else:
            self.response(ptype, p, ts)

    # ------------------------------------------------------------ rows

    def event_msg(self, ptype, p, ts):
        st, lv = self.st, self.lv
        if ptype == "task_started":
            st.last_kind = "think"
            st.done = False
        elif ptype in ("task_complete", "turn_aborted"):
            st.last_kind = "end"
            st.pending.clear()
            if not self.main and not st.done:
                st.done, st.done_ts = True, ts
                lv.add_event(ts, "handback", st.id, "子代理交回：%s" % (st.desc or st.id))
        elif ptype == "token_count":
            info = p.get("info")
            if not info:
                return
            self.tc_rows += 1
            tot = (info.get("total_token_usage") or {}).get("total_tokens", 0) or 0
            if tot == self.prev_total:
                return
            self.prev_total = tot
            u = info.get("last_token_usage") or {}
            inp, cached, cw = u.get("input_tokens", 0) or 0, u.get("cached_input_tokens", 0) or 0, u.get("cache_write_input_tokens", 0) or 0
            out = u.get("output_tokens", 0) or 0
            pr = source_codex.price_step(st.model, {"in": inp, "cached": cached, "cw": cw, "out": out, "rsn": u.get("reasoning_output_tokens", 0) or 0})
            if pr["cost"] is None:
                lv.unpriced.add(st.model or "(unknown)")
            st.add_cost(ts, pr["cost"] or 0.0, prices.tok_total(pr["tok"]))
            prices.add_tok(st.tok, pr["tok"])
            st.steps += 1
            st.step_ts.append(ts)
            st.ctx = inp
            st.window = info.get("model_context_window") or 0
            st.cur = None  # the next call opens the next step record
        elif ptype == "item_completed":
            it = p.get("item") or {}
            if it.get("type") == "UserMessage" and self.main:
                tx = content_text(it.get("content")).strip()
                if tx and not tx.startswith(("<", "# AGENTS.md")):
                    lv.add_event(ts, "user", "main", tx, full=len(tx))
                st.last_kind = "user"

    def response(self, ptype, p, ts):
        st, lv = self.st, self.lv
        if ptype in ("function_call", "custom_tool_call"):
            self.call(ptype, p, ts)
        elif ptype in ("function_call_output", "custom_tool_call_output"):
            self.output(p, ts)
        elif ptype == "message":
            tx = content_text(p.get("content")).strip()
            if tx:
                st.said = tx
                if st.cur is None:
                    st.new_step(ts)
                    st.cur["tool"], st.cur["sum"] = "回复", tx.split("\n", 1)[0][:200]
            st.last_kind = "think"
        elif ptype == "reasoning":
            st.last_kind = "think"
        elif ptype == "web_search_call":
            st.last_kind = "think"

    def call(self, ptype, p, ts):
        st, lv = self.st, self.lv
        name = p.get("name") or ""
        raw = p.get("arguments") if ptype == "function_call" else p.get("input")
        raw = raw if isinstance(raw, str) else json.dumps(raw or {}, ensure_ascii=False)
        custom = ptype == "custom_tool_call"
        nested = nested_calls(raw) if custom and name == "exec" else []
        names = [n for n, _ in nested] if nested else ([name] if not (custom and name == "exec") else [])
        args = {}
        if not custom:
            try:
                a = json.loads(raw)
                args = a if isinstance(a, dict) else {"_raw": raw}
            except ValueError:
                args = {"_raw": raw}
        else:
            args = {"_raw": raw}
        cmds = [str((a or {}).get("cmd") or (a or {}).get("command") or "") for n, a in nested if _short(n) in SHELL_TOOLS]
        if not cmds and name in SHELL_TOOLS:
            cmds = [str(args.get("cmd") or args.get("command") or "")]
        cmd = "\n".join(c for c in cmds if c)
        first = nested[0][1] if nested else args
        cat = _tool_cat(names, cmd, first)
        shown = "+".join(dict.fromkeys(_short(n) for n in names)) if names else ("exec" if name == "exec" else name)
        summ = _summary(name, names, nested, [], args, cmd)[:240]
        desc = _desc(args, nested, [], raw)[:200]
        wait = bool(names) and all(_short(n) in _WAIT_NAMES for n in names)
        call = {"id": p.get("call_id") or p.get("id"), "name": shown, "sum": summ, "desc": desc, "ts": ts, "cat": cat, "bg": False,
                "waitAgent": wait, "poll": cat == "wait" and not wait and bool(cmd), "cmd": cmd, "cwd": st.cwd}
        if st.cur is None:
            st.new_step(ts)
            st.cur["n"] = st.steps
        step = st.cur
        call["step"] = step
        step["calls"].append(call)
        if len(step["calls"]) == 1:
            step["tool"], step["sum"] = shown, summ
        why = desc or (st.said.split("\n", 1)[0][:160] if st.said else "")
        if why and not step["why"]:
            step["why"] = why
        st.pending[call["id"]] = call
        st.last_kind = "call"
        if call["poll"]:
            st.poll_ts = ts
        if "spawn_agent" in [_short(n) for n in names] or name == "spawn_agent":
            sp = next((a for n, a in nested if _short(n) == "spawn_agent" and a), None) or args
            model = sp.get("model") or ""
            lv.add_event(ts, "dispatch", st.id, "派单：%s%s" % (sp.get("task_name") or summ, "（%s%s）" % (model, "·" + sp["reasoning_effort"] if sp.get("reasoning_effort") else "") if model else ""))

    def output(self, p, ts):
        st, lv = self.st, self.lv
        call = st.pending.pop(p.get("call_id"), None)
        if call is None:
            return
        text = content_text(p.get("output"))
        step = call["step"]
        step["dur"] = max(step["dur"], max(0, ts - call["ts"]))
        bad = text.startswith("Script failed") or _bad_exit(text)
        hook = bool(text) and bool(_HOOK.search(text[:300]))
        st.last_kind = "result"
        if hook:
            call["st"] = step["st"] = "hook"
            st.hook_ts.append(ts)
            st.fail_streak += 1
            lv.add_event(ts, "hook", st.id, "钩子拦截 %s：%s" % (call["name"], text[:160]))
        elif bad:
            call["st"] = step["st"] = "err"
            st.fail_streak += 1
            lv.add_event(ts, "fail", st.id, "%s 失败：%s" % (call["name"], (call["sum"] or text)[:120]))
        else:
            call["st"] = "ok"
            st.fail_streak = 0
            if call["cat"] == "git" and call["cmd"]:
                mk = merge_kind(call["cmd"], call["cwd"])
                if mk:
                    st.merge_ts = ts
                    lv.add_event(ts, "merge", st.id, "合入主线（%s）：%s" % (mk, call["sum"][:120]))


class CodexLive:
    def __init__(self, lv):
        self.lv = lv
        self.root_id = lv.id
        self.family = {lv.id}          # thread ids already known to belong to this session
        self.head_cache = {}           # path -> (parent id, meta) for rollouts that are not ours (yet)
        self.dirs_seen = {}

    def build(self, now):
        lv = self.lv
        main = AgentState("main", "主代理")
        main.start = lv.row.get("start")
        lv.agents["main"] = main
        meta = read_meta(lv.path)
        main.cwd = meta.get("cwd") or ""
        feed = CodexFeed(lv, main, True, meta.get("subagent_history_start_ordinal") or 0)
        t = lv.follow(lv.path, main, feed, now)
        self.prefix(main, lv.path, t.start, feed)
        tree = source_codex.thread_tree(lv.recs.values(), self.root_id)
        for tid, path in tree.items():
            if tid != self.root_id:
                self.add_child(tid, path, None, now)
        self.discover(now)

    def prefix(self, st, path, upto, feed):
        """Steps before the window. Small prefixes are counted inline; large ones get an estimate from the window's
        density now and the exact token_count count from a background thread."""
        if upto <= 0:
            return
        st.approx = True
        ratio = st.steps / feed.tc_rows if feed.tc_rows >= 5 else 0.6
        win = max(1, os.stat(path).st_size - upto)
        st.prefix_steps = int(st.steps * upto / win)

        def count():
            n = 0
            needle = b'"type":"token_count","info":{'
            with open(path, "rb") as f:
                left = upto
                while left > 0:
                    chunk = f.read(min(64_000_000, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    n += chunk.count(needle)
            st.prefix_steps = int(n * ratio)

        if upto > 24_000_000:
            threading.Thread(target=count, daemon=True).start()
        else:
            count()

    def add_child(self, tid, path, meta, now):
        lv = self.lv
        if tid in lv.agents or path in lv.tails:
            return
        meta = meta or read_meta(path)
        try:
            s = os.stat(path)
        except OSError:
            return
        age = now - s.st_mtime * 1000
        known = lv.known.get(path)
        if known and known[0] == s.st_mtime_ns:
            return
        if age > WINDOW_MS:
            with open(path, "rb") as f:
                f.seek(max(0, s.st_size - 65536))
                data = f.read()
            done = max(data.rfind(b'"type":"task_complete"'), data.rfind(b'"type":"turn_aborted"')) > data.rfind(b'"type":"task_started"')
            lv.known[path] = (s.st_mtime_ns, "old" if done else "stale")
            lv.stale_unreturned = sum(1 for v in lv.known.values() if v[1] == "stale")
            return
        ap = meta.get("agent_path") or ""
        nick = meta.get("agent_nickname") or ""
        st = AgentState(tid, "%s%s" % (ap.rsplit("/", 1)[-1] or tid[:8], " · " + nick if nick else ""))
        sp = (((meta.get("source") or {}).get("subagent") or {}).get("thread_spawn") or {}) if isinstance(meta.get("source"), dict) else {}
        st.depth = sp.get("depth") or max(1, ap.count("/") - 1)
        st.tu = None
        st.parent_tid = meta.get("parent_thread_id")
        st.cwd = meta.get("cwd") or ""
        if meta.get("timestamp"):
            st.start = ts_ms(meta["timestamp"])
        lv.agents[tid] = st
        self.family.add(tid)
        feed = CodexFeed(lv, st, False, meta.get("subagent_history_start_ordinal") or 0)
        t = lv.follow(path, st, feed, now)
        self.prefix(st, path, t.start, feed)

    def discover(self, now):
        """New child rollouts: any new file in the recent date directories whose parent id is in this session's family."""
        lv = self.lv
        import datetime
        days = {datetime.date.fromtimestamp(now / 1000 - d * 86400) for d in (0, 1)}
        if lv.row.get("start"):
            days.add(datetime.date.fromtimestamp(lv.row["start"] / 1000))
        dirs = [os.path.join(source_codex.sessions_dir(source_codex.SOURCE.root), "%04d" % d.year, "%02d" % d.month, "%02d" % d.day) for d in days]
        for d in dirs:
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for fn in names:
                if not fn.startswith("rollout-") or not fn.endswith(".jsonl"):
                    continue
                path = os.path.join(d, fn)
                if path in lv.tails or path == lv.path:
                    continue
                hc = self.head_cache.get(path)
                if hc is None:
                    meta = read_meta(path)
                    hc = self.head_cache[path] = (meta.get("parent_thread_id"), meta)
                parent, meta = hc
                tid = meta.get("id") or ""
                if parent in self.family and tid:
                    self.add_child(tid, path, meta, now)
