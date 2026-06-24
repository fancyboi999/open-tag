#!/usr/bin/env bash
# Stop the open-tag production control plane: the server LISTENER + the open-tag prod daemon.
# Daemons for other workspaces (machine-key daemons from a separate repo) are left alone.
# Usage: npm run prod:down
set -euo pipefail
[ -f .env.prod ] || { echo "✗ no .env.prod in $(pwd)"; exit 1; }
PORT=$(grep -E "^PORT=" .env.prod | head -1 | cut -d= -f2- || true); PORT="${PORT:-7788}"

echo "→ stopping server listener on :${PORT}…"
lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true

echo "→ stopping open-tag prod daemon…"
pkill -f "ENV_FILE=.env.prod tsx src/daemon/index.ts" 2>/dev/null || true   # the launcher shell
pkill -f "open-tag/node_modules.*tsx.*src/daemon/index.ts" 2>/dev/null || true  # its tsx/node child (this checkout only; not worktrees / other repos)

echo "✅ prod down (server + open-tag daemon)."
