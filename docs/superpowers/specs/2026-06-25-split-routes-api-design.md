# Split `src/server/routes-api.ts` into a `routes-api/` module directory

**Status:** approved (design) · **Date:** 2026-06-25 · **Branch:** `feature/split-routes-api`

## Problem

`src/server/routes-api.ts` is **1093 lines / 92 KB** — the single largest file in the repo
(next is `core.ts` at 631). It violates the project's own architectural invariant
(`ARCHITECTURE.md` §IV: *"Single file ≤ 1000 lines (split if exceeded)"*), and that same
line is itself **stale** — it claims the file is "~670 lines". The file is one hand-rolled
`handleApi` dispatcher: a long `if (p === … && method === …)` / regex `.exec(p)` chain.

This is the human REST surface (`/api/*`) and an **authorization-sensitive** area
(`docs/authorization.md`: *越权很危险*). The refactor must be **pure** — zero behavior change,
zero new/removed endpoints.

## Goal (verifiable)

Split into focused modules, each well under 1000 lines, **while preserving behavior exactly** —
proven by (a) a route-inventory diff and (b) a byte-level curl regression against a baseline
snapshot taken from the pre-split code on the same seeded DB.

## Hard invariants (the security-critical constraints)

The dispatcher has **three sequential auth gates** that establish context. Which gate a route
sits behind *is* its auth level — moving a route across a gate is a privilege bug.

1. **Gate 0 — public / self-authed** (before any global auth): `auth/dev-login·setup·register·login·invite-info`,
   plus `GET /api/attachments/:id(/preview)?` which **self-authenticates** via `?token=` or Bearer
   (placed pre-gate on purpose so `<img src>` can fetch with a query token). Must stay pre-gate.
2. **Gate 1 — `userId`** (`verifyUser(bearer)` → 401): `accept-invite`, `me`, `servers` list/create/unread-summary/:id.
3. **Gate 2 — `serverId` + `member`** (`x-server-id` → 400, membership → 403): everything else.

Additional invariants:
- **Linear evaluation order preserved.** A few routes disambiguate by first-match
  (e.g. `/api/channels/saved` precedes `/api/channels/:id`). Regexes are mostly `$`-anchored +
  method-discriminated so no collision flips in practice, but order is treated as load-bearing.
- **Tail contract:** any unmatched `/api/*` ends in `return (sendErr(res, 404, "not found"), true)`.
  `handleApi` returns `false` only for non-`/api/*` paths. Entry signature unchanged.
- **`mm` couples `members`+`machines`** in one block (`/api/servers/:id/(members|machines)`) → do not split them.

## Design — domain modules + thin orchestrator

`handleApi(req,res,url,method)` keeps the three gates and builds a context object, then delegates
each gate's routes to per-domain handler functions `(ctx) => Promise<boolean>` (return `true` =
handled & response sent). Route bodies move **verbatim**; only the context plumbing changes
(`userId`/`serverId`/`member` go from closure variables to `ctx.*`).

```
src/server/routes-api/
  index.ts        # handleApi: 3 gates + build ctx + ordered delegation + tail 404
  ctx.ts          # BaseCtx / UserCtx / ServerCtx types
  shared.ts       # attachMentions(), userChannels()  (used by ≥2 modules)
  auth.ts         # gate0: dev-login·setup·register·login·invite-info ; gate1: accept-invite·me
  servers.ts      # gate1: servers list/create/unread-summary/:id ; gate2: members·roles·join-links·machines·notification-settings·sidebar-order·member-profile
  agents.ts       # gate2: agents CRUD·start/stop/reset·workspace-files·activity-log·scopes·skills·integrations·agent-dms
  channels.ts     # gate2: channels·dm·unread·inbox·threads(+done/undone)·members·files·create·archive·:id·join/leave/read
  messages.ts     # gate2: messages·channel·search·sync·reactions·mark-executed·mentions·saved
  tasks.ts        # gate2: tasks channel/server/convert/claim/unclaim/status/delete
  reminders.ts    # gate2: reminders GET
  attachments.ts  # gate0: :id download (self-authed) ; gate2: upload·me/agent/server avatar
```

Orchestrator dispatch order (preserves original top-to-bottom):

```
if !p.startsWith('/api/') return false
base = {req,res,url,method,p}
if (await auth.handlePublic(base))        return true
if (await attachments.handlePublicGet(base)) return true
userId = verifyUser(bearer(req)); if !userId → 401
user = {...base, userId}
if (await auth.handleAuthed(user))        return true
if (await servers.handleUserScope(user))  return true
serverId = serverIdHeader(req); if !serverId → 400
member = …; if !member → 403
sctx = {...user, serverId, member}
for h in [agents, reminders, channels, messages(mentions/saved), attachments.handleAuthed, channels(rest), servers.handleServerScope, messages(rest), tasks]:
  if (await h(sctx)) return true     // exact original order within gate 2
return (sendErr(res,404,"not found"), true)
```

> The gate-2 module call order is fixed to reproduce the original file's linear order so the
> `saved`-before-`:id` style disambiguation is preserved. The verification step asserts this.

## Verification (no route-level test net exists → real-run required)

1. **`npm run typecheck`** (root) green — first gate, not the finish line.
2. **Route-inventory diff** — `extract-routes.cjs` pulls the ordered `(kind, pattern, methods)`
   guard set from the old monolith (golden: **78 guards**) and from the new modules; assert the
   sets are identical (no route lost / added / method-changed).
3. **Behavioral curl regression** — `battery.sh` (48 calls covering every domain + both gate
   boundaries + collision probes: `saved` vs `:id`, `attachments/upload` exclusion, public
   token-auth) run against a baseline server (pre-split) and the post-split server on the **same
   seeded DB**; diff STATUS for every call + normalized BODY for reads. Baseline captured:
   34×200 / 3×400 / 5×401 / 1×403 / 5×404, no 500s.
4. **Code review** — adversarial reviewer subagent over the diff (gate order, lost/moved routes,
   behavior drift), then a `/code-review`.

**Fail loud:** the "done" report lists what was skipped, any warnings, and what was not verified.

## Doc-sync (same PR)

- `ARCHITECTURE.md` §codemap: replace the `routes-api.ts` line with a `routes-api/` directory entry
  describing each module; **fix the stale "~670 lines"**.
- `ARCHITECTURE.md` §IV invariant line: update "largest is routes-api.ts at ~670 lines" to the new
  largest file.
- Pure refactor → no `FEATURES.md` change, no DB/schema change, no daemon release.

## Out of scope

No endpoint behavior changes; no fixing the pre-existing non-UUID-id → 500 responses; no router-table
rewrite (YAGNI); `routes-agent.ts` (486 lines, under limit) untouched.
