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
   (§6 C1–C3/C6/C7/C8 — fixed).

## 5. What the hardening PRs enforced

**Slice 1 — cross-tenant IDOR batch + machine capability gate:**

| Endpoint | Was | Now |
|---|---|---|
| `POST /api/servers/:id/machines` (create) | member only | `manageMachines` |
| `DELETE /api/servers/:id/machines/:id` (delete) | member only | `manageMachines` |
| `GET /api/messages/channel/:id` | any tenant by UUID | `serverId`-scoped (cross-tenant read blocked) |
| `GET /api/agents/:id/activity-log` | any tenant by agent id | `serverId`-scoped |
| `GET /api/agents/:id/agent-dms` | any tenant's DMs | agent-ownership pre-check (404 on foreign agent) + `serverId`-scoped channel lookup |
| `GET /api/channels/:id/members` | any tenant by UUID | channel-ownership pre-check (404 otherwise) |
| `GET /api/channels/:id/files` | any tenant by UUID | `serverId`-scoped |
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

### Pending — capability gates (behavior change: members lose an over-permission)
- **F3 [MED]** `GET /api/agents/:id/workspace-files[/read]` — member can read any agent's files (source,
  secrets, `MEMORY.md`) via daemon RPC. Add `requireCap(manageAgents)`.
- **F5 [MED]** `PUT /api/agents/:id/scopes` — member can change an agent's permission scopes. Add
  `requireCap(manageAgents)`.
- **F8 [MED-HIGH]** `POST/DELETE /api/channels/:id/members` — member can add/remove anyone to/from any
  channel **including private** (bypasses invite-only) and from any tenant. Add `requireCap(manageChannels)`
  + channel-ownership pre-check + a private-visibility rule.

### Pending — agent-plane ownership (the channel-access layer above is done; this is a finer-grained check)
- **C5 [MED]** `POST /agent/task/update`, `/task/unclaim` — an agent that can access the channel can still
  modify/unclaim **another agent's** task (no `taskAssigneeId === agent.id` check). This is an *ownership*
  check, distinct from channel access (now enforced), and has a product question — may any channel member
  move a task, or only its assignee/an admin? Decide the policy, then gate `setTaskStatus`/`unclaimTask`.

### Pending — auth primitives
- **C4 [HIGH]** `resolveAgent` does not filter `agents.deletedAt`, and soft-delete does not clear
  `agentTokenHash` → a deleted agent's token keeps working until the next server restart. Add
  `isNull(deletedAt)` to `resolveAgent` **and** null the hash on soft-delete.
- **C10 [LOW]** `auth.ts` token compare uses `===`, not the existing `safeEqual` (timing side-channel,
  largely mitigated by fixed-length hex but not guaranteed). Switch to `safeEqual`.
- **C11 [LOW]** `routes-agent.ts` file comment + the `401` message say "machine key" but the plane uses a
  per-agent token — misleading. (Corrected alongside this PR.)
- **C12 [DESIGN]** agent tokens have no TTL and no revoke endpoint. Consider an `expiresAt` + a rotate/revoke
  path; short-term, C4's hash-clear-on-delete is the main mitigation.

> When you close a roadmap item, move it to "Fixed", update the §5 table if it changes enforcement, and add
> a cross-tenant/cross-channel test. Keep `core-beliefs.md` §4 and `ARCHITECTURE.md` in sync.
