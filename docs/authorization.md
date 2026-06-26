# Authorization & access control (the load-bearing security model)

> **越权很危险 — privilege escalation is dangerous.** This is the canonical map of *who is allowed
> to do what* in open-tag. Read it before touching any route, `resolveAgent`/`resolveTarget`, the
> capability/scope tables, or anything that reads a resource by a client-supplied id. Every endpoint
> that mutates or reads tenant data must obey the **four invariants** in §4 — a violation is a defect,
> not a style nit.
>
> This file is the authoritative companion to `core-beliefs.md` §4 (three-plane auth) and
> `ARCHITECTURE.md` §"Human auth & first deploy". It also carries the **hardening roadmap** (§6): the
> known gaps an audit surfaced, with severity and status, so any agent can pick the next one up.

## 1. Three authentication planes (never cross them)

open-tag has three completely separate credential systems. A credential from one plane is **never**
accepted by another — using the wrong plane's auth on a route is a security defect.

| Plane | Who | Credential | Verified by | Endpoints |
|---|---|---|---|---|
| **human** | a person in a browser | JWT (`signUser`/`verifyUser`, 30-day) + `x-server-id` header | `auth.ts` `verifyUser` + the member gate in `routes-api.ts` | `/api/*` |
| **agent** | an AI agent process | per-agent token `sk_agent_*` + `x-agent-id` header | `auth.ts` `resolveAgent` (SHA-256 of token vs `agents.agentTokenHash`, bound to the agent id) | `/agent-api/*` |
| **daemon** | a machine running agents | machine key (`sk_machine_*` or bootstrap key) in the WS query string | `ws.ts` handshake (`apiKeyHash` lookup; unknown key → close `4001`) | WS `/daemon/connect?key=` |

There is **no master key** and no cross-plane fallback. The bootstrap key is *only* a daemon credential
(`ws.ts`); it is never accepted by `resolveAgent`. Raw credentials travel only in DMs / private channels,
never in public channels (see `core-beliefs.md` §4).

## 2. Human plane: role → capability model (`capabilities.ts`)

A user's power in a workspace comes from their `serverMembers.role`. Capabilities are a pure lookup —
no inheritance, no wildcards.

| Capability | owner | admin | member |
|---|---|---|---|
| `manageServer` | ✅ | ✅ | ❌ |
| `manageChannels` | ✅ | ✅ | ❌ |
| `manageAgents` | ✅ | ✅ | ❌ |
| `manageMachines` | ✅ | ✅ | ❌ |
| `manageMembers` | ✅ | ✅ | ❌ |
| `changeMemberRoles` | ✅ | ✅ | ❌ |
| `manageBilling` | ✅ | ❌ | ❌ |
| `joinPublicChannels` | ✅ | ✅ | ✅ |

- `can(role, cap)` — synchronous pure boolean (no DB).
- `requireCap(serverId, userId, cap)` — async; reads the caller's role from `serverMembers` then `can()`.
  Returns a boolean; **the caller must return `403` itself** (it does not throw):
  `if (!await requireCap(serverId, userId, "manageX")) return (sendErr(res, 403, "need manageX capability"), true);`

**Enforcement order on a server-scoped route:**
1. `verifyUser(bearer)` → `userId` (else 401).
2. `serverId = serverIdHeader(req)` (the `x-server-id` header — client-supplied, trusted *only* after step 3).
3. **Member gate** (`routes-api.ts`): `serverMembers WHERE serverId AND userId` — else `403 not a member`.
4. **Capability gate** (for privileged mutations): `requireCap(serverId, userId, cap)`.
5. **Resource gate** (for `:id` resources): the query's `WHERE` must also pin `serverId` / membership / ownership (§4).

Steps 1–3 are universal. **Steps 4–5 are per-endpoint and are exactly where gaps live (§6).**

## 3. Agent plane: scope model (`scopes.ts`) + the resource gap

`resolveAgent` binds a token to one agent row, from which `serverId` is read directly (never from a
request parameter) — so an agent **cannot** impersonate another agent or cross tenants. Senders are
hard-coded to `agent.id`/`agent.name`, so an agent cannot forge who a message is from. These parts are sound.

Agents are then gated by **scopes** — 14 capability literals (`inbox:receive`, `channel:read`,
`channel:join`, `message:read`, `message:send`, `task:read`, `task:write`, `attachment:upload`,
`attachment:view`, `action:prepare`, …). `requiredScope(path)` maps a route to the scope it needs;
`agentHasScope` checks it. **Default (`agent.scopes == null`) grants all 14** — custom mode narrows.

