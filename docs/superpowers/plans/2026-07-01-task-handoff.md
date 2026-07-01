# Task Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add agent-to-agent task handoff in `open-tag`, including server mutation, agent API, CLI command, minimal UI, and real E2E verification.

**Architecture:** Extend the existing message-backed task lifecycle in `src/server/core.ts` with a dedicated `assignTask()` mutation, expose it through `/agent-api/task/assign`, mirror it in the CLI, and surface a minimal human-side assign control in existing task UIs. Reuse the current task thread audit trail and daemon wake/deliver path instead of inventing a new workflow layer.

**Tech Stack:** TypeScript, Drizzle/Postgres, ws/socket fan-out, commander CLI, React/Vite UI, shell-driven dev E2E harness

## Global Constraints

- Work only in the isolated `open-tag-task-handoff` worktree.
- Do not modify `nowcrew`.
- Prefer no schema migration and no new table.
- Reuse existing task/message/thread semantics; no bridge code.
- Every behavior change must be documented in `ARCHITECTURE.md` and `FEATURES.md`.
- Verification must include failing tests first, passing tests after, and a real `dev:e2e` run.

---

### Task 1: Add failing tests for server-side task handoff

**Files:**
- Create: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/test/taskAssign.integration.ts`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/src/server/core.ts`

**Interfaces:**
- Consumes: existing `createServer`, `createMessage`, `convertMessageToTask`, `claimTask`, `setTaskStatus`, `getOrCreateThread`
- Produces: failing coverage for `assignTask(serverId: string, messageId: string, assigneeId: string, by?: { type: "user" | "agent"; id: string }): Promise<typeof schema.messages.$inferSelect | null>`

- [ ] **Step 1: Write the failing integration test file**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { createServer, createMessage, convertMessageToTask, claimTask, setTaskStatus, assignTask } from "../src/server/core.js";

async function makeUser(name: string) {
  const [u] = await db.insert(schema.users).values({ name, displayName: name, passwordHash: "x" }).returning();
  return u!;
}

async function makeAgent(serverId: string, name: string) {
  const [a] = await db.insert(schema.agents).values({
    serverId,
    name,
    displayName: name,
    runtime: "claude",
    model: "sonnet",
    creatorType: "user",
    creatorId: null,
  }).returning();
  return a!;
}

async function makeAllChannel(serverId: string) {
  return (await db.select().from(schema.channels).where(and(eq(schema.channels.serverId, serverId), eq(schema.channels.name, "all"))))[0]!;
}

test("assignTask assigns todo task to target agent and moves it to in_progress", async () => {
  const owner = await makeUser(`owner-${randomUUID()}`);
  const srv = await createServer(`srv-${randomUUID()}`, `slug-${randomUUID()}`, owner.id);
  const ch = await makeAllChannel(srv.id);
  const src = await makeAgent(srv.id, `src_${randomUUID().slice(0, 8)}`);
  const dst = await makeAgent(srv.id, `dst_${randomUUID().slice(0, 8)}`);
  const msg = await createMessage({ serverId: srv.id, channelId: ch.id, senderType: "user", senderId: owner.id, senderName: owner.name, content: "handoff me" });
  const task = await convertMessageToTask(srv.id, msg.id, { type: "user", id: owner.id });
  assert.ok(task);

  const assigned = await assignTask(srv.id, task!.id, dst.id, { type: "agent", id: src.id });
  assert.ok(assigned);
  assert.equal(assigned!.taskAssigneeType, "agent");
  assert.equal(assigned!.taskAssigneeId, dst.id);
  assert.equal(assigned!.taskStatus, "in_progress");
});

