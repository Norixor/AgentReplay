"""Claude Code side of the live state: folds transcript rows into AgentState and discovers sub-agent files."""
import json
import os
import re
import threading

import source_claude
from common import classify_bash, merge_kind, ts_ms
from prices import add_tok, tok_total, zero_tok
from live import WINDOW_MS, AgentState
from parse import categorize, classify_text, family, summarize

_ID = re.compile(rb'"id":"(msg_\w+)","type":"message"')
_HOOK = re.compile(r"\s*PreToolUse:\S+ hook error:")
_WAIT_TOOLS = {"Agent", "Task", "TaskOutput", "Monitor"}


def _flat(c):
    if isinstance(c, str):
        return c[:400]
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                return (b.get("text") or "")[:400]
    return ""


def peek_done(data):
    """Cheap guess from the last bytes of a sub-agent file: did it hand back or end its turn?"""
    if data.rfind(b'"name":"SubagentHandback"') >= 0:
        return True
    return data.rfind(b'"stop_reason":"end_turn"') > data.rfind(b'"tool_use_id"')


class ClaudeFeed:
    def __init__(self, lv, st, is_main):
        self.lv, self.st, self.main = lv, st, is_main

    def feed(self, line):
        try:
            r = json.loads(line)
        except ValueError:
            return
        t = r.get("type")
        if t not in ("assistant", "user", "system", "attachment") or not r.get("timestamp"):
            return
        ts = ts_ms(r["timestamp"])
        st = self.st
        if st.start is None or ts < st.start:
            st.start = ts
        if ts > st.last_ts:
            st.last_ts = ts
        if r.get("cwd"):
            st.cwd = r["cwd"]
        if t == "assistant":
            self.assistant(r, ts)
        elif t == "user":
            self.user(r, ts)
        elif t == "system":
            self.system(r, ts)
        else:
            a = r.get("attachment") or {}
            if a.get("type") == "queued_command" and self.main:
                p = a.get("prompt")
                if isinstance(p, list):
                    p = "\n".join(b.get("text", "") for b in p if isinstance(b, dict))
                self.human(p or "", ts, False)

    # ------------------------------------------------------------ rows

    def assistant(self, r, ts):
        st, lv = self.st, self.lv
        m = r.get("message") or {}
        mid = m.get("id") or r.get("uuid")
        if st.done and mid != st.done_key:
            st.done = False
        if mid != st.cur_mid:
            st.cur_mid = mid
            st.ids.add(mid)
            st.steps = len(st.ids)
            st.new_step(ts)
            st.msg[mid] = [ts, 0.0, zero_tok()]   # ts, amount and token vector already counted for this message
            st.step_ts.append(ts)
            if len(st.msg) > 48:
                for k in list(st.msg)[:16]:
                    del st.msg[k]
        if m.get("model"):
            st.model = m["model"]
        if r.get("effort") and self.main:
            st.effort = r["effort"]
        u = m.get("usage")
        if u and mid in st.msg:
            pr = source_claude.price_step(st.model, u)
            if pr["cost"] is None:
                lv.unpriced.add(st.model or "(unknown)")
            acc = st.msg[mid]
            # A message is written block by block with growing usage: count only what is new since the last row.
            new = {k: max(acc[2][k], pr["tok"][k]) for k in acc[2]}
            delta = {k: new[k] - acc[2][k] for k in new}
            add_tok(st.tok, delta)
            dq, dt = max(0.0, (pr["cost"] or 0.0) - acc[1]), tok_total(delta)
            if dq or dt:
                st.add_cost(acc[0], dq, dt)
            acc[1], acc[2] = max(pr["cost"] or 0.0, acc[1]), new
            if pr["tok"]["out"] > 0 or not st.ctx:
                st.ctx = pr["tok"]["in"] + pr["tok"]["cw5"] + pr["tok"]["cw1"] + pr["tok"]["cr"]
        step = st.cur
        for b in m.get("content") or []:
            bt = b.get("type")
            if bt == "text":
                tx = (b.get("text") or "").strip()
                if tx:
                    st.said = tx
                    if not step["sum"] and not step["calls"]:
                        step["tool"], step["sum"] = "回复", tx.split("\n", 1)[0][:200]
            elif bt == "tool_use":
                self.tool_use(b, ts, step)
        if m.get("stop_reason") == "end_turn":
            st.last_kind = "end"
            if not self.main:
                self.finish(ts, mid)
        else:
            st.last_kind = "assistant"

    def finish(self, ts, mid):
        st = self.st
        if not st.done:
            st.done, st.done_ts, st.done_key = True, ts, mid
            self.lv.add_event(ts, "handback", st.id, "子代理交回：%s" % (st.desc or st.id))

    def tool_use(self, b, ts, step):
        st, lv = self.st, self.lv
        name, inp = b.get("name") or "", b.get("input") or {}
        if name == "SubagentHandback":
            self.finish(ts, st.cur_mid)
        cat = categorize(name, inp)
        bg = bool(inp.get("run_in_background")) if name in ("Bash", "Agent", "Task") else False
        call = {"id": b.get("id"), "name": name, "sum": summarize(name, inp)[:240], "desc": str(inp.get("description") or "")[:200], "ts": ts,
                "cat": cat, "bg": bg, "waitAgent": name in ("Agent", "Task") and not bg or name == "TaskOutput",
                "poll": name == "Bash" and cat == "wait", "cmd": (inp.get("command") or "") if name == "Bash" else "", "cwd": st.cwd, "step": step}
        if call["poll"] and not bg:
            st.poll_ts = ts
        st.pending[call["id"]] = call
        step["calls"].append(call)
        if len(step["calls"]) == 1 or not step["tool"] or step["tool"] == "回复":
            step["tool"] = name
            step["sum"] = call["sum"]
        why = call["desc"] or (st.said.split("\n", 1)[0][:160] if st.said else "")
        if why and not step["why"]:
            step["why"] = why
        if name in ("Agent", "Task"):
            lv.tu_owner[b.get("id")] = st.id
            lines = [l.strip() for l in str(inp.get("prompt") or "").split("\n") if l.strip()]
            lv.briefs[b.get("id")] = {"lines": [l[:160] for l in lines[:2]], "why": next((l[:240] for l in lines if l.startswith("选档理由")), "")}
            if len(lv.briefs) > 300:
                del lv.briefs[next(iter(lv.briefs))]
            extra = "（%s%s）" % (inp.get("model") or "", "·" + inp["effort"] if inp.get("effort") else "") if inp.get("model") else ""
            lv.add_event(ts, "dispatch", st.id, "派单：%s%s" % (call["desc"] or call["sum"], extra), tool=name)

    def user(self, r, ts):
        st = self.st
        c = (r.get("message") or {}).get("content")
        if isinstance(c, str):
            c = [{"type": "text", "text": c}]
        had_result = False
        for b in c or []:
            if b.get("type") == "tool_result":
                had_result = True
                self.result(b, ts)
            elif b.get("type") == "text":
                tx = b.get("text") or ""
                if self.main:
                    self.human(tx, ts, bool(r.get("isMeta")))
                elif st.done and not tx.lstrip().startswith("<system-reminder>"):
                    st.done = False  # a follow-up message reopens a returned sub-agent
        st.last_kind = "result" if had_result else "user"

    def human(self, tx, ts, meta):
        ev = classify_text(tx, meta=meta)
        if ev and ev["k"] == "human":
            self.lv.add_event(ts, "user", "main", ev["text"].strip(), full=len(ev["text"]))

    def result(self, b, ts):
        st, lv = self.st, self.lv
        call = st.pending.pop(b.get("tool_use_id"), None)
        if call is None:
            return
        dur = max(0, ts - call["ts"])
        step = call["step"]
        text = _flat(b.get("content"))
        if b.get("is_error"):
            if _HOOK.match(text):
                call["st"] = "hook"
                st.hook_ts.append(ts)
                lv.add_event(ts, "hook", st.id, "钩子拦截 %s：%s" % (call["name"], _HOOK.sub("", text)[:160]))
            else:
                call["st"] = "err"
                lv.add_event(ts, "fail", st.id, "%s 失败：%s" % (call["name"], (call["sum"] or text)[:120]))
            st.fail_streak += 1
            step["st"] = call["st"]
        else:
            call["st"] = "ok"
            st.fail_streak = 0
            if call["name"] == "Bash" and call["cat"] == "git":
                mk = merge_kind(call["cmd"], call["cwd"])
                if mk:
                    st.merge_ts = ts
                    lv.add_event(ts, "merge", st.id, "合入主线（%s）：%s" % (mk, call["sum"][:120]))
        step["dur"] = max(step["dur"], dur)

    def system(self, r, ts):
        st, lv = self.st, self.lv
        sub = r.get("subtype")
        if sub == "compact_boundary":
            cm = r.get("compactMetadata") or {}
            lv.add_event(ts, "compact", st.id, "上下文压缩（%s，压缩前 %s token）" % (cm.get("trigger") or "?", cm.get("preTokens") or "?"))
            st.ctx = 0
        elif sub == "stop_hook_summary" and r.get("preventedContinuation"):
            st.hook_ts.append(ts)
            lv.add_event(ts, "hook", st.id, "Stop 钩子拦截结束：%s" % (r.get("stopReason") or "")[:160])


