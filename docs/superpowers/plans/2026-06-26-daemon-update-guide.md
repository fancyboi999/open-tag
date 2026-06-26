# Daemon Update Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an actionable, honest update guide for online machines whose daemon version is behind the latest published daemon.

**Architecture:** Keep daemon update logic in the web plane as guidance only. Pure helpers classify stale online machines and build non-secret command templates; the Computers page renders the action and modal. The backend reconnect endpoint remains offline-only.

**Tech Stack:** React + TypeScript, i18next locale JSON, Node `tsx --test` unit tests.

## Global Constraints

- Do not add daemon self-update or remote process-control protocol.
- Do not rotate a machine key while the machine is online.
- Do not expose or reconstruct a stored machine key; only `apiKeyPrefix` is available after first generation.
- Keep the offline Reconnect flow as the only fresh-key generation path.
- Do not touch `src/daemon/**`; this is a web guidance change, not a daemon package release.

---

### Task 1: Pure Machine Update Helpers

**Files:**
- Create: `web/src/machineUi.ts`
- Test: `test/machineUpdateGuide.unit.test.ts`

**Interfaces:**
- Produces: `isDaemonUpdateAvailable(machine: Pick<Machine, "status" | "daemonVersion">, latestDaemonVersion: string): boolean`
- Produces: `daemonUpdateCommandTemplate(origin: string): string`

- [ ] **Step 1: Write the failing test**

Create `test/machineUpdateGuide.unit.test.ts` with tests for online stale detection, non-stale cases, and placeholder command generation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test --test-force-exit test/machineUpdateGuide.unit.test.ts`

Expected: FAIL because `web/src/machineUi.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/machineUi.ts` exporting the two helpers. The command template must contain `@latest`, the current origin, and `<your sk_machine_... key>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test --test-force-exit test/machineUpdateGuide.unit.test.ts`

Expected: PASS.

### Task 2: Computers Page Update Modal

**Files:**
- Modify: `web/src/views/misc.tsx`
- Modify: `web/src/locales/en.json`
- Modify: `web/src/locales/zh.json`

**Interfaces:**
- Consumes: `isDaemonUpdateAvailable` and `daemonUpdateCommandTemplate` from `web/src/machineUi.ts`.

- [ ] **Step 1: Add button and modal**

For `capabilities.manageMachines` users, show `Update daemon` when `isDaemonUpdateAvailable(cur, latestDaemonVersion)` is true. Add a guidance-only modal that does not call `/reconnect`.

- [ ] **Step 2: Add copy**

Add English and Chinese locale keys for the action, title, current/latest version labels, two operator paths, command template label, key prefix hint, and close button.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

### Task 3: Alert Copy and Docs

**Files:**
- Modify: `web/src/locales/en.json`
- Modify: `web/src/locales/zh.json`
- Modify: `FEATURES.md`

- [ ] **Step 1: Update alert copy**

Change outdated alert body to point the user to Computers for update steps instead of implying a direct reconnect command is already available.

- [ ] **Step 2: Update feature checklist**

Extend the System alert center entry to mention the online outdated daemon update guide and its no-secret/no-online-rotate constraint.

### Task 4: Real Browser Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Start the app**

Run server and web dev server in the worktree.

- [ ] **Step 2: Create or patch browser-visible stale machine state**

Use the seeded workspace and DB/API to make one machine visible as `online` with an older `daemonVersion`, then load Computers in the browser.

- [ ] **Step 3: Capture evidence**

Verify the update button appears, the modal describes both saved-key and lost-key paths, and no browser console error appears.
