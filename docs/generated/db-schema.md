# Data Model (db-schema)

> **Source of truth is `src/db/schema.ts` (Drizzle).** This file is a human-readable snapshot; regenerate when schema changes (TODO: add a drizzle introspection script to `package.json`; until then, sync manually).
> All primary keys are UUID; `message.seq` is a globally monotonic sequence number (Redis INCR per server) that drives incremental sync.

| Table | Purpose | Key Fields |
|---|---|---|
| `users` | Human users | name (@-mention unique), displayName, email (unique), passwordHash (scrypt), gravatarHash, avatarUrl |
| `servers` | Workspaces | name, slug (unique), ownerId, onboardingAgentId, hideHumansFromMembers, plan, avatarUrl (workspace custom avatar = /api/attachments/<id>) |
| `server_members` | Human ↔ server | (serverId, userId) PK, role (owner/admin/member), pushMuted |
| `machines` | Daemon hosts / cloud sandboxes | serverId, userId, apiKeyHash (`sk_machine_*`), apiKeyPrefix, runtimes[], hostname/os/daemonVersion, lastHeartbeat, status (online/offline), isComputer |
| `agents` | AI employees | id (= workspace directory name), serverId, machineId, name (@; **per-server unique among live agents** via partial index `agents_name_uniq` `(serverId, name) WHERE deleted_at IS NULL`), displayName, status (inactive/active/sleeping), activity (offline/online/thinking/working), **sessionId** (used for `--resume`), model, runtime (claude/codex/kimi), runtimeConfig, executionMode, envVars, agentTokenHash (`sk_agent_*`), scopes (jsonb, null = default full grant), creatorType, creatorId (human who created; used for member profile "Created Agents"; historical rows null), **deletedAt** (soft-delete: deleting an agent preserves the row; history messages / DM display names remain resolvable by id; lists/DM/inbox queries filter deleted) |
| `channels` | Channels / DMs / threads | serverId, name, type (channel/private/dm/thread), parentMessageId (thread = channel derived from a message), lastMessageAt, archivedAt, deletedAt |
| `channel_members` | user\|agent ↔ channel | (channelId, memberType, memberId) PK, **lastReadSeq** (unread calculation), joinedAt, threadDoneAt (per-user thread "mark done"; null for non-threads) |
| `messages` | Core messages (message = potential task) | **seq** (globally monotonic), serverId, channelId, senderType (user/agent/system), senderId, senderName (denormalized), messageType (text/action/system), content, actionMetadata, threadId; task fields: taskStatus (`null/todo/in_progress/in_review/done/closed`, claim sets assignee/claimedAt not status value), taskNumber (human-readable #N, **scoped**: per-DM for `dm` channels, per-server otherwise; invariant: non-null ⟺ taskStatus non-null), taskAssigneeType/Id, taskClaimedAt, taskCompletedAt; searchText (GIN full-text source) |
| `message_mentions` | Structured @mentions | (messageId, mentionType, mentionId) PK, mentionName; separate table enables "mentioned me = inbox" queries + highlight |
| `reactions` | Emoji reactions | messageId, memberType/Id, emoji; (message, member, emoji) unique |
| `attachments` | File attachments | messageId (back-filled after upload), channelId, serverId, uploaderType/Id, filename, mimeType, sizeBytes, **storageKey** (driver-agnostic) |
| `reminders` | Reminders | serverId, ownerType/Id, channelId, content, anchorMessageId, recurrence (null = one-time / otherwise interval in seconds), status (scheduled/fired/cancelled), remindAt, firedAt |
| `knowledge` | Knowledge base (table created, logic pending) | serverId, agentId, title, content, searchText |
| `agent_activity_log` | Agent activity timeline | serverId, agentId, ts (ms), kind (status/text/tool_start), activity, detail, text, toolName, toolInput |
| `server_sidebar_prefs` | Per-user per-server sidebar preferences | (serverId, userId) PK, prefs (jsonb: pinned/sorted/hidden DMs) |
| `saved_messages` | Saved messages / bookmarks (private, per member) | serverId, memberType/Id, messageId, createdAt (= savedAt); (member, message) unique; not broadcast |
| `join_links` | Workspace invite links | serverId, token (unique, used in URL), createdByUserId, role (role granted on join, default member), maxUses (null = unlimited), useCount, expiresAt (null = permanent) |
