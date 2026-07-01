# Task Handoff Design

## Goal

Add first-class task handoff in `open-tag` so one agent can assign an existing task to another agent, with the change reflected in task state, recorded in the task thread, and delivered to the assignee through the existing daemon wake path.

## Why This Slice

`open-tag` already supports task creation, claiming, status transitions, thread follow-up, and agent wake delivery. What it lacks is a durable handoff primitive between agents. Without handoff, the product has multiple agents in one workspace, but not a reliable multi-agent execution chain.

This slice is intentionally narrow:

- agent assigns task to another **agent**
- uses the existing task/message/thread model
- uses the existing daemon wake + deliver flow
- avoids new tables or a separate workflow engine

It does **not** try to solve all actor combinations, approval policies, or queue scheduling in one shot.

## Existing Constraints

- `src/server/core.ts` is the canonical place for task lifecycle mutations (`convertMessageToTask`, `claimTask`, `unclaimTask`, `setTaskStatus`).
- Task audit messages already exist and are represented as `senderType=system` messages.
- A task's durable collaboration surface is its thread; task state changes already emit system messages there in `setTaskStatus()`.
- Agent APIs currently support `task/list`, `task/claim`, `task/update`, `task/new`, and `task/unclaim`, but not assignment.
- The CLI mirrors the agent API surface directly.
- The UI already renders assignee information in the task board and message task pill, so the core data shape is already present.

## Recommended Approach

Implement task handoff as a new task lifecycle mutation built on the existing message-backed task model.

### Server Core

Add `assignTask(serverId, messageId, assigneeId, by)` to `src/server/core.ts`.

Behavior:

1. Resolve the task message by id and verify it is already a task.
2. Resolve the target assignee as a live agent in the same server.
3. Atomically update:
   - `taskAssigneeType = "agent"`
   - `taskAssigneeId = <target>`
   - `taskClaimedAt = now`
   - `taskStatus = "in_progress"` when current status is `todo`; otherwise preserve current non-null status
4. Publish `task.updated`.
5. Ensure the task has a thread and ensure the new assignee is a thread member.
6. Write a system thread message describing the handoff.
7. Wake + deliver to the assignee using the same `broadcastToDaemons(... agent:start / agent:deliver ...)` path already used by `setTaskStatus()`.

The mutation should be idempotent enough for retries:

- assigning to the same agent should succeed without duplicating state transitions
- assigning a non-task should fail
- assigning to a missing or deleted agent should fail

### Agent API

Add `/agent-api/task/assign` in `src/server/routes-agent.ts`.

Input forms should mirror existing claim/update ergonomics:

- `{ messageId, to }`
- `{ channel, number, to }`

`to` should accept `@name` or bare `name`, because that matches how agents think and how the CLI already refers to peers.

The response should include:

- `ok`
- `number`
- `assigned`
- `to`
- `followUp`

`followUp` should point the assigning agent back to the task thread, matching the existing claim flow guidance.

### CLI

Add `open-tag task assign` in `src/cli/index.ts`.

Supported forms:

- `open-tag task assign --message-id <id> --to @agent`
- `open-tag task assign --channel <target> --number <n> --to @agent`

This keeps the command model consistent with `task claim` and `task update`.

### UI

Add a minimal human-side handoff affordance instead of inventing a brand-new task details workflow.

Scope:

- task board card / list rows: add a small assign control for owner/admin
- message task pill menu: add assign for owner/admin

The UI should use the already-loaded workspace `agents` list and only offer live, non-deleted agents.

This first slice does not need a fancy search dialog. A lightweight inline picker / small menu is enough, because the product value is the backend and runtime close loop, not UI ornament.

## Rejected Alternatives

### Full generalized handoff engine

Rejected for now. It would pull in human↔agent handoff semantics, approval policies, notifications, and likely new schema. That is a larger product slice and would dilute verification.

### UI-only assignee editing

Rejected. It would change visible assignee state without guaranteeing thread membership, audit messages, or daemon wake delivery. That would create a shallow affordance rather than a real collaboration primitive.

### New handoff table

Rejected. The current task/message/thread model is already expressive enough. A new table would add migration and lifecycle complexity without proving additional user value in the first slice.

## Data Flow

1. Agent A runs `open-tag task assign ... --to @agent-b`.
2. CLI calls `/agent-api/task/assign`.
3. Route resolves task and assignee, then calls `assignTask(...)`.
4. `assignTask` updates the task row, emits `task.updated`, and writes a system message into the task thread.
5. Server ensures Agent B is a member of the task thread.
6. Server wakes Agent B and delivers the handoff message to the task thread target.
7. Web clients reflect the new assignee through existing task/message realtime updates.

## Error Handling

- unknown task → `404`
- non-task message → `404` or task-specific error, consistent with current agent task endpoints
- unknown/deleted target agent → `404`
- target agent in another server → `404`
- invalid `to` syntax or missing target → `400`

No silent fallback to claim or status update.

## Testing Strategy

### Automated

- core-level integration:
  - assign updates assignee
  - assign moves `todo` to `in_progress`
  - assign preserves non-todo status
  - assign writes thread system message
  - assign adds assignee to thread members
  - assign rejects missing target agent
- route integration:
  - `/agent-api/task/assign` by message id
  - `/agent-api/task/assign` by `channel + number`
  - invalid target / missing task / non-task cases
- CLI surface:
  - command parses and hits the new endpoint correctly

### Real-run

Use the isolated worktree dev E2E stack:

1. `npm run dev:e2e:up`
2. bring up at least two agents
3. create/claim a real task
4. assign it from one agent to another
5. verify:
   - UI assignee changed
   - task thread shows handoff system message
   - assignee agent receives wake/delivery evidence in logs and/or thread reply

## Docs To Update

- `ARCHITECTURE.md` task/agent-api codemap
- `FEATURES.md` task collaboration coverage

## Out of Scope

- assigning to human members
- queue-based reassignment / orphan recovery
- permission model redesign
- batch handoff
- a full task detail page
