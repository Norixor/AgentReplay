"""Gemini CLI side of the live state: folds session records into AgentState; sub-agent sessions are found in the main
session's directory.

What the file does and does not tell us (read this before trusting the "state" column):
  - A model message is written when the response has arrived, and written again (same id, same tokens) once its tool calls
    have finished, now carrying them. A tool call is therefore never visible while it runs, only after it completed, and
    its own timestamp is the completion time. The feed shows think / idle from the age of the last record and never
    claims an executing tool, except for a call whose recorded status is not final and for the wait on a sub-agent whose
    session file exists (that file only appears while the invoke_agent call runs).
  - Messages are accounted by id: the later copy replaces the earlier one (tokens and amount are counted once, deltas go to
    the time buckets), {"$rewindTo": id} undoes the accounted messages from that id on, {"$set": {"messages": [...]}}
    starts over - the same rules gemini_scan.read_session applies for the replay page.
"""
import json
import os
import re
import threading

import prices
import source_gemini
from common import merge_kind
from gemini_calls import SHELL_TOOLS, make_call
from gemini_scan import chats_dir, is_context, to_ms, user_text
from live import WINDOW_MS, AgentState, config
from live_brief import STORE_RES, tool_inp

_GEM_ID = re.compile(rb'^\{"id":"([^"]+)","timestamp":"[^"]+","type":"gemini"', re.M)
_DONE = (b'"name":"complete_task"', b'{"$set":{"summary"')
_CALL_CTX = {"out": STORE_RES, "inp": 200}   # the result is kept for the card brief; the input is rebuilt from the arguments (tool_inp)
_KEEP = 6000                           # accounted messages / ids remembered per agent for dedupe and rewinds


def read_head(path):
    """The metadata record (first line) of a session file."""
    try:
        with open(path, "rb") as f:
            d = json.loads(f.readline(2_000_000))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


class DocTail:
    """Tail for a legacy single-document .json session: every change of the file re-serves all of its messages (the feed
    is idempotent per message id)."""
    start = 0

    def __init__(self, path):
        self.path, self.sig = path, None

    def _lines(self):
        from gemini_scan import read_session
        d = read_session(self.path)
        return [json.dumps(m, ensure_ascii=False).encode() for m in d["msgs"]]

    def first(self, cutoff_ms):
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        self.sig = (st.st_size, st.st_mtime_ns)
        return self._lines()

    def read_new(self):
        try:
            st = os.stat(self.path)
        except OSError:
            return []
        if (st.st_size, st.st_mtime_ns) == self.sig:
            return []
        self.sig = (st.st_size, st.st_mtime_ns)
        return self._lines()


