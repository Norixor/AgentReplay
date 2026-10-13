"""Demo session 2: a finished Codex session (root thread + 3 sub-agent threads) on the same invented shop project.

Rows follow the Codex rollout layout read by codex_scan.py: session_meta, turn_context, event_msg (task_started,
token_count, item_completed ...) and response_item (reasoning, message, function_call, agent_message ...).
Briefings are written as encrypted blobs, exactly as the real files keep them, so the page shows the same limitation.
"""
import json
import os
import random
from datetime import datetime, timezone

from demo_tx import iso

REPO = "/home/demo/acme-shop"
ROOT_ID = "019f3a52-6c1d-7e48-9b05-2d7c8a41e903"


class Rollout:
    def __init__(self, ses, tid, agent_path, parent, nick, role, model, effort, t0, depth=0):
        self.ses, self.tid, self.agent_path, self.parent = ses, tid, agent_path, parent
        self.nick, self.role, self.model, self.effort, self.t, self.depth = nick, role, model, effort, t0, depth
        self.rows, self.seq, self.total, self.ctx, self.report = [], 0, 0, 20000, ""
        self.turn = ""
        self.start = t0
        self.path = ""

    def _r(self, ts, typ, payload):
        self.seq += 1
        self.rows.append((ts, self.seq, typ, payload))

    def ev(self, ts, ptype, **kw):
        self._r(ts, "event_msg", dict(type=ptype, **kw))

    def resp(self, ts, ptype, **kw):
        self._r(ts, "response_item", dict(type=ptype, **kw))

    def meta(self):
        p = {"id": self.tid, "timestamp": iso(self.start), "cwd": REPO, "originator": "codex_cli_rs", "cli_version": "0.9.4", "model_provider": "openai"}
        if self.parent:
            p.update(parent_thread_id=self.parent, agent_path=self.agent_path, agent_nickname=self.nick, agent_role=self.role,
                     source={"subagent": {"thread_spawn": {"parent_thread_id": self.parent, "depth": self.depth}}})
        self._r(self.start, "session_meta", p)

    # --------------------------------------------------------- turns
    def start_turn(self, user=None, gap=2.0):
        self.t += int(gap * 1000)
        self.turn = "turn-" + self.ses.hex(8)
        self.ev(self.t, "task_started", turn_id=self.turn, model_context_window=272000)
        self._r(self.t + 5, "turn_context", {"turn_id": self.turn, "cwd": REPO, "model": self.model, "effort": self.effort})
        if user:
            self.ev(self.t + 10, "item_completed", item={"type": "UserMessage", "content": [{"type": "input_text", "text": user}]})

    def end_turn(self, final):
        self.t += 1500
        self.resp(self.t, "message", role="assistant", phase="final_answer", content=[{"type": "output_text", "text": final}])
        self.ev(self.t + 20, "task_complete", turn_id=self.turn, last_agent_message=final)
        self.report = final
        self.t += 100

    def message(self, to_path, mtype, text, enc=False, sender=None, ts=None):
        c = [{"type": "input_text", "text": "Message Type: %s\nTask name: %s\nSender: %s\nPayload:\n%s" % (mtype, self.ses_task(to_path), sender or "/root", "" if enc else text)}]
        if enc:
            c.append({"type": "encrypted_content", "encrypted_content": self.ses.blob()})
        self.resp(ts or self.t, "agent_message", author=sender or "/root", recipient=to_path, content=c)

    def ses_task(self, path):
        return path if path != "/root" else self.agent_path

    # --------------------------------------------------------- one model response
    def step(self, reason="", said="", calls=(), think=3.0):
        rng = self.ses.rng
        think *= self.ses.pace
        self.t += int(think * 1000)
        ts = self.t
        self.ev(ts, "item_completed", item={"type": "Reasoning"}, started_at_ms=ts, completed_at_ms=ts + int(think * 900))
        if reason:
            self.resp(ts + 1, "reasoning", summary=[{"type": "summary_text", "text": reason}])
        if said:
            self.resp(ts + 2, "message", role="assistant", phase="commentary", content=[{"type": "output_text", "text": said}])
        end = ts + 3
        for i, c in enumerate(calls):
            cid = "call_" + self.ses.hex(20)
            cs = ts + 4 + i * 2
            kind = c["kind"]
            if kind == "cmd":
                self.resp(cs, "function_call", name="exec_command", call_id=cid, arguments=json.dumps({"cmd": c["cmd"], "justification": c.get("why", "")}))
                done = cs + int(c["dur"] * 1000)
                self.ev(done - 2, "item_completed", item={"type": "CommandExecution", "command": c["cmd"], "exit_code": c.get("exit", 0),
                                                          "status": "completed" if not c.get("exit") else "failed",
                                                          "duration": {"secs": int(c["dur"]), "nanos": int((c["dur"] % 1) * 1e9)}},
                        started_at_ms=cs, completed_at_ms=done)
                self.resp(done, "function_call_output", call_id=cid, output="Exit code: %d\nWall time: %.1f seconds\nOutput:\n%s" % (c.get("exit", 0), c["dur"], c["out"]))
            elif kind == "patch":
                self.resp(cs, "custom_tool_call", name="apply_patch", call_id=cid, input=c["patch"])
                done = cs + 600
                self.ev(done - 2, "item_completed", item={"type": "FileChange", "changes": {f: {} for f in c["files"]}, "status": "completed"}, started_at_ms=cs, completed_at_ms=done)
                self.resp(done, "custom_tool_call_output", call_id=cid, output="Success. Updated the following files:\n" + "\n".join("M " + f for f in c["files"]))
            elif kind == "spawn":
                sp = c["spec"]
                args = {"task_name": sp["name"], "agent_type": sp["role"], "model": sp["model"], "reasoning_effort": sp["effort"], "message": self.ses.blob()}
                self.resp(cs, "function_call", name="spawn_agent", call_id=cid, arguments=json.dumps(args))
                child = self.ses.spawn(self, sp, cid, cs + 500)
                done = cs + 900
                self.ev(done - 2, "item_completed", item={"type": "SubAgentActivity", "kind": "started", "id": cid, "agent_thread_id": child.tid, "agent_path": child.agent_path})
                self.resp(done, "function_call_output", call_id=cid, output=json.dumps({"task_name": child.agent_path, "nickname": child.nick}))
            elif kind == "wait":
                child = c["child"]
                self.resp(cs, "function_call", name="wait_agent", call_id=cid, arguments=json.dumps({"targets": [child.agent_path], "timeout_ms": 600000}))
                done = max(cs + 500, child.end_ms() + 400)
                self.message(self.agent_path, "FINAL_ANSWER", child.report, sender=child.agent_path, ts=done - 200)
                self.resp(done, "function_call_output", call_id=cid, output=json.dumps({"status": {child.agent_path: {"completed": child.report[:200]}}}))
            end = max(end, done)
        rng_in = self.ctx + rng.randint(1500, 7000)
        out = rng.randint(120, 700)
        cached = int(rng_in * rng.uniform(0.82, 0.93))
        cw = int(rng_in * rng.uniform(0.01, 0.04))  # input_tokens includes both cached input and cache writes
        self.total += rng_in + out
        usage = {"input_tokens": rng_in, "cached_input_tokens": cached, "cache_write_input_tokens": cw, "output_tokens": out, "reasoning_output_tokens": int(out * 0.4), "total_tokens": rng_in + out}
        self.ctx = rng_in
        self.ev(end + 5, "token_count", info={"last_token_usage": usage, "total_token_usage": dict(usage, total_tokens=self.total), "model_context_window": 272000})
        self.t = end + 300

    def end_ms(self):
        return max(r[0] for r in self.rows)

    def lines(self):
        out = []
        for n, (ts, _, typ, payload) in enumerate(sorted(self.rows, key=lambda r: (r[0], r[1]))):
            out.append(json.dumps({"timestamp": iso(ts), "ordinal": n, "type": typ, "payload": payload}, ensure_ascii=False, separators=(",", ":")))
        return out


