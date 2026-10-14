"""Incremental live state for in-progress sessions (read-only).

Every followed file (main transcript, each sub-agent file / Codex child rollout) keeps a byte offset; a refresh reads only
the appended bytes and folds them into an in-memory AgentState. The first build for a session reads a window from the end
of each file (back to ~61 minutes, capped) instead of the whole file; earlier steps are only counted. State lives in the
server process per session and is released after `releaseSec` without requests.
"""
import json
import os
import re
import threading
import time
from collections import defaultdict, deque

import sources
from common import ts_ms
from prices import tok_total, zero_tok

HERE = os.path.dirname(os.path.abspath(__file__))
WINDOW_MS = 61 * 60 * 1000
BUCKET_MS = 60_000
_TS = re.compile(rb'"timestamp":"([^"]+)"')
_CFG = {"mtime": None, "data": {}}
DEFAULTS = {"ctxLimit": 400000, "idleSec": 300, "endedSec": 600, "longCmdSec": 600, "subStepLimit": 150,
            "hookRecentSec": 600, "failStreak": 3, "staleSubSec": 3600, "releaseSec": 1800, "pollSec": 5, "slowPollSec": 60,
            "returnedKeepSec": 600, "graphMaxNodes": 40, "graphFadeSec": 60}


def _defaults():
    """DEFAULTS plus each source's context-limit key (Source.ctx_limit_key / ctx_limit_default)."""
    out = dict(DEFAULTS)
    for s in sources.all():
        out.setdefault(s.ctx_limit_key, s.ctx_limit_default)
    return out


def config():
    """live.json next to prices.json; re-read when its mtime (or the set of registered sources) changes."""
    p = os.path.join(HERE, "live.json")
    defaults = _defaults()
    try:
        mt = (os.stat(p).st_mtime_ns, tuple(defaults))
        if mt != _CFG["mtime"]:
            with open(p, encoding="utf-8") as f:
                _CFG["data"] = dict(defaults, **{k: v for k, v in json.load(f).items() if k in defaults})
            _CFG["mtime"] = mt
    except (OSError, ValueError):
        if _CFG["mtime"] is None:
            _CFG["data"] = defaults
    return _CFG["data"]


class Tail:
    """Reads a growing JSONL file in complete lines; remembers the offset and any unfinished last line."""

    def __init__(self, path):
        self.path, self.pos, self.carry, self.start = path, 0, b"", 0

    def first(self, cutoff_ms, min_bytes=1_500_000, max_bytes=6_000_000):
        """Window from the end of the file back to the first row older than cutoff (bounded). -> list of lines."""
        size = os.stat(self.path).st_size
        n = min_bytes
        with open(self.path, "rb") as f:
            while True:
                start = max(0, size - n)
                f.seek(start)
                data = f.read(size - start)
                if start > 0:
                    data = data[data.find(b"\n") + 1:]
                m = _TS.search(data[:200000])
                if start == 0 or n >= max_bytes or (m and ts_ms(m.group(1).decode()) < cutoff_ms):
                    break
                n = min(n * 2, max_bytes)
        self.start = size - len(data)
        self.pos = size
        lines = data.split(b"\n")
        self.carry = lines.pop()
        return lines

    def read_new(self):
        try:
            size = os.stat(self.path).st_size
        except OSError:
            return []
        if size < self.pos:  # truncated or replaced: start over from the end
            self.pos, self.carry = size, b""
            return []
        if size == self.pos:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            data = self.carry + f.read(size - self.pos)
        self.pos = size
        lines = data.split(b"\n")
        self.carry = lines.pop()
        return lines


