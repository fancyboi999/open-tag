#!/usr/bin/env node
// One-off, idempotent migration: remove the legacy DB-backed showcase demo data after the showcase
// moved to a static front-end page (web/src/views/Showcase.tsx + web/src/showcaseData.ts — zero DB).
//
// Deletes, in one transaction:
//   • every type='showcase' channel + the thread channels derived from its anchor messages
//   • all messages in those channels + their message_mentions / reactions / saved_messages / attachments
//   • every creator_type='system' prop agent (the per-workspace demo cast — Pat/Cody/Alice/…)
// Attachment blobs are removed from object storage on a best-effort basis (local unlink / S3 DeleteObject);
// blob failures only warn — the DB is already consistent once the transaction commits.
//
// Idempotent: a second run finds nothing and reports all zeros.
//
// Usage (reads DATABASE_URL from the env, like the server; or pass it as the first arg):
//   node scripts/drop-showcase.mjs
//   node scripts/drop-showcase.mjs "postgres://user:pass@host:5432/db"
//   set -a && . ./.env.prod && set +a && node scripts/drop-showcase.mjs   # prod env (+ S3 blob cleanup)
import os from "node:os";
import path from "node:path";
import { unlink } from "node:fs/promises";
import postgres from "postgres";

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) {
  console.error("[drop-showcase] DATABASE_URL is required (set the env var or pass it as the first argument)");
  process.exit(1);
}

const sql = postgres(url);

// Mirror src/paths.ts uploadsDir() so local-driver blobs can be located for best-effort deletion.
const uploadsDir = () =>
  process.env.OPEN_TAG_UPLOAD_DIR ??
  path.join(process.env.OPEN_TAG_HOME ?? path.join(os.homedir(), ".open-tag"), "uploads");

/** Best-effort delete one attachment blob from whichever storage backend the server uses (mirrors src/server/storage.ts). */
async function deleteBlob(storageKey) {
  const driver = process.env.OPEN_TAG_STORAGE ?? "local";
  if (driver === "s3") {
    const mod = await import("@aws-sdk/client-s3");
    const client = new mod.S3Client({
      endpoint: process.env.OPEN_TAG_S3_ENDPOINT,
      region: process.env.OPEN_TAG_S3_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.OPEN_TAG_S3_KEY, secretAccessKey: process.env.OPEN_TAG_S3_SECRET },
    });
    await client.send(new mod.DeleteObjectCommand({ Bucket: process.env.OPEN_TAG_S3_BUCKET, Key: storageKey }));
  } else {
    await unlink(path.join(uploadsDir(), storageKey));
  }
}

async function main() {
  const counts = { channels: 0, agents: 0, messages: 0, attachments: 0 };
  let blobKeys = [];

  await sql.begin(async (tx) => {
    // 1. Resolve the full set of channels to drop up-front (as id lists) — showcase channels plus the thread
    //    channels derived from their anchor messages — so later DELETEs never depend on rows already removed.
    const showcaseCh = await tx`SELECT id FROM channels WHERE type = 'showcase'`;
    const showcaseChIds = showcaseCh.map((r) => r.id);

    let threadChIds = [];
    if (showcaseChIds.length) {
      const threadCh = await tx`
        SELECT id FROM channels
        WHERE type = 'thread'
          AND parent_message_id IN (SELECT id FROM messages WHERE channel_id IN ${tx(showcaseChIds)})`;
      threadChIds = threadCh.map((r) => r.id);
    }
    const channelIds = [...showcaseChIds, ...threadChIds];

    if (channelIds.length) {
      const msgs = await tx`SELECT id FROM messages WHERE channel_id IN ${tx(channelIds)}`;
      const messageIds = msgs.map((r) => r.id);

      // Capture blob storage keys before the attachment rows are deleted (blobs are removed after commit).
      const atts = await tx`SELECT storage_key FROM attachments WHERE channel_id IN ${tx(channelIds)}`;
      blobKeys = atts.map((r) => r.storage_key);

      // Delete message-referencing rows (FKs onto messages.id) before the messages themselves.
      if (messageIds.length) {
        await tx`DELETE FROM message_mentions WHERE message_id IN ${tx(messageIds)}`;
        await tx`DELETE FROM reactions       WHERE message_id IN ${tx(messageIds)}`;
        await tx`DELETE FROM saved_messages  WHERE message_id IN ${tx(messageIds)}`;
      }
      counts.attachments = (await tx`DELETE FROM attachments WHERE channel_id IN ${tx(channelIds)}`).count;
      counts.messages = (await tx`DELETE FROM messages WHERE channel_id IN ${tx(channelIds)}`).count;

      // Delete channel-referencing rows (FKs onto channels.id) before the channels themselves.
      await tx`DELETE FROM channel_members WHERE channel_id IN ${tx(channelIds)}`;
      await tx`DELETE FROM reminders       WHERE channel_id IN ${tx(channelIds)}`;
      counts.channels = (await tx`DELETE FROM channels WHERE id IN ${tx(channelIds)}`).count;
    }

    // 2. Drop every system-seeded prop agent (no longer produced once the showcase is static).
    //    Clear its knowledge rows first — knowledge.agent_id is the only FK onto agents.id, so a stray row
    //    (prop agents never run, so in practice they have none) would otherwise roll the whole migration back.
    await tx`DELETE FROM knowledge WHERE agent_id IN (SELECT id FROM agents WHERE creator_type = 'system')`;
    counts.agents = (await tx`DELETE FROM agents WHERE creator_type = 'system'`).count;
  });

  // 3. Best-effort blob cleanup (after commit — failures only warn; the DB is already consistent).
  let blobsDeleted = 0;
  for (const key of blobKeys) {
    try {
      await deleteBlob(key);
      blobsDeleted++;
    } catch (e) {
      console.warn(`[drop-showcase] WARN could not delete blob "${key}": ${e?.message ?? e}`);
    }
  }

  console.log("[drop-showcase] done:");
  console.log(`  channels deleted    : ${counts.channels}`);
  console.log(`  agents deleted      : ${counts.agents}`);
  console.log(`  messages deleted    : ${counts.messages}`);
  console.log(`  attachments deleted : ${counts.attachments} (blobs removed: ${blobsDeleted}/${blobKeys.length})`);

  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
