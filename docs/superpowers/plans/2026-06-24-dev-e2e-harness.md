# Per-worktree on-demand dev E2E harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a developer or coding agent bring up, on demand, a fully isolated workspace with a real runnable `claude`/`sonnet` agent for end-to-end human↔agent verification, with zero collision across parallel worktrees.

**Architecture:** Build on the existing `wt:add` (which already isolates DB + ports + redis + `.env`). Add a single `OPEN_TAG_HOME` env so the daemon/agent data dir is per-worktree; an idempotent `seed:dev` that ensures a `claude`/`sonnet` agent; and on-demand `dev:e2e:up`/`:down` scripts that start server+daemon and verify readiness. AGENTS.md tells the coding agent when to use it.

**Tech Stack:** TypeScript (Node 20+, tsx), drizzle-orm + postgres, bash scripts, socket.io, `node:test`.

## Global Constraints

- Default behavior unchanged: with no `OPEN_TAG_HOME` set, every path resolves to `~/.open-tag/...` exactly as today (prod/existing setups unaffected).
- `seed:dev` is a DEV-ONLY fixture; it must never run on production paths and must be idempotent.
- Single source of truth for paths: `src/paths.ts`. Existing `OPEN_TAG_LOG_DIR` / `OPEN_TAG_UPLOAD_DIR` overrides keep working and take precedence over the `OPEN_TAG_HOME`-derived default.
- Invocation is plain `npm run` scripts (agent-agnostic), never auto-triggered.
- `claude` CLI + credentials are assumed present on the dev host; absence must fail loud, never seed a dead agent silently.

---

## File Structure

- Create `src/paths.ts` — resolves `OPEN_TAG_HOME` and all derived dirs (one responsibility: path resolution).
- Create `test/paths.unit.test.ts` — unit tests for path resolution (default + override).
- Modify `src/daemon/agentManager.ts`, `src/daemon/workspace.ts`, `src/daemon/openTagBin.ts`, `src/daemon/index.ts`, `src/log.ts`, `src/server/storage.ts` — source dirs from `src/paths.ts`.
- Create `src/db/seed-dev.ts` — idempotent dev agent fixture.
- Create `scripts/dev-e2e-up.sh`, `scripts/dev-e2e-down.sh` — on-demand stack lifecycle.
- Modify `scripts/wt-add.sh`, `scripts/wt-rm.sh` — per-worktree data-dir isolation + teardown.
- Modify `package.json` — add `seed:dev`, `dev:e2e:up`, `dev:e2e:down`.
- Modify `AGENTS.md` — dev E2E guidance.

---

## Task 1: `OPEN_TAG_HOME` path module + wire all consumers

**Files:**
- Create: `src/paths.ts`
- Test: `test/paths.unit.test.ts`
- Modify: `src/daemon/agentManager.ts:11-12`, `src/daemon/workspace.ts:8`, `src/daemon/openTagBin.ts:9`, `src/daemon/index.ts:31`, `src/log.ts:7`, `src/server/storage.ts:12`

**Interfaces:**
- Produces: `openTagHome(): string`, `agentsDir(): string`, `binDir(): string`, `machineIdFile(): string`, `logsDir(): string`, `uploadsDir(): string` — all read `process.env` on each call so env loaded via `env.ts` before first call is honored, and tests can toggle env between calls.

- [ ] **Step 1: Write the failing test** — `test/paths.unit.test.ts`

