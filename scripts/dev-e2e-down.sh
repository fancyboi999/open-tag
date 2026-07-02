#!/usr/bin/env bash
# Stop this worktree's dev E2E stack (server + daemon started by dev:e2e:up).
# Usage: npm run dev:e2e:down
set -euo pipefail
[ -f .env ] || { echo "✗ no .env in $(pwd)"; exit 1; }
HOME_DIR=$(grep -E "^OPEN_TAG_HOME=" .env | head -1 | cut -d= -f2- | sed "s|^\$HOME|$HOME|; s|^~|$HOME|")
RUN="${HOME_DIR:-$HOME/.open-tag}"
for svc in server daemon; do
  f="$RUN/dev-e2e-$svc.pid"
  # Kill the whole process tree, not just the recorded npm-exec parent: `kill $pid` alone orphans the
  # tsx → node children (they keep running, holding the WS open → ghost daemons that cause double-delivery).
  pkill -f "$PWD/src/$svc/index.ts" 2>/dev/null || true
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    kill "$pid" 2>/dev/null && echo "  stopped $svc ($pid)" || echo "  $svc not running"
    rm -f "$f"
  fi
done
echo "✅ dev E2E down"
