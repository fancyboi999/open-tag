#!/usr/bin/env bash
# Bring up an isolated, on-demand dev E2E stack for THIS worktree: server + daemon + dev-bot agent.
# The server serves the built web/dist on PORT, so browser E2E needs no separate vite process.
# Usage: npm run dev:e2e:up
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd) — run from a worktree created by 'npm run wt:add'"; exit 1; }

val() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }
PORT=$(val PORT)
KEY=$(val DAEMON_BOOTSTRAP_KEY)
HOME_DIR=$(val OPEN_TAG_HOME | sed "s|^\$HOME|$HOME|; s|^~|$HOME|")
: "${PORT:?PORT missing in .env}" "${KEY:?DAEMON_BOOTSTRAP_KEY missing in .env}"
RUN="${HOME_DIR:-$HOME/.open-tag}"

command -v claude >/dev/null 2>&1 || { echo "✗ 'claude' CLI not found on PATH — install + authenticate it before dev:e2e (agents won't run otherwise)"; exit 1; }

# Guard against double-up (would collide on PORT).
if [ -f "$RUN/dev-e2e-server.pid" ] && kill -0 "$(cat "$RUN/dev-e2e-server.pid")" 2>/dev/null; then
  echo "✗ dev E2E already running for this worktree (server pid $(cat "$RUN/dev-e2e-server.pid")). Run 'npm run dev:e2e:down' first."; exit 1
fi
mkdir -p "$RUN/logs"

echo "→ schema + bootstrap seed (idempotent)…"
npm run db:push >/dev/null 2>&1 || true
npm run seed    >/dev/null 2>&1 || true

echo "→ building web (served by the server on :$PORT)…"
npm run build --prefix web >/dev/null

echo "→ starting server (:$PORT)…"
nohup npx tsx src/server/index.ts > "$RUN/logs/dev-e2e-server.log" 2>&1 & echo $! > "$RUN/dev-e2e-server.pid"
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 || { echo "✗ server did not become healthy — see $RUN/logs/dev-e2e-server.log"; exit 1; }

echo "→ starting daemon…"
nohup npx tsx src/daemon/index.ts --api-key "$KEY" > "$RUN/logs/dev-e2e-daemon.log" 2>&1 & echo $! > "$RUN/dev-e2e-daemon.pid"
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