```ts
// Run: npx tsx --test --test-force-exit test/paths.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import * as p from "../src/paths.ts";

test("defaults to ~/.open-tag when OPEN_TAG_HOME is unset", () => {
  delete process.env.OPEN_TAG_HOME;
  delete process.env.OPEN_TAG_LOG_DIR;
  delete process.env.OPEN_TAG_UPLOAD_DIR;
  const home = path.join(os.homedir(), ".open-tag");
  assert.equal(p.openTagHome(), home);
  assert.equal(p.agentsDir(), path.join(home, "agents"));
  assert.equal(p.binDir(), path.join(home, "bin"));
  assert.equal(p.machineIdFile(), path.join(home, "machine-id"));
  assert.equal(p.logsDir(), path.join(home, "logs"));
  assert.equal(p.uploadsDir(), path.join(home, "uploads"));
});

test("OPEN_TAG_HOME relocates every derived dir", () => {
  process.env.OPEN_TAG_HOME = "/tmp/ot-wtX";
  delete process.env.OPEN_TAG_LOG_DIR;
  delete process.env.OPEN_TAG_UPLOAD_DIR;
  assert.equal(p.agentsDir(), "/tmp/ot-wtX/agents");
  assert.equal(p.binDir(), "/tmp/ot-wtX/bin");
  assert.equal(p.machineIdFile(), "/tmp/ot-wtX/machine-id");
  assert.equal(p.logsDir(), "/tmp/ot-wtX/logs");
  assert.equal(p.uploadsDir(), "/tmp/ot-wtX/uploads");
});

test("legacy OPEN_TAG_LOG_DIR / OPEN_TAG_UPLOAD_DIR still win", () => {
  process.env.OPEN_TAG_HOME = "/tmp/ot-wtX";
  process.env.OPEN_TAG_LOG_DIR = "/var/log/ot";
  process.env.OPEN_TAG_UPLOAD_DIR = "/var/up/ot";
  assert.equal(p.logsDir(), "/var/log/ot");
  assert.equal(p.uploadsDir(), "/var/up/ot");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test --test-force-exit test/paths.unit.test.ts`
Expected: FAIL — cannot find module `../src/paths.ts`.

- [ ] **Step 3: Create `src/paths.ts`**

```ts
// Single source of truth for on-disk locations. OPEN_TAG_HOME (default ~/.open-tag) lets each
// worktree/dev environment use its own data dir so parallel daemons/agents never collide.
// Read on each call so env loaded by env.ts (before first use) is honored, and tests can toggle it.
import os from "node:os";
import path from "node:path";

export const openTagHome = (): string => process.env.OPEN_TAG_HOME ?? path.join(os.homedir(), ".open-tag");
export const agentsDir = (): string => path.join(openTagHome(), "agents");
export const binDir = (): string => path.join(openTagHome(), "bin");
export const machineIdFile = (): string => path.join(openTagHome(), "machine-id");
// Legacy specific overrides keep precedence over the HOME-derived default (back-compat).
export const logsDir = (): string => process.env.OPEN_TAG_LOG_DIR ?? path.join(openTagHome(), "logs");
export const uploadsDir = (): string => process.env.OPEN_TAG_UPLOAD_DIR ?? path.join(openTagHome(), "uploads");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test --test-force-exit test/paths.unit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the six consumers**

`src/daemon/agentManager.ts` — replace the hardcoded `DATA_DIR`:
```ts
// remove: const DATA_DIR = path.join(os.homedir(), ".open-tag", "agents");
import { agentsDir } from "../paths.js";
const DATA_DIR = agentsDir();
```
`src/daemon/workspace.ts` — same:
```ts
// remove: const DATA_DIR = path.join(os.homedir(), ".open-tag", "agents");
import { agentsDir } from "../paths.js";
const DATA_DIR = agentsDir();
```
`src/daemon/openTagBin.ts` — replace `path.join(os.homedir(), ".open-tag", "bin")` with `binDir()` (add `import { binDir } from "../paths.js";`).
`src/daemon/index.ts` — replace `const MID_FILE = path.join(os.homedir(), ".open-tag", "machine-id");` with `import { machineIdFile } from "../paths.js"; const MID_FILE = machineIdFile();`.
`src/log.ts` — replace `const LOG_DIR = process.env.OPEN_TAG_LOG_DIR ?? path.join(os.homedir(), ".open-tag", "logs");` with `import { logsDir } from "./paths.js"; const LOG_DIR = logsDir();`.
`src/server/storage.ts` — replace `const LOCAL_DIR = process.env.OPEN_TAG_UPLOAD_DIR ?? path.join(os.homedir(), ".open-tag", "uploads");` with `import { uploadsDir } from "../paths.js"; const LOCAL_DIR = uploadsDir();`.

Remove now-unused `os`/`path` imports only if they become unused (check each file; several still use `path`/`os` elsewhere — leave those).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit` → Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/paths.ts test/paths.unit.test.ts src/daemon/agentManager.ts src/daemon/workspace.ts src/daemon/openTagBin.ts src/daemon/index.ts src/log.ts src/server/storage.ts
git commit -m "feat(paths): OPEN_TAG_HOME so daemon/agent data dir is per-worktree isolatable"
```

---

## Task 2: `seed:dev` dev agent fixture

**Files:**
- Create: `src/db/seed-dev.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `schema` from `src/db/index.ts`; the `open-tag` workspace + `#all` channel created by `npm run seed`.
- Produces: an agent row `name="dev-bot"`, `runtime="claude"`, `model="sonnet"` in the `open-tag` server, joined to `#all`. Idempotent (skip if present).

