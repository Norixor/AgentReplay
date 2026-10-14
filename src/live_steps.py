"""Step feed for the detail pages of in-progress sessions: /api/steps/<tool>/<id>?agent=<id>&after=<n>.

The page embeds the full parse result of the moment it was generated. While the session keeps running, the page asks
this feed for the steps added since. The feed keeps one parse result per followed session in memory and refreshes it in a
background thread when a session file has grown, never inside the request, so a request that needs no re-parse answers
in a few milliseconds.

Re-parse cost control: each entry keeps a cache dict that the source's parse() may use for incremental reads (Claude keeps
the parsed rows of every file and reads only the appended bytes, but still rebuilds the step model; Codex has no
incremental reader and parses whole rollouts). Hence a minimum gap between two parses of one session (Source.reparse_gap:
5 s Claude, 30 s Codex) and release of idle sessions after `releaseSec`.
Strings are redacted per response (the page redacts its embedded data the same way, with redact.walk).
"""
import threading
import time

import live
import sources
from redact import walk

OUT_CHARS, INP_CHARS = 600, 4000   # the caps render.build_html parses with
WARM_WAIT = 1.5                    # seconds a first request waits for the initial parse before answering "warming"
HEAVY = ("turns", "briefing")      # fields left out of the per-agent statistics


class Entry:
    """Parse result of one session plus the bookkeeping to refresh it."""

    def __init__(self):
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.data = None
        self.sig = None            # ((path, size), ...) the data was parsed from
        self.parsed_at = 0.0
        self.viewed = time.time()
        self.parsing = False
        self.error = ""
        self.rev = 0
        self.rows = {}             # per-session parse cache handed to Source.parse (Claude: parse.read_rows_inc)
        self.flat = {}             # agent id -> [(turn index, step)], rebuilt per parse


class StepFeed:
    def __init__(self, files_fn, tree_fn):
        """files_fn(row) -> files that make up the session; tree_fn(row) -> {agent id: path} (Source.tree)."""
        self.files_fn, self.tree_fn = files_fn, tree_fn
        self.entries = {}
        self.lock = threading.Lock()

    # ---------------------------------------------------------------- parsing

    def _sweep(self, now):
        ttl = live.config().get("releaseSec", 1800)
        with self.lock:
            for k in [k for k, e in self.entries.items() if now - e.viewed > ttl and not e.parsing]:
                del self.entries[k]

    def _parse(self, e, row, sig, tree):
        try:
            data = sources.get(row["tool"]).parse(row["id"], tree, row["name"], OUT_CHARS, INP_CHARS, cache=e.rows)
            with e.lock:
                e.data, e.sig, e.flat, e.error = data, sig, {}, ""
                e.rev += 1
        except Exception as ex:  # reported in the answer; the previous data (if any) keeps being served
            e.error = "%s: %s" % (type(ex).__name__, ex)
        finally:
            e.parsed_at = time.time()
            e.parsing = False
            e.done.set()

    def _signature(self, row):
        out, newest = [], 0
        src = sources.get(row["tool"])
        for p in sorted(self.files_fn(row)):
            try:
                size, mtime = src.stat(p)
            except OSError:
                continue
            out.append((p, size))
            newest = max(newest, mtime)
        return tuple(out), newest

    def _maybe_parse(self, e, row, sig, now):
        """Start a background parse when the files changed and the minimum gap has passed."""
        if e.parsing or (e.data is not None and (sig == e.sig or now - e.parsed_at < sources.get(row["tool"]).reparse_gap)):
            return
        e.parsing = True
        e.done.clear()
        threading.Thread(target=self._parse, args=(e, row, sig, self.tree_fn(row)), daemon=True, name="steps-parse").start()

    # ---------------------------------------------------------------- answer

    @staticmethod
    def _flat(e, agent):
        f = e.flat.get(agent["id"])
        if f is None:
            f = e.flat[agent["id"]] = [(ti, s) for ti, t in enumerate(agent["turns"]) for s in t["steps"]]
        return f

    def answer(self, row, agent_id, after=0, nturns=0, pend=(), known=0, full=False):
        """JSON-ready dict: steps after `after`, refreshed steps (the last known one and those listed in `pend`), turn
        headers from the last known turn on, the agent's statistics, and agents the page does not know yet (index >= known).
        `full` also returns the whole agent record (no turns, briefing included) as `agentRec`: a page that asks for an
        agent it has never seen (a click on a sub-agent newer than the page) needs more than the statistics."""
        t0 = time.time()
        self._sweep(t0)
        key = "%s:%s" % (row["tool"], row["id"])
        with self.lock:
            e = self.entries.get(key)
            if e is None:
                e = self.entries[key] = Entry()
        e.viewed = t0
        sig, newest = self._signature(row)
        self._maybe_parse(e, row, sig, t0)
        if e.data is None:
            e.done.wait(WARM_WAIT)
        out = {"ok": True, "now": int(t0 * 1000), "sinceWrite": max(0, int((t0 - newest) * 1000)) if newest else 0}
        out["ended"] = out["sinceWrite"] > live.config().get("endedSec", 600) * 1000
        with e.lock:
            data = e.data
            if data is None:
                out.update(warming=not e.error, error=e.error, steps=[], ti=[], updated=[], turns=[], agents=[])
                return out
            agent = next((a for a in data["agents"] if a["id"] == agent_id), None)
            if agent is None:
                return {"ok": False, "error": "没有这个代理：%s" % agent_id, "now": out["now"]}
            flat = self._flat(e, agent)
            reset = after > len(flat)
            lo = 0 if reset else after
            redo = sorted({n for n in set(pend) | {after - 1} if 0 <= n < min(after, len(flat))}) if not reset else []
            out.update(
                rev=e.rev, agent=agent_id, total=len(flat), reset=reset, parsedAt=int(e.parsed_at * 1000), error=e.error,
                steps=[s for _, s in flat[lo:]], ti=[ti for ti, _ in flat[lo:]],
                updated=[flat[n][1] for n in redo], updatedTi=[flat[n][0] for n in redo],
                turns=[{"ti": i, "trig": t["trig"], "evs": t["evs"]} for i, t in enumerate(agent["turns"]) if i >= max(0, nturns - 1)],
                stats={k: v for k, v in agent.items() if k not in HEAVY},
                state="done" if agent.get("doneTs") else "running",
                agents=[{k: v for k, v in a.items() if k != "turns"} for a in data["agents"][known:] if a["id"] != agent_id],
                totals=data["totals"], end=data["meta"]["end"])
            if full:
                out["agentRec"] = {k: v for k, v in agent.items() if k != "turns"}
        out = walk(out)
        out["took"] = round((time.time() - t0) * 1000)
        return out
