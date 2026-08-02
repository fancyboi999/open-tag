// open-tag backend table definitions (Drizzle / Postgres)
// Field names and semantics are derived from observed /api/* response shapes (see root CLAUDE.md "Data Model").
// All primary keys are uuid. message.seq is a globally monotonic sequence per server (from Redis INCR), driving incremental sync.
import { pgTable, uuid, text, boolean, integer, bigint, jsonb, timestamp, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ── Human users ──────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),         // stable identifier used in @mentions
  displayName: text("display_name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),           // for local login (nullable in PoC)
  gravatarHash: text("gravatar_hash"),
  avatarUrl: text("avatar_url"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Workspace (server) ────────────────────────────────────────
export const servers = pgTable("servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: uuid("owner_id").notNull().references(() => users.id),
  onboardingAgentId: uuid("onboarding_agent_id"),
  avatarUrl: text("avatar_url"),                   // custom workspace avatar; value = /api/attachments/<id>
  hideHumansFromMembers: boolean("hide_humans_from_members").default(false).notNull(),
  plan: text("plan").default("free").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const serverMembers = pgTable("server_members", {
  serverId: uuid("server_id").notNull().references(() => servers.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").default("member").notNull(), // owner | admin | member
  pushMuted: boolean("push_muted").default(false).notNull(), // whether the user has muted push notifications for this server
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId] }) }));

// ── Machine (daemon host / cloud sandbox) ─────────────────────────────
export const machines = pgTable("machines", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  userId: uuid("user_id").notNull().references(() => users.id), // owner
  name: text("name").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),    // hash of sk_machine_* key
  apiKeyPrefix: text("api_key_prefix").notNull(),// display prefix
  runtimes: jsonb("runtimes").$type<string[]>().default([]).notNull(), // ["claude","codex",...]
  hostname: text("hostname"),
  os: text("os"),
  daemonVersion: text("daemon_version"),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }),
  status: text("status").default("offline").notNull(), // online | offline
  isComputer: boolean("is_computer").default(false).notNull(), // false = local daemon, true = cloud sandbox
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byServer: index("machines_server_idx").on(t.serverId) }));

// ── Agent (AI employee) ────────────────────────────────────────
export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),    // also used as the workspace directory name ~/.open-tag/agents/<id>
  serverId: uuid("server_id").notNull().references(() => servers.id),
  machineId: uuid("machine_id").references(() => machines.id), // which machine this agent runs on
  name: text("name").notNull(),                   // @mention identifier
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  description: text("description"),               // role / system prompt seed
  status: text("status").default("inactive").notNull(),   // inactive | starting | active | sleeping | queued
  activity: text("activity").default("offline").notNull(),// offline|online|thinking|working
  sessionId: text("session_id"),                  // current runtime session (used with --resume)
  model: text("model"),                            // model alias or NULL → CLI uses its local default (~/.claude / ~/.codex)
  runtime: text("runtime").default("claude").notNull(),   // claude | codex | copilot | opencode | kimi | pi | cursor | hermes | reasonix (registry: src/daemon/runtimes.ts REG)
  projectPath: text("project_path"),               // canonical absolute cwd on machineId; null = use isolated agent state dir
  runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().default({}).notNull(),
  executionMode: text("execution_mode").default("auto").notNull(),

  envVars: jsonb("env_vars").$type<Record<string, string>>().default({}).notNull(),
  agentTokenHash: text("agent_token_hash"),       // hash of sk_agent_* token (used for CLI auth)
  scopes: jsonb("scopes").$type<{ granted: string[]; mode: "default" | "custom"; revision: number; updatedAt: string }>(), // null = default (all granted); see scopes.ts
  creatorType: text("creator_type").default("user").notNull(),
  creatorId: uuid("creator_id").references(() => users.id), // human creator; used in member profile "Created Agents" section. Null for historical records
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete: keep the row so historical message/DM names stay resolvable by-id
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byServer: index("agents_server_idx").on(t.serverId),
  // A live agent's name is the @mention / DM routing key (core.ts parseMentions/resolveTarget resolve by name),
  // so it must be unique per server — otherwise a same-named agent becomes an unreachable routing blind spot.
  // Partial index excludes soft-deleted rows, so a name frees up after delete and can be reused by a new agent.
  nameUniq: uniqueIndex("agents_name_uniq").on(t.serverId, t.name).where(sql`${t.deletedAt} is null`),
}));

