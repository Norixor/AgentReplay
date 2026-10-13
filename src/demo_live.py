"""Demo session 3: an in-progress Claude Code session.

The history is back-dated so that one sub-agent has been running a shell command for 12+ minutes (the live page raises
its long-command alert). While `agent-replay demo` runs, LiveFeeder appends new steps every few seconds to the main
transcript and one sub-agent. Every 20-30 seconds it also spawns a short-lived sub-agent (now and then that sub-agent
spawns a nested one and waits for it), lets each of them work for a minute or two and hands it back, and sprinkles in
hook stops, failed calls, merges into main and context compactions. The flow graph on the live page has something to
show at all times; one sub-agent (the e2e run) keeps executing a long command throughout.
"""
import random
import threading
import time

from demo_tx import Bash, Dispatch, Edit, Glob, Grep, Hook, Read, Session, Write

REPO = "/home/demo/acme-storefront"
WT = "/home/demo/acme-storefront-worktrees"
SID = "c7e41b09-2d53-4f8a-a6b2-91d0e3f57c48"
MIN = 60_000
# (description, model, effort, worktree name) of the short-lived workers the feeder spawns, in rotation.
WORKERS = [("Order list cursor loader", "sonnet", "medium", "cursor-ui"), ("Cursor docs refresh", "haiku", "high", "cursor-docs"),
           ("Legacy page param audit", "opus", "medium", "cursor-legacy"), ("Mobile client contract check", "sonnet", "medium", "cursor-mobile"),
           ("Index plan review", "fable", "high", "cursor-index"), ("Cursor error messages", "haiku", "high", "cursor-errors")]
NESTED = [("Query plan check", "haiku", "high"), ("Fixture refresh", "haiku", "high"), ("Snapshot update", "sonnet", "medium")]


def cat(*lines):
    return "\n".join("%6d\t%s" % (i + 1, l) for i, l in enumerate(lines))


FILES = ["src/api/orders.ts", "src/api/cursor.ts", "src/api/serializers.ts", "web/src/OrderList.tsx", "web/src/useOrders.ts", "docs/api/orders.md"]
SNIPPETS = ["export async function listOrders(req: Request) {", "const page = Number(req.query.page ?? 1);", "return { items, nextPage: page + 1 };",
            "const cursor = decodeCursor(req.query.cursor);", "export const encodeCursor = (o: Order) => b64(`${o.createdAt}|${o.id}`);", "// legacy page param stays until 5.0"]


