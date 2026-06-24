#!/bin/sh
# Control-plane container entrypoint: bring the schema and bootstrap data up to date (both idempotent),
# then hand off to the server. Postgres/Redis readiness is guaranteed by compose `depends_on: service_healthy`.
set -e

echo "[entrypoint] applying schema (drizzle-kit push, idempotent)..."
npx drizzle-kit push --force

echo "[entrypoint] seeding bootstrap data (idempotent — skips if the workspace already exists)..."
npx tsx src/db/seed.ts

echo "[entrypoint] starting control plane on :${PORT:-7788} ..."
exec npx tsx src/server/index.ts
