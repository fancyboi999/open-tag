#!/usr/bin/env bash
# Bring up the open-tag production control plane in the background.
# Stops ONLY the old server listener (daemons connected to the port are left alive → they just
# reconnect to the restarted server), rebuilds web, starts the server, then starts the open-tag prod
# daemon only if one isn't already running. Usage: npm run prod:up
set -euo pipefail
[ -f .env.prod ] || { echo "✗ no .env.prod in $(pwd) — run from the prod checkout"; exit 1; }
PORT=$(grep -E "^PORT=" .env.prod | head -1 | cut -d= -f2- || true); PORT="${PORT:-7788}"
LOGDIR="$HOME/.open-tag/logs"; mkdir -p "$LOGDIR"

echo "→ stopping old server listener on :$PORT (connected daemons left running)…"
lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

echo "→ building web (web/dist is served by the server)…"
npm run web:build >/dev/null

# Migrate the DB schema to the code BEFORE the new server starts. Skipping this is how a prod:up
# once shipped code whose onConflict / new columns hit a not-yet-migrated DB → runtime 500s (agent
# create failed on a missing partial unique index added by a merged-but-unmigrated schema change).
# drizzle-kit push is additive-safe and prompts before any destructive change; `set -e` aborts
# prod:up if the migration fails, so the server never starts against a mismatched schema.
echo "→ syncing DB schema to code (drizzle-kit push)…"
npm run db:push:prod

echo "→ starting server on :$PORT (background)…"
nohup npm run start:prod > "$LOGDIR/prod-server.out" 2>&1 &
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || { echo "✗ server did not become healthy — see $LOGDIR/prod-server.out"; exit 1; }
echo "  server healthy ✓"

if pgrep -f "ENV_FILE=.env.prod tsx src/daemon/index.ts" >/dev/null 2>&1; then
  echo "→ open-tag prod daemon already running — it reconnects to the restarted server (no restart needed)."
else
  echo "→ starting open-tag prod daemon (background)…"
  nohup npm run daemon:prod > "$LOGDIR/prod-daemon.out" 2>&1 &
fi

cat <<EOF

✅ prod up on http://localhost:$PORT  (server + open-tag daemon)
   logs: $LOGDIR/prod-{server,daemon}.out
   note: a daemon for any OTHER workspace (a machine-key daemon, e.g. from a separate repo) is not
         managed here — start that one yourself if you use it.
EOF
