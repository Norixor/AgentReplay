"""opencode side of the live state: folds the changed message / part rows of opencode_tail into AgentState.

One agent per session: the listed session is "main", every sub-session (session.parent_id, recursively) is an agent keyed by
its session id. Rows are updated in place while a response streams (tokens appear when the message completes, a tool part
goes pending -> running -> completed), so the feed keeps the latest version of every message and part and re-derives from
it: a step is registered once per message id, tokens and amount of a message are replaced (not added) when they change, and
a call is pending until its part reports completed / error. The numbers use the replay page's helpers
(parse_opencode.message_tokens / usage_of / link_tasks / describe, opencode_calls.make_call, source_opencode.price_step), so
the same messages give the same tokens and amount in both views.
"""
import json
import sqlite3

import opencode_scan
import opencode_tail
import parse_opencode
import source_opencode
from common import merge_kind
from live import WINDOW_MS, AgentState
from live_brief import STORE_RES, tool_inp
from opencode_calls import make_call
from opencode_scan import model_id
from prices import add_tok, tok_total, zero_tok

CTX = {"out": STORE_RES, "inp": 300}   # caps for make_call; the input is rebuilt from the arguments (tool_inp)
OPEN = parse_opencode.DONE_REASONS_OPEN
MAX_MSGS = 300                   # messages kept per agent (older ones are dropped, their step and money stay counted)
REPROBE_MS = 30_000