class CodexSession:
    def __init__(self, codex_dir, seed, t0):
        self.dir, self.rng, self.threads, self.pace = codex_dir, random.Random(seed), [], 5.0
        self.root = Rollout(self, ROOT_ID, "/root", None, "", "", "gpt-6-sol", "high", t0)
        self.threads.append(self.root)

    def hex(self, n):
        return "".join(self.rng.choice("0123456789abcdef") for _ in range(n))

    def blob(self):
        return "gAAAAAB" + "".join(self.rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") for _ in range(150))

    def spawn(self, parent, sp, call_id, start):
        h = self.hex(32)
        tid = "019f3a5%s-%s-%s-%s-%s" % (h[:1], h[1:5], h[5:9], h[9:13], h[13:25])
        child = Rollout(self, tid, "/root/" + sp["name"], parent.tid, sp["nick"], sp["role"], sp["model"], sp["effort"], start, parent.depth + 1)
        self.threads.append(child)
        child.meta()
        child.message(child.agent_path, "NEW_TASK", "", enc=True, ts=start + 50)
        child.start_turn(None, 0.1)
        sp["script"](child)
        return child

    def save(self, title):
        for r in self.threads:
            d = datetime.fromtimestamp(r.start / 1000, timezone.utc)
            folder = os.path.join(self.dir, "sessions", "%04d" % d.year, "%02d" % d.month, "%02d" % d.day)
            os.makedirs(folder, exist_ok=True)
            r.path = os.path.join(folder, "rollout-%s-%s.jsonl" % (d.strftime("%Y-%m-%dT%H-%M-%S"), r.tid))
            with open(r.path, "w", encoding="utf-8") as f:
                f.writelines(l + "\n" for l in r.lines())
            os.utime(r.path, (r.end_ms() / 1000, r.end_ms() / 1000))
        with open(os.path.join(self.dir, "session_index.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"id": ROOT_ID, "thread_name": title}) + "\n")


def C(cmd, out="", dur=1.0, exit=0, why=""):
    return {"kind": "cmd", "cmd": cmd, "out": out, "dur": dur, "exit": exit, "why": why}


def Spawn(name, nick, role, model, effort, script):
    return {"kind": "spawn", "spec": {"name": name, "nick": nick, "role": role, "model": model, "effort": effort, "script": script}}


def log_scan(t):
    t.step("Find how often the inventory sync test failed in recent CI runs.", "Scanning the archived CI logs for the failing test name.", [
        C("grep -rl 'inventory-sync.test' ci-logs | head -20", "ci-logs/run-4811.txt\nci-logs/run-4823.txt\nci-logs/run-4840.txt", 0.8)], 2.0)
    t.step("", "", [C("grep -h -B2 -A6 'FAIL.*inventory-sync' ci-logs/run-4823.txt", "FAIL src/inventory/inventory-sync.test.ts > reconciles stock after concurrent updates\nAssertionError: expected 7 to be 8\n  at src/inventory/inventory-sync.test.ts:58:22", 0.6)], 1.5)
    t.end_turn("Failures in 3 of the last 40 CI runs (4811, 4823, 4840), always the same test: 'reconciles stock after concurrent updates', always off by one (expected N+1, got N). No other test in the file fails, which points at a race rather than a data issue.")


def race(t):
    t.step("Reproduce locally by looping the test.", "Running the single test 50 times to see whether it fails here.", [
        C("npx vitest run src/inventory/inventory-sync.test.ts --repeat 50", " ✓ inventory-sync.test.ts (50)\n Tests  50 passed (50)", 71.0, why="Repeat the flaky test")], 2.5)
    t.step("It passes alone; the CI failures are under parallel load. Run with the whole directory in parallel.", "", [
        C("npx vitest run src/inventory --repeat 20 --pool=threads", " ❯ inventory-sync.test.ts (20) 2 failed\n   × reconciles stock after concurrent updates\n     AssertionError: expected 7 to be 8\n Tests  2 failed | 18 passed (20)", 49.0, exit=1, why="Reproduce under parallel load")], 3.0)
    t.step("The test and the sync worker both write the stock counter; reading the worker.", "", [C("sed -n 30,80p src/inventory/sync-worker.ts", "async function applyDelta(sku: string, delta: number) {\n  const row = await db.stock.get(sku);\n  await db.stock.put(sku, row.qty + delta);\n}", 0.3)], 2.0)
    t.end_turn("Reproduced: 2 of 20 repeats fail when the inventory suite runs in parallel threads. Cause: applyDelta in src/inventory/sync-worker.ts reads qty and writes qty + delta in two separate awaits, so two concurrent deltas for the same SKU lose one update (read-modify-write race). Fix: use an atomic increment (db.stock.increment) or serialise per SKU.")


def test_review(t):
    t.step("Review the proposed atomic increment change.", "", [C("git diff -- src/inventory", "-  const row = await db.stock.get(sku);\n-  await db.stock.put(sku, row.qty + delta);\n+  await db.stock.increment(sku, delta);", 0.4)], 2.0)
    t.step("", "Checking that increment exists on the stock collection type.", [C("grep -n 'increment' src/db/collections.ts", "41:  increment(key: string, by: number): Promise<void>;", 0.3)], 1.5)
    t.end_turn("The change is correct and minimal. db.stock.increment is atomic (single UPDATE ... SET qty = qty + $1). One suggestion: add a regression test that fires 50 concurrent deltas at one SKU and asserts the sum, so the race cannot return unnoticed.")


def build(codex_dir, now):
    ses = CodexSession(codex_dir, 23, now - 7 * 3600_000)
    r = ses.root
    r.meta()
    r.start_turn("The inventory sync test keeps failing now and then in CI. Please find out why and fix it. Use helpers for the log digging and for a second look at the fix.")
    r.step("Plan: read the test, gather failure evidence in parallel, then reproduce.", "I will read the test first, then ask a helper to mine the CI logs.", [
        C("sed -n 1,80p src/inventory/inventory-sync.test.ts", "describe('inventory sync', () => {\n  it('reconciles stock after concurrent updates', async () => {\n    await Promise.all(deltas.map((d) => syncWorker.apply('SKU-1', d)));\n    expect(await stock('SKU-1')).toBe(8);\n  });\n});", 0.4)], 5.0)
    r.step("", "", [Spawn("log_scan", "Mira", "explorer", "gpt-6-luna", "low", log_scan)], 2.0)
    scan = ses.threads[-1]
    r.step("While the helper reads logs I will try the test locally.", "", [C("npx vitest run src/inventory/inventory-sync.test.ts", " ✓ inventory-sync.test.ts (1)\n Tests  1 passed (1)\n Duration  2.4s", 3.6)], 2.0)
    r.step("", "", [{"kind": "wait", "child": scan}], 1.0)
    r.step("Three failures, same assertion. Handing the reproduction to a worker with more effort.", "", [Spawn("race_repro", "Orin", "worker", "gpt-6-sol", "medium", race)], 4.0)
    rep = ses.threads[-1]
    r.step("", "", [{"kind": "wait", "child": rep}], 1.0)
    r.step("The race is in applyDelta. Applying the fix.", "Switching the read-modify-write to an atomic increment.", [
        {"kind": "patch", "files": ["src/inventory/sync-worker.ts"], "patch": "*** Begin Patch\n*** Update File: src/inventory/sync-worker.ts\n@@\n async function applyDelta(sku: string, delta: number) {\n-  const row = await db.stock.get(sku);\n-  await db.stock.put(sku, row.qty + delta);\n+  await db.stock.increment(sku, delta);\n }\n*** End Patch"}], 6.0)
    r.step("", "", [C("npx vitest run src/inventory --repeat 20 --pool=threads", " ✓ inventory-sync.test.ts (20)\n Tests  20 passed (20)", 52.0, why="Verify under the load that reproduced the failure")], 2.0)
    r.step("", "", [Spawn("test_review", "Lena", "reviewer", "gpt-6-luna", "medium", test_review)], 2.0)
    rev = ses.threads[-1]
    r.step("", "", [{"kind": "wait", "child": rev}], 1.0)
    r.end_turn("Fixed. The flaky test was a real race: applyDelta read the stock row and wrote qty + delta back in two steps, so concurrent deltas for one SKU could overwrite each other. It now uses db.stock.increment (atomic). 20 parallel repeats pass; CI had failed 3 of the last 40 runs. A reviewer suggests a 50-way concurrent regression test.")
    r.start_turn("Yes, please add that regression test.", 600)
    r.step("Adding the concurrent regression test next to the existing one.", "", [
        {"kind": "patch", "files": ["src/inventory/inventory-sync.test.ts"], "patch": "*** Begin Patch\n*** Update File: src/inventory/inventory-sync.test.ts\n@@\n+  it('does not lose updates under 50 concurrent deltas', async () => {\n+    await Promise.all(Array.from({ length: 50 }, () => syncWorker.apply('SKU-2', 1)));\n+    expect(await stock('SKU-2')).toBe(50);\n+  });\n*** End Patch"}], 4.0)
    r.step("", "", [C("npx vitest run src/inventory/inventory-sync.test.ts", " ✓ inventory-sync.test.ts (2)\n Tests  2 passed (2)", 3.1),
                     C("git status --short", " M src/inventory/inventory-sync.test.ts\n M src/inventory/sync-worker.ts", 0.2)], 2.0)
    r.end_turn("Added 'does not lose updates under 50 concurrent deltas'; both tests in the file pass. Changes are uncommitted: src/inventory/sync-worker.ts and src/inventory/inventory-sync.test.ts.")
    ses.save("Stabilise flaky inventory sync test")
    return ses
