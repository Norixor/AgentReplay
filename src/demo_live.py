"""Demo session 3: an in-progress Claude Code session.

The history is back-dated so that one sub-agent has been running a shell command for 12+ minutes (the live page raises
its long-command alert). While `agent-replay demo` runs, LiveFeeder appends new steps every few seconds to the main
transcript and one sub-agent, and once spawns another sub-agent, so the live page, event stream and burn rate keep moving.
"""
import threading
import time

from demo_tx import Bash, Dispatch, Edit, Glob, Grep, Hook, Read, Session, Write

REPO = "/home/demo/acme-storefront"
WT = "/home/demo/acme-storefront-worktrees"
SID = "c7e41b09-2d53-4f8a-a6b2-91d0e3f57c48"
MIN = 60_000


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


class LiveFeeder(threading.Thread):
    """Appends one step every `period` seconds, alternating between the main transcript and the endpoint sub-agent."""

    def __init__(self, ses, period=3.0):
        super().__init__(daemon=True)
        self.ses, self.period, self.stop_flag, self.n = ses, period, threading.Event(), 0
        self.endpoint = next(c for c, meta in ses.subs if meta["description"] == "Orders endpoint cursor support")

    def tick(self):
        ses, n = self.ses, self.n
        now = int(time.time() * 1000)
        ses.now = now
        if n == 4:  # a new sub-agent appears
            ses.main.t = now - 800
            ses.main.step("The endpoint is moving; I will start the list UI in parallel.", [Dispatch(
                "Order list cursor loader", "sonnet", "medium",
                "In %s/cursor-ui change web/src/OrderList.tsx to load further pages with nextCursor (infinite scroll), keeping the legacy fallback. Commit on feat/cursor-ui.\n选档理由：UI follows the documented contract; sonnet medium." % WT,
                lambda tx: tx.step("Reading the current list component.", [Read(WT + "/cursor-ui/web/src/OrderList.tsx", cat("export function OrderList() {", "  const { items, next } = useOrders();"))], think=1.0),
                bg=True, live=True, worktree=WT + "/cursor-ui")], think=0.5)
        elif n % 2 == 0:
            ses.main.t = now - 1200
            said, calls = step_for(n // 2, REPO)
            ses.main.step(said, calls, think=0.5)
        else:
            self.endpoint.t = now - 1200
            said, calls = step_for(n // 2 + 40, WT + "/cursor-api")
            self.endpoint.step(said or "Continuing with the endpoint change.", calls, think=0.5)
        ses.flush()
        self.n += 1

    def run(self):
        while not self.stop_flag.wait(self.period):
            try:
                self.tick()
            except Exception:  # demo data only: never take the server down
                pass

    def stop(self):
        self.stop_flag.set()
