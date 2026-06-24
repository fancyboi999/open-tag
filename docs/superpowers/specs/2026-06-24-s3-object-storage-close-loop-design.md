# Design — Close the loop on S3-compatible object storage (MinIO/OSS)

- **Date:** 2026-06-24
- **Branch:** `feature/s3-storage`
- **Status:** approved-pending-spec-review
- **Scope tier:** close-loop + fail-fast (chosen by user; not "full hardening")

## Problem (first-principles root cause)

`src/server/storage.ts` already ships a pluggable storage boundary with two drivers:
local disk (default) and an S3-compatible driver (`OPEN_TAG_STORAGE=s3`, intended for
MinIO/Garage/SeaweedFS/OSS). The **code exists and is logically near-complete**, but the
feature was never *closed off*:

1. **Not installable** — `@aws-sdk/client-s3` is declared **nowhere** in `package.json`
   (not even `optionalDependencies`). Enabling `s3` throws `S3 driver requires
   @aws-sdk/client-s3` until the user guesses they must `npm i` it.
2. **Not discoverable** — `README.md` and `.env.example` mention **none** of
   `OPEN_TAG_STORAGE` / `OPEN_TAG_S3_*` / `OPEN_TAG_UPLOAD_DIR`. The only trace is one
   codemap line in `ARCHITECTURE.md:51`. A self-hoster has no way to find this.
3. **Never verified** — local-disk is browser-verified (`FEATURES.md:46`), but the S3
   path has no test, no E2E, no "Verified" evidence. Nobody has run a byte through it.
4. **One Fail-loud violation** — `storage.ts:43` uses
   `accessKeyId: process.env.OPEN_TAG_S3_KEY ?? ""`. A missing/typo'd credential is
   swallowed; the failure surfaces much later, deep inside the AWS SDK, as an opaque
   error. This directly violates the project's "Fail loud — no silent failures" rule.

The fix is **not** to rewrite the storage logic. It is to **close the loop**:
installable → discoverable → verified → fail-loud.

## Goals

- Make `OPEN_TAG_STORAGE=s3` install cleanly and fail **loudly + clearly** on misconfig.
- Make it **discoverable**: documented in README + `.env.example`, with a reproducible
  local-MinIO verification recipe.
- **Prove it works** end-to-end against a real local MinIO container (upload → object
  lands in bucket → download → bytes match), for both the human and the agent path.

## Non-goals (YAGNI / surgical / fail-loud-about-what-we-skip)

- No new test framework (project uses `node:test` + `tsx`; we follow it).
- No `ContentType` pass-through to S3 objects, no `S3Client` reuse/caching — that is the
  "full hardening" tier the user did **not** pick. Downloads already set `content-type`
  from the DB row (`routes-api.ts`), so object-level `ContentType` does not affect
  open-tag's own download path.
- Do **not** add MinIO to the shared `docker-compose.yml` — verification uses a throwaway
  container so we don't impose a standing service on every developer.
- Do **not** fix the pre-existing busboy `fileSize`-limit **silent truncation** (a file
  over 25 MB is saved truncated, in *both* drivers — not S3-specific). Record it in
  `docs/tech-debt-tracker.md` instead of widening this diff.
- The E2E script is **not committed** (user: "don't push to remote"); its steps live in
  README prose so the knowledge is preserved and reproducible.

## Design

### A. Fail-fast S3 config (`src/server/storage.ts`)

