"""Writers for synthetic Claude Code transcripts, used only to build the demo sessions.

The row layout mirrors what parse.py and live_claude.py read: one JSONL row per content block with a shared
message.id, usage on every row of a message, tool_use / tool_result pairs, subagents/agent-<id>.jsonl plus
agent-<id>.meta.json, compact_boundary system rows and task-notification attachments. Everything written here is invented.
"""
import json
import os
import random
from datetime import datetime, timezone

MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}


def iso(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)


# ------------------------------------------------------------------ call constructors

def Bash(cmd, out="", dur=1.0, err=False, desc="", bg=False):
    inp = {"command": cmd}
    if desc:
        inp["description"] = desc
    if bg:
        inp["run_in_background"] = True
    return {"name": "Bash", "inp": inp, "res": ("Exit code %d\n%s" % (err if isinstance(err, int) and err is not True else 1, out)) if err else out,
            "dur": dur, "err": bool(err)}


def Read(path, text, dur=0.3):
    return {"name": "Read", "inp": {"file_path": path}, "res": text, "dur": dur}


def Grep(pattern, path, out, dur=0.5):
    return {"name": "Grep", "inp": {"pattern": pattern, "path": path, "output_mode": "content", "-n": True}, "res": out, "dur": dur}


def Glob(pattern, out, dur=0.3):
    return {"name": "Glob", "inp": {"pattern": pattern}, "res": out, "dur": dur}


def Edit(path, old, new, dur=0.4):
    return {"name": "Edit", "inp": {"file_path": path, "old_string": old, "new_string": new}, "dur": dur,
            "res": "The file %s has been updated successfully." % path}


def Write(path, content, dur=0.4):
    return {"name": "Write", "inp": {"file_path": path, "content": content}, "dur": dur, "res": "File created successfully at: %s" % path}


def Hook(cmd, hook_script, message, dur=0.2):
    """A Bash call stopped by a PreToolUse hook (Claude Code reports it as an error result)."""
    return {"name": "Bash", "inp": {"command": cmd}, "dur": dur, "err": True,
            "res": "PreToolUse:Bash hook error: [%s]: %s" % (hook_script, message)}


def Dispatch(desc, model, effort, brief, script, bg=False, handback=False, agent_type="general-purpose", worktree="", live=False):
    """Agent tool call; `script(tx)` writes the sub-agent's own transcript."""
    inp = {"description": desc, "prompt": brief, "subagent_type": agent_type, "model": model, "effort": effort}
    if bg:
        inp["run_in_background"] = True
    return {"name": "Agent", "inp": inp, "dur": 0, "res": "", "sub": {"script": script, "desc": desc, "model": model, "effort": effort, "brief": brief,
                                                                      "bg": bg, "handback": handback, "type": agent_type, "worktree": worktree, "live": live}}


# ------------------------------------------------------------------ transcripts