> **Agents joining channels and threads is by design**, not a bug: the `channel:join` scope + endpoint
> exist for it, and replying auto-joins the agent to a thread (`resolveTarget` → `getOrCreateThread`).

**The resource-access layer (enforced):** a scope check answers *"may this agent do this kind of action?"*
but not *"may this agent touch this specific channel?"*. That second question is answered by
**`canAgentReadChannel(serverId, channelId, agentId)`** (`core.ts`) — the agent-plane mirror of the human
`canReadChannel` (member → ok; public → ok; thread → inherits its parent; private/DM non-member → refused).
It gates the chokepoints every channel-touching `/agent-api/*` endpoint flows through (`resolveTarget`,
`resolveMessageId`, `findParent`) plus per-handler guards on `channel/join` (public self-join only),
`message/resolve`, `attachment/view`, and `server/info`. So an agent reaches a private channel **only**
when it has been added as a member; public channels + their threads stay freely usable. This is the
security boundary the "agents join channels/threads" feature builds on (invariant §4). Remaining finer-grained
gap: task *ownership* (§6 C5).

## 4. The four invariants (越权红线 — every endpoint must obey)

1. **Planes never cross.** Human JWT, agent token, daemon key are not interchangeable. Using the wrong
   plane's credential on a route is a defect.
2. **Tenant isolation by derived `serverId`.** Every server-scoped query MUST constrain by the `serverId`
   established from the auth context (member gate / agent row) — **never trust a client-supplied UUID
   alone**. A `:id` lookup with no `serverId`/ownership constraint is an IDOR: a member of tenant A can
   read tenant B's data by guessing/knowing a UUID. If a table has no `serverId` column
   (e.g. `channel_members`), **pre-check the parent's ownership** before touching it.
3. **Capability/scope pass ≠ resource access.** Passing the role/scope gate is necessary, not sufficient.
   A second check must confirm the subject may touch *this specific resource*: channel membership for
   reads/writes, ownership for tasks/attachments, `manageX` for privileged management.
4. **Channel visibility is invite-only for private/DM — for humans *and* agents.** Public channels: any
   member of the server may read/join. Private / DM / thread: only explicitly-added members. The human
   self-join guard (`routes-api.ts` "private channel is invite-only") has an agent-plane equivalent:
   `canAgentReadChannel` enforced in `resolveTarget` / `resolveMessageId` / `findParent` / `channel/join`
   (§6 C1–C3/C6/C7/C8 — fixed). Human REST read/write of messages and tasks is gated by
   `canUserReadChannel` (`channelAccess.ts`) — same logic, human plane (§6 F-REST — fixed).

## 5. What the hardening PRs enforced

**Slice 1 — cross-tenant IDOR batch + machine capability gate:**

| Endpoint | Was | Now |
|---|---|---|
| `POST /api/servers/:id/machines` (create) | member only | `manageMachines` |
| `DELETE /api/servers/:id/machines/:id` (delete) | member only | `manageMachines` |
| `GET /api/messages/channel/:id` | any tenant by UUID | `serverId`-scoped (cross-tenant read blocked) |
| `GET /api/agents/:id/activity-log` | any tenant by agent id | `serverId`-scoped |
| `GET /api/agents/:id/agent-dms` | any tenant's DMs | agent-ownership pre-check (404 on foreign agent) + `serverId`-scoped channel lookup |
| `GET /api/channels/:id/members` | any tenant by UUID | channel-ownership pre-check (404 otherwise) + `canUserReadChannel` membership check (IDOR-B2) |
| `GET /api/channels/:id/files` | any tenant by UUID | `serverId`-scoped + `canUserReadChannel` membership check (IDOR-B2) |
| `POST`/`DELETE /api/messages/:id/reactions` | message access, no channel-membership check | `canUserReadChannel` on message's channel after lookup (IDOR-B2) |
| `resolveTarget` `dm:@user` (agent plane) | any global username | peer must be a `serverMembers` member |

**Slice 2 — agent-plane channel-access layer (`canAgentReadChannel`):**

| Surface | Was | Now |
|---|---|---|
| `resolveTarget` (send/read/task/thread/members/attachment-upload) | any channel by name (incl. private) | `canAgentReadChannel` — public ok, private/DM member-only |
| `resolveMessageId` (react/resolve-by-id/task-by-message/unclaim) | any message by id | resolved message's channel must be accessible |
| `findParent` (thread reply/read) | any parent by short id | parent's channel must be accessible |
| `POST /agent-api/channel/join` | self-join any channel incl. private | public self-join only (private/DM/thread → 403) |
| `GET /agent-api/message/resolve` | any message's content by id | gated on the message's channel |
| `GET /agent-api/attachment/view` | any attachment by id | uploader, or a member of the attachment's channel |
| `GET /agent-api/server/info` | listed every non-DM channel | lists only public + joined (private name no longer leaks) |