test("assignTask preserves non-todo status", async () => {
  const owner = await makeUser(`owner-${randomUUID()}`);
  const srv = await createServer(`srv-${randomUUID()}`, `slug-${randomUUID()}`, owner.id);
  const ch = await makeAllChannel(srv.id);
  const src = await makeAgent(srv.id, `src_${randomUUID().slice(0, 8)}`);
  const dst = await makeAgent(srv.id, `dst_${randomUUID().slice(0, 8)}`);
  const msg = await createMessage({ serverId: srv.id, channelId: ch.id, senderType: "user", senderId: owner.id, senderName: owner.name, content: "already reviewing" });
  const task = await convertMessageToTask(srv.id, msg.id, { type: "user", id: owner.id });
  await claimTask(srv.id, task!.id, "agent", src.id);
  await setTaskStatus(srv.id, task!.id, "in_review", { type: "agent", id: src.id });

  const assigned = await assignTask(srv.id, task!.id, dst.id, { type: "agent", id: src.id });
  assert.ok(assigned);
  assert.equal(assigned!.taskStatus, "in_review");
});

test("assignTask writes handoff system message into the task thread and joins assignee", async () => {
  const owner = await makeUser(`owner-${randomUUID()}`);
  const srv = await createServer(`srv-${randomUUID()}`, `slug-${randomUUID()}`, owner.id);
  const ch = await makeAllChannel(srv.id);
  const src = await makeAgent(srv.id, `src_${randomUUID().slice(0, 8)}`);
  const dst = await makeAgent(srv.id, `dst_${randomUUID().slice(0, 8)}`);
  const msg = await createMessage({ serverId: srv.id, channelId: ch.id, senderType: "user", senderId: owner.id, senderName: owner.name, content: "thread me" });
  const task = await convertMessageToTask(srv.id, msg.id, { type: "user", id: owner.id });

  const assigned = await assignTask(srv.id, task!.id, dst.id, { type: "agent", id: src.id });
  assert.ok(assigned?.threadId);

  const systemRows = await db.select().from(schema.messages).where(and(eq(schema.messages.channelId, assigned!.threadId!), eq(schema.messages.senderType, "system"), isNotNull(schema.messages.taskStatus).not ? eq(schema.messages.senderType, "system") : eq(schema.messages.senderType, "system")));
  assert.ok(systemRows.some((m) => m.content.includes("assigned") && m.content.includes(`#${assigned!.taskNumber}`)));

  const member = (await db.select().from(schema.channelMembers).where(and(eq(schema.channelMembers.channelId, assigned!.threadId!), eq(schema.channelMembers.memberType, "agent"), eq(schema.channelMembers.memberId, dst.id))))[0];
  assert.ok(member);
});

