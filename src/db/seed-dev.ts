// DEV-ONLY fixture: ensure a runnable claude/sonnet agent ("dev-bot") exists in the open-tag
// workspace + #all, for local human↔agent E2E. Idempotent. Never run on production paths.
import "../env.js";
import { db, schema, sql } from "./index.js";
import { and, eq } from "drizzle-orm";

async function main() {
  const { servers, agents, channels, channelMembers } = schema;
  const [server] = await db.select().from(servers).where(eq(servers.slug, "open-tag"));
  if (!server) { console.error("[seed:dev] no 'open-tag' workspace — run `npm run seed` first"); await sql.end(); process.exit(1); }

  const existing = await db.select().from(agents).where(and(eq(agents.serverId, server.id), eq(agents.name, "dev-bot")));
  if (existing.length && !existing[0]!.deletedAt) { console.log("[seed:dev] dev-bot already exists, skipping"); await sql.end(); return; }

  const [bot] = await db.insert(agents).values({
    serverId: server.id, name: "dev-bot", displayName: "Dev Bot",
    description: "Local dev E2E agent — claude/sonnet. Created by `npm run seed:dev`.",
    model: "sonnet", runtime: "claude",
  }).returning();

  const [all] = await db.select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  if (all) await db.insert(channelMembers).values({ channelId: all.id, memberType: "agent", memberId: bot!.id }).onConflictDoNothing();

  console.log(`[seed:dev] created dev-bot (${bot!.id}) in #all`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