// ── Channel / DM / Thread ───────────────────────────────────────
export const channels = pgTable("channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(),                   // channel | private | dm | thread
  parentMessageId: uuid("parent_message_id"),     // thread = a channel derived from a specific message
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byServer: index("channels_server_idx").on(t.serverId),
  // Partition-scoped uniqueness: prevents concurrent get-or-create from creating duplicate DM / thread channels (only one row per member pair for DMs, one row per parent message for threads).
  dmUniq: uniqueIndex("channels_dm_uniq").on(t.serverId, t.name).where(sql`${t.type} = 'dm'`),
  threadUniq: uniqueIndex("channels_thread_uniq").on(t.serverId, t.parentMessageId).where(sql`${t.type} = 'thread'`),
}));

// Members can be either users or agents; lastReadSeq is used for unread calculation
export const channelMembers = pgTable("channel_members", {
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  memberType: text("member_type").notNull(),      // user | agent
  memberId: uuid("member_id").notNull(),
  lastReadSeq: bigint("last_read_seq", { mode: "number" }).default(0).notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  threadDoneAt: timestamp("thread_done_at", { withTimezone: true }), // per-user thread done mark (thread done → removed from inbox). Always null for non-thread channels
}, (t) => ({ pk: primaryKey({ columns: [t.channelId, t.memberType, t.memberId] }) }));

// A Conversation Turn groups a short burst from one sender in one concrete channel context.
// Visibility remains message-level; dispatch/ownership is claimed once per durable turn.
export const conversationTurns = pgTable("conversation_turns", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  senderType: text("sender_type").notNull(),      // user | agent
  senderId: uuid("sender_id").notNull(),
  anchorMessageId: uuid("anchor_message_id").notNull(),
  triggerMessageId: uuid("trigger_message_id").notNull(),
  latestMessageId: uuid("latest_message_id").notNull(),
  firstSeq: bigint("first_seq", { mode: "number" }).notNull(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull(),
  boundaryKind: text("boundary_kind").default("ambient").notNull(), // ambient | direct | task | action
  state: text("state").default("collecting").notNull(), // collecting | ready | dispatching | active | dispatched | blocked
  dispatchAfter: timestamp("dispatch_after", { withTimezone: true }).notNull(),
  dispatchLeaseUntil: timestamp("dispatch_lease_until", { withTimezone: true }),
  dispatchAttempts: integer("dispatch_attempts").default(0).notNull(),
  ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
  responsibilityState: text("responsibility_state").default("pending").notNull(), // pending | assigned | active | delivered | blocked | completed
  causalRootId: uuid("causal_root_id").notNull(),
  causalDepth: integer("causal_depth").default(0).notNull(),
  agentWakeCount: integer("agent_wake_count").default(0).notNull(),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byDispatch: index("conversation_turns_dispatch_idx").on(t.state, t.dispatchAfter),
  bySenderContext: index("conversation_turns_sender_context_idx").on(t.serverId, t.channelId, t.senderType, t.senderId, t.createdAt),
  collectingUniq: uniqueIndex("conversation_turns_collecting_uniq")
    .on(t.serverId, t.channelId, t.senderType, t.senderId)
    .where(sql`${t.state} = 'collecting'`),
}));

