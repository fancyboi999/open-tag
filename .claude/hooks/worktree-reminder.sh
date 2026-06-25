#!/usr/bin/env bash
# SessionStart soft reminder — see AGENTS.md "Parallel development (worktrees)".
# Nudges toward `npm run wt:add` when a session starts on `main` in the MAIN checkout. Fires
# once per session. NEVER blocks (always exits 0); stays silent inside a worktree or on a
# non-main branch. Intentionally a reminder, not a gate — trivial doc/one-line edits are fine.
input="$(cat)"

# Only act inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Silent inside a linked worktree (its git-dir lives under .../​.git/worktrees/<name>).
case "$(git rev-parse --git-dir 2>/dev/null)" in
  */worktrees/*) exit 0 ;;
esac

# Silent unless on the default branch `main`.
[ "$(git branch --show-current 2>/dev/null)" = "main" ] || exit 0

# Defensive once-per-session dedupe on the hook's session_id (parsed without jq — may be absent
# on macOS). The SessionStart matcher is limited to `startup`, so this normally fires once anyway.
sid="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
marker="${TMPDIR:-/tmp}/claude-wt-reminder-${sid:-default}"
if [ -e "$marker" ]; then exit 0; fi
: > "$marker" 2>/dev/null || true

# Non-blocking: SessionStart stdout is injected into the model's context (like the sibling
# pull-main-on-session-start.sh hook). exit 0 → proceed.
echo "open-tag worktree reminder: this session starts on \`main\` in the MAIN checkout. Default workflow is to do non-trivial work (a feature, multi-file change, or anything needing an isolated stack) in a worktree: \`npm run wt:add -- <name>\` (own DB/ports/data-dir, branched from origin/main), then open the PR from there. Trivial doc / one-line changes on a branch off origin/main in the main checkout are fine — use judgment. This fires once per session."
exit 0