class OpencodeFeed:
    def __init__(self, lv, st, is_main, owner, aid, model0=""):
        self.lv, self.st, self.main, self.owner, self.aid, self.model0 = lv, st, is_main, owner, aid, model0
        self.msgs = {}        # message id -> {"d": slim message JSON, "c": created, "role", "parts": {part id: slim part JSON}}
        self.calls = {}       # part id -> call dict
        self.steps = {}       # message id -> step record
        self.msg_calls = {}   # message id -> [part ids of its tool calls]
        self.newest = None    # (created, message id) of the newest message
        self.ctx_key = (0, "")

    def feed(self, raw):
        try:
            r = json.loads(raw)
        except ValueError:
            return
        k = r.get("k") if isinstance(r, dict) else None
        if k == "m":
            self.message(r)
        elif k == "p":
            self.part(r)
        else:
            return
        self.settle()

    # ------------------------------------------------------------ rows

    def touch(self, created, updated):
        st = self.st
        if created and (st.start is None or created < st.start):
            st.start = created
        st.last_ts = max(st.last_ts, created, updated)

    def message(self, r):
        mid, d = r.get("id"), r.get("d") or {}
        created = int((d.get("time") or {}).get("created") or r.get("c") or 0)
        m = self.msgs.get(mid)
        if m is None:
            m = self.msgs[mid] = {"c": created, "parts": {}}
        m["d"], m["role"] = d, d.get("role")
        self.touch(created, int(r.get("u") or 0))
        if self.newest is None or (created, mid) >= self.newest:
            self.newest = (created, mid)
        if m["role"] == "assistant":
            self.assistant(mid)
        if len(self.msgs) > MAX_MSGS:
            self.prune()

    def part(self, r):
        mid, pid = r.get("mid"), r.get("id")
        m = self.msgs.get(mid)
        if m is None:
            return
        pd = r.get("d") or {}
        c = int(r.get("c") or 0)
        fresh = pid not in m["parts"]
        m["parts"][pid] = pd
        self.touch(c, int(r.get("u") or 0))
        if m["role"] == "user":
            self.user_part(m, pd, fresh)
        elif m["role"] == "assistant":
            if pd.get("type") == "tool":
                self.tool_part(mid, pid, pd, c, int(r.get("u") or 0))
            self.assistant(mid)

    def user_part(self, m, pd, fresh):
        t = pd.get("type")
        if t == "text" and not pd.get("ignored"):
            tx = (pd.get("text") or "").strip()
            if tx and self.main:
                self.lv.add_event(m["c"], "user", "main", tx, full=len(tx))
        elif t == "compaction" and fresh:
            self.lv.add_event(m["c"], "compact", self.st.id, "上下文压缩")
            self.st.ctx = 0

    @staticmethod
    def ended(m):
        """The response is over for good: it finished with a final reason, or failed / was aborted."""
        d = m["d"]
        return bool(d.get("error")) or bool((d.get("time") or {}).get("completed") and d.get("finish") not in OPEN)

    def ensure_step(self, mid):
        st = self.st
        step = self.steps.get(mid)
        if step is None:
            created = self.msgs[mid]["c"]
            if mid not in st.ids:
                st.ids.add(mid)
                st.steps = len(st.ids)
                st.step_ts.append(created)
                st.msg.setdefault(mid, [created, 0.0, zero_tok()])
                if len(st.msg) > 2000:
                    for k in list(st.msg)[:500]:
                        del st.msg[k]
            step = self.steps[mid] = st.new_step(created)
            step["n"] = st.steps
        return step

    def assistant(self, mid):
        """(Re)derive what an assistant message contributes: step, text, tokens and amount; drop calls of a finished response."""
        st, lv = self.st, self.lv
        m = self.msgs[mid]
        d = m["d"]
        texts, rsum, has_tool = [], False, False
        for pd in m["parts"].values():
            t = pd.get("type")
            if t == "text" and not pd.get("ignored") and (pd.get("text") or "").strip():
                texts.append(pd["text"].strip())
            elif t == "reasoning" and (pd.get("text") or "").strip():
                rsum = True
            elif t == "tool":
                has_tool = True
        tk = parse_opencode.message_tokens(d, [{"data": pd} for pd in m["parts"].values()])
        model = model_id(d.get("modelID") or d.get("model")) or self.model0
        if model:
            st.model = model
            lv.models.add(model)
        paid = any(tk.values())
        if texts or rsum or has_tool or paid:
            step = self.ensure_step(mid)
            if texts:
                st.said = texts[-1]
                if not step["calls"]:
                    step["tool"], step["sum"] = "回复", texts[-1].split("\n", 1)[0][:200]
            if paid:
                self.account(mid, model, tk, d, m["c"])
        if self.ended(m):
            for pid in self.msg_calls.get(mid, ()):
                st.pending.pop(pid, None)

    def account(self, mid, model, tk, d, created):
        """Tokens and amount of one message, replaced (not added) when the row changes."""
        st, lv = self.st, self.lv
        acc = st.msg.setdefault(mid, [created, 0.0, zero_tok()])
        pr = source_opencode.price_step(model, parse_opencode.usage_of(tk, d, created))
        if pr["cost"] is None:
            lv.unpriced.add(model or "(unknown)")
        cost = pr["cost"] or 0.0
        delta = {k: v - acc[2].get(k, 0) for k, v in pr["tok"].items()}
        add_tok(st.tok, delta)
        dq, dt = cost - acc[1], tok_total(delta)
        if dq or dt:
            st.add_cost(acc[0], dq, dt)
        acc[1], acc[2] = cost, dict(pr["tok"])
        if (created, mid) >= self.ctx_key:
            self.ctx_key, st.ctx = (created, mid), tk["in"] + tk["cr"] + tk["cw"]

    # ------------------------------------------------------------ tool calls

    def tool_part(self, mid, pid, pd, created, updated):
        st, lv = self.st, self.lv
        m = self.msgs[mid]
        step = self.ensure_step(mid)
        mk = make_call(dict(pd, _created=created), CTX)
        state = pd.get("state") or {}
        inp = state.get("input") if isinstance(state.get("input"), dict) else {}
        done = state.get("status") in ("completed", "error")
        cmd = str(inp.get("command") or "") if mk["name"] in ("bash", "shell") else ""
        call = self.calls.get(pid)
        new = call is None
        if new:
            call = self.calls[pid] = {"id": pid, "bg": False, "step": step, "done": False, "_sid": "", "_in": {}, "dispatched": False, "st": "pend"}
            self.msg_calls.setdefault(mid, []).append(pid)
            step["calls"].append(call)
        old_sid = call["_sid"]
        call.update(name=mk["name"], sum=mk["sum"][:240], desc=mk["desc"][:200], ts=mk["ts"], cat=mk["cat"], waitAgent=mk["cat"] == "agent",
                    poll=mk["cat"] == "wait" and bool(cmd), cmd=cmd, cwd=(m["d"].get("path") or {}).get("cwd") or st.cwd,
                    _sid=mk.get("_sid", ""), _in=mk.get("_in") or {}, inp=tool_inp(inp, cmd), res=mk["res"], rlen=mk["rlen"], dur=mk["dur"])
        if step["calls"][0] is call or step["tool"] in ("", "回复"):
            step["tool"], step["sum"] = call["name"], call["sum"]
        if not step["why"]:
            why = call["desc"] or (st.said.split("\n", 1)[0][:160] if st.said else "")
            if why:
                step["why"] = why
        if call["cat"] == "agent":
            if new:
                self.owner.tasks.setdefault(self.aid, []).append(call)
            self.dispatch(call, inp)
        if call["poll"] and not done:
            st.poll_ts = call["ts"]
        if not call["done"]:
            if done:
                self.finish_call(call, mk, updated)
            elif not self.ended(m):
                st.pending[pid] = call
        if call["cat"] == "agent" and (new or call["_sid"] != old_sid):
            self.owner.relink()

    def dispatch(self, call, inp):
        if call["dispatched"] or not (call["_in"].get("description") or call["_in"].get("subagent_type")):
            return
        call["dispatched"] = True
        lv = self.lv
        lv.tu_owner[call["id"]] = self.st.id
        lines = [l.strip() for l in str(inp.get("prompt") or "").split("\n") if l.strip()]
        lv.briefs[call["id"]] = {"lines": [l[:160] for l in lines[:2]], "why": next((l[:240] for l in lines if l.startswith("选档理由")), "")}
        if len(lv.briefs) > 300:
            del lv.briefs[next(iter(lv.briefs))]
        lv.add_event(call["ts"], "dispatch", self.st.id, "派单：%s" % (call["desc"] or call["sum"]), tool="task")

    def finish_call(self, call, mk, updated):
        st, lv = self.st, self.lv
        call["done"] = True
        st.pending.pop(call["id"], None)
        step = call["step"]
        end = call["ts"] + mk["dur"] if mk["dur"] else updated
        step["dur"] = max(step["dur"], mk["dur"])
        if mk["st"] == "err":
            call["st"] = step["st"] = "err"
            st.fail_streak += 1
            lv.add_event(end, "fail", st.id, "%s 失败：%s" % (call["name"], (call["sum"] or mk["res"])[:120]))
        else:
            call["st"] = "ok"
            st.fail_streak = 0
            if call["cat"] == "git" and call["cmd"]:
                kind = merge_kind(call["cmd"], call["cwd"])
                if kind:
                    st.merge_ts = end
                    lv.add_event(end, "merge", st.id, "合入主线（%s）：%s" % (kind, call["sum"][:120]))
        if call["cat"] == "agent":
            self.owner.task_done(call, end)

    # ------------------------------------------------------------ agent state

    def settle(self):
        """last_kind and the returned flag of a sub-agent follow from the newest message, whatever order the rows arrived in."""
        st = self.st
        m = self.msgs.get(self.newest[1]) if self.newest else None
        if m is None:
            return
        mid = self.newest[1]
        if st.done and mid != st.done_key:
            st.done = False  # a newer message reopens a returned sub-agent
        if m["role"] != "assistant":
            st.last_kind = "user"
        elif self.ended(m):
            st.last_kind = "end"
            if not self.main and not st.pending:
                self.finish((m["d"].get("time") or {}).get("completed") or st.last_ts, mid)
        else:
            st.last_kind = "call" if st.pending else "think"

    def finish(self, ts, mid):
        st = self.st
        if not st.done:
            st.done, st.done_ts, st.done_key = True, ts, mid
            self.lv.add_event(ts, "handback", st.id, "子代理交回：%s" % (st.desc or st.id))

    def returned(self, ts):
        """The parent's task call came back: this sub-agent is done unless it already wrote something newer."""
        if not self.main and self.newest:
            self.finish(ts, self.newest[1])

    def prune(self):
        keep = {mid for pid in self.st.pending for mid, ids in self.msg_calls.items() if pid in ids}
        keep.add(self.newest[1] if self.newest else None)
        for key in sorted(self.msgs, key=lambda i: (self.msgs[i]["c"], i))[:len(self.msgs) - MAX_MSGS]:
            if key in keep:
                continue
            del self.msgs[key]
            self.steps.pop(key, None)
            for pid in self.msg_calls.pop(key, ()):
                self.calls.pop(pid, None)