- [ ] **Step 1: Create `src/db/seed-dev.ts`**

```ts
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
```

- [ ] **Step 2: Add npm scripts** — `package.json`, in `"scripts"`:

```json
"seed:dev": "tsx src/db/seed-dev.ts",
```

- [ ] **Step 3: Verify against a scratch DB (integration)**

Run (from a worktree whose `.env` points at its own DB, after `npm run db:push && npm run seed`):
```bash
npm run seed:dev          # → "created dev-bot (...) in #all"
npm run seed:dev          # → "dev-bot already exists, skipping"  (idempotent)
```
Expected: first run creates, second run is a no-op.

- [ ] **Step 4: Commit**

```bash
git add src/db/seed-dev.ts package.json
git commit -m "feat(seed): seed:dev — idempotent claude/sonnet dev-bot fixture for E2E"
```

---

## Task 3: wt:add / wt:rm per-worktree data-dir isolation + teardown

**Files:**
- Modify: `scripts/wt-add.sh` (the `.env` heredoc)
- Modify: `scripts/wt-rm.sh` (teardown)

**Interfaces:**
- Produces: each worktree `.env` now carries `OPEN_TAG_HOME=$HOME/.open-tag-<safe>` and `ALLOW_DEV_LOGIN=true`; `wt:rm` removes that data dir and drops the DB.

- [ ] **Step 1: Extend the `wt-add.sh` `.env` heredoc**

Add two lines to the generated `.env` (after `DAEMON_BOOTSTRAP_KEY=poc-secret-key`):
```bash
OPEN_TAG_HOME=$HOME/.open-tag-$SAFE
ALLOW_DEV_LOGIN=true
```
(`$SAFE` is already computed in the script as the sanitized name.)

- [ ] **Step 2: Extend `wt-rm.sh` teardown**

After `git worktree remove "$WT" --force`, add (replacing the "kept / to clean up" notice with real cleanup):
```bash
SAFE="${NAME//[^a-zA-Z0-9]/_}"
rm -rf "$HOME/.open-tag-$SAFE" && echo "  removed data dir ~/.open-tag-$SAFE"
docker compose exec -T postgres dropdb -U opentag "opentag_$SAFE" 2>/dev/null && echo "  dropped db opentag_$SAFE" || echo "  (db opentag_$SAFE not found / already dropped)"
echo "  branch feature/$NAME kept — remove with: git branch -D feature/$NAME"
```

- [ ] **Step 3: Verify**

```bash
npm run wt:add -- e2etmp
grep -E "OPEN_TAG_HOME|ALLOW_DEV_LOGIN" ../open-tag-e2etmp/.env   # both present
npm run wt:rm -- e2etmp                                            # removes worktree + data dir + db
ls -d ~/.open-tag-e2etmp 2>/dev/null || echo "data dir gone ✓"
```
Expected: `.env` has both lines; after `wt:rm`, the worktree, `~/.open-tag-e2etmp`, and `opentag_e2etmp` are gone.

- [ ] **Step 4: Commit**

```bash
git add scripts/wt-add.sh scripts/wt-rm.sh
git commit -m "feat(wt): per-worktree OPEN_TAG_HOME + dev-login; wt:rm cleans data dir + db"
```

---

## Task 4: on-demand `dev:e2e:up` / `dev:e2e:down`