test("assignTask rejects missing target agent", async () => {
  const owner = await makeUser(`owner-${randomUUID()}`);
  const srv = await createServer(`srv-${randomUUID()}`, `slug-${randomUUID()}`, owner.id);
  const ch = await makeAllChannel(srv.id);
  const msg = await createMessage({ serverId: srv.id, channelId: ch.id, senderType: "user", senderId: owner.id, senderName: owner.name, content: "fail me" });
  const task = await convertMessageToTask(srv.id, msg.id, { type: "user", id: owner.id });

  const assigned = await assignTask(srv.id, task!.id, randomUUID(), { type: "user", id: owner.id });
  assert.equal(assigned, null);
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `node --test test/taskAssign.integration.ts`
Expected: FAIL with `assignTask` missing from `src/server/core.ts` export or similar unresolved symbol failure.

- [ ] **Step 3: Add the minimal export stub in `src/server/core.ts` to move from import failure to behavior failure**

```ts
export async function assignTask(
  _serverId: string,
  _messageId: string,
  _assigneeId: string,
  _by?: { type: "user" | "agent"; id: string },
) {
  return null;
}
```

- [ ] **Step 4: Re-run the test file to verify semantic failures**

Run: `node --test test/taskAssign.integration.ts`
Expected: FAIL on assertions about assignee, status, thread message, and thread membership.

- [ ] **Step 5: Commit the failing-test setup**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add test/taskAssign.integration.ts src/server/core.ts
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "test: add failing coverage for task handoff"
```

### Task 2: Implement core task assignment semantics

**Files:**
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/src/server/core.ts`
- Test: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/test/taskAssign.integration.ts`

**Interfaces:**
- Consumes: `emitTaskUpdated`, `sysTaskMsg`, `getOrCreateThread`, `agentConfig`, `broadcastToDaemons`
- Produces: `assignTask(serverId, messageId, assigneeId, by?) => updated task | null`

- [ ] **Step 1: Replace the stub with the real `assignTask` implementation**

```ts
export async function assignTask(
  serverId: string,
  messageId: string,
  assigneeId: string,
  by?: { type: "user" | "agent"; id: string },
) {
  const target = (await db.select().from(schema.agents).where(and(eq(schema.agents.id, assigneeId), eq(schema.agents.serverId, serverId), isNull(schema.agents.deletedAt))))[0];
  if (!target) return null;

  const current = (await db.select().from(schema.messages).where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus)))).[0];
  if (!current) return null;

  const nextStatus = current.taskStatus === "todo" ? "in_progress" : current.taskStatus;
  const [upd] = await db.update(schema.messages)
    .set({
      taskStatus: nextStatus,
      taskAssigneeType: "agent",
      taskAssigneeId: assigneeId,
      taskClaimedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.serverId, serverId), isNotNull(schema.messages.taskStatus)))
    .returning();
  if (!upd) return null;

  await emitTaskUpdated(serverId, upd);
  const th = await getOrCreateThread(serverId, upd.id);
  if (!upd.threadId) {
    await db.update(schema.messages).set({ threadId: th.id }).where(eq(schema.messages.id, upd.id));
    upd.threadId = th.id;
  }
  await db.insert(schema.channelMembers).values({ channelId: upd.threadId!, memberType: "agent", memberId: assigneeId }).onConflictDoNothing();

  const actor = by ? await actorName(by.type, by.id) : "Someone";
  const sysMsg = await sysTaskMsg(serverId, upd.threadId!, `${actor} assigned #${upd.taskNumber} "${taskTitle(upd.content)}" to ${target.displayName || target.name}`, by);

  const cfg = await agentConfig(assigneeId);
  if (cfg) {
    broadcastToDaemons(serverId, { type: "agent:start", agentId: assigneeId, config: cfg });
    broadcastToDaemons(serverId, {
      type: "agent:deliver",
      agentId: assigneeId,
      seq: sysMsg.seq,
      from: actor,
      target: upd.threadId!,
      targetName: `task #${upd.taskNumber}`,
      msgShort: sysMsg.id.slice(0, 8),
      isTask: true,
      message: { content: `#${upd.taskNumber} assigned to you` },
      mentioned: true,
    });
  }

  return upd;
}
```

- [ ] **Step 2: Fix any compile/runtime issues in the test caused by the real implementation**

Run: `node --test test/taskAssign.integration.ts`
Expected: either green or a smaller set of assertion failures around system-message lookup or exact copy.

- [ ] **Step 3: Tighten the test to assert the actual system-message shape**

```ts
const systemRows = await db.select().from(schema.messages).where(and(
  eq(schema.messages.channelId, assigned!.threadId!),
  eq(schema.messages.senderType, "system"),
));
assert.ok(systemRows.some((m) => m.content.includes("assigned") && m.content.includes(dst.displayName || dst.name)));
```

- [ ] **Step 4: Re-run the test file to verify the core behavior passes**

Run: `node --test test/taskAssign.integration.ts`
Expected: PASS for all assignment semantics.

- [ ] **Step 5: Commit the core implementation**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add src/server/core.ts test/taskAssign.integration.ts
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "feat: implement task handoff core flow"
```

### Task 3: Add failing agent-route coverage for `/agent-api/task/assign`

**Files:**
- Create: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/test/taskAssignAgent.integration.ts`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/src/server/routes-agent.ts`

**Interfaces:**
- Consumes: `resolveMessageId`, `assignTask`, `findTaskByNumber`-style existing route logic
- Produces: `/agent-api/task/assign` supporting `messageId` or `channel + number`, plus `to`

- [ ] **Step 1: Write the failing agent-route integration test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { db, schema } from "../src/db/index.js";
import { handleAgentApi } from "../src/server/routes-agent.js";
import { createServer, createMessage, convertMessageToTask } from "../src/server/core.js";
import { hashToken } from "../src/server/auth.js";