class OpencodeLive:
    def __init__(self, lv):
        self.lv = lv
        self.db, self.root_sid = opencode_scan.split(lv.path)
        self.sess = {}      # agent id -> session row ("main" = the listed session)
        self.tasks = {}     # agent id -> its task calls
        self.feeds = {}     # agent id -> OpencodeFeed
        self.tail_of = {}   # agent id -> OpencodeTail
        self.fp = None      # database fingerprint at the last sub-session discovery

    def read_rows(self):
        """{session id: row} of the whole session table, None when the database cannot be read right now."""
        try:
            con = opencode_scan.connect(self.db)
            try:
                return opencode_tail.read_sessions(con)
            finally:
                con.close()
        except (sqlite3.Error, OSError):
            return None

    def build(self, now):
        lv = self.lv
        main = AgentState("main", "主代理")
        main.start = lv.row.get("start")
        main.model = lv.row.get("model") or ""
        lv.agents["main"] = main
        rows = self.read_rows() or {}
        root = rows.get(self.root_sid)
        if root:
            self.sess["main"] = root
            main.cwd = root["directory"] or ""
            main.start = main.start or root["time_created"]
        self.start_agent("main", main, lv.path, root, now)
        self.discover(now)

    def start_agent(self, aid, st, path, sess, now):
        lv = self.lv
        self.feeds[aid] = feed = OpencodeFeed(lv, st, aid == "main", self, aid, model_id((sess or {}).get("model")))
        self.tail_of[aid] = tail = opencode_tail.OpencodeTail(path)
        lv.follow(path, st, feed, now, tail=tail)
        st.prefix_steps = tail.prefix

    def discover(self, now):
        """New sub-sessions (recursively below the listed session): any session row whose parent is already in the tree."""
        lv = self.lv
        for aid, tail in self.tail_of.items():
            lv.agents[aid].prefix_steps = tail.prefix  # set once the opening window could be read
        fp = opencode_tail.fingerprint(self.db)
        if fp[0] is None or fp == self.fp:
            return
        rows = self.read_rows()
        if rows is None:
            return
        self.fp = fp
        kids = {}
        for sid, s in rows.items():
            if s["parent_id"]:
                kids.setdefault(s["parent_id"], []).append(sid)
        depth, stack = {self.root_sid: 0}, [self.root_sid]
        while stack:
            sid = stack.pop()
            for k in sorted(kids.get(sid, ()), key=lambda x: (rows[x]["time_created"] or 0, x), reverse=True):
                if k not in depth:
                    depth[k] = depth[sid] + 1
                    stack.append(k)
        order = sorted((s for s in depth if s != self.root_sid), key=lambda s: (depth[s], rows[s]["time_created"] or 0, s))
        if self.root_sid in rows:
            self.sess["main"] = rows[self.root_sid]
        for sid in order:
            self.sess[sid] = rows[sid]
            if sid not in lv.agents:
                self.add_child(sid, rows[sid], depth[sid], now)
        self.relink()

    def add_child(self, sid, s, depth, now):
        lv = self.lv
        path = opencode_scan.vpath(self.db, sid)
        if now - (s["time_created"] or 0) > WINDOW_MS:   # an old sub-session: follow it only if it is still going
            known = lv.known.get(path)
            if known and known[0] == s["time_updated"] and now - known[2] < REPROBE_MS:
                return
            try:
                con = opencode_scan.connect(self.db)
                try:
                    last, ended = opencode_tail.probe(con, sid)
                finally:
                    con.close()
            except (sqlite3.Error, OSError):
                return
            if now - max(last, s["time_updated"] or 0) > WINDOW_MS:
                lv.known[path] = (s["time_updated"], "old" if ended else "stale", now)
                lv.stale_unreturned = sum(1 for v in lv.known.values() if v[1] == "stale")
                return
            lv.known.pop(path, None)
            lv.stale_unreturned = sum(1 for v in lv.known.values() if v[1] == "stale")
        st = AgentState(sid, sid[-8:])
        st.depth, st.parent_tid, st.cwd, st.start = depth, s["parent_id"], s["directory"] or "", s["time_created"]
        st.model = model_id(s["model"])
        lv.agents[sid] = st
        self.start_agent(sid, st, path, s, now)

    def relink(self):
        """Match task calls to sub-sessions again (the same rules as the replay page): names, task ids and the brief."""
        if "main" not in self.sess:
            return
        for calls in self.tasks.values():
            for c in calls:
                c.pop("agent", None)
        claimed = parse_opencode.link_tasks({aid: {"tasks": self.tasks.get(aid, [])} for aid in self.sess}, self.sess)
        for aid, st in self.lv.agents.items():
            if aid == "main" or aid not in self.sess:
                continue
            c = claimed.get(aid)
            st.desc = parse_opencode.describe(aid, self.sess[aid], (c or {}).get("_in") or {})
            st.tu = c["id"] if c else None

    def task_done(self, call, end):
        """A task call came back: its sub-agent has handed back."""
        self.relink()
        feed = self.feeds.get(call.get("agent"))
        if feed is not None:
            feed.returned(end)