**Files:**
- Create: `scripts/dev-e2e-up.sh`, `scripts/dev-e2e-down.sh`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: the current worktree `.env` (PORT, DATABASE_URL, OPEN_TAG_HOME, DAEMON_BOOTSTRAP_KEY); `npm run seed`, `npm run seed:dev`, `npm run build --prefix web`.
- Produces: background `server` + `daemon` for this worktree, a registered online machine, a seeded `dev-bot`; prints the dev-login URL.

- [ ] **Step 1: Create `scripts/dev-e2e-up.sh`**

```bash
#!/usr/bin/env bash
# Bring up an isolated, on-demand dev E2E stack for THIS worktree: server + daemon + dev-bot agent.
# Server serves the built web/dist on PORT, so no separate vite process is needed for browser E2E.
# Usage: npm run dev:e2e:up
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd) — run from a worktree created by 'npm run wt:add'"; exit 1; }
PORT=$(grep -E "^PORT=" .env | cut -d= -f2)
KEY=$(grep -E "^DAEMON_BOOTSTRAP_KEY=" .env | cut -d= -f2)
HOME_DIR=$(grep -E "^OPEN_TAG_HOME=" .env | cut -d= -f2 | sed "s|\$HOME|$HOME|; s|^~|$HOME|")
: "${PORT:?PORT missing in .env}" "${KEY:?DAEMON_BOOTSTRAP_KEY missing in .env}"
command -v claude >/dev/null 2>&1 || { echo "✗ 'claude' CLI not found on PATH — install + authenticate it before dev:e2e (agents won't run otherwise)"; exit 1; }
mkdir -p "${HOME_DIR:-$HOME/.open-tag}/logs"
RUN="${HOME_DIR:-$HOME/.open-tag}"

echo "→ schema + seed (idempotent)…"
npm run db:push >/dev/null 2>&1 || true
npm run seed    >/dev/null 2>&1 || true

echo "→ building web (served by server on $PORT)…"
npm run build --prefix web >/dev/null

echo "→ starting server (:$PORT) + daemon…"
nohup npx tsx src/server/index.ts   > "$RUN/logs/dev-e2e-server.log" 2>&1 & echo $! > "$RUN/dev-e2e-server.pid"
# wait for server health
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break; sleep 1; done
nohup npx tsx src/daemon/index.ts --api-key "$KEY" > "$RUN/logs/dev-e2e-daemon.log" 2>&1 & echo $! > "$RUN/dev-e2e-daemon.pid"
# wait for the daemon to register (machine-id file written by the daemon under OPEN_TAG_HOME)
for i in $(seq 1 30); do [ -s "$RUN/machine-id" ] && break; sleep 1; done

echo "→ seeding dev-bot…"; npm run seed:dev || true

cat <<EOF

✅ dev E2E up (worktree-isolated)
   data dir : $RUN
   login    : http://localhost:$PORT/?as=you
   agent    : @dev-bot  (claude/sonnet) in #all
   logs     : $RUN/logs/dev-e2e-{server,daemon}.log
   stop     : npm run dev:e2e:down
EOF
```

- [ ] **Step 2: Create `scripts/dev-e2e-down.sh`**

```bash
#!/usr/bin/env bash
# Stop this worktree's dev E2E stack (server + daemon started by dev:e2e:up).
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd)"; exit 1; }
HOME_DIR=$(grep -E "^OPEN_TAG_HOME=" .env | cut -d= -f2 | sed "s|\$HOME|$HOME|; s|^~|$HOME|")
RUN="${HOME_DIR:-$HOME/.open-tag}"
for svc in server daemon; do
  f="$RUN/dev-e2e-$svc.pid"
  if [ -f "$f" ]; then kill "$(cat "$f")" 2>/dev/null && echo "  stopped $svc ($(cat "$f"))" || echo "  $svc not running"; rm -f "$f"; fi
done
echo "✅ dev E2E down"
```

- [ ] **Step 3: Add npm scripts** — `package.json`:

```json
"dev:e2e:up": "bash scripts/dev-e2e-up.sh",
"dev:e2e:down": "bash scripts/dev-e2e-down.sh",
```