def step_for(n, root, kinds=8):
    """Deterministic pseudo-work for the n-th live tick: (said, calls). Failures and hook stops recur at fixed intervals."""
    f = FILES[n % len(FILES)]
    k = n % kinds
    snip = SNIPPETS[n % len(SNIPPETS)]
    if k == 0:
        return "Reading %s before the next change." % f, [Read("%s/%s" % (root, f), cat(snip, SNIPPETS[(n + 1) % len(SNIPPETS)], "  // ..."))]
    if k == 1:
        return "", [Grep("nextPage|cursor", "%s/src" % root, "src/api/orders.ts:%d:  return { items, nextPage: page + 1 };\nweb/src/useOrders.ts:%d:  const next = data.nextPage;" % (10 + n % 40, 20 + n % 30))]
    if k == 2:
        return "Updating the handler to accept the cursor parameter.", [Edit("%s/%s" % (root, f), snip, snip + "\n  // cursor: opaque, base64(createdAt|id)")]
    if k == 3:
        return "", [Bash("npx vitest run src/api/orders", " ✓ src/api/orders.test.ts (%d)\n Tests  %d passed (%d)\n Duration  %.1fs" % (6 + n % 5, 6 + n % 5, 6 + n % 5, 2.0 + n % 7 / 3.0), 2.5 + n % 3, desc="Run orders API tests")]
    if k == 4:
        if (n // kinds) % 2 == 1:
            return "Type-checking.", [Bash("npm run typecheck", "src/api/cursor.ts(%d,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.\nFound 1 error." % (12 + n % 20), 8.0, err=2, desc="Type-check")]
        return "Type-checking.", [Bash("npm run typecheck", "> tsc --noEmit\n", 7.5, desc="Type-check")]
    if k == 5:
        return "", [Bash("git status --short", " M %s\n M src/api/cursor.ts" % f, 0.3)]
    if k == 6:
        if (n // kinds) % 2 == 0:
            return "Saving progress.", [Hook("git commit -am \"wip: cursor pagination\"", "sh .claude/hooks/guard-main.sh", "Direct commits to main are blocked in this repository. Commit on a feature branch and merge it from the integration workspace.")]
        return "", [Glob("%s/src/api/*.ts" % root, "src/api/orders.ts\nsrc/api/cursor.ts\nsrc/api/serializers.ts")]
    return "", [Bash("npm run lint -- src/api", "> eslint src/api\n", 6.0)]


def audit(tx):
    tx.step("Finding every consumer of the page-based orders endpoint.", [Grep("page=|nextPage", REPO, "web/src/useOrders.ts:20:  const next = data.nextPage;\nmobile/src/api/orders.ts:33:  `/orders?page=${page}`\nsrc/api/orders.ts:10:  return { items, nextPage: page + 1 };", 0.8)], think=1.5)
    tx.step("", [Read(REPO + "/src/api/orders.ts", cat("export async function listOrders(req: Request) {", "  const page = Number(req.query.page ?? 1);", "  const items = await db.orders.page(page, 20);", "  return { items, nextPage: page + 1 };", "}"))], think=1.2)
    tx.finish("Consumers of GET /orders: web/src/useOrders.ts (reads nextPage), mobile/src/api/orders.ts (sends page=N, reads nextPage), and the server handler src/api/orders.ts. Mobile app must keep working: keep both `page` and `nextPage` in responses until 5.0.")


def helpers(tx):
    wt = WT + "/cursor-helpers"
    for i, (said, calls) in enumerate([
        ("Reading how ids and timestamps are stored.", [Read(wt + "/src/db/orders.ts", cat("createdAt: Date; id: string; // ULID"))]),
        ("Writing the cursor helpers.", [Write(wt + "/src/api/cursor.ts", "export const encodeCursor = (o: Order) => Buffer.from(`${o.createdAt.toISOString()}|${o.id}`).toString('base64url');\nexport function decodeCursor(c: string) {\n  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');\n  return { createdAt: new Date(at), id };\n}")]),
        ("Round-trip and malformed input tests.", [Write(wt + "/src/api/cursor.test.ts", "it('round-trips', () => expect(decodeCursor(encodeCursor(o)).id).toBe(o.id));\nit('rejects garbage', () => expect(() => decodeCursor('###')).toThrow());")]),
        ("", [Bash("npx vitest run src/api/cursor", " ✓ src/api/cursor.test.ts (2)\n Tests  2 passed (2)", 3.0)]),
        ("", [Bash("git add -A && git commit -m \"Add cursor encode/decode helpers\"", "[feat/cursor-helpers a41c7be] Add cursor encode/decode helpers\n 2 files changed, 17 insertions(+)", 0.7)])]):
        tx.step(said, calls, think=45)
    tx.finish("Branch feat/cursor-helpers (a41c7be): encodeCursor/decodeCursor in src/api/cursor.ts, opaque base64url of createdAt|id, decode throws on malformed input. 2 tests pass.")


def endpoint(tx):
    """Long-running sub-agent: history now, more steps appended by the feeder."""
    for n in range(14):
        said, calls = step_for(n + 20, WT + "/cursor-api", 8)
        tx.step(said or "Continuing with the endpoint change.", calls, think=50)


def e2e(tx):
    tx.step("Checking the e2e project layout.", [Bash("ls e2e && git status --short", "orders.spec.ts\ncheckout.spec.ts\nplaywright.config.ts", 0.4)], think=1.5)
    tx.step("Starting the orders e2e project against the local mock server.", [Read(WT + "/cursor-e2e/e2e/playwright.config.ts", cat("workers: 2,", "use: { baseURL: 'http://127.0.0.1:4010' }"))], think=2.0)
    tx.t = tx.ses.now - int(12.5 * MIN)
    tx.step("Running the orders suite.", [dict(Bash("npm run test:e2e -- --workers=2 --project=orders", desc="Run orders e2e suite"), pending=True)], think=1.0)


def build(claude_dir, now):
    ses = Session(claude_dir, REPO, SID, 5, now - 38 * MIN, "opus", "medium", "Migrate order history to cursor pagination")
    ses.now, ses.pace = now, 1.0
    m = ses.main
    m.user("Switch the order history API and page to cursor-based pagination. Keep the old `page` parameter working until the next major release.", 0)
    m.step("First I want to see the current handler and who calls it.", [Read(REPO + "/src/api/orders.ts", cat("export async function listOrders(req: Request) {", "  const page = Number(req.query.page ?? 1);", "  return { items: await db.orders.page(page, 20), nextPage: page + 1 };", "}")),
                                                                         Bash("git status --short && git branch --show-current", "main", 0.4)], think=3.0)
    m.step("Consumer discovery is a search task; delegating it.", [Dispatch("Audit orders pagination consumers", "haiku", "high",
                                                                      "List every consumer of GET /orders in %s (web, mobile, server). Report file:line and which response fields each reads. Read-only, under 150 words." % REPO, audit, agent_type="Explore")], think=2.0)
    m.step("Plan: cursor helpers first (small, isolated), then the endpoint, then the web list, then e2e.", [
        Bash("git worktree add %s/cursor-helpers -b feat/cursor-helpers && git worktree add %s/cursor-api -b feat/cursor-api && git worktree add %s/cursor-e2e -b feat/cursor-e2e" % (WT, WT, WT),
             "Preparing worktree (new branch 'feat/cursor-helpers')\nPreparing worktree (new branch 'feat/cursor-api')\nPreparing worktree (new branch 'feat/cursor-e2e')", 2.4)], think=6.0)
    m.t = max(m.t, now - 24 * MIN)
    m.step("Starting the helpers in the background; they are small and independent.", [Dispatch(
        "Cursor encode/decode helpers", "sonnet", "medium",
        "In %s/cursor-helpers add src/api/cursor.ts with encodeCursor/decodeCursor (opaque base64url of createdAt|id, decode must throw on malformed input) and tests. Commit on feat/cursor-helpers.\n选档理由：small isolated module with a clear spec; sonnet medium.\nReport in under 100 words." % WT,
        helpers, bg=True, worktree=WT + "/cursor-helpers")], think=3.0)
    m.t = max(m.t, now - 22 * MIN)
    m.user("Keep the response shape backwards compatible - the mobile app still reads `nextPage`.", 0)
    m.step("Noted. The endpoint will return both `nextPage` and `nextCursor` while the legacy `page` parameter is honoured.", [Write(REPO + "/docs/api/orders.md", "# GET /orders\n\nQuery: `page` (legacy) or `cursor`. Response: `items`, `nextPage` (legacy), `nextCursor`.\n")], think=4.0)
    m.t = max(m.t, now - 16 * MIN)
    m.step("Helpers are done. Starting the endpoint work and the e2e run in the background.", [
        Dispatch("Orders endpoint cursor support", "sonnet", "medium",
                 "In %s/cursor-api make GET /orders accept `cursor` next to the legacy `page`, returning both nextPage and nextCursor. Use feat/cursor-helpers for encoding (merge it first). Add handler tests, keep lint and typecheck green, commit on feat/cursor-api.\n选档理由：contract is fixed in docs/api/orders.md; sonnet medium.\nReport in under 150 words." % WT,
                 endpoint, bg=True, live=True, worktree=WT + "/cursor-api")], think=3.0)
    m.t = max(m.t, now - 14 * MIN)
    m.step("", [Dispatch("Run orders e2e suite", "haiku", "high",
                         "In %s/cursor-e2e run the orders Playwright project (npm run test:e2e -- --workers=2 --project=orders) and summarise failures. Do not change code." % WT, e2e, bg=True, live=True, worktree=WT + "/cursor-e2e")], think=2.0)
    m.t = max(m.t, now - 13 * MIN)
    m.step("The helpers branch is ready; merging it into main from the integration workspace.", [Bash("git merge --no-ff feat/cursor-helpers -m \"Merge cursor helpers\"", "Merge made by the 'ort' strategy.\n src/api/cursor.test.ts | 6 ++++++\n src/api/cursor.ts      | 11 +++++++++++\n 2 files changed, 17 insertions(+)", 0.9, desc="Merge cursor helpers")], think=3.0)
    m.step("Updating the web hook to prefer nextCursor when present.", [Read(REPO + "/web/src/useOrders.ts", cat("export function useOrders() {", "  const next = data.nextPage;", "}"))], think=60)
    m.step("", [Edit(REPO + "/web/src/useOrders.ts", "const next = data.nextPage;", "const next = data.nextCursor ?? data.nextPage;")], think=40)
    m.t = max(m.t, now - 9 * MIN)
    m.step("Recording progress.", [Hook("git commit -am \"Use nextCursor in useOrders\"", "sh .claude/hooks/guard-main.sh", "Direct commits to main are blocked in this repository. Commit on a feature branch and merge it from the integration workspace.")], think=2.0)
    m.step("Right, branch first.", [Bash("git switch -c feat/web-cursor && git commit -am \"Use nextCursor in useOrders\" && git switch main", "Switched to a new branch 'feat/web-cursor'\n[feat/web-cursor 6d2b8f1] Use nextCursor in useOrders\nSwitched to branch 'main'", 1.3)], think=2.5)
    m.t = max(m.t, now - 6 * MIN)
    m.step("Type-checking the web package.", [Bash("npm run typecheck --workspace web", "web/src/useOrders.ts(14,9): error TS2339: Property 'nextCursor' does not exist on type 'OrdersPage'.\nFound 1 error.", 11.0, err=2, desc="Type-check web")], think=2.0)
    m.step("The shared type needs the new field.", [Edit(REPO + "/web/src/types.ts", "nextPage: number;", "nextPage: number;\n  nextCursor?: string;")], think=3.0)
    m.step("", [Bash("npm run typecheck --workspace web", "> tsc --noEmit\n", 10.5)], think=1.5)
    ses.save(backdate=False)
    return ses


class Worker:
    """A live sub-agent the feeder keeps writing to until its time is up."""

    def __init__(self, tx, root, born, life_s, desc, nested=False, parent=None):
        self.tx, self.root, self.born, self.life, self.desc = tx, root, born, life_s * 1000, desc
        self.nested, self.parent, self.steps, self.open = nested, parent, 0, None   # open: the call still waiting for its result row
        self.seed = random.randrange(100)
        self.child = None


class LiveFeeder(threading.Thread):
    """Appends one step every `period` seconds, rotating between the main transcript, the endpoint sub-agent and the
    short-lived workers, and spawns / retires workers on a timer so the sub-agent tree keeps changing."""

    def __init__(self, ses, period=3.0):
        super().__init__(daemon=True)
        self.ses, self.period, self.stop_flag, self.n = ses, period, threading.Event(), 0
        self.endpoint = next(c for c, meta in ses.subs if meta["description"] == "Orders endpoint cursor support")
        self.rng = random.Random()
        self.workers, self.rr, self.spawned, self.nested_n, self.main_n, self.ep_n = [], 0, 0, 0, 0, 0
        self.next_spawn = int(time.time() * 1000) + 9_000

    # ------------------------------------------------------------ helpers

    def dispatch_call(self, desc, model, effort, wt, nested, bg):
        brief = "In %s/%s work on one slice of the cursor pagination change: %s. Commit on its own branch and report in under 80 words.\n选档理由：the slice is small and its contract is fixed; %s %s is enough." % (WT, wt, desc, model, effort)
        return Dispatch(desc, model, effort, brief, lambda tx: tx.step("Reading the files this slice touches.", [Read("%s/%s/web/src/OrderList.tsx" % (WT, wt), cat("export function OrderList() {"))], think=0.3),
                        bg=bg, live=True, worktree="%s/%s" % (WT, wt))

    def spawn(self, now):
        base = [w for w in self.workers if not w.nested]
        if len(base) >= 5:
            return
        desc, model, effort, wt = WORKERS[self.spawned % len(WORKERS)]
        if self.spawned >= len(WORKERS):
            desc += " (%d)" % (self.spawned // len(WORKERS) + 1)
        self.spawned += 1
        ses = self.ses
        ses.main.t = now - 800
        ses.main.step("Another slice can run in parallel; delegating it.", [self.dispatch_call(desc, model, effort, wt, False, True)], think=0.5)
        self.workers.append(Worker(ses.subs[-1][0], "%s/%s" % (WT, wt), now, self.rng.uniform(65, 105), desc))

    def spawn_nested(self, w, now):
        desc, model, effort = NESTED[self.nested_n % len(NESTED)]
        self.nested_n += 1
        call = dict(self.dispatch_call(desc, model, effort, "cursor-nested", True, False), pending=True)
        w.tx.t = max(w.tx.t, now - 1500)
        w.tx.step("This part is independent; splitting it off and waiting for the answer.", [call], think=0.4)
        life = max(20.0, min(self.rng.uniform(28, 42), (w.born + w.life - now) / 1000 - 14))
        child = Worker(self.ses.subs[-1][0], "%s/cursor-nested" % WT, now, life, desc, nested=True, parent=w)
        w.child, w.open = child, {"id": call["id"], "due": None}
        self.workers.append(child)

    def run_step(self, w, now):
        """One step of a worker as a call that stays open for a few seconds, so the page sees it executing."""
        if w.open:
            return
        if not w.nested and w.child is None and w.steps >= 2 and now - w.born > 18_000 and w.born + w.life - now > 55_000 and self.rng.random() < 0.5:
            self.spawn_nested(w, now)
            return
        said, calls = step_for(w.steps + w.seed, w.root, 8)
        w.steps += 1
        if calls[0].get("err") and self.rng.random() > 0.3:  # failures and hook stops stay occasional
            said, calls = "", [Bash("npm run lint -- src/api", "> eslint src/api\n", 6.0)]
        call = dict(calls[0], pending=True)
        w.tx.t = max(w.tx.t, now - 500)
        w.tx.step(said or "Continuing with this slice.", [call], think=0.4)
        w.open = {"id": call["id"], "due": now + max(call["dur"], 0.8) * 1600, "res": call["res"], "err": bool(call.get("err"))}

    def close_open(self, w, now):
        o = w.open
        if o and o["due"] is not None and now >= o["due"]:
            w.tx.result(o["id"], o["res"], now - 100, o["err"])
            w.open = None

    def retire(self, w, now):
        tx = w.tx
        if w.open and w.open["due"] is not None:
            self.close_open(w, now + 10_000)
        tx.t = max(tx.t, now - 500)
        tx.report = "Slice done on %s: change committed on its branch, checks green." % w.root.rsplit("/", 1)[-1]
        tx.step(tx.report, stop="end_turn", think=0.3)
        if w.parent is not None:  # the waiting parent gets the report as the result of its foreground Agent call
            w.parent.tx.result(w.parent.open["id"], tx.report, now + 200)
            w.parent.open, w.parent.child = None, None
        self.workers.remove(w)

    # ------------------------------------------------------------ one tick

    def tick(self):
        ses = self.ses
        now = int(time.time() * 1000)
        ses.now = now
        for w in list(self.workers):
            self.close_open(w, now)
        for w in sorted(self.workers, key=lambda x: not x.nested):  # nested workers first: a parent waits for its child
            if now >= w.born + w.life and (w.nested or w.child is None):
                self.retire(w, now)
        if now >= self.next_spawn:
            self.spawn(now)
            self.next_spawn = now + int(self.rng.uniform(20, 30) * 1000)
        act = self.n % 3
        if act == 0:
            self.main_tick(now)
        elif act == 1:
            self.endpoint.t = now - 1200
            said, calls = step_for(self.ep_n + 40, WT + "/cursor-api")
            self.ep_n += 1
            self.endpoint.step(said or "Continuing with the endpoint change.", calls, think=0.5)
        elif self.workers:
            self.rr += 1
            self.run_step(self.workers[self.rr % len(self.workers)], now)
        ses.flush()
        self.n += 1

    def main_tick(self, now):
        m = self.ses.main
        if m.ctx > 330_000:  # context compaction: the context bar on the graph falls back
            m.t = now - 4000
            m.compact("Summary of the work so far: cursor helpers merged, endpoint and list UI in progress, e2e running.")
        m.t = now - 1200
        n = self.main_n
        self.main_n += 1
        if n % 20 == 19:  # a merge into main from the integration workspace
            m.step("A finished slice can go into main now.", [Bash("git merge --no-ff feat/cursor-ui -m \"Merge cursor ui\"",
                   "Merge made by the 'ort' strategy.\n web/src/OrderList.tsx | 14 ++++++++------\n 1 file changed, 8 insertions(+), 6 deletions(-)", 0.9, desc="Merge cursor ui")], think=0.5)
            return
        said, calls = step_for(n, REPO)
        m.step(said, calls, think=0.5)

    def run(self):
        while not self.stop_flag.wait(self.period):
            try:
                self.tick()
            except Exception:  # demo data only: never take the server down
                pass

    def stop(self):
        self.stop_flag.set()
