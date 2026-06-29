# sec-idor4 — IDOR-B4: channel-access gates on human-plane task/action-card write endpoints

> **Status: DONE — 2026-06-29.** Caveat resolved: RED re-run cleanly on `main` (6 breach cases FAIL /
> return 200; 2 regressions PASS — the prior "regression FAIL" was pure context-pollution noise, not a
> test bug). 4 route-layer guards applied; GREEN (ALL PASS); no-regression suite (base/B2/B3 guards +
> 196/197 unit — the 1 fail is pre-existing `mimeXssGuard` JWT_SECRET env, unrelated) + typecheck clean;
> docs synced (authorization.md §6 Pending→Fixed, tech-debt I74). Shipped via the sec-idor4 PR.

Worktree: `../open-tag-sec-idor4` · branch `feature/sec-idor4` · server `:7802` · db `opentag_sec_idor4` · redis `/5`.

## Goal (contract)

A same-tenant **non-member** of a private/DM channel must not be able to mutate that channel's
tasks or action cards by supplying a known message/task UUID. Closes **IDOR-B4** from
`docs/authorization.md` §6 (the last LOW-MED human-plane IDOR gap).

| Endpoint | BEFORE | AFTER |
|---|---|---|
| `POST /api/tasks/convert-message` (private-ch msg) | 200 (promotes) | 404 |
| `PATCH /api/tasks/:id/claim` (private-ch task) | 200 | 404 |
| `PATCH /api/tasks/:id/status` | 200 | 404 |
| `PATCH /api/tasks/:id/unclaim` | 200 | 404 |
| `DELETE /api/tasks/:id` | 200 | 404 |
| `POST /api/actions/:id/mark-executed` (private-ch) | 200 | 404 |

Regression (must stay green): non-member (server member) on a **public** channel → 200;
owner (channel member) on a **private** channel → 200.