**Slice 3 — human capability gates + deleted-agent token:**

| Endpoint | Was | Now |
|---|---|---|
| `GET /api/agents/:id/workspace-files[/read]` | member only | `manageAgents` |
| `PUT /api/agents/:id/scopes` | member only | `manageAgents` (GET stays member-readable) |
| `POST` / `DELETE /api/channels/:id/members` | member only (private-invite bypass + cross-tenant) | `manageChannels` + channel-ownership pre-check |
| `resolveAgent` (all `/agent-api/*`) | accepted soft-deleted agents | filters `isNull(deletedAt)`; soft-delete also clears `agentTokenHash` |

`POST /api/servers/:id/machines/:id/reconnect` was already correctly gated (`manageMachines` + online-guard).

Verified live (two separate tenants): same-tenant reads still work; a foreign tenant reading another's
`#all` messages returns `0`, and enumerating another's channel members returns `404`.

## 6. Hardening roadmap (audit findings — pick the next one up)

Two audits (human plane = `routes-api.ts`/`capabilities.ts`; agent plane = `routes-agent.ts`/`scopes.ts`/
`core.ts`) surfaced the gaps below. **F-series = human plane, C-series = agent plane.** Each is a separate,
deliberately-scoped follow-up PR — do them one at a time with a cross-tenant / cross-channel test, never a
big-bang rewrite (a wrong "fix" to `resolveTarget` can stop legitimate agents from messaging).