function mkReq(path: string, token: string, agentId: string, body?: unknown) {
  const raw = body ? JSON.stringify(body) : "";
  const readable = Readable.from(raw ? [Buffer.from(raw)] : []);
  return Object.assign(readable, {
    method: "POST",
    url: path,
    headers: {
      authorization: `Bearer ${token}`,
      "x-agent-id": agentId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

async function run(path: string, token: string, agentId: string, body?: unknown) {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(c: number) { status = c; this.statusCode = c; },
    end(d?: string | Buffer) { raw = d ? String(d) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  await handleAgentApi(mkReq(path, token, agentId, body), res, new URL(`http://localhost${path}`), "POST");
  await EventEmitter.once(emitter, "finish");
  return { status, body: raw ? JSON.parse(raw) : {} };
}

test("agent-api task assign works by message id and by channel+number", async () => {
  const [owner] = await db.insert(schema.users).values({ name: `owner_${randomUUID().slice(0, 8)}`, displayName: "owner", passwordHash: "x" }).returning();
  const srv = await createServer(`srv-${randomUUID()}`, `slug-${randomUUID()}`, owner!.id);
  const ch = (await db.select().from(schema.channels).where(eq(schema.channels.serverId, srv.id)))[0]!;
  const rawA = `sk_agent_${randomUUID().replace(/-/g, "")}`;
  const rawB = `sk_agent_${randomUUID().replace(/-/g, "")}`;
  const [a] = await db.insert(schema.agents).values({ serverId: srv.id, name: `a_${randomUUID().slice(0, 6)}`, displayName: "A", runtime: "claude", model: "sonnet", agentTokenHash: hashToken(rawA), creatorType: "user", creatorId: owner!.id }).returning();
  const [b] = await db.insert(schema.agents).values({ serverId: srv.id, name: `b_${randomUUID().slice(0, 6)}`, displayName: "B", runtime: "claude", model: "sonnet", agentTokenHash: hashToken(rawB), creatorType: "user", creatorId: owner!.id }).returning();
  await db.insert(schema.channelMembers).values([{ channelId: ch.id, memberType: "agent", memberId: a!.id }, { channelId: ch.id, memberType: "agent", memberId: b!.id }]).onConflictDoNothing();

  const msg = await createMessage({ serverId: srv.id, channelId: ch.id, senderType: "user", senderId: owner!.id, senderName: owner!.name, content: "assign me" });
  const task = await convertMessageToTask(srv.id, msg.id, { type: "user", id: owner!.id });

  const byId = await run("/agent-api/task/assign", rawA, a!.id, { messageId: task!.id, to: `@${b!.name}` });
  assert.equal(byId.status, 200);

  const byNumber = await run("/agent-api/task/assign", rawA, a!.id, { channel: "#all", number: task!.taskNumber, to: b!.name });
  assert.equal(byNumber.status, 200);
});
```

- [ ] **Step 2: Run the route test to verify it fails**

Run: `node --test test/taskAssignAgent.integration.ts`
Expected: FAIL with `/agent-api/task/assign` not found or returning 404.

- [ ] **Step 3: Add a route stub in `src/server/routes-agent.ts`**

```ts
if (p === "/agent-api/task/assign" && method === "POST") {
  return (sendErr(res, 404, "not implemented"), true);
}
```

- [ ] **Step 4: Re-run the route test to verify the endpoint is now the failing surface**

Run: `node --test test/taskAssignAgent.integration.ts`
Expected: FAIL on status assertions expecting `200`.

- [ ] **Step 5: Commit the failing route coverage**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add test/taskAssignAgent.integration.ts src/server/routes-agent.ts
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "test: add failing agent-api handoff coverage"
```

### Task 4: Implement agent API and CLI task assign

**Files:**
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/src/server/routes-agent.ts`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/src/cli/index.ts`
- Test: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/test/taskAssignAgent.integration.ts`

**Interfaces:**
- Consumes: `assignTask`, existing `findTaskByNumber` route logic, CLI `api()` helper
- Produces: `/agent-api/task/assign` and `open-tag task assign`

- [ ] **Step 1: Wire `assignTask` into `src/server/routes-agent.ts` imports and scope map**

```ts
import { createMessage, resolveTarget, channelMembers, addChannelMembers, addReaction, removeReaction, getOrCreateThread, unclaimTask, claimTask, setTaskStatus, convertMessageToTask, TASK_STATUSES, resolveMessageId, canAgentReadChannel, descTooLong, DESC_TOO_LONG, assignTask } from "./core.js";
```

```ts
if (p === "/agent-api/task/claim" || p === "/agent-api/task/update" || p === "/agent-api/task/new" || p === "/agent-api/task/assign") return "task:write";
```

- [ ] **Step 2: Replace the route stub with the real assignment route**

```ts
if (p === "/agent-api/task/assign" && method === "POST") {
  const b = await readJson(req);
  const to = String(b.to ?? "").trim().replace(/^@/, "");
  if (!to) return (sendErr(res, 400, "to required"), true);
  const targetAgent = (await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, serverId), eq(schema.agents.name, to), isNull(schema.agents.deletedAt))))[0];
  if (!targetAgent) return (sendErr(res, 404, "target agent not found"), true);

  let taskMsg: typeof schema.messages.$inferSelect | undefined;
  if (b.number != null && b.channel) {
    const tgt = await resolveTarget(serverId, String(b.channel), agent.id);
    if (!tgt) return (sendErr(res, 404, "channel not found"), true);
    taskMsg = (await db.select().from(schema.messages).where(and(eq(schema.messages.serverId, serverId), eq(schema.messages.channelId, tgt.channelId), eq(schema.messages.taskNumber, Number(b.number)))))[0];
  } else {
    const mid = await resolveMessageId(serverId, b.messageId, agent.id);
    if (!mid) return (sendErr(res, 404, "message not found"), true);
    taskMsg = (await db.select().from(schema.messages).where(eq(schema.messages.id, mid)))[0];
  }
  if (!taskMsg?.taskStatus) return (sendErr(res, 404, "task not found"), true);

  const assigned = await assignTask(serverId, taskMsg.id, targetAgent.id, { type: "agent", id: agent.id });
  if (!assigned) return (sendErr(res, 404, "task not found"), true);
  const threadTarget = assigned.threadId ? `${await addressableTarget((await db.select().from(schema.channels).where(eq(schema.channels.id, assigned.channelId)))[0]!, agent.id)}:${assigned.id.slice(0, 8)}` : null;
  return (sendJson(res, 200, { ok: true, assigned: assigned.id, number: assigned.taskNumber, to: targetAgent.name, followUp: threadTarget ? `Follow up in the task's thread: open-tag message send --target "${threadTarget}"` : null }), true);
}
```

- [ ] **Step 3: Add the CLI command in `src/cli/index.ts`**

```ts
task.command("assign").description("hand off a task to another agent")
  .option("--message-id <id>")
  .option("--channel <ch>", "#name / dm:@name (used with --number)")
  .option("--number <n>", "task number #N")
  .requiredOption("--to <agent>", "@agent handle")
  .action(async (opts) => {
    const body: Record<string, unknown> = { to: opts.to };
    if (opts.number != null) { body.channel = opts.channel; body.number = Number(opts.number); }
    else body.messageId = opts.messageId;
    const d = await api("POST", "/agent-api/task/assign", body);
    console.log(`Assigned task #${d.number ?? "?"} -> @${d.to}`);
    if (d.followUp) console.log(d.followUp);
  });
```

- [ ] **Step 4: Re-run the route tests to verify they pass**

Run: `node --test test/taskAssignAgent.integration.ts`
Expected: PASS for message-id and channel+number assignment flows.

- [ ] **Step 5: Re-run the CLI help surface to verify the command exists**

Run: `node src/cli/index.ts task --help`
Expected: help output includes `assign`.

- [ ] **Step 6: Commit the agent API + CLI implementation**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add src/server/routes-agent.ts src/cli/index.ts test/taskAssignAgent.integration.ts
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "feat: add agent task handoff api and cli"
```

### Task 5: Add minimal UI handoff affordance

**Files:**
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/web/src/TaskBoard.tsx`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/web/src/views/Chat.tsx`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/web/src/i18n.ts`

**Interfaces:**
- Consumes: existing `agents`, `api`, task message data, owner/admin role signal
- Produces: a minimal assign picker in existing task surfaces

- [ ] **Step 1: Add a shared local helper for eligible assignee agents in `TaskBoard.tsx`**

```ts
const liveAgents = agents
  .filter((a) => a.status !== "inactive")
  .map((a) => ({ value: a.id, label: `@${a.displayName || a.name}` }));
```

- [ ] **Step 2: Add assign controls to task board cards/list rows for admins**

```tsx
{manageServer && liveAgents.length > 0 && (
  <Select
    ariaLabel={t("tasks.assignTo")}
    value=""
    onChange={(id) => { if (id) void api("POST", "/agent-api/task/assign", { messageId: task.id, to: agents.find((a) => a.id === id)?.name }); }}
    options={[{ value: "", label: t("tasks.assignTo") }, ...liveAgents]}
  />
)}
```

- [ ] **Step 3: Add a compact assign entry in the chat task-pill menu**

```tsx
{manageServer && agents.filter((a) => a.id !== m.taskAssigneeId).length > 0 && (
  <div className="st-assign">
    {agents.filter((a) => a.id !== m.taskAssigneeId).map((a) => (
      <button key={a.id} onClick={() => { setTaskMenu(null); void api("POST", "/agent-api/task/assign", { messageId: m.id, to: a.name }); }}>
        {t("chat.assignToAgent", { name: a.displayName || a.name })}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Add the needed copy strings**

```ts
tasks: {
  assignTo: "Assign to agent",
},
chat: {
  assignToAgent: "Assign to @{{name}}",
},
```

- [ ] **Step 5: Run typecheck to verify the UI compiles**

Run: `npm run typecheck`
Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit the minimal UI affordance**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add web/src/TaskBoard.tsx web/src/views/Chat.tsx web/src/i18n.ts
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "feat: add task handoff controls to existing ui"
```

### Task 6: Update docs and run full verification

**Files:**
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/ARCHITECTURE.md`
- Modify: `/Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff/FEATURES.md`

**Interfaces:**
- Consumes: implemented route/core/CLI/UI behavior
- Produces: synced architecture + feature docs and verification evidence

- [ ] **Step 1: Update `ARCHITECTURE.md` codemap and task lifecycle notes**

```md
- `routes-agent.ts` — agent data plane now includes `task/assign` for agent-to-agent handoff.
- `core.ts` — task lifecycle includes claim / assign / unclaim / status; assign writes thread audit and wakes the assignee.
```

- [ ] **Step 2: Update `FEATURES.md` task collaboration coverage**

```md
- [x] Agent-to-agent task handoff: existing task assigned to another agent, recorded in thread, assignee auto-woken
```

- [ ] **Step 3: Run the targeted automated checks**

Run:

```bash
cd /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff
node --test test/taskAssign.integration.ts
node --test test/taskAssignAgent.integration.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 4: Bring up the real isolated E2E stack**

Run:

```bash
cd /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff
npm run dev:e2e:up
```

Expected: server up, daemon up, login URL printed, `@dev-bot` seeded.

- [ ] **Step 5: Exercise the real handoff channel**

Run a real command sequence against the live stack after creating a second agent in the UI:

```bash
cd /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff
OPEN_TAG_SERVER_URL=http://localhost:7801 OPEN_TAG_AGENT_ID=<assigner-id> OPEN_TAG_AGENT_TOKEN=<assigner-token> node src/cli/index.ts task assign --channel "#all" --number 1 --to @<assignee-name>
```

Expected: CLI prints `Assigned task #1 -> @...` and a follow-up thread target.

- [ ] **Step 6: Verify in a real browser**

Open: `http://localhost:7801/?as=you`

Check:

- task assignee changed in board/chat UI
- task thread shows handoff system message
- assignee agent shows wake/activity evidence or replies in thread

Capture before/after screenshots into `.shots/`.

- [ ] **Step 7: Tear down the E2E stack**

Run:

```bash
cd /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff
npm run dev:e2e:down
```

Expected: background server/daemon stopped cleanly.

- [ ] **Step 8: Commit doc sync and verification-driven adjustments**

```bash
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff add ARCHITECTURE.md FEATURES.md
git -C /Users/nowcoder/Desktop/auto-code-work/open-tag-task-handoff commit -m "docs: sync task handoff architecture and feature docs"
```