// ── Message (core; message-as-task) ─────────────────────────────────
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull(),       // globally monotonic within server (Redis INCR)
  serverId: uuid("server_id").notNull().references(() => servers.id),
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  senderType: text("sender_type").notNull(),      // user | agent | system
  senderId: uuid("sender_id"),
  senderName: text("sender_name").notNull(),      // denormalized, used for rendering
  messageType: text("message_type").default("text").notNull(), // text | action | system
  content: text("content").notNull(),
  actionMetadata: jsonb("action_metadata"),       // system / platform action payload
  agentActivity: jsonb("agent_activity").$type<{ timestamp: number; kind: string; activity?: string | null; detail?: string | null; text?: string | null; toolName?: string | null; toolInput?: string | null }[]>().default([]).notNull(),
  agentActivityStreamId: text("agent_activity_stream_id"), // reply stream/run that produced this message or receipt
  agentActivityState: text("agent_activity_state"), // running | handled | error
  conversationTurnId: uuid("conversation_turn_id").references(() => conversationTurns.id, { onDelete: "set null" }),
  threadId: uuid("thread_id"),                    // owning thread channel
  // —— Task fields (a message can be promoted to a task) ——
  taskStatus: text("task_status"),                // null | todo | in_progress | in_review | done | closed (claiming is tracked via taskAssigneeId/taskClaimedAt, not status value)
  taskNumber: integer("task_number"),
  taskAssigneeType: text("task_assignee_type"),   // user | agent
  taskAssigneeId: uuid("task_assignee_id"),
  taskClaimedAt: timestamp("task_claimed_at", { withTimezone: true }),
  taskCompletedAt: timestamp("task_completed_at", { withTimezone: true }),
  searchText: text("search_text"),                // source text for full-text search (GIN to_tsvector index to be added later)
  replyToMessageId: uuid("reply_to_message_id"),  // agent reply authorization trigger; null for independent messages
  replyGrantSlot: text("reply_grant_slot"),       // primary | directed | supplemental; paired with replyToMessageId
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  bySeq: index("messages_server_seq_idx").on(t.serverId, t.seq),     // primary index for incremental sync
  byChannel: index("messages_channel_idx").on(t.channelId, t.seq),
  byConversationTurn: index("messages_conversation_turn_idx").on(t.conversationTurnId, t.seq),
  // Agents cite 6-8 char short-id prefixes (core.ts resolveIdOrPrefix does `id::text LIKE 'prefix%'`);
  // the uuid pkey btree can't serve a text-cast prefix match, so without this the lookup is a seq scan.
  idTextPrefix: index("messages_id_text_prefix_idx").using("btree", sql`(${t.id}::text) text_pattern_ops`),
  replySlotUniq: uniqueIndex("messages_reply_slot_budget_uniq").on(t.replyToMessageId, t.replyGrantSlot)
    .where(sql`${t.replyToMessageId} is not null and ${t.replyGrantSlot} in ('primary', 'supplemental')`),
  replyAgentUniq: uniqueIndex("messages_reply_agent_grant_uniq").on(t.replyToMessageId, t.senderId)
    .where(sql`${t.replyToMessageId} is not null and ${t.replyGrantSlot} is not null and ${t.senderId} is not null`),
}));

// Auditable Agent-to-Agent work edges. Duplicate directed edges within one causal root are
// recorded but do not wake the same target repeatedly; the root wake budget is enforced atomically.
export const causalEdges = pgTable("causal_edges", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  rootTurnId: uuid("root_turn_id").notNull().references(() => conversationTurns.id, { onDelete: "cascade" }),
  parentTurnId: uuid("parent_turn_id").notNull().references(() => conversationTurns.id, { onDelete: "cascade" }),
  sourceAgentId: uuid("source_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  depth: integer("depth").notNull(),
  outcome: text("outcome").notNull(), // accepted | duplicate | blocked_budget | blocked_depth
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byRoot: index("causal_edges_root_idx").on(t.rootTurnId, t.createdAt),
  acceptedPairUniq: uniqueIndex("causal_edges_accepted_pair_uniq")
    .on(t.rootTurnId, t.sourceAgentId, t.targetAgentId)
    .where(sql`${t.outcome} = 'accepted'`),
}));

