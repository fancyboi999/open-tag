# Design — GitHub Copilot CLI runtime for open-tag

- **Date:** 2026-06-24
- **Status:** Approved → in implementation (branch `feature/copilot-runtime`)
- **Scope:** Add **Copilot CLI** as the third agent runtime (after `claude`, `codex`). First slice of a broader "many runtimes" effort; deliberately one runtime at a time.
- **References:** multica's `server/pkg/agent/copilot.go` (protocol reference) + `src/daemon/codexRuntime.ts` (queue/serial-turn structure). **All protocol facts below were verified against the real local binary `GitHub Copilot CLI 1.0.61`** — multica's documented event set is partly stale for this version (see §4).

## 1. Goal & success criteria

> A user creates an agent with `runtime: "copilot"` from the UI; it spawns the real
> `copilot` CLI on the daemon host, streams thinking/text/tool trajectory into the
> channel, holds a multi-turn conversation, sleeps when idle, and **resumes** on next
> wake — at parity with `claude`/`codex`. Verified end-to-end against a real account.

**Done = all of:** (1) `getRuntime("copilot")` works; agent reaches `active` and replies. (2) Multi-turn carries context via resume. (3) idle-sleep → wake → resume continues the session. (4) trajectory + activity render live. (5) `npm run typecheck` (root + web) green; parser sanity test green. (6) Browser-verified evidence posted.

## 2. Non-goals (YAGNI)

- **No ACP mode.** `copilot --acp` persistent transport is not used (see §3). A future slice may add a shared ACP transport (would also unlock kimi/kiro/qoder).
- **No live local model discovery this slice.** Copilot CLI has **no `models list` command** (verified); the only programmatic source of the account's real model list is the `copilot --acp` `availableModels` handshake, and open-tag has **no daemon→server model-reporting channel** (the `runtime-models` endpoint is a static server map; the daemon registration only ships runtime *names*). Live discovery therefore needs a new daemon↔server plumbing slice. This slice ships a **static candidate list + `auto` default + loud runtime failure on an unavailable model** (per the owner's "不行就给候选" decision). Live discovery is tracked in `docs/tech-debt-tracker.md`.
- **No MCP injection**, **no `Runtime` interface change**, **no other runtimes**.

## 3. Core decision — one-shot per turn, self-assigned session id

open-tag's existing runtimes are *persistent processes* (claude: stdin stream-json; codex: app-server JSON-RPC). Copilot's stable automation channel is **one-shot**:

```
copilot -p "<prompt>" --output-format json --allow-all --no-ask-user \
        [--session-id <uuid> | --resume <uuid>] [--model <id>] [--effort <level>]
```

`-p` runs exactly one turn, emits JSONL on stdout, prints a final `result` line, and **the process exits**. Multi-turn = chaining processes by session id.

**Chosen: (A) pipe mode, spawn one process per turn.** Rejected (B) `copilot --acp` (needs a whole ACP transport open-tag lacks; out of scope). (A) fits open-tag's sleep/wake-by-resume model cleanly: no persistent process to babysit; "resume on wake" is the same resume every turn uses.

### 3.1 Session id — self-assign (verified more robust than multica's scrape)

**Verified against v1.0.61:** there is **no `session.start` event**; `sessionId` appears **only on the final `result` line**. multica scrapes it from `session.start` (absent here) — unreliable for this version. Instead:

