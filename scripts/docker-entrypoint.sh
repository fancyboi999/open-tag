#!/bin/sh
# Control-plane container entrypoint: bring the schema and bootstrap data up to date (both idempotent),
# then hand off to the server. Postgres/Redis readiness is guaranteed by compose `depends_on: service_healthy`.

#
# Schema migration safety:
#   drizzle-kit push WITHOUT --force is additive-safe: it applies additive-only changes without
#   prompting. If a migration requires destructive changes (dropping columns / tables), drizzle-kit
#   will fail in a non-interactive container environment — causing the container to refuse to start
#   rather than silently destroying data. In that case the container has already exited (docker exec
#   won't work); run the migration in a one-off container instead:
#     docker compose --profile app run --rm --entrypoint "" app npx drizzle-kit push --force
#   Review the diff carefully before confirming. (Same procedure as docs/self-host.md.)
set -e

echo "[entrypoint] applying schema (drizzle-kit push, additive-safe)..."
npx drizzle-kit push

echo "[entrypoint] seeding bootstrap data (idempotent — skips if the workspace already exists)..."
npx tsx src/db/seed.ts

echo "[entrypoint] starting control plane on :${PORT:-7788} ..."
exec npx tsx src/server/index.ts