// @mentions: separate table for efficient "messages that mention me = inbox" queries + frontend highlighting
export const messageMentions = pgTable("message_mentions", {
  messageId: uuid("message_id").notNull().references(() => messages.id),
  mentionType: text("mention_type").notNull(),    // user | agent
  mentionId: uuid("mention_id").notNull(),
  mentionName: text("mention_name").notNull(),    // used for rendering
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.mentionType, t.mentionId] }),
  byMention: index("mentions_target_idx").on(t.mentionType, t.mentionId),
}));

// One auditable observe/decide/grant row per agent recipient of an inbound message.
// Slot uniqueness is the reply budget: one primary and one supplemental at most.
// Directed grants are independently bounded by the (messageId, agentId) primary key.
export const agentMessageDecisions = pgTable("agent_message_decisions", {
  messageId: uuid("message_id").notNull().references(() => messages.id),
  agentId: uuid("agent_id").notNull().references(() => agents.id),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  channelId: uuid("channel_id").notNull().references(() => channels.id),
  attention: text("attention").default("ambient").notNull(), // direct | dm | assigned | ambient
  observedAt: timestamp("observed_at", { withTimezone: true }),
  decision: text("decision").default("pending").notNull(), // pending | requested | accepted | no_action | delegated | abstained | denied | published
  reasonCode: text("reason_code"),
  summary: text("summary"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  grantSlot: text("grant_slot"),                 // primary | directed | supplemental
  grantStatus: text("grant_status").default("none").notNull(), // none | reserved | active | publishing | released | consumed
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  delegatedByAgentId: uuid("delegated_by_agent_id").references(() => agents.id),
  replyMessageId: uuid("reply_message_id").references(() => messages.id),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ownerNotifiedAt: timestamp("owner_notified_at", { withTimezone: true }),
  grantNotifiedAt: timestamp("grant_notified_at", { withTimezone: true }),
  // Durable transport admission is separate from reply/publication state. A partial fan-out retry
  // must never send work again to a recipient whose daemon already accepted this Turn.
  deliveryAdmittedAt: timestamp("delivery_admitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.agentId] }),
  byAgent: index("agent_message_decisions_agent_idx").on(t.agentId, t.createdAt),
  slotUniq: uniqueIndex("agent_message_decisions_slot_budget_uniq").on(t.messageId, t.grantSlot)
    .where(sql`${t.grantSlot} in ('primary', 'supplemental') and ${t.grantStatus} in ('reserved', 'active', 'publishing', 'consumed')`),
  replyUniq: uniqueIndex("agent_message_decisions_reply_uniq").on(t.replyMessageId)
    .where(sql`${t.replyMessageId} is not null`),
}));

// Message-grained read receipts are separate from canonical Turn decisions. This lets an agent
// read a stable Turn across pagination/cursor gaps without either repeating or hiding members.
export const agentMessageObservations = pgTable("agent_message_observations", {
  messageId: uuid("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  serverId: uuid("server_id").notNull().references(() => servers.id, { onDelete: "cascade" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.messageId, t.agentId] }),
  byAgent: index("agent_message_observations_agent_idx").on(t.agentId, t.observedAt),
}));

export const reactions = pgTable("reactions", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  memberType: text("member_type").notNull(),
  memberId: uuid("member_id").notNull(),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uniq: uniqueIndex("reactions_uniq").on(t.messageId, t.memberType, t.memberId, t.emoji) }));

export const attachments = pgTable("attachments", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: uuid("message_id").references(() => messages.id), // back-filled after attaching to a message (null before attachment, not shown in files list)
  channelId: uuid("channel_id"),                  // recorded at upload time, used for /channels/:id/files
  serverId: uuid("server_id").notNull().references(() => servers.id),
  uploaderType: text("uploader_type"),            // user | agent
  uploaderId: uuid("uploader_id"),
  filename: text("filename").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  storageKey: text("storage_key").notNull(),      // absolute local server path (MVP; object storage to follow)
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byChannel: index("attachments_channel_idx").on(t.channelId),
  // Same short-id prefix lookup as messages (core.ts resolveIdOrPrefix) — see messages_id_text_prefix_idx.
  idTextPrefix: index("attachments_id_text_prefix_idx").using("btree", sql`(${t.id}::text) text_pattern_ops`),
}));