class GeminiFeed:
    def __init__(self, gl, st, is_main, path):
        self.gl, self.lv, self.st, self.main, self.path = gl, gl.lv, st, is_main, path
        self.order = {}        # message id -> record type, in file order (rewinds cut this list)
        self.step_of = {}      # gemini message id -> its step record (the second copy updates it in place)
        self.done_calls = set()
        self.anon = 0

    def feed(self, raw):
        try:
            r = json.loads(raw)
        except ValueError:
            return
        if not isinstance(r, dict):
            return
        if isinstance(r.get("$set"), dict):
            self.patch(r["$set"])
        elif "$rewindTo" in r:
            self.rewind(r["$rewindTo"])
        elif "sessionId" in r and "type" not in r:
            if self.st.start is None and to_ms(r.get("startTime")):
                self.st.start = to_ms(r["startTime"])
        else:
            self.message(r)

    # ------------------------------------------------------------ patches

    def patch(self, s):
        if isinstance(s.get("messages"), list):
            self.reset()
            for m in s["messages"]:
                if isinstance(m, dict):
                    self.message(m)
        if not self.main and s.get("summary"):
            self.finish(self.st.last_ts)   # a sub-agent session writes its summary when it ends

    def rewind(self, at):
        keys = list(self.order)
        if at in self.order:
            drop = keys[keys.index(at):]
        elif self.windowed():
            return        # the target is before the window: nothing we accounted can be undone reliably
        else:
            drop = keys
        for k in drop:
            self.order.pop(k, None)
            self.undo(k)
        self.refresh_ctx()

    def reset(self):
        for k in list(self.st.msg):
            self.undo(k)
        self.order.clear()
        self.st.pending.clear()
        self.st.ctx = 0

    def windowed(self):
        t = self.lv.tails.get(self.path)
        return bool(t and t[0].start > 0)

    def undo(self, key):
        st = self.st
        acc = st.msg.pop(key, None)
        self.step_of.pop(key, None)
        if acc is None:
            return
        prices.add_tok(st.tok, acc[2], -1)
        st.add_cost(acc[0], -acc[1], -prices.tok_total(acc[2]))
        st.ids.discard(key)
        st.steps = len(st.ids)
        try:
            st.step_ts.remove(acc[0])
        except ValueError:
            pass

    def refresh_ctx(self):
        vals = list(self.st.msg.values())
        self.st.ctx = vals[-1][3] if vals else 0

    # ------------------------------------------------------------ messages

    def message(self, m):
        kind, mid = m.get("type"), m.get("id")
        if not kind:
            return
        st = self.st
        ts = to_ms(m.get("timestamp")) or st.last_ts
        if mid:
            self.order.setdefault(mid, kind)
            if len(self.order) > _KEEP:
                del self.order[next(iter(self.order))]
        if ts:
            if st.start is None or ts < st.start:
                st.start = ts
            if ts > st.last_ts:
                st.last_ts = ts
        if kind == "user":
            self.user(m, ts)
        elif kind == "gemini":
            self.reply(m, ts, mid or self.anonymous())
        elif kind in ("info", "error", "warning"):
            body = user_text(m.get("content")).strip()
            if kind == "error" and body:
                self.lv.add_event(ts, "fail", st.id, "错误：%s" % body[:300])
            if kind == "error" or "cancel" in body.lower():
                st.last_kind = "end"

    def anonymous(self):
        self.anon += 1
        return "#%d" % self.anon

    def user(self, m, ts):
        st, lv = self.st, self.lv
        text = user_text(m.get("content")).strip()
        if is_context(text):
            return
        if not text:
            st.last_kind = "result"     # a tool result echoed back by the CLI
            return
        st.last_kind = "user"
        if self.main:
            lv.add_event(ts, "user", "main", text, full=len(text))
        elif st.id not in self.gl.briefed:
            self.gl.first_brief(st, text, ts)

    def reply(self, m, ts, key):
        st, lv, gl = self.st, self.lv, self.gl
        new = key not in st.msg
        model = str(m.get("model") or "")
        if model:
            st.model = model
            lv.models.add(model)
        u = m.get("tokens") if isinstance(m.get("tokens"), dict) else None
        if u:
            pr = source_gemini.price_step(model, dict(u, day=str(m.get("timestamp") or "")[:10]))
            if pr["cost"] is None:
                lv.unpriced.add(model or "(unknown)")
        else:   # no usage recorded (interrupted response): nothing to price, same as the replay page
            pr = prices.result(0.0, source_gemini.gemini_tokens(None), True)
        tok, cost = pr["tok"], pr["cost"] or 0.0
        acc = st.msg.setdefault(key, [ts, 0.0, prices.zero_tok(), 0])
        delta = {k: tok.get(k, 0) - acc[2].get(k, 0) for k in set(tok) | set(acc[2])}
        prices.add_tok(st.tok, delta)
        dq, dt = cost - acc[1], prices.tok_total(delta)
        if dq or dt:
            st.add_cost(acc[0], dq, dt)
        acc[1], acc[2], acc[3] = cost, dict(tok), tok["in"] + tok["cr"]
        if len(st.msg) > _KEEP:
            del st.msg[next(iter(st.msg))]
        if u:
            st.ctx = acc[3]
        if new:
            st.ids.add(key)
            st.steps = len(st.ids)
            st.step_ts.append(ts)
            step = self.step_of[key] = st.new_step(ts)
            if len(self.step_of) > 100:
                del self.step_of[next(iter(self.step_of))]
        else:
            step = self.step_of.get(key) or st.new_step(ts)
        text = user_text(m.get("content")).strip()
        subject = next((str(t.get("subject") or "").strip() for t in m.get("thoughts") or [] if isinstance(t, dict) and t.get("subject")), "")
        if text:
            st.said = text
            if not step["tool"]:
                step["tool"], step["sum"] = "回复", text.split("\n", 1)[0][:200]
        calls = self.calls(m, ts, step)
        if subject and not step["why"]:
            step["why"] = subject[:160]
        if not step["why"] and text:
            step["why"] = text.split("\n", 1)[0][:160]
        if calls is None:
            st.last_kind = "think"
        else:
            st.last_kind = "call" if calls else "result"
        # The first copy of a message that has tool calls is written before they ran; whether the turn ended or a tool is
        # running is not in the file, so a reply without calls stays "think" until the idle threshold (see module doc).

    def calls(self, m, ts, step):
        """Fold the tool calls of a message. -> None when it has none, else True while any call is still unfinished."""
        st, lv = self.st, self.lv
        raw = [tc for tc in m.get("toolCalls") or [] if isinstance(tc, dict)]
        if not raw:
            return None
        items = []
        for tc in raw:
            fin = to_ms(tc.get("timestamp"))
            items.append((fin or ts, str(tc.get("id") or "%s@%s" % (tc.get("name"), ts)), tc, make_call(tc, ts, fin, _CALL_CTX, None), fin))
        items.sort(key=lambda x: x[0])
        pending = False
        for at, cid, tc, c, fin in items:
            args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
            if fin and fin > st.last_ts:
                st.last_ts = fin
            if tc.get("agentId"):
                self.gl.invoked(tc["agentId"], st, args, ts, fin if c["st"] != "pend" else None, c["sum"])
            if not step["tool"] or step["tool"] == "回复":
                step["tool"], step["sum"] = c["name"], c["sum"]
            desc = c["desc"][:200]
            if desc and not step["why"]:
                step["why"] = desc
            cmd = str(args.get("command") or "") if c["name"].split("__")[-1] in SHELL_TOOLS else ""
            # one entry per call, shared by the step (card briefs) and the pending map (current call): messages are re-fed as they grow
            ent = next((x for x in step["calls"] if x["id"] == cid), None)
            if ent is None:
                ent = {"id": cid, "name": c["name"], "sum": c["sum"][:240], "desc": desc, "ts": ts, "cat": c["cat"], "bg": False,
                       "waitAgent": c["cat"] == "agent", "poll": False, "cmd": cmd, "cwd": st.cwd, "step": step, "inp": tool_inp(args, cmd)}
                step["calls"].append(ent)
            ent.update(st=c["st"], dur=c["dur"], res=c["res"], rlen=c["rlen"])
            if c["st"] == "pend":
                pending = True
                st.pending[cid] = ent
                continue
            st.pending.pop(cid, None)
            if cid in self.done_calls:
                continue
            if len(self.done_calls) > 5000:
                self.done_calls.clear()
            self.done_calls.add(cid)
            step["dur"] = max(step["dur"], c["dur"])
            if c["st"] == "err":
                step["st"] = "err"
                st.fail_streak += 1
                lv.add_event(at, "fail", st.id, "%s 失败：%s" % (c["name"], (c["sum"] or c["res"])[:120]))
            else:
                st.fail_streak = 0
                if cmd and c["cat"] == "git":
                    mk = merge_kind(cmd, st.cwd)
                    if mk:
                        st.merge_ts = at
                        lv.add_event(at, "merge", st.id, "合入主线（%s）：%s" % (mk, c["sum"][:120]))
            if cmd and c["cat"] == "wait":
                st.poll_ts = at
            if c["name"] == "complete_task" and c["st"] == "ok":
                self.finish(fin or ts)
        return pending

    def finish(self, ts):
        st = self.st
        if self.main or st.done:
            return
        st.done, st.done_ts = True, ts or st.last_ts
        self.gl.clear_wait(st.id)
        self.lv.add_event(st.done_ts, "handback", st.id, "子代理交回：%s" % (st.desc or st.id))


