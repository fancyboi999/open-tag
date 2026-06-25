#!/usr/bin/env bash
# Create an isolated dev worktree: own branch + ports + database + redis DB + .env, with deps installed and DB seeded.
# Lets you develop several features in parallel without port/database collisions.
# Usage: npm run wt:add -- <name>     (e.g. npm run wt:add -- msg-edit)
set -euo pipefail
NAME="${1:-}"
[ -z "$NAME" ] && { echo "Usage: npm run wt:add -- <name>  (e.g. msg-edit)"; exit 1; }
SAFE="${NAME//[^a-zA-Z0-9]/_}"
WT="../open-tag-$NAME"
[ -e "$WT" ] && { echo "✗ $WT already exists"; exit 1; }

# Scan for free ports (server from 7801, vite from 5301; avoids dev 7777/5273 and prod 7788).
free_port() { local p=$1; while lsof -i ":$p" >/dev/null 2>&1; do p=$((p+1)); done; echo "$p"; }
SPORT=$(free_port 7801)
VPORT=$(free_port 5301)
RDB=$(( (SPORT - 7799) % 14 + 2 ))      # redis DB index 2..15 (avoids dev/0, prod/1)
DB="opentag_$SAFE"

# Branch from the canonical main, NOT the current HEAD — otherwise a PR made from this
# worktree would inherit whatever branch you happened to be on. WT_BASE=HEAD to opt out (stacking).
BASE="${WT_BASE:-origin/main}"
echo "→ worktree=$WT  server=$SPORT  vite=$VPORT  db=$DB  redis=/$RDB  base=$BASE"
git fetch origin main --quiet 2>/dev/null || true
git worktree add "$WT" -b "feature/$NAME" "$BASE"
docker compose exec -T postgres createdb -U opentag "$DB" 2>/dev/null || echo "  (db $DB already exists, reusing)"

# Generate random secrets for each worktree — never reuse the weak defaults
# (the server now fails fast on startup if these are missing or empty).
WT_JWT_SECRET=$(openssl rand -hex 32)
WT_BOOTSTRAP_KEY=$(openssl rand -hex 32)

cat > "$WT/.env" <<EOF
PORT=$SPORT
VITE_PORT=$VPORT
DATABASE_URL=postgres://opentag:opentag@localhost:5433/$DB
REDIS_URL=redis://localhost:6380/$RDB
JWT_SECRET=$WT_JWT_SECRET
DAEMON_BOOTSTRAP_KEY=$WT_BOOTSTRAP_KEY
OPEN_TAG_HOME=$HOME/.open-tag-$SAFE
ALLOW_DEV_LOGIN=true
EOF

echo "→ Installing deps + pushing schema + seeding (please wait)…"
( cd "$WT" && npm install --silent && ( cd web && npm install --silent ) && npm run db:push && npm run seed )

cat <<EOF

✅ worktree '$NAME' ready (branch feature/$NAME)
   cd $WT
   npm run server            # backend on $SPORT (reads this .env)
   npm run daemon            # daemon auto-connects to $SPORT
   (cd web && npm run dev)   # frontend on $VPORT, proxies → $SPORT
   open http://localhost:$VPORT
⚠️ To remove, run from the main repo: npm run wt:rm -- $NAME
EOF
