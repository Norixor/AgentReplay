"""Cursor side of the live state: folds the lines of cursor_tail.CursorTail into AgentState; sub-agent chats are found through
the sub-agent ids of the chat and the task calls that started them.

Same reading of the chat as the replay parser (parse_cursor.build_agent): one model response is several messages (thinking,
reply text, one message per tool call); the calls of one response (shared response id, else back to back) are one step.
Differences forced by the live setting:
  * a step is counted when its first message appears (the replay counts it when the next one closes it)
  * a tool message that has not finished yet is a pending call (the page shows "executing"); the finished message arrives
    later as an update of the same bubble id and resolves it, without counting a second step
  * a call that finished without a completedAtMs ends at the next message's stamp, as in the replay (resolved when it arrives)
Cursor records no token usage, so tok / amounts stay zero (Source.page["noUsage"]; the page leaves them out).
"""
import json
import time

import cursor_scan
import cursor_tail
from common import merge_kind
from cursor_calls import AGENT_TOOLS, SHELL_TOOLS, agent_id, agent_kind, args_of, is_finished, make_call, response_key, same_response
from live import WINDOW_MS, AgentState
from live_brief import STORE_RES, tool_inp
from parse_cursor import model_of

CTX = {"out": STORE_RES, "inp": 240}   # caps for make_call; the input is rebuilt from the arguments (tool_inp)
STALE_RECHECK_S = 60             # how often a sub-agent chat that looked old is looked at again
KNOWN_MAX = 6000