Extract a single `s3Config()` helper that **reads env on each call** — mirroring the
established `src/paths.ts` philosophy ("Read on each call so env loaded by env.ts is
honored, and tests can toggle it"). This matters because `DRIVER` is a top-level `const`
evaluated once at module load; a per-call config function is what makes the validation
unit-testable and honors lazily-loaded env.

```ts
interface S3Config { endpoint: string; region: string; bucket: string; key: string; secret: string }

function s3Config(): S3Config {
  const endpoint = process.env.OPEN_TAG_S3_ENDPOINT;
  const bucket   = process.env.OPEN_TAG_S3_BUCKET;
  const key      = process.env.OPEN_TAG_S3_KEY;
  const secret   = process.env.OPEN_TAG_S3_SECRET;
  const missing = [
    ["OPEN_TAG_S3_ENDPOINT", endpoint], ["OPEN_TAG_S3_BUCKET", bucket],
    ["OPEN_TAG_S3_KEY", key], ["OPEN_TAG_S3_SECRET", secret],
  ].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new Error(
    `OPEN_TAG_STORAGE=s3 requires ${missing.join(", ")} to be set (see README → Object storage).`);
  return { endpoint: endpoint!, region: process.env.OPEN_TAG_S3_REGION ?? "us-east-1",
           bucket: bucket!, key: key!, secret: secret! };
}
```

`s3client()` calls `s3Config()` and stops using `?? ""`. `saveS3`/`readS3` read
`bucket` from the validated config instead of re-reading `process.env.OPEN_TAG_S3_BUCKET`.

**Decision — `OPEN_TAG_S3_ENDPOINT` is required.** open-tag's storage driver targets
self-hosted S3-compatible services (MinIO/Garage/OSS — all of which need an explicit
endpoint), per the product framing and `storage.ts` header comment. Native AWS S3 (where
endpoint is optional) is out of scope; if needed later, relax this then. `OPEN_TAG_S3_REGION`
stays optional with a default. This is stated explicitly so the constraint is intentional,
not accidental.

### B. Dependency declaration (`package.json`)

Add `@aws-sdk/client-s3` to **`optionalDependencies`**. Rationale: the default local-disk
path never needs it; the lazy `import("@aws-sdk/client-s3" as string)` already handles its
absence; `optionalDependencies` means a failed install never breaks `npm i` for local-disk
users. The `as string` cast keeps `tsc --noEmit` green whether or not the package resolves.

### C. Documentation (doc-sync hard rule)

- **`README.md`** — new "Object storage" subsection: one line that local disk is the
  zero-config default; an env table (`OPEN_TAG_STORAGE`, `OPEN_TAG_S3_ENDPOINT/BUCKET/REGION/KEY/SECRET`,
  `OPEN_TAG_UPLOAD_DIR`); the 2-step enable recipe (`npm i @aws-sdk/client-s3` + set env);
  and a short **"Verify with local MinIO"** recipe (the reproducible E2E steps).
- **`.env.example`** — a commented block listing the same vars (commented out; local disk
  is the default so nothing is required).
- **`FEATURES.md`** — extend the attachment line to note "S3-compatible storage backend
  (MinIO, E2E-verified)".
- **`ARCHITECTURE.md:51`** — align the existing storage.ts codemap line with the new
  fail-fast behavior (one-line tweak, only if wording drifts).
- **`docs/tech-debt-tracker.md`** — record the busboy silent-truncation gap as known debt.

### D. Unit test (`test/storage.unit.test.ts`)

Follow the `node:test` pattern (`npx tsx --test --test-force-exit`). Test `s3Config()`
only (pure logic, no network):
- missing each of the four required vars → throws, and the message names the missing var(s);
- all set → returns the config with `region` defaulting to `us-east-1` when unset.

To make `s3Config` testable, export it (named export) alongside the existing functions.

### E. Real E2E verification (local MinIO, throwaway, NOT committed)

Run inside this worktree (`OPEN_TAG_STORAGE=s3`, server on :7802):

1. `docker run` a throwaway MinIO (`:9000` API), create a bucket via `mc`/aws-cli (or
   the S3 SDK).
2. Start the server with `OPEN_TAG_STORAGE=s3` + `OPEN_TAG_S3_*` pointing at MinIO.
3. **Human path:** dev-login → JWT → `POST /api/attachments/upload` a known file →
   assert the object exists in the MinIO bucket → `GET /api/attachments/<id>?token=` →
   assert downloaded bytes' sha256 == source.
4. **Agent path:** seeded agent token → `POST /agent-api/attachment/upload` →
   `GET /agent-api/attachment/view` → assert bytes round-trip.
5. **Fail-fast check:** start with a missing `OPEN_TAG_S3_*` and confirm the clear error.
6. `docker rm -f` the container.

## Verification order (per CLAUDE.md / AGENTS.md)

`npm run typecheck` → `npx tsx --test test/storage.unit.test.ts` → local MinIO E2E
(human + agent + fail-fast) → paste evidence (command output + bucket listing + sha256
match) → only then "done". Fail-loud report must list what was skipped (truncation,
hardening tier) and what was not exercised.

## Files touched

| File | Change |
|---|---|
| `src/server/storage.ts` | extract+export `s3Config()`, fail-fast, drop `?? ""` |
| `package.json` | add `@aws-sdk/client-s3` to `optionalDependencies` |
| `test/storage.unit.test.ts` | new — unit tests for `s3Config()` |
| `README.md` | new "Object storage" subsection + local-MinIO verify recipe |
| `.env.example` | commented `OPEN_TAG_STORAGE` / `OPEN_TAG_S3_*` block |
| `FEATURES.md` | note S3 backend (MinIO verified) |
| `ARCHITECTURE.md` | align storage.ts codemap line (if wording drifts) |
| `docs/tech-debt-tracker.md` | record busboy silent-truncation debt |

## Risks

- **MinIO/SDK version drift** — pin a known-good MinIO image tag and a current
  `@aws-sdk/client-s3` major in the E2E recipe; record exact versions in the evidence.
- **`forcePathStyle: true`** stays (required by MinIO/Garage); harmless for OSS. Not
  changed.
- E2E depends on Docker being available; this worktree confirmed Docker 28.3.3.
