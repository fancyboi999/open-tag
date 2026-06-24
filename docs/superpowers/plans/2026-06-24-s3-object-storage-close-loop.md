# S3 Object Storage Close-the-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing S3-compatible storage driver installable, discoverable, fail-loud, and proven against a real local MinIO — without rewriting its logic.

**Architecture:** `src/server/storage.ts` keeps its driver-agnostic `saveObject/readObject` boundary. We add a per-call `s3Config()` that validates env and throws clearly on misconfig (mirroring `src/paths.ts`'s read-on-each-call philosophy), declare `@aws-sdk/client-s3` as an optional dependency, document the feature, and verify end-to-end with a throwaway MinIO container.

**Tech Stack:** Node.js, TypeScript, `tsx`, `node:test`, `@aws-sdk/client-s3`, busboy, Docker (MinIO).

## Global Constraints

- TypeScript throughout; `npm run typecheck` (root + web) must stay green.
- Tests use `node:test` + `tsx`; run with `npx tsx --test --test-force-exit <file>`. No new test framework.
- `OPEN_TAG_S3_ENDPOINT`, `OPEN_TAG_S3_BUCKET`, `OPEN_TAG_S3_KEY`, `OPEN_TAG_S3_SECRET` are **required** when `OPEN_TAG_STORAGE=s3`; `OPEN_TAG_S3_REGION` is optional (default `us-east-1`).
- Surgical diff: every line traces to this task. Do NOT touch ContentType pass-through, S3Client caching, busboy truncation, or `docker-compose.yml`.
- E2E verification script is throwaway (scratchpad), NOT committed.
- Doc-sync is a hard rule: code change = doc change in the same logical unit of work.

---

### Task 1: Fail-fast `s3Config()` + unit tests

**Files:**
- Modify: `src/server/storage.ts` (lines ~37-58: `s3client`/`saveS3`/`readS3`)
- Test: `test/storage.unit.test.ts` (create)

**Interfaces:**
- Produces: `export interface S3Config { endpoint: string; region: string; bucket: string; key: string; secret: string }` and `export function s3Config(): S3Config` — reads env on each call, throws `Error` listing missing required vars.
- Consumes: nothing new. `storage.ts` has no top-level `@aws-sdk` import (it's dynamically imported inside functions), so importing the module in a unit test needs no aws-sdk installed.

- [ ] **Step 1: Write the failing test** — `test/storage.unit.test.ts`

```ts
// Unit tests for S3 config validation (fail-loud). Pure logic, no network/disk.
// Run: npx tsx --test --test-force-exit test/storage.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { s3Config } from "../src/server/storage.ts";

const S3_VARS = ["OPEN_TAG_S3_ENDPOINT", "OPEN_TAG_S3_BUCKET", "OPEN_TAG_S3_KEY", "OPEN_TAG_S3_SECRET", "OPEN_TAG_S3_REGION"];
function setAll() {
  process.env.OPEN_TAG_S3_ENDPOINT = "http://localhost:9000";
  process.env.OPEN_TAG_S3_BUCKET = "open-tag";
  process.env.OPEN_TAG_S3_KEY = "ak";
  process.env.OPEN_TAG_S3_SECRET = "sk";
  delete process.env.OPEN_TAG_S3_REGION;
}
function clearAll() { for (const v of S3_VARS) delete process.env[v]; }

test("all required set → returns config, region defaults to us-east-1", () => {
  setAll();
  assert.deepEqual(s3Config(), {
    endpoint: "http://localhost:9000", region: "us-east-1",
    bucket: "open-tag", key: "ak", secret: "sk",
  });
});

test("explicit region is honored", () => {
  setAll();
  process.env.OPEN_TAG_S3_REGION = "cn-hangzhou";
  assert.equal(s3Config().region, "cn-hangzhou");
});

test("missing endpoint throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_ENDPOINT;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_ENDPOINT/);
});

test("missing bucket throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_BUCKET;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_BUCKET/);
});

test("missing key throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_KEY;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_KEY/);
});

test("missing secret throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_SECRET;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_SECRET/);
});

test("multiple missing → message lists all of them", () => {
  clearAll();
  assert.throws(() => s3Config(), (e: Error) =>
    /OPEN_TAG_S3_ENDPOINT/.test(e.message) && /OPEN_TAG_S3_BUCKET/.test(e.message) &&
    /OPEN_TAG_S3_KEY/.test(e.message) && /OPEN_TAG_S3_SECRET/.test(e.message));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../open-tag-s3-storage && npx tsx --test --test-force-exit test/storage.unit.test.ts`
Expected: FAIL — `s3Config` is not exported (import error / not a function).

- [ ] **Step 3: Implement in `src/server/storage.ts`**

Replace the S3 driver block (current `s3client`/`saveS3`/`readS3`) with:

```ts
export interface S3Config { endpoint: string; region: string; bucket: string; key: string; secret: string }

/** Validate + read S3 env on each call (mirrors paths.ts: honors lazily-loaded env, stays testable). Fail loud. */
export function s3Config(): S3Config {
  const endpoint = process.env.OPEN_TAG_S3_ENDPOINT;
  const bucket = process.env.OPEN_TAG_S3_BUCKET;
  const key = process.env.OPEN_TAG_S3_KEY;
  const secret = process.env.OPEN_TAG_S3_SECRET;
  const missing = ([
    ["OPEN_TAG_S3_ENDPOINT", endpoint], ["OPEN_TAG_S3_BUCKET", bucket],
    ["OPEN_TAG_S3_KEY", key], ["OPEN_TAG_S3_SECRET", secret],
  ] as const).filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new Error(
    `OPEN_TAG_STORAGE=s3 requires ${missing.join(", ")} to be set (see README → Object storage).`);
  return { endpoint: endpoint!, region: process.env.OPEN_TAG_S3_REGION ?? "us-east-1", bucket: bucket!, key: key!, secret: secret! };
}

async function s3client(cfg: S3Config): Promise<any> {
  const mod = await import("@aws-sdk/client-s3" as string).catch(() => { throw new Error("S3 driver requires @aws-sdk/client-s3: npm i @aws-sdk/client-s3"); });
  return new mod.S3Client({
    endpoint: cfg.endpoint, region: cfg.region,
    forcePathStyle: true, // required for MinIO/Garage
    credentials: { accessKeyId: cfg.key, secretAccessKey: cfg.secret },
  });
}
async function saveS3(key: string, stream: Readable): Promise<Saved> {
  const cfg = s3Config();
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of stream) { chunks.push(c as Buffer); size += (c as Buffer).length; }
  const mod = await import("@aws-sdk/client-s3" as string);
  await (await s3client(cfg)).send(new mod.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: Buffer.concat(chunks) }));
  return { key, size };
}
async function readS3(key: string): Promise<Buffer> {
  const cfg = s3Config();
  const mod = await import("@aws-sdk/client-s3" as string);
  const r = await (await s3client(cfg)).send(new mod.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const chunks: Buffer[] = []; for await (const c of r.Body as Readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
```

Also update the file header comment's env list if it omits any var (keep it accurate).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx tsx --test --test-force-exit test/storage.unit.test.ts` → Expected: 7 pass.
Run: `npm run typecheck` → Expected: no errors (the `as string` dynamic import keeps tsc green without aws-sdk installed).

- [ ] **Step 5: Commit**

```bash
git add src/server/storage.ts test/storage.unit.test.ts
git commit -m "feat(storage): fail-fast S3 config validation + unit tests"
```

---

### Task 2: Declare `@aws-sdk/client-s3` as optional dependency

**Files:**
- Modify: `package.json` (add `optionalDependencies`)

**Interfaces:**
- Consumes: `s3client()` from Task 1 (dynamically imports the package).
- Produces: an installed `@aws-sdk/client-s3` so the S3 driver actually runs.

- [ ] **Step 1: Add the optional dependency**

Add to `package.json` (after `devDependencies`):

```json
  "optionalDependencies": {
    "@aws-sdk/client-s3": "^3.0.0"
  }
```

- [ ] **Step 2: Install + verify resolution**

Run: `npm install`
Run: `node -e "import('@aws-sdk/client-s3').then(m=>console.log('s3 sdk ok:', typeof m.S3Client)).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `s3 sdk ok: function`

- [ ] **Step 3: Verify typecheck still green**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(storage): declare @aws-sdk/client-s3 as optionalDependency"
```

---

### Task 3: Documentation (README, .env.example, FEATURES, ARCHITECTURE, tech-debt)

**Files:**
- Modify: `README.md` (new "Object storage" subsection)
- Modify: `.env.example` (commented S3 block)
- Modify: `FEATURES.md` (attachment line)
- Modify: `ARCHITECTURE.md` (storage.ts codemap line, only if wording drifts)
- Modify: `docs/tech-debt-tracker.md` (busboy truncation entry)

**Interfaces:** none (docs).

- [ ] **Step 1: README — add an "Object storage" subsection**

Add near the configuration/env area of `README.md`:

```markdown
### Object storage (attachments)

Attachments default to **local disk** (`$OPEN_TAG_HOME/uploads/`, overridable with
`OPEN_TAG_UPLOAD_DIR`) — zero config, data stays on your machine.

To use an **S3-compatible backend** (MinIO / Garage / SeaweedFS / Aliyun OSS):

1. `npm i @aws-sdk/client-s3`
2. Set in `.env`:
   ```
   OPEN_TAG_STORAGE=s3
   OPEN_TAG_S3_ENDPOINT=http://127.0.0.1:9000   # required (self-hosted endpoint)
   OPEN_TAG_S3_BUCKET=open-tag                   # required
   OPEN_TAG_S3_KEY=...                           # required
   OPEN_TAG_S3_SECRET=...                        # required
   OPEN_TAG_S3_REGION=us-east-1                  # optional (default us-east-1)
   ```
   Missing any required var makes the server fail loudly with the exact var name.

**Verify with a local MinIO:**
```bash
docker run -d --name ot-minio -p 9000:9000 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
  minio/minio:RELEASE.2024-01-16T16-07-38Z server /data
docker exec ot-minio mc alias set local http://127.0.0.1:9000 minio minio123  # or use mc client
# create the bucket, then start the server with OPEN_TAG_STORAGE=s3 + the vars above,
# upload an attachment in the UI, and confirm the object appears in the bucket.
docker rm -f ot-minio   # cleanup
```
```

(Adjust exact MinIO image tag to the one used during verification.)

- [ ] **Step 2: .env.example — add commented block**

Append to `.env.example`:

```bash
# ── Object storage (attachments) ───────────────────────────────────────────
# Default: local disk at $OPEN_TAG_HOME/uploads (no config needed).
# OPEN_TAG_UPLOAD_DIR=                 # override local upload dir
# To use an S3-compatible backend (MinIO/Garage/OSS): npm i @aws-sdk/client-s3, then:
# OPEN_TAG_STORAGE=s3
# OPEN_TAG_S3_ENDPOINT=http://127.0.0.1:9000   # required when STORAGE=s3
# OPEN_TAG_S3_BUCKET=open-tag                   # required
# OPEN_TAG_S3_KEY=                              # required
# OPEN_TAG_S3_SECRET=                           # required
# OPEN_TAG_S3_REGION=us-east-1                  # optional (default us-east-1)
```

- [ ] **Step 3: FEATURES.md — note the backend**

On the attachment line (`FEATURES.md:46`), append: ` Pluggable storage backend: local disk (default) or S3-compatible (MinIO E2E-verified).`

- [ ] **Step 4: ARCHITECTURE.md — align codemap line**

Confirm `ARCHITECTURE.md:51` still accurately describes storage.ts; if it omits fail-fast behavior, append `; fails loud on missing OPEN_TAG_S3_* config.` Otherwise leave unchanged.

- [ ] **Step 5: docs/tech-debt-tracker.md — record truncation gap**

Add an entry: oversized uploads (busboy `fileSize` 25 MB limit) are saved **truncated** in both local and S3 drivers (no truncation detection); pre-existing, not S3-specific; deferred.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example FEATURES.md ARCHITECTURE.md docs/tech-debt-tracker.md
git commit -m "docs(storage): document S3-compatible backend + local-MinIO verify recipe"
```

---

### Task 4: Real E2E verification against local MinIO (throwaway, not committed)

**Files:**
- Create (scratchpad, NOT committed): verification script under the session scratchpad dir.

**Interfaces:** exercises `POST /api/attachments/upload`, `GET /api/attachments/:id`, `POST /agent-api/attachment/upload`, `GET /agent-api/attachment/view`, and the fail-fast path.

- [ ] **Step 1: Start a throwaway MinIO + create bucket**

```bash
docker run -d --name ot-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minio -e MINIO_ROOT_PASSWORD=minio123 \
  minio/minio:RELEASE.2024-01-16T16-07-38Z server /data --console-address ":9001"
# create bucket "open-tag" (via mc in a one-off container or aws-cli --endpoint-url)
```

- [ ] **Step 2: Confirm worktree `.env` allows dev-login + start server with S3 env**

Check `../open-tag-s3-storage/.env` has `ALLOW_DEV_LOGIN=true`. Start server on :7802 with `OPEN_TAG_STORAGE=s3` + `OPEN_TAG_S3_ENDPOINT=http://127.0.0.1:9000` + bucket/key/secret. Wait until `curl -sf http://localhost:7802/` succeeds.

- [ ] **Step 3: Human path round-trip**

```bash
# dev-login → JWT
TOKEN=$(curl -sf -X POST localhost:7802/api/auth/dev-login -H 'content-type: application/json' -d '{"username":"you"}' | jq -r .token)
# upload a known file
echo "hello-s3-$(date +%s)" > /tmp/ot-s3-src.txt   # use scratchpad path in practice
ID=$(curl -sf -X POST localhost:7802/api/attachments/upload -H "authorization: Bearer $TOKEN" \
  -F channelId=<seeded #all id> -F files=@/tmp/ot-s3-src.txt | jq -r '.attachments[0].attachmentId')
# object exists in MinIO bucket?  (mc ls / aws s3 ls --endpoint-url)
# download + compare bytes
curl -sf "localhost:7802/api/attachments/$ID?token=$TOKEN" -o /tmp/ot-s3-dl.txt
diff /tmp/ot-s3-src.txt /tmp/ot-s3-dl.txt && echo "HUMAN ROUND-TRIP OK"
```
Expected: object listed in bucket; `diff` clean; sha256 match.

- [ ] **Step 4: Agent path round-trip**

Using a seeded agent's token (`sk_agent_*` + `x-agent-id`): `POST /agent-api/attachment/upload` then `GET /agent-api/attachment/view?id=<id>`; assert returned base64/text decodes to the same bytes.
Expected: `AGENT ROUND-TRIP OK`.

- [ ] **Step 5: Fail-fast check**

Restart the server with `OPEN_TAG_STORAGE=s3` but `OPEN_TAG_S3_BUCKET` unset; attempt an upload; confirm the response/log surfaces the clear `requires OPEN_TAG_S3_BUCKET` error (not an opaque SDK error).
Expected: explicit error naming the missing var.

- [ ] **Step 6: Teardown + record evidence**

```bash
docker rm -f ot-minio
```
Paste evidence: bucket listing, `diff`/sha256 results, fail-fast error text, MinIO + aws-sdk versions. Then update README's MinIO image tag to the verified one and re-commit docs if it changed.

- [ ] **Step 7: Final verification gate**

Run: `npm run typecheck` and `npx tsx --test --test-force-exit test/storage.unit.test.ts` once more → both green. Report the fail-loud checklist (skipped: truncation fix, hardening tier; not exercised: native-AWS endpoint-optional path).

---

## Self-Review

**Spec coverage:** A (fail-fast) → Task 1; B (optionalDependencies) → Task 2; C (docs) → Task 3; D (unit test) → Task 1 Step 1; E (E2E human+agent+fail-fast) → Task 4. All spec sections covered.

**Placeholder scan:** Concrete `<seeded #all id>` and the agent token are runtime values resolved during execution (seed output / DB), not plan placeholders; every code/command step is otherwise complete.

**Type consistency:** `s3Config()` / `S3Config` names and the four required-var list are identical across Task 1 (impl + tests), Task 3 (docs), and Task 4 (fail-fast check).
