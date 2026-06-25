# Core Beliefs (open-tag load-bearing constraints)

> Only **open-tag-specific, load-bearing** beliefs live here — scan before touching anything. Every belief has a code or architectural basis; none are slogans.
> Generic engineering disciplines (testing, debugging, verification) belong in each contributor's own global configuration and are not repeated here.

1. **`src/` is the sole canonical implementation.** All new work goes in `src/`. **Never write "supports both old and new" bridge code** — bridge code is harder to maintain and debug than either pure implementation.

2. **`docs/` = what we wrote; no external material belongs there.** `docs/` holds authoritative project knowledge: beliefs, generated schema, plans, and debt tracking. External or third-party specifications belong in a separate directory, clearly segregated from project-owned docs. Never mix the two; do not mistake third-party material for ground truth about our own behavior.

3. **Read the existing code before changing anything.** Before implementing a feature or fixing a bug, locate the relevant module in `ARCHITECTURE.md`, read the actual source, and confirm what is already implemented. Most core capabilities (channels / DM / tasks / threads / members / agent profiles / runtimes / idle-sleep) exist — understand them before touching them. Do not rebuild what is already there.

4. **Three-plane auth must not bleed across planes.** Human users authenticate via JWT (+ `x-server-id`). Agents authenticate via a **per-agent token** (`sk_agent_*`) SHA-256 matched against `agents.agentTokenHash` (+ `x-agent-id`) — **not** the machine key. Daemons authenticate via the WS `/daemon/connect?key=` handshake (machine key). **Raw credentials** (`sk_agent_*` / JWT / machine key) travel only in DMs or private channels — never in public channels. Redact before any public post. **Full model + enforcement invariants + hardening roadmap: [`docs/authorization.md`](./authorization.md).**

5. **Control-plane WebSocket is the backbone.** All daemon ↔ server commands and state changes flow over `/daemon/connect`. HTTP is for client requests only; daemon lifecycle events do not use HTTP polling.

6. **`seq` is the synchronization source of truth.** `message.seq` is globally monotonically increasing (Redis INCR per server) and drives unread state (`lastReadSeq`) and offline catch-up endpoints. Real-time delivery to human clients uses the full `message:new` socket.io event. Any change to real-time or sync logic must preserve `seq` monotonicity.

7. **An agent's world is exactly what it can see.** Agent communication goes exclusively through the `open-tag` CLI (generated at `~/.open-tag/bin`, injected into PATH; claude does not use MCP for this). Knowledge not visible in the agent's context does not exist for it — persistent knowledge must be written into the workspace `MEMORY.md` (read at startup; used for recovery after compaction). Do not rely on informal chat history to carry cross-session state.

8. **Single file ≤ 1000 lines; split when approaching the limit.** The current largest file `routes-api.ts` (~670 lines) is already a warning sign.

9. **Committed files contain zero personal or machine-specific references.** Files that enter the repository (`CLAUDE.md`, `ARCHITECTURE.md`, `docs/**`, `.claude/skills/`) must be valid for any contributor on any machine. They must not contain: personal global config paths (`~/.claude/...`), absolute machine paths (`/Users/...`), personal memory references, personal global skill names, or gateway hostnames. Personal and machine-specific context belongs in `CLAUDE.local.md` (gitignored) or a personal global config. Self-check: `grep -rE '~/\.claude|/Users/' <committed file>`.

10. **Browser automation in our own web uses chrome-devtools MCP.** Our web (localhost, no auth required) is driven by the chrome-devtools MCP server with a real headed browser and screenshot evidence. Do not use other browser automation tools for our own web UI verification.

> These beliefs are load-bearing — each corresponds to an invariant or boundary in `ARCHITECTURE.md`. The next step in harness engineering is making them mechanically enforceable (lint / CI) rather than relying on memory.