class AgentState:
    def __init__(self, aid, desc=""):
        self.id, self.desc = aid, desc
        self.model = self.effort = self.cwd = ""
        self.parent, self.depth = None, 0
        self.start, self.last_ts, self.last_kind = None, 0, ""
        self.steps, self.ids, self.prefix_steps = 0, set(), 0
        self.ctx, self.window = 0, 0
        self.pending = {}           # call id -> call dict
        self.recent = deque(maxlen=5)   # newest last; the node tooltip shows 5, cards show 3
        self.tok = zero_tok()       # token vector (see prices.py) seen in the read window
        self.step_ts = deque(maxlen=400)
        self.cur = None             # step record being filled
        self.said = ""
        self.fail_streak = 0
        self.hook_ts = deque(maxlen=20)
        self.poll_ts = 0
        self.done, self.done_ts, self.done_key = False, 0, None
        self.buckets = defaultdict(lambda: [0.0, 0])   # minute -> [amount in USD, tokens]
        self.msg = {}               # message id -> [ts, amount, token vector] already accounted
        self.cur_mid = None
        self.approx = False
        self.merge_ts = 0
        self.tu = None
        self.parent_tid = None

    def add_cost(self, ts, q, tk):
        b = self.buckets[ts // BUCKET_MS]
        b[0] += q
        b[1] += tk

    def new_step(self, ts):
        self.cur = {"n": self.steps, "ts": ts, "tool": "", "sum": "", "why": "", "st": "ok", "dur": 0, "calls": []}
        self.recent.append(self.cur)
        return self.cur

    def prune(self, now):
        cut = (now - WINDOW_MS - 2 * BUCKET_MS) // BUCKET_MS
        for k in [k for k in self.buckets if k < cut]:
            del self.buckets[k]


class Live:
    """Live state of one session: its agents, a merged event stream and the file followers."""

    def __init__(self, row, recs):
        self.row, self.tool, self.id, self.path = row, row["tool"], row["id"], row["path"]
        self.lock = threading.RLock()
        self.agents = {}            # id -> AgentState
        self.tails = {}             # path -> (Tail, AgentState, feed)
        self.events = deque(maxlen=120)
        self._seen = set()
        self.last_use = time.time()
        self.last_refresh = 0.0
        self.tu_owner = {}          # tool_use id of a dispatch -> dispatching agent id
        self.recs = recs
        self.stale_unreturned = 0
        self.known = {}             # path -> peek result for files we decided not to follow
        self.briefs = {}            # dispatch tool_use id -> first brief lines and the model-choice reason
        self.last_user = None       # newest user message {ts, text}
        self.first_built = False
        self.models = set()
        self.unpriced = set()       # models seen without a price: their tokens count, their amount does not
        self.build_ms = 0
        self.source = sources.get(self.tool)
        self.impl = self.source.live(self)

    # ------------------------------------------------------------ shared helpers used by the feeds

    def add_event(self, ts, k, aid, text, **extra):
        key = (k, aid, ts, text[:40])
        if key in self._seen:
            return
        self._seen.add(key)
        if len(self._seen) > 600:
            self._seen = {(e["k"], e["agent"], e["ts"], e["text"][:40]) for e in self.events}
        e = {"ts": ts, "k": k, "agent": aid, "text": text[:400]}
        e.update(extra)
        if k == "user" and (self.last_user is None or ts >= self.last_user["ts"]):
            self.last_user = {"ts": ts, "text": text[:120]}
        self.events.append(e)

    def follow(self, path, state, feed, now, window=True):
        t = Tail(path)
        self.tails[path] = (t, state, feed)
        lines = t.first(now - WINDOW_MS) if window else []
        for ln in lines:
            if ln:
                feed.feed(ln)
        return t

    # ------------------------------------------------------------ refresh + snapshot

    def refresh(self, now):
        with self.lock:
            t0 = time.time()
            if not self.first_built:
                self.impl.build(now)
                self.first_built = True
                self.build_ms = int((time.time() - t0) * 1000)
            else:
                self.impl.discover(now)
                for t, st, feed in list(self.tails.values()):
                    for ln in t.read_new():
                        if ln:
                            feed.feed(ln)
            self.last_refresh = time.time()

    def sub_states(self):
        return [a for a in self.agents.values() if a.id != "main"]

    def last_write(self):
        return max([a.last_ts for a in self.agents.values()] + [0])

    def running_subs(self, now, cfg):
        stale = cfg["staleSubSec"] * 1000
        return [a for a in self.sub_states() if not a.done and now - a.last_ts <= stale and a.last_ts]

    def agent_state(self, a, now, cfg, n_children):
        """('exec'|'think'|'waiting'|'idle', detail dict) from the last records.

        exec: a call has no result yet (even after minutes). waiting: only sub-agent waits are pending, or the agent
        ended its turn / went quiet while sub-agents are still running. idle: nothing written for idleSec, or the turn
        ended with nothing running. think: otherwise (last record is a tool result, a user message or partial output).
        """
        if a.pending:
            calls = list(a.pending.values())
            real = [x for x in calls if not x["waitAgent"]]
            if not real:
                c = calls[0]
                return "waiting", {"tool": c["name"], "sum": c["sum"], "desc": c["desc"], "elapsed": now - c["ts"]}
            c = min(real, key=lambda x: x["ts"])
            return "exec", {"tool": c["name"], "sum": c["sum"], "desc": c["desc"], "elapsed": now - c["ts"], "n": len(calls)}
        quiet = now - a.last_ts > cfg["idleSec"] * 1000
        if n_children and (a.last_kind == "end" or quiet):
            return "waiting", {"why": "没有在执行的调用，等 %d 个子代理" % n_children}
        if quiet:
            return "idle", {"why": "超过 %d 分钟没有写入" % (cfg["idleSec"] // 60)}
        if a.last_kind == "end":
            return "idle", {"why": "本轮已结束，等待用户"}
        return "think", {"since": now - a.last_ts}

    def alerts(self, a, now, cfg, state):
        out = []
        for c in a.pending.values():
            if c["waitAgent"]:
                continue
            el = now - c["ts"]
            if el > cfg["longCmdSec"] * 1000 and not c["bg"]:
                out.append({"k": "longcmd", "text": "命令已执行 %d 分钟：%s" % (el // 60000, c["sum"][:80])})
            if c["poll"] and not c["bg"]:
                out.append({"k": "poll", "text": "前台轮询（sleep/until/while）：%s" % c["sum"][:80]})
        if not any(x["k"] == "poll" for x in out) and a.poll_ts and now - a.poll_ts < 5 * 60 * 1000:
            out.append({"k": "poll", "text": "刚做过前台轮询（%d 秒前）" % ((now - a.poll_ts) // 1000)})
        if a.id != "main" and a.steps > cfg["subStepLimit"]:
            out.append({"k": "steps", "text": "子代理已 %d 步，超过 %d 步" % (a.steps, cfg["subStepLimit"])})
        limit = cfg[self.source.ctx_limit_key]
        if a.ctx > limit:
            out.append({"k": "ctx", "text": "上下文 %d token，超过压缩点 %d" % (a.ctx, limit)})
        recent_hooks = [t for t in a.hook_ts if now - t < cfg["hookRecentSec"] * 1000]
        if recent_hooks:
            out.append({"k": "hook", "text": "最近 %d 分钟被钩子拦截 %d 次" % (cfg["hookRecentSec"] // 60, len(recent_hooks))})
        if a.fail_streak >= cfg["failStreak"]:
            out.append({"k": "fail", "text": "连续 %d 次调用失败" % a.fail_streak})
        return out

    def parent_of(self, a):
        if a.id == "main":
            return None
        if a.parent_tid:
            return "main" if a.parent_tid == self.id else a.parent_tid
        return self.tu_owner.get(a.tu) or "main"

    def sub_status(self, now, cfg, kids):
        """id -> status of every followed sub-agent (the sub-agent list matches rows by id)."""
        out = {}
        for s in self.sub_states():
            state, det = self.agent_state(s, now, cfg, kids.get(s.id, 0))
            if s.done:
                state, det = "done", {}
            out[s.id] = {"state": state, "start": s.start, "runMs": max(0, now - s.start) if s.start else None, "lastTs": s.last_ts,
                         "doneTs": s.done_ts if s.done else 0, "tool": det.get("tool", ""), "desc": det.get("desc", ""), "sum": det.get("sum", ""),
                         "elapsed": det.get("elapsed"), "why": det.get("why", "")}
        return out

    def live_kids(self, now, cfg):
        """parent id -> number of its sub-agents that are not returned and wrote recently."""
        kids = {}
        for s in self.sub_states():
            if not s.done and s.last_ts and now - s.last_ts <= cfg["idleSec"] * 1000:
                p = self.parent_of(s)
                kids[p] = kids.get(p, 0) + 1
        return kids

    def card(self, a, now, cfg, n_children):
        state, det = self.agent_state(a, now, cfg, n_children)
        if a.done:
            state, det = "done", {}
        win15 = (now - 15 * 60000) // BUCKET_MS
        c15 = sum(v[0] for k, v in a.buckets.items() if k > win15)
        t15 = sum(v[1] for k, v in a.buckets.items() if k > win15)
        limit = cfg[self.source.ctx_limit_key]
        steps = a.steps + a.prefix_steps
        span = min(300_000, max(60_000, now - (a.start or now)))
        spm = round(sum(1 for t in a.step_ts if now - t <= span) * 60_000 / span, 1)
        return {"id": a.id, "desc": a.desc or a.id, "model": a.model, "effort": a.effort, "parent": self.parent_of(a), "depth": a.depth,
                "start": a.start, "runMs": max(0, now - a.start) if a.start else None, "steps": steps, "stepsApprox": a.approx,
                "ctx": a.ctx, "ctxLimit": limit, "state": state, "detail": det, "lastTs": a.last_ts, "done": a.done, "doneTs": a.done_ts if a.done else 0,
                "tok": dict(a.tok), "tokTotal": tok_total(a.tok), "costWin": sum(v[0] for v in a.buckets.values()), "spm": spm, "brief": self.briefs.get(a.tu) if a.tu else None,
                "recent": [{k: r[k] for k in ("n", "ts", "tool", "sum", "why", "st", "dur")} for r in a.recent][::-1],
                "alerts": self.alerts(a, now, cfg, state), "cost15": c15, "tok15": t15}

    def snapshot(self, now):
        cfg = config()
        with self.lock:
            self.last_use = time.time()
            subs = self.running_subs(now, cfg)
            main = self.agents.get("main")
            kids = self.live_kids(now, cfg)
            cards = []
            if main is not None:
                cards.append(self.card(main, now, cfg, len([s for s in subs if s.last_ts and now - s.last_ts <= cfg["idleSec"] * 1000])))
            for s in sorted(subs, key=lambda x: -(x.start or 0)):
                cards.append(self.card(s, now, cfg, kids.get(s.id, 0)))
            tot15 = tot60 = 0.0
            tk15 = tk60 = 0
            series, tseries = [0.0] * 12, [0] * 12
            for a in self.agents.values():
                a.prune(now)
                for k, v in a.buckets.items():
                    age = now - (k + 1) * BUCKET_MS
                    if age < 15 * 60000:
                        tot15 += v[0]
                        tk15 += v[1]
                    if age < 60 * 60000:
                        tot60 += v[0]
                        tk60 += v[1]
                        i = min(11, max(0, int(age // 300000)))
                        series[i] += v[0]
                        tseries[i] += v[1]
            keep = cfg["returnedKeepSec"] * 1000
            returned = [self.card(s, now, cfg, kids.get(s.id, 0)) for s in sorted(self.sub_states(), key=lambda x: x.start or 0)
                        if s.done and s.done_ts and now - s.done_ts <= keep]
            last = self.last_write()
            evs = sorted(self.events, key=lambda e: -e["ts"])[:30]
            names = {i: (a.desc or i) for i, a in self.agents.items()}
            for e in evs:
                e["agentName"] = names.get(e["agent"], e["agent"])
            return {"ok": True, "tool": self.tool, "id": self.id, "now": now,
                    "lastWrite": last, "sinceWrite": (now - last) if last else None, "ended": bool(last) and now - last > cfg["endedSec"] * 1000,
                    "cards": cards, "returned": returned, "events": evs, "lastUser": self.last_user, "tok15": tk15, "staleSubs": self.stale_unreturned,
                    "subs": self.sub_status(now, cfg, kids), "unpriced": sorted(self.unpriced),
                    "rate": {"c15": tot15, "c60": tot60, "perHour15": tot15 * 4, "perHour60": tot60, "t15": tk15, "t60": tk60,
                             "tPerHour15": tk15 * 4, "tPerHour60": tk60, "series": series[::-1], "tseries": tseries[::-1]},
                    "cfg": {"pollSec": cfg["pollSec"], "slowPollSec": cfg["slowPollSec"], "ctxLimit": cfg["ctxLimit"],
                            "graphMaxNodes": cfg["graphMaxNodes"], "graphFadeSec": cfg["graphFadeSec"], "returnedKeepSec": cfg["returnedKeepSec"]},
                    "build": {"ms": self.build_ms, "followed": len(self.tails)}}

    def row_info(self, now):
        cfg = config()
        with self.lock:
            main = self.agents.get("main")
            subs = self.running_subs(now, cfg)
            live_subs = [s for s in subs if now - s.last_ts <= cfg["idleSec"] * 1000]
            if main is None:
                return {"state": "idle", "running": 0}
            state, _ = self.agent_state(main, now, cfg, len(live_subs))
            return {"state": state, "running": len(live_subs)}


class Store:
    """Sessions with live state, released after releaseSec without requests."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        t = threading.Thread(target=self._sweeper, daemon=True)
        t.start()

    def sweep(self):
        now = time.time()
        with self.lock:
            for k in [k for k, v in self.items.items() if now - v.last_use > config()["releaseSec"]]:
                del self.items[k]

    def _sweeper(self):
        while True:
            time.sleep(60)
            self.sweep()

    def get(self, row, recs):
        key = row["key"]
        now = time.time()
        self.sweep()
        with self.lock:
            lv = self.items.get(key)
            if lv is None:
                lv = self.items[key] = Live(row, recs)
            lv.recs = recs
            lv.row = row
            lv.last_use = now
            return lv


STORE = Store()


def snapshot(row, recs, now=None):
    now = now or int(time.time() * 1000)
    lv = STORE.get(row, recs)
    t0 = time.time()
    lv.refresh(now)
    out = lv.snapshot(now)
    out["took"] = int((time.time() - t0) * 1000)
    return out


def row_info(row, recs, now=None):
    now = now or int(time.time() * 1000)
    lv = STORE.get(row, recs)
    lv.refresh(now)
    return lv.row_info(now)