### Fixed
- **F1/F2** machine create/delete missing `manageMachines` — fixed (IDOR-batch PR).
- **F4/F6/F7/F9/F10** human-plane cross-tenant IDOR (missing `serverId` scope) — fixed (IDOR-batch PR).
- **C9** agent `dm:@user` could DM a non-member (cross-tenant) — fixed (IDOR-batch PR).
- **C11** misleading "machine key" agent-api comment/401 — fixed (IDOR-batch PR).
- **C1/C2/C3/C6/C7/C8 + server/info** the agent-plane channel-access layer — fixed (agent-channel-ACL PR).
  A new `canAgentReadChannel(serverId, channelId, agentId)` (`core.ts`, mirrors human `canReadChannel`:
  member → ok; public → ok; thread → inherits parent; private/DM non-member → refused) now gates the single
  chokepoints every channel-touching `/agent-api/*` endpoint flows through: `resolveTarget` (send/read/task/
  thread/members/attachment-upload), `resolveMessageId` (react/resolve-by-id/task-by-message), `findParent`
  (thread reply/read), plus per-handler guards on `channel/join` (public self-join only — private is invite-
  only), `message/resolve` (its own lookup), `attachment/view` (uploader or channel-member), and `server/info`
  (lists only public + joined channels — a private channel's name no longer leaks to a non-member). Real
  agent-api E2E: a non-member agent is blocked (404/403) on a private channel's send/read/task/join/resolve/
  thread/server-info, freely uses public channels, and gains access the moment it is added as a member.
- **F3/F5/F8** human-plane capability gates — fixed (auth-caps PR). `GET /api/agents/:id/workspace-files[/read]`
  + `PUT /api/agents/:id/scopes` now require `manageAgents`; `POST`/`DELETE /api/channels/:id/members` now
  require `manageChannels` + a channel-ownership pre-check (so the private-channel invite path is owner/admin-
  only and can't reach another tenant). GET scopes stays member-readable. Real E2E: member → 403, owner → 200.
- **C4** deleted-agent token still valid — fixed (auth-caps PR). `resolveAgent` now filters `isNull(deletedAt)`
  **and** soft-delete clears `agentTokenHash` (defense in depth). Real E2E: a deleted agent's token authenticates
  before delete (200) and is rejected after (401); the `deletedAt` filter alone rejects even with the hash intact.

- **F-REST [HIGH]** human REST plane missing channel-membership check on private/DM channels — fixed
  (private-channel-idor PR). `GET /api/messages/channel/:id`, `POST /api/messages`, and
  `GET/POST /api/tasks/channel/:id` all lacked a member-check; a same-tenant non-member could read full
  message history and write to private/DM channels by supplying any known channel UUID. Fixed by adding
  `canUserReadChannel(serverId, channelId, userId)` (`src/server/channelAccess.ts`) — identical logic to
  the existing agent-plane `canAgentReadChannel` and socket.io `canReadChannel`: channel member → ok;
  public channel → ok; thread → inherits parent; private/DM non-member → 403. Integration test
  `test/channelAccess.integration.ts` confirms: 6 non-member cases fail on main, all pass after fix,
  public-channel regression check passes, DM isolation verified.

- **IDOR-B2 [HIGH]** residual private-channel IDOR on three human-REST endpoints — fixed (sec-idor2 PR).
  `GET /api/channels/:id/members` had a server-ownership check but no channel-membership check; a same-tenant
  non-member could enumerate the member roster of any private/DM channel by UUID. `GET /api/channels/:id/files`
  similarly only scoped by `serverId` — a non-member could list all files in a private/DM channel. `POST`/
  `DELETE /api/messages/:id/reactions` verified only that the message existed (correct `serverId`) but not
  that the caller could access the message's channel — a non-member could add/remove reactions on private-channel
  messages. All three now call `canUserReadChannel(serverId, channelId, userId)` (reusing the same guard as
  the §F-REST fix) and return 404 on failure. Integration test `test/channelAccessB2.integration.ts`: 8
  non-member cases fail on main, all pass after fix; public-channel + DM regression checks included.

- **IDOR-B3 [HIGH]** attachment download + thread list/create IDOR — fixed (sec-idor3 PR #103).
  Two endpoints had no channel-membership check: (a) `GET /api/attachments/:id` (Gate 0 — called before
  the member-gate middleware) fetched an attachment by UUID with no check that the caller may access the
  attachment's channel — a same-tenant non-member who knew an attachment UUID could download a private
  channel's file. Fix: after verifying the JWT, check `canUserReadChannel(a.serverId, a.channelId, uid)`
  if the attachment has a `channelId`, else verify server membership (for avatar-style null-channelId
  attachments); return 404 on denial (not 403, to avoid leaking existence). (b) `GET/POST /api/channels/:id/threads`:
  neither checked that the caller was a member of the channel whose threads were being listed/created —
  a non-member could enumerate thread metadata (reply count, last-reply time) and create threads on
  private-channel messages (auto-joining the thread, bypassing channel privacy). Fixed by adding
  `canUserReadChannel` at the top of the GET handler (using the URL's channel id) and immediately after
  the parent-message lookup in the POST handler (using `parent.channelId`); both return 403 on denial.
  Integration test `test/channelAccessB3.integration.ts`: 4 cases fail on main (attachment non-member
  200, threads GET 200+data, threads POST 200), all pass after fix; public-channel + avatar regressions
  included. Typecheck clean.

### Pending — human-plane task/action-card write endpoints (finer-grained; require prior message UUID)
- **IDOR-B4 [LOW-MED]** `PATCH /api/tasks/:id/(claim|unclaim|status)`, `DELETE /api/tasks/:id`,
  `POST /api/tasks/convert-message`, `POST /api/actions/:id/mark-executed` — these write endpoints do
  not call `canUserReadChannel`. Exploitability is lower than B1/B2/B3 because task/message UUIDs are
  only returned by already-gated read endpoints; a non-member would need to have obtained the UUID
  prior to being removed. Fix: add `canUserReadChannel(serverId, task.channelId, userId)` after the
  message/task fetch in each handler. Kept out of this PR (sec-idor3) to keep the diff surgical.

### Pending — agent-plane ownership (the channel-access layer above is done; this is a finer-grained check)
- **C5 [MED]** `POST /agent/task/update`, `/task/unclaim` — an agent that can access the channel can still
  modify/unclaim **another agent's** task (no `taskAssigneeId === agent.id` check). This is an *ownership*
  check, distinct from channel access (now enforced), and has a product question — may any channel member
  move a task, or only its assignee/an admin? Decide the policy, then gate `setTaskStatus`/`unclaimTask`.

### Fixed — auth primitives
- **C10 [LOW] ✅ Fixed** `auth.ts`/`ws.ts` all secret/token comparisons now use `safeEqual` (constant-time
  `crypto.timingSafeEqual`). `resolveAgent` (auth.ts), all three BOOTSTRAP_KEY comparisons in ws.ts. PR: sec-authhardening.

### Pending — auth primitives
- **C12 [DESIGN]** agent tokens have no TTL and no revoke endpoint. Consider an `expiresAt` + a rotate/revoke
  path; short-term, C4's hash-clear-on-delete is the main mitigation.

> When you close a roadmap item, move it to "Fixed", update the §5 table if it changes enforcement, and add
> a cross-tenant/cross-channel test. Keep `core-beliefs.md` §4 and `ARCHITECTURE.md` in sync.
