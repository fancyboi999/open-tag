# Connect-Computer Wizard — design spec

> Status: approved (brainstorm) · 2026-06-29 · branch `feature/computer-wizard`

## Problem

When a workspace has **no machine**, `AddComputerModal` (`web/src/views/misc.tsx:343-385`)
auto-pops, but it is only an **intro screen**: clicking "Connect" merely
`nav(/s/:slug/computer)`. The user then has to click the sidebar `+`, type a name,
and click "Generate" in a *separate* modal (`ConnectMachineModal`, `misc.tsx:285-333`)
to actually get the daemon command. That is a multi-jump, broken flow for the single
most important first-run action: getting a computer online.

## Goal contract

- **End state**: A single self-contained multi-step wizard carries the user through
  **intro → generate connect command → wait for the machine to come online → connected
  (optional rename) → Done**, entirely inside the modal — no page jump, no second click
  in another modal. All three entry points (no-machine auto-pop, Computers-page `+`,
  offline-machine reconnect) share this one wizard. i18n is complete (en + zh). The two
  legacy modals are removed (no dual implementation).
- **Evidence**:
  1. New `PATCH /api/servers/:serverId/machines/:machineId` rename endpoint — a unit
     test that first **fails** (cross-server rename must 404/403, own rename must
     persist) then passes, plus a real `curl` run.
  2. dev:e2e isolated stack + chrome-devtools driving the full wizard against a **real**
     daemon: auto-pop → command → daemon connects → connected state → rename → Done,
     with screenshots.
  3. A separate skeptical verifier subagent confirms the end state and tries to break it.
- **Constraints**: do **not** touch the daemon protocol (no `arch`); authorization red
  line (tenant isolation + `manageMachines` on the new route); surgical diff; delete the
  old modals rather than leaving a "satisfies-both" hybrid; keep every file < 1000 lines
  (extract a dedicated component file); doc-sync in the same PR.
- **Ceiling**: if dev:e2e / daemon / socket wiring repeatedly fails beyond a few honest
  attempts, STOP and escalate instead of thrashing.

## Facts established (from code, not assumed)

- **i18n**: react-i18next, packs at `web/src/locales/{en,zh}.json` (nested), `t("misc.…")`.
  Existing keys: `chat.addComputer*` (intro), `misc.connectModal*` / `misc.reconnectModal*`.
- **machines table** (`src/db/schema.ts:42-57`): `id, serverId, userId, name, apiKeyHash,
  apiKeyPrefix, runtimes[], hostname, os, daemonVersion, lastHeartbeat, status, isComputer,
  createdAt`. **No `arch` column.**
- **daemon onReady** (`src/server/ws.ts:83-110`) reports `hostname, os, runtimes,
  daemonVersion` only — **no arch**. So the connected card shows `hostname · os · runtimes`,
  not `darwin arm64`. (Adding arch would mean daemon-protocol change + schema column +
  migration + a new daemon package release — out of scope.)
- **machine routes** (`src/server/routes-api/servers.ts`):
  - `GET  /api/servers/:id/machines` → `{machines[], latestDaemonVersion}` (line 184-185).
  - `POST /api/servers/:id/machines` → create offline row, return `{id,name,apiKeyPrefix,key}`
    (key plaintext once); empty name → "new machine" (line 221-229).
  - `POST /api/servers/:id/machines/:id/reconnect` → rotate key, **409 if online** (234-245).
  - `DELETE /api/servers/:id/machines/:id` → guarded delete (256-276).
  - **No rename (PATCH/PUT) endpoint** — must be added.
- **Live "waiting → online" feedback already exists**: `ConnectMachineModal` has a
  `useEffect` that closes when the just-added machine appears `status === "online"`, driven
  by the socket `machine:status` event → store refetch (`web/src/store.tsx:328-331`,
  `src/server/socketio.ts:101`, `src/server/ws.ts:110`). The wizard reuses this signal to
  advance from **connect** → **connected**.
- **opt-out** (`misc.tsx:340-341`): `COMPUTER_OPTOUT_KEY` (localStorage, permanent global),
  `COMPUTER_DISMISSED_KEY` (sessionStorage, this tab). Reused as-is for the intro step.
- File sizes: `misc.tsx` is 681 lines → extract the wizard to its own file rather than
  growing it.

## Design

### New component — `web/src/views/ConnectComputerWizard.tsx`

A single modal component driven by a `mode` prop and an internal `step` state.

```
type Mode = "onboard" | "add" | "reconnect";
// onboard   → starts at step "intro"  (auto-pop, no-machine)
// add       → starts at step "connect" (Computers + button; intent already expressed)
// reconnect → starts at step "connect" (rotates key on an existing machine)

type Step = "intro" | "connect" | "connected";
```

Props (sketch): `{ mode: Mode; machine?: { id: string; name: string }; onClose: () => void }`.
`machine` is required for `reconnect`.

**Step "intro"** (onboard only)
- Title `t("chat.addComputerTitle")` ("ADD A COMPUTER"), lead copy
  `t("chat.addComputerBody")`, runtime list `t("chat.addComputerRuntimes")`.