- [ ] **Step 4: Verify (single worktree)**

```bash
# inside ../open-tag-e2etmp (from wt:add):
npm run dev:e2e:up     # → server+daemon up, machine-id written, dev-bot seeded, prints login URL
curl -sf http://localhost:$(grep ^PORT= .env|cut -d= -f2)/ >/dev/null && echo "server serving ✓"
test -s ~/.open-tag-e2etmp/machine-id && echo "daemon registered ✓"
npm run dev:e2e:down   # → stops both
```

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-e2e-up.sh scripts/dev-e2e-down.sh package.json
git commit -m "feat(dev): on-demand dev:e2e:up/down — isolated server+daemon+dev-bot stack"
```

---

## Task 5: AGENTS.md guidance + full integration verification

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add an AGENTS.md subsection** (under the verification/dev section)

```markdown
### Isolated dev E2E (on demand)

When a task touches the **agent runtime / human↔agent loop / realtime delivery to agents /
agent memory**, verify it in an isolated stack instead of poking prod:

1. `npm run wt:add -- <task>` — isolated worktree: own DB, ports, redis, and **data dir**
   (`~/.open-tag-<task>`), so parallel worktrees never collide.
2. `cd ../open-tag-<task>` and do the work.
3. `npm run dev:e2e:up` — builds web, starts server + daemon (background), seeds a real
   `claude`/`sonnet` `@dev-bot` in `#all`, prints the dev-login URL `http://localhost:$PORT/?as=you`.
4. Verify (browser dev-login → `@dev-bot`; or curl).
5. `npm run dev:e2e:down`, then from the main repo `npm run wt:rm -- <task>` (removes worktree
   + data dir + DB).

If your task does NOT involve the agent runtime (docs, pure REST, UI-only), skip this — it
needs the `claude` CLI/credentials and is wasted setup otherwise.
```

- [ ] **Step 2: Integration verification — parallel isolation (the headline)**

```bash
npm run wt:add -- e2ea
npm run wt:add -- e2eb
( cd ../open-tag-e2ea && npm run dev:e2e:up )
( cd ../open-tag-e2eb && npm run dev:e2e:up )
# assert two independent data dirs, two machine-ids, two servers:
diff <(cat ~/.open-tag-e2ea/machine-id) <(cat ~/.open-tag-e2eb/machine-id) && echo "FAIL: shared machine-id" || echo "isolated machine-id ✓"
ls ~/.open-tag-e2ea/agents ~/.open-tag-e2eb/agents   # separate agent workspaces
```
Expected: different machine-ids, separate agent dirs, both servers healthy on their own ports.

- [ ] **Step 3: Integration verification — full human↔agent E2E**

In `../open-tag-e2ea`, open `http://localhost:$PORT/?as=you` (chrome-devtools), go to `#all`,
send `@dev-bot ping — reply with the word pong`, and confirm a real `claude` reply lands in
the channel live (no refresh). Capture the reply text as evidence.

- [ ] **Step 4: Teardown + typecheck**

```bash
( cd ../open-tag-e2ea && npm run dev:e2e:down )
( cd ../open-tag-e2eb && npm run dev:e2e:down )
npm run wt:rm -- e2ea
npm run wt:rm -- e2eb
npx tsc --noEmit          # exit 0
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): guidance for on-demand isolated dev E2E harness"
```

---

## Self-Review

**Spec coverage:** real runnable agent (Task 2 + 4 + 5.3), DB isolation (existing wt:add, unchanged), local runtime (daemon on host, Task 4), on-demand (Task 4 + AGENTS.md Task 5), per-worktree parallel (Task 1 OPEN_TAG_HOME + Task 3 + verified Task 5.2). All covered.

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `paths.ts` exports (`openTagHome/agentsDir/binDir/machineIdFile/logsDir/uploadsDir`) match consumer usage in Task 1 Step 5. `seed-dev.ts` agent name `dev-bot` matches AGENTS.md + verification references.

**Assumption to re-confirm at execution:** `dev-e2e-up.sh` derives `OPEN_TAG_HOME` from `.env` and `claude` must be on PATH — both fail loud if missing.