- New agent (no `opts.sessionId`): generate `randomUUID()`, pass `--session-id <uuid>` on turn 1, call `cb.onSession(uuid)` **immediately** (the resume pointer no longer depends on parsing `result`, so a crash/timeout mid-turn can't lose it). Subsequent turns pass `--resume <uuid>`.
- Resumed agent (`opts.sessionId` set, e.g. wake-after-sleep): every turn passes `--resume <uuid>`.

**Empirically confirmed:** turn 1 `--session-id <uuid>` → `result.sessionId == uuid`; turn 2 `--resume <uuid>` correctly recalls a fact set in turn 1. Resume works end-to-end.

### 3.2 Mapping onto the `Runtime` contract (no contract change)

`copilotRuntime.start(opts, cb)` returns a `RuntimeSession` backed by a **serial turn queue** mirroring `codexRuntime.ts` (`queue` / `turnBusy` / `pump()`):

- `start()`: write `opts.systemPrompt` → `{cwd}/AGENTS.md` (§4.2); seed session id + `onSession`; enqueue `initialPrompt`; `pump()`.
- `deliver(text)`: enqueue; `pump()`.
- `pump()`: if `!stopped && !turnBusy && queue.length`, shift one and `runTurn()`.
- `runTurn(prompt)`: `turnBusy=true`; `onActivity("working","turn")`; spawn `copilot` (args §3); parse stdout JSONL → callbacks; capture stderr **tail**.
- on process **exit**: `turnBusy=false`;
  - intentional `stop()` → no-op.
  - exit 0 (or a `result` seen) → `onActivity("online")`, mark `everSucceeded`, `pump()` next. **Normal one-shot exit is NOT `onExit`** (that would make `agentManager` mark the agent dead and stop delivering).
  - exit≠0 → emit `[copilot error] <stderr tail>` trajectory + `onActivity("error", <stderr last line>)`; if **first turn / never succeeded** (bad model, auth, missing binary) → `onExit(code)` (surface as crashed); else keep the session alive and `pump()` (let a later message retry).
- `stop()`: `stopped=true`; kill the in-flight proc; no `onExit` (matches claude/codex on intentional stop).

Copilot is open-tag's **first one-shot/per-turn runtime** — a test that the `Runtime` contract absorbs this shape unchanged.

## 4. Event parsing (verified against v1.0.61)

JSONL envelope `{ type, data, id, timestamp, parentId, ephemeral }`; `result` has top-level `sessionId`/`exitCode`/`usage`. **Real event set observed** (fixtures: `src/daemon/__fixtures__/copilot-happy.jsonl`):

| Copilot event (v1.0.61) | open-tag action |
|---|---|
| `assistant.turn_start` (`turnId`) | `onActivity("working","turn")` |
| `assistant.message_start` (`messageId`) | ignore |
| `assistant.message_delta` (`deltaContent`) | **drop** (token stream — would spam per-row timeline; same as codex) |
| `assistant.message` (`content`, `model`, `toolRequests[]`, `outputTokens`) | `text` entry for non-empty `content`; one `tool` entry per `toolRequests[]` (name + clipped args) |
| `assistant.reasoning` (`content`) | `thinking` entry **only if `content` non-empty** (often empty — reasoning is encrypted in `reasoningOpaque`) |
| `tool.execution_complete` (`toolCallId`, `success`, `result`) | surface tool name/short result (kept from multica; not exercised by the happy fixture — verify in E2E with a tool-using prompt) |
| `assistant.turn_end` (`turnId`) | informational (process exit is the authoritative turn-done) |
| `result` (`sessionId`, `exitCode`) | capture `sessionId`; `exitCode≠0` → failure |
| `session.mcp_servers_loaded` / `skills_loaded` / `tools_updated` / `mcp_server_status_changed` / `user.message` | ignore |

The pure mapping lives in an exported `handleCopilotEvent(evt) → { trajectory[], activity?, sessionId?, errorText? }` so it is unit-testable against the captured fixtures without spawning a process.

### 4.1 Error reporting — stderr, not a JSON event (verified)

**Critical, verified:** an unavailable `--model` makes copilot **exit 1 with the error only on `stderr`** (`Error: Model "X" from --model flag is not available.`) and **no `result` and no JSON error event on stdout**. So the adapter must **retain a stderr tail** and surface it on non-zero exit (open-tag's claude/codex currently discard stderr at debug level). This is how the owner's "选了不可用模型要做好提醒" requirement is met: the failure shows up loudly as an `error` activity + `[copilot error] …` channel entry. Selection-time pre-warning is impossible without live discovery (deferred), so runtime loud-failure is the honest mechanism.

### 4.2 System prompt → `{cwd}/AGENTS.md` (verified default)

Copilot pipe mode has no system-prompt flag. **Verified:** `--no-custom-instructions` help reads "Disable loading of custom instructions from **AGENTS.md** and related files" — i.e. by default Copilot loads `AGENTS.md` from cwd. So write `opts.systemPrompt` → `{opts.cwd}/AGENTS.md` (the agent's isolated workspace `~/.open-tag/agents/<id>/`). Written once in `start()`.

## 5. Touch surface (no DB migration, no server-side whitelist)

1. **NEW** `src/daemon/copilotRuntime.ts` — adapter + exported `handleCopilotEvent` (~180 lines).
2. **NEW** `src/daemon/copilotRuntime.test.ts` + `src/daemon/__fixtures__/copilot-*.jsonl` — `node:test` parser test over real fixtures (run `npx tsx --test`; first test in the repo — project has no runner yet).
3. `src/daemon/runtimes.ts` — `REG.copilot = copilotRuntime`; `"copilot"` already in `detectRuntimes()`? (no — add it).
4. `web/src/views/Members.tsx` — add `{ value: "copilot", label: "Copilot CLI" }` to `RUNTIMES`.
5. `web/src/views/misc.tsx` — `RT_LABEL.copilot` already present ✅.
6. `src/server/routes-api.ts` — `MODELS.copilot = [{auto}, {gpt-5.5}, {gpt-5.4}, {claude-sonnet-4.6}, {claude-opus-4.7}, …]` (`auto` first/default).
7. **Doc-sync:** `ARCHITECTURE.md` codemap (new daemon file + runtime), `FEATURES.md`, `README.md` "Verified", `docs/tech-debt-tracker.md` (two entries — see §5.1).

### 5.1 Tech-debt entries to record (fail-loud, don't silently leave)

- **gemini/opencode UI-ahead-of-daemon drift**: `detectRuntimes()` advertises kimi/gemini/opencode and `RUNTIMES` lists gemini/opencode, but `REG` has only claude/codex (now +copilot) → selecting them yields `no runtime: <x>` offline. Not fixed here; recorded.
- **Copilot live model discovery**: needs an ACP probe + daemon→server model channel (see §2). Static list shipped meanwhile.

## 6. Edge cases (grounded in verified behavior)

- **Bad/unavailable model**: exit 1 + stderr; first-turn → fatal `onExit` with stderr surfaced (§3.2/§4.1).
- **Binary missing / not authed**: spawn `error` event or non-zero first exit → `onActivity("offline", …)` + `onExit`.
- **Reasoning content empty** (`reasoningOpaque` only): skip the `thinking` entry.
- **Long prompt**: per-turn prompt is the short inbox notice; the long system prompt is in `AGENTS.md`, not argv. `spawn()` (no shell) makes argv content-safe.
- **Concurrent deliveries**: queued + serialized via `pump()`; `agentManager.deliver` already debounces 3 s.
- **`stop()` mid-turn**: kill proc, set `stopped`; late exit callback is a no-op.

## 7. Verification plan

1. Worktree `copilot-runtime` (done — own DB/ports/redis/data dir).
2. `npm run typecheck` (root + web) green; `npx tsx --test src/daemon/copilotRuntime.test.ts` green (parser vs real fixtures).
3. `npm run dev:e2e:up`; create a `copilot` agent (real account, `copilot 1.0.61` on PATH); browser dev-login → `@` it.
4. Assert: replies; multi-turn context (resume); trajectory + activity render; idle-sleep→wake→resume; a tool-using prompt exercises `assistant.message.toolRequests`/`tool.execution_complete`; a bad-model agent shows the loud error.
5. `dev:e2e:down`; from main `npm run wt:rm -- copilot-runtime`.
6. **Fail-loud checklist** at completion: skipped (ACP, live models, MCP — intentional), warnings, unexercised paths.