class CursorFeed:
    """Folds the lines of one chat into its AgentState (aid: "main" or the composerId)."""

    def __init__(self, impl, st, aid):
        self.impl, self.lv, self.st, self.aid = impl, impl.lv, st, aid
        self.main = aid == "main"
        self.grp = None            # the step being filled: {step, mcid, calls, call_end}
        self.known = {}            # bubble id -> {"call": call dict | None, "text": bool}: a repeated line updates, never recounts
        self.await_end = []        # finished calls without completedAtMs: they end at the next message's stamp
        self.amsgs = 0             # assistant messages folded (the ratio for the steps before the window)
        self.name = ""
        self.status, self.gen = "", False

    def feed(self, raw):
        try:
            r = json.loads(raw)
        except ValueError:
            return
        if not isinstance(r, dict):
            return
        if r.get("k") == "c":
            self.chat(r)
        elif r.get("k") == "m" and isinstance(r.get("b"), dict) and isinstance(r.get("h"), dict):
            self.message(r)

    # ------------------------------------------------------------ chat state

    def chat(self, r):
        st = self.st
        model, effort = model_of({"modelConfig": r.get("mc")})
        st.model, st.effort = model or st.model, effort or st.effort
        if st.model:
            self.lv.models.add(st.model)
        if isinstance(r.get("ctx"), (int, float)) and not isinstance(r["ctx"], bool) and r["ctx"] > 0:
            st.ctx = int(r["ctx"])
        if isinstance(r.get("limit"), (int, float)) and not isinstance(r["limit"], bool):
            st.window = int(r["limit"])
        if st.start is None and r.get("created"):
            st.start = r["created"]
        self.name, self.status, self.gen = str(r.get("name") or ""), str(r.get("status") or ""), bool(r.get("gen"))
        for cid in r.get("subs") or []:
            self.impl.note_sub(cid, self.aid)
        self.impl.refresh_desc(self.aid)
        self.settle()

    def settle(self):
        """A chat that reports completed / aborted and writes nothing is not executing: calls that have been open for longer than
        the long-command limit are dropped (their message was never completed, e.g. after the user stopped the run). Younger
        ones stay: Cursor may keep the previous status until the new turn is over."""
        st = self.st
        if self.status not in ("completed", "aborted") or self.gen or not st.pending:
            return
        limit_ms = 600_000
        for cid, c in list(st.pending.items()):
            if st.last_ts - c["ts"] > limit_ms:
                del st.pending[cid]
        if not st.pending and st.last_kind in ("call", "result"):
            st.last_kind = "end"

    # ------------------------------------------------------------ messages

    def message(self, r):
        st = self.st
        bid, ts, b, h = r.get("id"), r.get("ts"), r["b"], r["h"]
        if not isinstance(ts, int) or not bid:
            return
        if bid in self.known:
            self.update(bid, b, h, ts)
            return
        self.known[bid] = {"call": None, "text": False}
        if len(self.known) > KNOWN_MAX:
            del self.known[next(iter(self.known))]
        if st.start is None or ts < st.start:
            st.start = ts
        if ts > st.last_ts:
            st.last_ts = ts
        for c in self.await_end:  # finished calls without an end stamp end where this message starts
            c["step"]["dur"] = max(c["step"]["dur"], max(0, ts - c["ts"]))
        self.await_end = []
        if b.get("type") == 1:
            self.user(b, ts)
        elif b.get("type") == 2:
            self.amsgs += 1
            if b.get("tool"):
                self.call(bid, b, h, ts)
            else:
                self.text(bid, b, h, ts)
            if h.get("turnDurationMs") and not b.get("tool"):  # the final reply of a turn carries the turn's length
                self.grp = None
                st.last_kind = "end"
        self.settle()

    def user(self, b, ts):
        st = self.st
        self.grp = None
        st.pending.clear()  # a new turn: whatever was still open from the previous one is over
        tx = (b.get("text") or "").strip()
        if self.main and tx:
            self.lv.add_event(ts, "user", "main", tx, full=len(tx))
        st.last_kind = "user"

    def open_group(self, ts):
        st = self.st
        step = st.new_step(ts)
        st.steps += 1
        st.step_ts.append(ts)
        self.grp = {"step": step, "mcid": None, "calls": 0, "call_end": None}
        return self.grp

    def text(self, bid, b, h, ts):
        st = self.st
        text, think = (b.get("text") or "").strip(), (b.get("thinking") or "").strip()
        dur = b.get("thinkingDurationMs") or h.get("thinkingDurationMs")
        if not (text or think or dur):
            return
        if self.grp is not None and self.grp["calls"]:
            self.grp = None  # text after calls is the next model response
        grp = self.grp or self.open_group(ts)
        step = grp["step"]
        if text:
            st.said = text
            self.known[bid]["text"] = True
            if not step["calls"]:
                step["tool"], step["sum"] = "回复", text.split("\n", 1)[0][:200]
        elif not step["calls"] and not step["tool"]:
            step["tool"], step["sum"] = "思考", (think.split("\n", 1)[0][:200] if think else "")
        st.last_kind = "think"

    def call(self, bid, b, h, ts):
        st, lv = self.st, self.lv
        t = b["tool"]
        mcid = response_key(t)
        grp = self.grp
        if grp is not None and grp["calls"] and not same_response(mcid, grp["mcid"], ts, grp["call_end"]):
            grp = None
        grp = grp or self.open_group(ts)
        end = cursor_scan.ms_of(h.get("completedAtMs"))
        c0 = make_call(b, ts, end, CTX, None)
        name = c0["name"]
        p, raw = args_of(t)
        both = dict(raw, **p)
        cmd = str(both.get("command") or "") if name in SHELL_TOOLS else ""
        agent = name in AGENT_TOOLS
        step = grp["step"]
        call = {"id": bid, "name": name, "sum": c0["sum"][:240], "desc": c0["desc"][:200], "ts": ts, "cat": c0["cat"], "bg": False,
                "waitAgent": agent, "poll": c0["cat"] == "wait" and not agent and bool(cmd), "cmd": cmd, "cwd": st.cwd, "step": step,
                "st": "pend", "agent": "", "inp": tool_inp(both, cmd), "res": "", "rlen": 0, "dur": 0}
        grp["mcid"] = grp["mcid"] or mcid
        grp["calls"] += 1
        step["calls"].append(call)
        if len(step["calls"]) == 1:
            step["tool"], step["sum"] = name, call["sum"]
        why = call["desc"] or (st.said.split("\n", 1)[0][:160] if st.said else "")
        if why and not step["why"]:
            step["why"] = why
        st.pending[bid] = call
        st.last_kind = "call"
        if call["poll"]:
            st.poll_ts = ts
        self.known[bid]["call"] = call
        if agent:
            self.dispatch(call, t, both, ts)
        if c0["st"] != "pend":
            self.finish(call, c0, end, ts)
        grp["call_end"] = max(grp["call_end"] or 0, ts + (c0["dur"] if c0["st"] != "pend" else 0))

    def dispatch(self, call, t, both, ts):
        cid = agent_id(t)
        if not cid or call["agent"]:
            return
        call["agent"] = cid
        kind, what = agent_kind(both), str(both.get("description") or "")
        model = str(both.get("model") or "")
        self.impl.note_dispatch(cid, self.aid, {"type": kind, "description": what, "prompt": str(both.get("prompt") or ""), "model": model})
        self.lv.add_event(ts, "dispatch", self.st.id, "派单：%s%s" % (what or call["sum"], "（%s）" % model if model else ""))

    def finish(self, call, c0, end, ts, late=False):
        """A call got its outcome (ok / failed): resolve it, count a failure, note a merge, report a returned sub-agent.
        late: the outcome arrived as an update of an older message, so newer messages of this poll are already folded and
        decide the chat's last kind (only "a call is open" turns into "a result came back")."""
        st, lv = self.st, self.lv
        st.pending.pop(call["id"], None)
        step = call["step"]
        call["res"], call["rlen"], call["dur"] = c0["res"], c0["rlen"], c0["dur"]
        if end is None:
            self.await_end.append(call)
        else:
            step["dur"] = max(step["dur"], c0["dur"])
        if not late or st.last_kind == "call":
            st.last_kind = "result"
        if c0["st"] == "err":
            call["st"] = step["st"] = "err"
            st.fail_streak += 1
            lv.add_event(end or ts, "fail", st.id, "%s 失败：%s" % (call["name"], (call["sum"] or c0["res"])[:120]))
        else:
            call["st"] = "ok"
            st.fail_streak = 0
            if call["cat"] == "git" and call["cmd"]:
                mk = merge_kind(call["cmd"], call["cwd"])
                if mk:
                    st.merge_ts = end or ts
                    lv.add_event(end or ts, "merge", st.id, "合入主线（%s）：%s" % (mk, call["sum"][:120]))
        if call["agent"]:
            self.impl.on_return(call["agent"], end or ts)

    def update(self, bid, b, h, ts):
        """A bubble seen before: a running call that finished, a sub-agent id that appeared, a reply that got its text."""
        k = self.known[bid]
        call = k["call"]
        if call is not None:
            if call["st"] == "pend" and b.get("tool"):
                t = b["tool"]
                end = cursor_scan.ms_of(h.get("completedAtMs"))
                p, raw = args_of(t)
                if call["name"] in AGENT_TOOLS and not call["agent"]:
                    self.dispatch(call, t, dict(raw, **p), call["ts"])
                if is_finished(t):
                    c0 = make_call(b, call["ts"], end, CTX, None)
                    self.finish(call, c0, end, ts, late=True)
                    self.st.last_ts = max(self.st.last_ts, end or ts)
            return
        text = (b.get("text") or "").strip()
        if text and not k["text"] and self.grp is not None and not self.grp["step"]["calls"]:
            k["text"] = True
            self.st.said = text
            self.grp["step"]["tool"], self.grp["step"]["sum"] = "回复", text.split("\n", 1)[0][:200]