class GeminiLive:
    def __init__(self, lv):
        self.lv = lv
        self.sub_dir = os.path.join(chats_dir(lv.path), lv.id)
        self.info = {}          # sub-agent session id -> {issuer, name, ret}: what the invoking call told us
        self.dispatched = set()
        self.briefed = set()

    def build(self, now):
        lv = self.lv
        main = AgentState("main", "主代理")
        main.start = lv.row.get("start")
        main.model = lv.row.get("model") or ""
        main.cwd = lv.row.get("cwd") or ""
        lv.agents["main"] = main
        feed = GeminiFeed(self, main, True, lv.path)
        tail = DocTail(lv.path) if lv.path.endswith(".json") else None
        t = lv.follow(lv.path, main, feed, now, tail=tail)
        self.prefix(main, lv.path, t.start)
        self.discover(now)

    def prefix(self, st, path, upto):
        """Steps before the window: the distinct gemini message ids there. Large prefixes get an estimate now and the exact
        count from a background thread."""
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
                    seen.update(m.decode() for m in _GEM_ID.findall(data[:cut]))
                    tail = data[cut:]
            st.prefix_steps = len(seen - set(st.msg))
            st.approx = False

        if upto > 24_000_000:
            st.prefix_steps, st.approx = int(st.steps * upto / win), True
            threading.Thread(target=count, daemon=True).start()
        else:
            count()

    # ------------------------------------------------------------ sub-agents

    def discover(self, now):
        lv = self.lv
        self.prune_waits(now)
        try:
            entries = [e for e in os.scandir(self.sub_dir) if e.name.endswith(".jsonl")]
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
            if now - s.st_mtime * 1000 > WINDOW_MS:
                try:
                    with open(e.path, "rb") as f:
                        f.seek(max(0, s.st_size - 65536))
                        data = f.read()
                except OSError:
                    continue
                lv.known[e.path] = (s.st_mtime_ns, "old" if any(data.rfind(k) >= 0 for k in _DONE) else "stale")
                lv.stale_unreturned = sum(1 for v in lv.known.values() if v[1] == "stale")
                continue
            self.add_child(e.name[:-6], e.path, now)

    def add_child(self, sid, path, now):
        lv = self.lv
        meta = read_head(path)
        sid = meta.get("sessionId") or sid
        if sid in lv.agents:
            return
        st = AgentState(sid, "子代理 · %s" % sid[:8])
        st.depth, st.tu = 1, sid
        st.start = to_ms(meta.get("startTime"))
        dirs = meta.get("directories")
        st.cwd = str(dirs[0]) if isinstance(dirs, list) and dirs else ""
        lv.agents[sid] = st
        lv.tu_owner.setdefault(sid, "main")
        feed = GeminiFeed(self, st, False, path)
        t = lv.follow(path, st, feed, now)
        self.prefix(st, path, t.start)
        self.apply(sid)
        info = self.info.get(sid)
        if not st.done and not (info and info["ret"] is not None):
            issuer = lv.agents.get(info["issuer"]) if info else None
            (issuer or lv.agents["main"]).pending["wait:" + sid] = {
                "id": "wait:" + sid, "name": "invoke_agent", "sum": "等待子代理 %s" % st.desc, "desc": st.desc, "ts": st.start or now, "cat": "agent",
                "bg": False, "waitAgent": True, "poll": False, "cmd": "", "cwd": "", "step": None}

    def first_brief(self, st, text, ts):
        """A sub-agent's first user message is its briefing; it also tells us a dispatch happened when the invoking call has
        not been written yet (it is written when the child returns)."""
        self.briefed.add(st.id)
        if st.id not in self.info:
            self.set_brief(st.id, text)
        if st.id not in self.dispatched:
            self.dispatched.add(st.id)
            first = text.strip().split("\n", 1)[0][:160]
            self.lv.add_event(ts, "dispatch", self.lv.tu_owner.get(st.id, "main"), "派单：子代理 · %s" % first, tool="invoke_agent")

    def set_brief(self, sid, prompt):
        lines = [l.strip() for l in str(prompt).split("\n") if l.strip()]
        lv = self.lv
        lv.briefs[sid] = {"lines": [l[:160] for l in lines[:2]], "why": next((l[:240] for l in lines if l.lstrip(" >*-").startswith("选档理由")), "")}
        if len(lv.briefs) > 300:
            del lv.briefs[next(iter(lv.briefs))]

    def invoked(self, sid, issuer, args, ts, ret, summ):
        """An invoke_agent call (any call with an agentId) was recorded: `ret` is its completion time, None while it is not final."""
        lv = self.lv
        self.info[sid] = {"issuer": issuer.id, "name": str(args.get("agent_name") or ""), "ret": ret}
        lv.tu_owner[sid] = issuer.id
        self.set_brief(sid, args.get("prompt") or "")
        if sid not in self.dispatched:
            self.dispatched.add(sid)
            lv.add_event(ts, "dispatch", issuer.id, "派单：%s" % summ[:200], tool="invoke_agent")
        self.apply(sid)

    def apply(self, sid):
        """Hand the invoking call's facts (name, depth, returned) to the sub-agent state once both exist."""
        lv = self.lv
        info, child = self.info.get(sid), lv.agents.get(sid)
        if not info or not child:
            return
        child.desc = "%s · %s" % (info["name"] or "子代理", sid[:8])
        issuer = lv.agents.get(info["issuer"])
        child.depth = (issuer.depth if issuer else 0) + 1
        if info["ret"] is not None and not child.done:
            child.done, child.done_ts = True, info["ret"]
            self.clear_wait(sid)
            lv.add_event(info["ret"], "handback", sid, "子代理交回：%s" % child.desc)
        elif info["ret"] is not None:
            self.clear_wait(sid)

    def clear_wait(self, sid):
        for a in self.lv.agents.values():
            a.pending.pop("wait:" + sid, None)

    def prune_waits(self, now):
        """Drop the wait on a sub-agent that is finished or has not written for staleSubSec."""
        stale = config()["staleSubSec"] * 1000
        for a in self.lv.agents.values():
            for k in [k for k in a.pending if k.startswith("wait:")]:
                c = self.lv.agents.get(k[5:])
                if c is None or c.done or now - max(c.last_ts, c.start or 0) > stale:
                    a.pending.pop(k, None)