- "Don't remind me again" checkbox → on Skip/close, writes the opt-out keys (existing logic).
- Buttons: Skip (`t("chat.addComputerSkip")`) · Add Computer → advances to "connect".

**Step "connect"**
- On entering this step, immediately call the generate endpoint **once**:
  - `add` / `onboard`: `POST /api/servers/:id/machines` (no name field; server defaults
    "new machine"). daemon will overwrite the display name with the real hostname on connect.
  - `reconnect`: `POST /api/servers/:id/machines/:machine.id/reconnect`.
- Show the ready-to-run command:
  `npx @fancyboi999/open-tag-daemon@latest --server-url <origin> --api-key <key>` + copy button.
- Show a 🟠 pulsing "Waiting for computer to connect…" status.
- Button: Cancel. (No Done here — connection auto-advances.)
- When the socket reports this machine `online`, auto-advance to "connected".
- Error handling: if generate fails, show an inline error with a Retry affordance (not a
  silent dead modal).

**Step "connected"**
- 🟢 success card: `Computer connected` + mono `hostname · os · runtimes`.
- Optional "Computer Name" input (placeholder = hostname; `reconnect` pre-fills current name).
- Done button: if the input is non-empty **and changed**, call
  `PATCH /api/servers/:id/machines/:machineId { name }`, then `reload()` + `onClose()`.
  Empty/unchanged → just close (keeps the auto/hostname name).

### Backend — new rename endpoint

`PATCH /api/servers/:serverId/machines/:machineId` in `src/server/routes-api/servers.ts`,
mirroring the reconnect/delete handlers:

- `requireCap(serverId, userId, "manageMachines")` → 403 otherwise.
- Load the row with **tenant isolation**: `and(eq(machines.id, mid), eq(machines.serverId, serverId))`
  → 404 if not found (this is the authorization red line — a machine id from another
  workspace must not be renamable).
- Validate `name`: trimmed, non-empty, length-capped (e.g. ≤ 80) → 400 otherwise.
- `db.update(...).set({ name }).where(eq(machines.id, mid))`, return the updated machine
  shape consistent with the list endpoint.
- (No socket publish strictly required; the modal calls `reload()`. A `machine` rename
  event is optional polish — keep out unless trivial, to stay surgical.)

### Entry-point wiring

- `web/src/views/Chat.tsx:411` — replace `<AddComputerModal />` with
  `<ConnectComputerWizard mode="onboard" … />` (same auto-pop condition lives inside the
  component: `machines.length === 0 && capabilities.manageMachines && !dismissed`).
- `misc.tsx` Computers sidebar `+` → open wizard in `mode="add"`.
- `misc.tsx` reconnect action (offline machine) → open wizard in `mode="reconnect"` with
  the machine.

### Removal (no dual implementation)

Delete `AddComputerModal` and `ConnectMachineModal` from `misc.tsx`; move their reusable
bits (opt-out constants, command string, copy helper, online-auto-advance effect) into the
wizard. Net: one connect UI, one source of truth.

### i18n

Add wizard keys to both `en.json` and `zh.json` (reuse `chat.addComputer*` for intro;
add `misc.wizard*` for connect/connected/rename/errors). Copy, labels, and error messages
get an `/impeccable:impeccable` **clarify** pass; accessibility / responsive / performance
get an **audit** pass.

## Verification plan

1. **Unit** — `test/machineRename.unit.test.ts` (node:test, run via
   `npx tsx --test --test-force-exit`): rename own machine persists; cross-server id →
   404; missing `manageMachines` → 403; empty/oversize name → 400. Red first, then green.
2. **curl** — against the dev:e2e server: PATCH own machine, PATCH a foreign id (expect
   404/403), GET list to confirm the new name.
3. **Browser (chrome-devtools)** — dev:e2e stack; seed has no machine for a fresh path or
   bind/clear as needed. Drive: auto-pop intro → Add Computer → copy command → run the real
   `npx @fancyboi999/open-tag-daemon` in the worktree → wizard auto-advances to connected →
   rename → Done → machine shows in Computers with the new name. Screenshots to `.shots/`.
4. **Separate verifier subagent** — given goal contract + diff + run instructions; must hit
   edge/error/concurrency (generate failure, Cancel mid-wait, reconnect on an online
   machine = 409, rename race) and return a fail-loud report.

## Doc-sync

- `ARCHITECTURE.md` — add the new `PATCH …/machines/:id` route to the routes-api contract.
- `FEATURES.md` / `README.md` "Verified" — note the streamlined connect-computer flow.
- `docs/generated/db-schema.md` — **no change** (machines table untouched).

## Risks / open edges

- dev:e2e daemon must actually connect to :7801 to exercise the online transition; if it
  can't, the connect→connected step can't be browser-verified end to end — fall back to
  flipping machine status in psql to drive the socket event, and say so (fail loud).
- Reconnect-on-online returns 409 by design; the wizard should only offer reconnect for
  offline machines (existing UI invariant) and surface the 409 if it races.