class ClaudeLive:
    def __init__(self, lv):
        self.lv = lv
        self.sub_dir = os.path.join(os.path.dirname(lv.path), lv.id, "subagents")

    def build(self, now):
        lv = self.lv
        main = AgentState("main", "主代理")
        main.start = lv.row.get("start")
        main.model = lv.row.get("model") or ""
        lv.agents["main"] = main
        t = lv.follow(lv.path, main, ClaudeFeed(lv, main, True), now)
        self.prefix(main, lv.path, t.start)
        self.discover(now)

    def prefix(self, st, path, upto):
        """Count distinct messages in the part of the file before the window (steps only; nothing else is needed).
        Large prefixes get an estimate now and the exact count from a background thread."""
        if upto <= 0:
            return
        win = max(1, os.stat(path).st_size - upto)

        def count():
            seen = set()
            with open(path, "rb") as f:
                left, tail = upto, b""
                while left > 0:
                    chunk = f.read(min(8_000_000, left))
                    if not chunk:
                        break
                    left -= len(chunk)
                    data = tail + chunk
                    cut = data.rfind(b"\n") + 1 if left > 0 else len(data)
                    seen.update(m.decode() for m in _ID.findall(data[:cut]))
                    tail = data[cut:]
            st.ids |= seen
            st.steps = len(st.ids)
            st.approx = False

        if upto > 24_000_000:
            st.prefix_steps, st.approx = int(len(st.ids) * upto / win), True
            threading.Thread(target=count, daemon=True).start()
        else:
            count()

    def discover(self, now):
        lv = self.lv
        try:
            entries = [e for e in os.scandir(self.sub_dir) if e.name.startswith("agent-") and e.name.endswith(".jsonl")]
        except OSError:
            return
        for e in entries:
            if e.path in lv.tails:
                continue
            try:
                s = e.stat()
            except OSError:
                continue
            known = lv.known.get(e.path)
            if known and known[0] == s.st_mtime_ns:
                continue
            age = now - s.st_mtime * 1000
            done = False
            if age > WINDOW_MS:
                with open(e.path, "rb") as f:
                    f.seek(max(0, s.st_size - 65536))
                    done = peek_done(f.read())
                lv.known[e.path] = (s.st_mtime_ns, "old" if done else "stale")
                lv.stale_unreturned = sum(1 for v in lv.known.values() if v[1] == "stale")
                continue
            aid = e.name[6:-6]
            meta = {}
            try:
                with open(e.path[:-6] + ".meta.json", encoding="utf-8") as f:
                    meta = json.load(f)
            except (OSError, ValueError):
                pass
            st = AgentState(aid, meta.get("description") or aid)
            st.model, st.effort, st.depth = meta.get("model") or "", meta.get("effort") or "", meta.get("spawnDepth", 1)
            st.tu = meta.get("toolUseId")
            lv.agents[aid] = st
            t = lv.follow(e.path, st, ClaudeFeed(lv, st, False), now)
            self.prefix(st, e.path, t.start)