class Tx:
    def __init__(self, ses, aid, model, effort, t0, depth=0, ctx0=30000, cwd=None):
        self.ses, self.aid, self.model, self.effort = ses, aid, MODELS.get(model, model), effort
        self.t, self.depth, self.ctx, self.cwd = t0, depth, ctx0, cwd or ses.cwd
        self.rows, self.seq, self.written, self.report = [], 0, 0, ""
        self.parent_uuid = None
        self.path = ""

    def emit(self, ts, typ, **kw):
        row = {"type": typ, "uuid": self.ses.uid(), "parentUuid": self.parent_uuid, "isSidechain": self.aid != "main", "sessionId": self.ses.sid,
               "timestamp": iso(ts), "cwd": self.cwd, "version": "2.3.1"}
        if self.aid != "main":
            row["agentId"] = self.aid
        row.update(kw)
        self.parent_uuid = row["uuid"]
        self.seq += 1
        self.rows.append((ts, self.seq, row))

    def user(self, text, gap=3.0):
        self.t += int(gap * 1000)
        self.emit(self.t, "user", message={"role": "user", "content": text})

    def _usage(self, text, calls):
        rng = self.ses.rng
        grow = rng.randint(4000, 11000) if self.aid == "main" else rng.randint(1500, 6000)
        self.ctx += grow
        out = 40 + (len(text) + sum(len(json.dumps(c["inp"])) for c in calls)) // 3 + rng.randint(0, 60)
        return {"input_tokens": rng.randint(2, 9), "cache_creation_input_tokens": grow, "cache_read_input_tokens": self.ctx - grow,
                "output_tokens": out, "service_tier": "standard"}

    def step(self, said="", calls=(), think=2.0, stop=None):
        """One model response (possibly several tool calls). Advances the clock past the slowest call."""
        ses = self.ses
        think *= ses.pace
        self.t += int(think * 1000)
        ts = self.t
        mid = "msg_01" + ses.hex(22)
        usage = self._usage(said, calls)
        blocks = ([{"type": "text", "text": said}] if said else [])
        for c in calls:
            c.setdefault("id", ses.tid())
            blocks.append({"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["inp"]})
        for i, b in enumerate(blocks):
            last = i == len(blocks) - 1
            extra = {"thinkingDurationMs": int(think * 700)} if i == 0 and think > 1 else {}
            if self.aid == "main" and self.effort:
                extra["effort"] = self.effort
            self.emit(ts + i, "assistant", message={"id": mid, "type": "message", "role": "assistant", "model": self.model, "content": [b],
                                                    "stop_reason": (stop or ("tool_use" if calls else "end_turn")) if last else None, "usage": usage}, **extra)
        end = ts + len(blocks)
        for c in calls:
            if c.get("pending"):  # started but never finished: no result row
                continue
            res, dur = c["res"], c["dur"]
            if c.get("sub"):
                res, dur = ses.run_sub(self, c, ts + len(blocks) + 800)
            done = ts + len(blocks) + int(dur * 1000) + 5
            block = {"type": "tool_result", "tool_use_id": c["id"], "content": res}
            if c.get("err"):
                block["is_error"] = True
            self.emit(done, "user", message={"role": "user", "content": [block]})
            end = max(end, done)
        self.t = end + 300

    def finish(self, report, handback=False):
        """Sub-agent ending: return the report as the last text, or through SubagentHandback."""
        self.report = report
        if handback:
            self.step("The work is complete; sending the final report back.", [{"name": "SubagentHandback", "inp": {"message": report}, "res": "Report delivered.", "dur": 0.2}])
        else:
            self.step(report, stop="end_turn")

    def compact(self, summary):
        self.t += 2500
        self.emit(self.t, "system", subtype="compact_boundary", content="Conversation compacted", level="info",
                  compactMetadata={"trigger": "auto", "preTokens": self.ctx})
        self.emit(self.t + 400, "user", message={"role": "user", "content": summary}, isCompactSummary=True, isVisibleInTranscriptOnly=True)
        self.t += 900
        self.ctx = 13000

    def lines(self, start=0):
        rows = sorted(self.rows[start:], key=lambda r: (r[0], r[1]))
        return [json.dumps(r[2], ensure_ascii=False, separators=(",", ":")) for r in rows]

    def write(self, mode="w"):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, mode, encoding="utf-8") as f:
            f.writelines(l + "\n" for l in self.lines(self.written))
        self.written = len(self.rows)

    def end_ms(self):
        return max(r[0] for r in self.rows) if self.rows else self.t


class Session:
    """One Claude Code session on disk: main transcript plus subagents/."""

    def __init__(self, claude_dir, cwd, sid, seed, t0, model, effort, title=""):
        self.cwd, self.sid, self.rng, self.title = cwd, sid, random.Random(seed), title
        self.now, self.pace = 0, 6.0  # pace stretches the think times so a scripted session spans a realistic wall-clock time
        self.proj = os.path.join(claude_dir, "projects", cwd.replace("/", "-"))
        self.sdir = os.path.join(self.proj, sid)
        self.main = Tx(self, "main", model, effort, t0)
        self.main.path = os.path.join(self.proj, sid + ".jsonl")
        self.subs = []  # (Tx, meta)

    def hex(self, n):
        return "".join(self.rng.choice("0123456789abcdef") for _ in range(n))

    def uid(self):
        h = self.hex(32)
        return "%s-%s-%s-%s-%s" % (h[:8], h[8:12], h[12:16], h[16:20], h[20:])

    def tid(self):
        return "toolu_01" + self.hex(22)

    def new_sub(self, parent, spec, tool_id, start):
        aid = "a" + self.hex(16)
        child = Tx(self, aid, spec["model"], spec["effort"], start, depth=parent.depth + 1, ctx0=12000, cwd=spec["worktree"] or parent.cwd)
        child.path = os.path.join(self.sdir, "subagents", "agent-%s.jsonl" % aid)
        meta = {"agentType": spec["type"], "description": spec["desc"], "toolUseId": tool_id, "model": child.model, "effort": spec["effort"],
                "spawnDepth": child.depth}
        if spec["worktree"]:
            meta["worktreePath"] = spec["worktree"]
        if spec["bg"]:
            meta["requestShape"] = "background"
        self.subs.append((child, meta))
        return child

    def run_sub(self, parent, call, start):
        """Build the sub-agent's whole transcript; -> (tool_result text, duration seconds) for the dispatching call."""
        spec = call["sub"]
        child = self.new_sub(parent, spec, call["id"], start)
        child.emit(start, "user", message={"role": "user", "content": spec["brief"]})
        spec["script"](child)
        end = child.end_ms()
        if spec["live"]:  # still running: no completion notice
            return "Async agent launched successfully.\nagentId: %s (internal ID - do not mention to user)" % child.aid, 1.5
        if spec["bg"]:
            note = ("<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>%s</tool-use-id>\n<status>completed</status>\n"
                    "<summary>Agent \"%s\" completed</summary>\n<duration_ms>%d</duration_ms>\n</task-notification>" % (child.aid, call["id"], spec["desc"], end - start))
            parent.emit(end + 600, "attachment", attachment={"type": "queued_command", "prompt": note, "commandMode": "task-notification"})
            return "Async agent launched successfully.\nagentId: %s (internal ID - do not mention to user)" % child.aid, 1.5
        if spec["handback"]:
            body = "\n".join("  " + l for l in child.report.split("\n"))
            parent.emit(end + 500, "user", message={"role": "user", "content": (
                "Another Claude session sent a message:\n<agent-message from=\"%s\" kind=\"report\">[Subagent hand-back] The sub-agent \"%s\" has "
                "finished. The report follows:\n%s</agent-message>" % (child.aid, spec["desc"], body))})
            return "The sub-agent finished and handed its report back.", (end - start) / 1000 + 1.2
        return child.report, (end - start) / 1000 + 1.2

    def flush(self):
        """Write rows not yet on disk (first call writes whole files, later calls append)."""
        os.makedirs(os.path.join(self.sdir, "subagents"), exist_ok=True)
        for c in [self.main] + [c for c, _ in self.subs]:
            if len(c.rows) > c.written:
                c.write("a" if c.written else "w")
        for c, meta in self.subs:
            mp = c.path[:-6] + ".meta.json"
            if not os.path.exists(mp):
                with open(mp, "w", encoding="utf-8") as f:
                    json.dump(meta, f)

    def save(self, backdate=True):
        """Write everything; with backdate the files get the time of their last row so the session reads as finished."""
        self.flush()
        if self.title:
            with open(os.path.join(self.sdir, "custom-title.json"), "w", encoding="utf-8") as f:
                json.dump({"customTitle": self.title}, f)
        if backdate:
            for c in [self.main] + [c for c, _ in self.subs]:
                os.utime(c.path, (c.end_ms() / 1000, c.end_ms() / 1000))