// ── Reminders / Knowledge base (tables created first, logic to follow) ────────────────────────
export const reminders = pgTable("reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  ownerType: text("owner_type").notNull(),        // user | agent
  ownerId: uuid("owner_id").notNull(),
  channelId: uuid("channel_id").references(() => channels.id),
  content: text("content").notNull(),
  anchorMessageId: uuid("anchor_message_id"),     // anchor message (system reminder is posted in its channel/thread when fired)
  recurrence: text("recurrence"),                 // null = one-time; otherwise interval in seconds (simplified cadence)
  status: text("status").default("scheduled").notNull(), // scheduled | fired | cancelled
  remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byDue: index("reminders_due_idx").on(t.remindAt) }));

export const knowledge = pgTable("knowledge", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  agentId: uuid("agent_id").references(() => agents.id),
  title: text("title").notNull(),
  content: text("content").notNull(),
  searchText: text("search_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Agent activity log (activity-log: status|text|tool_start timeline) ──
export const agentActivityLog = pgTable("agent_activity_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  ts: bigint("ts", { mode: "number" }).notNull(),     // millisecond timestamp
  kind: text("kind").notNull(),                        // status | text | tool_start
  activity: text("activity"),                          // kind=status: online|working|thinking|offline
  detail: text("detail"),
  text: text("text"),                                  // kind=text: model output
  toolName: text("tool_name"),                         // kind=tool_start
  toolInput: text("tool_input"),
  channelId: uuid("channel_id").references(() => channels.id),
  streamId: text("stream_id"),
  runSeq: integer("run_seq"),                         // stable ordering within one reply stream
  messageId: uuid("message_id").references(() => messages.id), // segment owner after a real message/receipt claims the row
}, (t) => ({
  byAgent: index("activity_agent_idx").on(t.agentId, t.ts),
  byStream: index("activity_stream_idx").on(t.agentId, t.streamId, t.runSeq),
  byMessage: index("activity_message_idx").on(t.messageId),
}));

// ── Sidebar preferences (GET/PUT /api/servers/:id/sidebar-order) ──
// One row per user per server: pinned items, sort order, hidden DMs, etc., stored as jsonb.
export const serverSidebarPrefs = pgTable("server_sidebar_prefs", {
  serverId: uuid("server_id").notNull().references(() => servers.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  prefs: jsonb("prefs").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.serverId, t.userId] }) }));

// ── Saved messages / bookmarks (GET/POST /channels/saved + DELETE /channels/saved/:id + POST /channels/saved/check) ──
// Private bookmark semantics: scoped per member, not broadcast to others; createdAt = savedAt.
export const savedMessages = pgTable("saved_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  memberType: text("member_type").notNull(),   // user (primary) | agent (reserved)
  memberId: uuid("member_id").notNull(),
  messageId: uuid("message_id").notNull().references(() => messages.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ uniq: uniqueIndex("saved_messages_uniq").on(t.memberType, t.memberId, t.messageId) }));

// ── Invite join links (POST /servers/:id/join-links) ──────
export const joinLinks = pgTable("join_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => servers.id),
  token: text("token").notNull().unique(),            // URL invite token (sk-style random string)
  createdByUserId: uuid("created_by_user_id").references(() => users.id),
  role: text("role").default("member").notNull(),     // role assigned upon joining (owner-configurable at creation time, defaults to member)
  maxUses: integer("max_uses"),                       // null = unlimited
  useCount: integer("use_count").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // null = never expires
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byServer: index("join_links_server_idx").on(t.serverId) }));