**404 (not 403) on denial** — matches the existing reactions guard (IDOR-B2, `messages.ts:133`):
by-message-id writes hide existence (can't tell "no access" from "doesn't exist").

## Root cause (verified by reading code this session)

`tasks.ts` GET/POST `tasks/channel/:id` + `tasks/server` already call `canUserReadChannel`, but the
**write** endpoints don't:
- `src/server/routes-api/tasks.ts` — `convert-message` (~L45), `claim|unclaim|status` (~L51), `DELETE` (~L63)
  call the core mutators (`convertMessageToTask` / `claimTask` / `unclaimTask` / `setTaskStatus` /
  `deleteTask`) with only `serverId` scoping — no channel-read check.
- `src/server/routes-api/messages.ts` — `mark-executed` (~L140) **fetches** the message (L142) but
  skips the guard, unlike the adjacent reactions handler (L133) which has it.

The core mutators (`core.ts` L536–651) are **shared with the agent plane** (which gates via
`resolveMessageId(serverId, id, agentId)` → `canAgentReadChannel`). So the fix MUST live at the
**route layer** (fetch message → `canUserReadChannel`), NOT in core — putting it in core would
double-gate / pollute the agent path. Same layer the B2/B3 fixes used.

`canUserReadChannel(serverId, channelId, userId)` is in `src/server/channelAccess.ts`; already
imported in both `tasks.ts` (L8) and `messages.ts`.

## Exact edits (NOT yet applied)

All four handlers: fetch the message by `(id, serverId)`, 404 if missing, then `canUserReadChannel`
→ 404 on denial, before calling the core mutator.

### `src/server/routes-api/tasks.ts`

**convert-message** — add fetch+guard before `convertMessageToTask`:
```ts
if (p === "/api/tasks/convert-message" && method === "POST") {
  const b = await readJson(req);
  if (!b.messageId) return (sendErr(res, 400, "messageId required"), true);
  const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, b.messageId), eq(schema.messages.serverId, serverId))))[0];
  if (!m) return (sendErr(res, 404, "message not found"), true);
  if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "message not found"), true); // invariant 3 (IDOR-B4)
  const t = await convertMessageToTask(serverId, b.messageId, { type: "user", id: userId });
  return (t ? sendJson(res, 200, { ok: true, id: t.id, taskNumber: t.taskNumber }) : sendErr(res, 404, "message not found"), true);
}
```

**claim|unclaim|status** — add fetch+guard right after destructuring `[, taskId, action]`:
```ts
const [, taskId, action] = tact;
const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, taskId!), eq(schema.messages.serverId, serverId))))[0];
if (!m) return (sendErr(res, 404, "task not found"), true);
if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "task not found"), true); // invariant 3 (IDOR-B4)
let r;
// ...rest unchanged
```

**DELETE** — add fetch+guard before `deleteTask`:
```ts
const tdel = /^\/api\/tasks\/([^/]+)$/.exec(p);
if (tdel && method === "DELETE") {
  const m = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, tdel[1]!), eq(schema.messages.serverId, serverId))))[0];
  if (!m) return (sendErr(res, 404, "task not found"), true);
  if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "task not found"), true); // invariant 3 (IDOR-B4)
  const r = await deleteTask(serverId, tdel[1]!);
  return (r ? sendJson(res, 200, { ok: true }) : sendErr(res, 404, "task not found"), true);
}
```
(`db`, `schema`, `and`, `eq`, `canUserReadChannel` all already imported in tasks.ts.)

### `src/server/routes-api/messages.ts`

**mark-executed** — one line after the existing `if (!m) ... "action not found"` (L143):
```ts
if (!m) return (sendErr(res, 404, "action not found"), true);
if (!(await canUserReadChannel(serverId, m.channelId, userId))) return (sendErr(res, 404, "action not found"), true); // invariant 3 (IDOR-B4)
```

## Done so far
- ✅ Root-cause analysis; exact gaps + fix design confirmed against code.
- ✅ RED test written: `test/channelAccessB4.integration.ts` (8 cases — 6 breach + 2 regression),
  follows the `channelAccessB3.integration.ts` mock-`handleApi` + real-pg pattern.
- ❌ Production fix — **not applied**.
- ❓ RED run — **not trustworthily verified** (see Caveat).

## ⚠️ Caveat — re-verify RED before trusting anything
The only RED run happened during a heavily context-polluted turn; its output was garbled and even
showed the **regression** cases [7]/[8] FAILing, which on unmodified `main` should pass (200). That
is either (a) pure pollution noise, or (b) a real test-setup bug (e.g. owner/public-channel op not
returning 200 — check seq uniqueness, `x-server-id` handling, or action-card metadata shape).
**First resume action: re-run the test cleanly and read the FULL output**, don't trust a tail.

## Next steps (resume here)
1. `cd ../open-tag-sec-idor4` and **re-run RED cleanly**, full output:
   `npx tsx test/channelAccessB4.integration.ts` → expect [1] convert may already 404 by luck? No —
   on main all 6 breach cases should currently return 200 (FAIL). Confirm regressions [7]/[8] PASS on
   main; if they FAIL, fix the test setup first (that's a test bug, not the feature).
2. Apply the four edits above (tasks.ts ×3 handlers, messages.ts ×1).
3. Re-run → expect **ALL PASS** (GREEN).
4. No-regression: `npx tsx --test --test-force-exit test/*.unit.test.ts src/daemon/*.test.ts` + the
   sibling guards `npx tsx test/channelAccess{,B2,B3}.integration.ts`. Then `npm run typecheck`.
   (Note: `*.integration.ts` are **not** in CI — CI only runs `*.unit.test.ts` + daemon tests — so
   B4 is a manually-run guard like its B2/B3 siblings. Mention this in the PR.)
5. **doc-sync**: in `docs/authorization.md` move **IDOR-B4** from "Pending — human-plane task/action-card
   write endpoints" to "Fixed" (describe the route-layer fetch+guard, 404-on-deny, ref the test);
   update the §6 roadmap line. In `docs/tech-debt-tracker.md` note IDOR-B4 closed under the I44
   authorization-layer entry. After 1–5 are green, this plan moves to `docs/exec-plans/completed/`.
6. Commit (surgical diff: 2 files + 1 test + docs) → push → open PR from the worktree. PR body: the
   contract table, the "404 existence-hiding (matches B2)" rationale, evidence (RED→GREEN + regressions),
   and the "not in CI / run manually" note.
7. Teardown when merged: from main repo `npm run wt:rm -- sec-idor4`.

## Notes / decisions
- 404 not 403 (existence-hiding, consistent with reactions B2). Same-file tasks GET/POST use 403 but
  those are by-channel-URL (channelId already known); by-message-id writes warrant the stricter 404.
- `convert-message` fetches the message once at the route layer purely for the guard;
  `convertMessageToTask` fetches again internally — minor redundancy, consistent with the B-series
  pattern, acceptable.
</parameter>
</invoke>
