#!/bin/sh
# Control-plane container entrypoint: bring the schema and bootstrap data up to date (both idempotent),
# then hand off to the server. Postgres/Redis readiness is guaranteed by compose `depends_on: service_healthy`.
#
# Privilege model:
#   The image starts as root so we can fix ownership on Docker named volumes (created root:root).
#   Local-storage uploads are written by the non-root `node` user; without this chown, POST
#   /api/attachments/upload fails with EACCES on a fresh volume (Coolify/compose). After fixing
#   perms we drop privileges with setpriv and never run the app/schema/seed as root.
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

# Defaults match paths.ts when OPEN_TAG_HOME is unset in compose (node home).
OPEN_TAG_HOME="${OPEN_TAG_HOME:-/home/node/.open-tag}"
UPLOADS_DIR="${OPEN_TAG_UPLOAD_DIR:-$OPEN_TAG_HOME/uploads}"

if [ "$(id -u)" = "0" ]; then
  # Ensure local-storage dirs exist and are writable by the runtime user.
  # Only touch known dirs — never chown -R arbitrary paths from env beyond uploads/logs.
  mkdir -p "$UPLOADS_DIR" "$OPEN_TAG_HOME/logs"
  # Parent of a volume mount is often root-owned; node needs to create siblings (e.g. logs/).
  chown node:node "$OPEN_TAG_HOME" 2>/dev/null || true
  chown -R node:node "$UPLOADS_DIR" "$OPEN_TAG_HOME/logs"
  # Drop privileges for schema/seed/server. setpriv is in util-linux (node:22-slim / Debian).
  exec setpriv --reuid=node --regid=node --init-groups -- "$0" "$@"
fi

echo "[entrypoint] applying schema (drizzle-kit push, additive-safe)..."
npx drizzle-kit push

echo "[entrypoint] seeding bootstrap data (idempotent — skips if the workspace already exists)..."
npx tsx src/db/seed.ts

echo "[entrypoint] starting control plane on :${PORT:-7788} ..."
exec npx tsx src/server/index.ts