class CursorLive:
    def __init__(self, lv):
        self.lv = lv
        self.db, self.root_id = cursor_scan.split(lv.path)
        self.feeds = {}        # agent id -> CursorFeed
        self.owner = {}        # sub-agent chat id -> id of the agent whose chat names it ("main" or another chat id)
        self.dispatch = {}     # sub-agent chat id -> {type, description, prompt, model, owner} from the task call
        self.returned = {}     # sub-agent chat id -> ms its task call completed

    # ------------------------------------------------------------ build / discover

    def build(self, now):
        lv = self.lv
        main = AgentState("main", "主代理")
        main.start = lv.row.get("start")
        main.cwd = lv.row.get("cwd") or ""
        lv.agents["main"] = main
        self.follow("main", lv.path, main, now)
        self.children(now)

    def follow(self, aid, path, st, now):
        feed = CursorFeed(self, st, aid)
        self.feeds[aid] = feed
        tail = cursor_tail.CursorTail(path)
        self.lv.follow(path, st, feed, now, tail=tail)
        if tail.prefix_msgs > 0:  # messages before the window are only counted, with the step density of the window
            st.approx = True
            ratio = st.steps / feed.amsgs if feed.amsgs >= 5 else 0.5
            st.prefix_steps = int(tail.prefix_msgs * ratio)

    def discover(self, now):
        """Poll every followed chat once and fold its new lines now (so sub-agent chats they name are followed in the same
        refresh; the refresh loop that runs after this finds nothing more to read), then follow the sub-agent chats that
        appeared. A failed read is reported once as an event and retried on the next refresh."""
        lv = self.lv
        for t, st, feed in list(lv.tails.values()):
            for ln in t.read_new():
                if ln:
                    feed.feed(ln)
            err = getattr(t, "error", "")
            if err and err != getattr(t, "reported", ""):
                lv.add_event(now, "fail", st.id, "读取 Cursor 数据库：%s" % err)
            t.reported = err
        self.children(now)

    def children(self, now):
        lv = self.lv
        more = True
        while more:  # a newly followed chat may name sub-agent chats of its own
            more = False
            for cid, owner in list(self.owner.items()):
                if cid not in lv.agents and cid != self.root_id and self.add_child(cid, owner, now):
                    more = True

    def add_child(self, cid, owner, now):
        lv = self.lv
        path = cursor_scan.vpath(self.db, cid)
        mono = time.monotonic()
        known = lv.known.get(path)
        if known and (known[0] == "old" or mono - known[1] < STALE_RECHECK_S):
            return False
        last = cursor_tail.last_activity(self.db, cid)
        if last is None:
            lv.known[path] = ("missing", mono)
            return False
        if now - last > WINDOW_MS:
            lv.known[path] = ("old" if cid in self.returned else "stale", mono)
            lv.stale_unreturned = sum(1 for v in lv.known.values() if v[0] == "stale")
            return False
        lv.known.pop(path, None)
        lv.stale_unreturned = sum(1 for v in lv.known.values() if v[0] == "stale")
        st = AgentState(cid, "子代理")
        parent = lv.agents.get(owner)
        st.depth = (parent.depth if parent else 0) + 1
        st.parent_tid = lv.id if owner == "main" else owner
        st.cwd = parent.cwd if parent else ""
        st.tu = cid
        lv.agents[cid] = st
        self.follow(cid, path, st, now)
        self.refresh_desc(cid)
        d = self.dispatch.get(cid)
        if d:
            lines = [l[:160] for l in d["prompt"].strip().split("\n") if l.strip()][:2]
            lv.briefs[cid] = {"lines": lines, "why": ""}
        if cid in self.returned:
            self.on_return(cid, self.returned[cid])
        return True

    # ------------------------------------------------------------ what the feeds report

    def note_sub(self, cid, owner):
        self.owner.setdefault(cid, owner)

    def note_dispatch(self, cid, owner, info):
        self.owner[cid] = owner
        self.dispatch.setdefault(cid, dict(info, owner=owner))
        st = self.lv.agents.get(cid)
        if st is not None:
            self.refresh_desc(cid)
            lines = [l[:160] for l in info["prompt"].strip().split("\n") if l.strip()][:2]
            self.lv.briefs.setdefault(cid, {"lines": lines, "why": ""})

    def refresh_desc(self, aid):
        """Sub-agent label as in the replay page: '<type> · <description>' from the task call, else the chat's own name."""
        st = self.lv.agents.get(aid)
        if st is None or aid == "main":
            return
        d = self.dispatch.get(aid, {})
        name = self.feeds[aid].name if aid in self.feeds else ""
        kind, what = d.get("type") or name, d.get("description") or name
        st.desc = "%s · %s" % (kind, what) if kind and what and kind != what else (kind or what or "子代理")

    def on_return(self, cid, ts):
        """The task call that started a sub-agent chat completed: the sub-agent has handed back."""
        self.returned[cid] = ts
        st = self.lv.agents.get(cid)
        if st is None or st.done:
            return
        st.done, st.done_ts = True, ts
        st.pending.clear()
        st.last_kind = "end"
        self.lv.add_event(ts, "handback", st.id, "子代理交回：%s" % (st.desc or st.id))
