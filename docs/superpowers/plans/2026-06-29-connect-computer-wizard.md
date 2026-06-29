# Connect-Computer Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken multi-jump "no machine → go to Computers page → click + → type name → generate" flow with one self-contained modal wizard (intro → generate command → wait for online → connected + optional rename → Done), shared by all three entry points.

**Architecture:** A new `web/src/views/ConnectComputerWizard.tsx` modal driven by a `mode` prop (`onboard` | `add` | `reconnect`) and internal `step` state (`intro` | `connect` | `connected`). It absorbs and replaces the old `AddComputerModal` (intro) and `ConnectMachineModal` (generate/wait) — both deleted. A new backend `PATCH …/machines/:id` rename endpoint backs the connected-step rename. The online transition reuses the existing socket `machine:status` → store-refetch signal.

**Tech Stack:** TypeScript, React 18, react-i18next, Drizzle/Postgres, node:test + tsx integration tests.

## Global Constraints

- Daemon package is `@fancyboi999/open-tag-daemon`; connect command = `npx @fancyboi999/open-tag-daemon@latest --server-url <origin> --api-key <key>`.
- Do **not** touch the daemon protocol or add an `arch` column. Connected card shows `hostname · os · runtimes` (existing fields only).
- **Authorization red line:** the new `PATCH …/machines/:id` MUST `requireCap(serverId, userId, "manageMachines")` (→403) AND load the row with tenant isolation `and(eq(machines.id, mid), eq(machines.serverId, serverId))` (→404 for a foreign id). Mirror the existing reconnect/delete handlers.
- Keep every file < 1000 lines (that's why the wizard is its own file, not grown into `misc.tsx`).
- i18n: every new string added to **both** `web/src/locales/en.json` and `web/src/locales/zh.json` under the same key.
- No "satisfies-both" hybrid: delete the two old modals; one connect UI, one source of truth.
- TDD for the backend (integration red→green); the wizard UI is verified by typecheck + chrome-devtools against a real daemon (no DOM test harness in this repo).
- Doc-sync in the same PR: `ARCHITECTURE.md` (new route), `FEATURES.md` + `README.md` (streamlined flow). `docs/generated/db-schema.md` unchanged (machines table untouched).

---

### Task 1: Backend `PATCH …/machines/:id` rename endpoint (TDD, authorization-guarded)

**Files:**
- Test: `test/machineRename.integration.ts` (create)
- Modify: `src/server/routes-api/servers.ts` (add handler right after the reconnect handler, ~line 246)
- Modify: `ARCHITECTURE.md` (routes-api machine contract)

**Interfaces:**
- Produces: `PATCH /api/servers/:serverId/machines/:machineId` with JSON body `{ name: string }` →
  `200 { id, name, hostname, os, runtimes, status, daemonVersion, isComputer, apiKeyPrefix, lastHeartbeat }`
  (same machine shape as the GET list rows); `400` empty/oversize name; `403` no `manageMachines`;
  `404` unknown/foreign machine id.

- [ ] **Step 1: Write the failing integration test**

Create `test/machineRename.integration.ts` (modeled on `test/machineDeleteFk.integration.ts` — reuse its mock-HTTP `makeReq`/`makeRes`/`apiCall` helpers verbatim):

```ts
// Integration test: PATCH /api/servers/:sid/machines/:mid rename + authorization.
// EXPECTED (goal contract):
//   BEFORE: no PATCH route → falls through to 404 → [1] FAILS (RED)
//   AFTER : owner rename persists (200) [1]; cross-tenant id → 404 [2]; member (no cap) → 403 [3];
//           empty name → 400 [4]; oversize name → 400 [5]
// Requires infra up (npm run infra) + worktree .env. Run: npx tsx test/machineRename.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { signUser, hashToken, newKey } from "../src/server/auth.ts";
import { handleApi } from "../src/server/routes-api/index.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

function makeReq(o: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const s = o.body ? JSON.stringify(o.body) : "";
  const r = Readable.from(s ? [Buffer.from(s)] : ([] as Buffer[]));
  return Object.assign(r, { method: o.method, url: o.path, headers: { authorization: `Bearer ${o.token}`, "x-server-id": o.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes() {
  let status = 0, body = "";
  const em = new EventEmitter();
  const res = Object.assign(em, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { body = d ? String(d) : ""; em.emit("finish"); } }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}
async function apiCall(o: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const PORT = Number(process.env.PORT ?? 7777);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(o.path, `http://localhost:${PORT}`);
  try { await handleApi(makeReq(o), res, url, o.method); }
  catch (e: unknown) { res.writeHead(500); res.end(JSON.stringify({ error: "internal", detail: e instanceof Error ? e.message : String(e) })); }
  let parsed: unknown; try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed as any };
}

let serverId = "", ownerId = "", ownerToken = "", memberId = "", memberToken = "";
let otherServerId = "", otherMachineId = "";

async function insertMachine(sid: string, uid: string, name: string) {
  const key = newKey("sk_machine_");
  const [m] = await db.insert(schema.machines).values({ serverId: sid, userId: uid, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status: "offline", isComputer: false }).returning();
  return m!;
}
async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `own_mr_${ts}`, displayName: "Owner", email: `own_mr_${ts}@t.local` }).returning();
  ownerId = owner!.id; ownerToken = signUser(ownerId);
  const [member] = await db.insert(schema.users).values({ name: `mem_mr_${ts}`, displayName: "Member", email: `mem_mr_${ts}@t.local` }).returning();
  memberId = member!.id; memberToken = signUser(memberId);
  const [srv] = await db.insert(schema.servers).values({ name: "T-mr", slug: `t-mr-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  await db.insert(schema.serverMembers).values({ serverId, userId: memberId, role: "member" });
  // A second server owned by the same user, to prove tenant isolation on machineId.
  const [srv2] = await db.insert(schema.servers).values({ name: "T-mr2", slug: `t-mr2-${ts}`, ownerId }).returning();
  otherServerId = srv2!.id;
  await db.insert(schema.serverMembers).values({ serverId: otherServerId, userId: ownerId, role: "owner" });
  const om = await insertMachine(otherServerId, ownerId, `other_${ts}`);
  otherMachineId = om.id;
}
async function cleanup() {
  for (const sid of [serverId, otherServerId]) {
    await db.delete(schema.machines).where(eq(schema.machines.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, memberId));
}

async function main() {
  await setup();

  console.log("\n[1] owner renames own machine → 200 + persisted");
  const m = await insertMachine(serverId, ownerId, `before_${ts}`);
  const r1 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "My Laptop" } });
  console.log(`     → status=${r1.status} body=${JSON.stringify(r1.body)}`);
  check("rename returns 200", r1.status === 200);
  check("response carries new name", r1.body?.name === "My Laptop");
  const after = await db.select().from(schema.machines).where(eq(schema.machines.id, m.id));
  check("DB name updated", after[0]?.name === "My Laptop");

  console.log("\n[2] cross-tenant machine id → 404 (tenant isolation)");
  const r2 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${otherMachineId}`, token: ownerToken, serverId, body: { name: "Hijack" } });
  console.log(`     → status=${r2.status}`);
  check("foreign machine id rejected with 404", r2.status === 404);
  const oth = await db.select().from(schema.machines).where(eq(schema.machines.id, otherMachineId));
  check("foreign machine name unchanged", oth[0]?.name === `other_${ts}`);

  console.log("\n[3] member (no manageMachines) → 403");
  const r3 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: memberToken, serverId, body: { name: "Nope" } });
  console.log(`     → status=${r3.status}`);
  check("member rename forbidden with 403", r3.status === 403);

  console.log("\n[4] empty name → 400");
  const r4 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "   " } });
  check("empty name rejected with 400", r4.status === 400);

  console.log("\n[5] oversize name (>80) → 400");
  const r5 = await apiCall({ method: "PATCH", path: `/api/servers/${serverId}/machines/${m.id}`, token: ownerToken, serverId, body: { name: "x".repeat(81) } });
  check("oversize name rejected with 400", r5.status === 400);
}

main().then(cleanup).then(() => { console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch {} process.exit(1); });
```

- [ ] **Step 2: Run the test, verify it FAILS (RED)**

Ensure infra is up first: `npm run infra` (pg :5433, redis :6380).
Run: `npx tsx test/machineRename.integration.ts`
Expected: `[1]` fails — no PATCH route exists, so the request falls through to the generic 404 (status ≠ 200). Test exits non-zero.

- [ ] **Step 3: Implement the PATCH handler**

In `src/server/routes-api/servers.ts`, insert right after the reconnect handler (after line ~246, before the DELETE handler comment block):

```ts
  // Rename a machine: set a human-friendly display name. Tenant-isolated (machineId must belong to
  // the path's server) and gated on manageMachines — same guard shape as reconnect/delete above.
  const renm = /^\/api\/servers\/[^/]+\/machines\/([^/]+)$/.exec(p);
  if (renm && method === "PATCH") {
    if (!await requireCap(serverId, userId, "manageMachines")) return (sendErr(res, 403, "need manageMachines capability"), true);
    const mid = renm[1]!;
    const b = await readJson(req).catch(() => ({}));
    const name = String(b.name ?? "").trim();
    if (!name || name.length > 80) return (sendErr(res, 400, "name must be 1–80 characters"), true);
    const m = (await db.select().from(schema.machines).where(and(eq(schema.machines.id, mid), eq(schema.machines.serverId, serverId))))[0];
    if (!m) return (sendErr(res, 404, "machine not found"), true);
    const [u] = await db.update(schema.machines).set({ name }).where(eq(schema.machines.id, mid)).returning();
    return (sendJson(res, 200, { id: u!.id, name: u!.name, hostname: u!.hostname, os: u!.os, runtimes: u!.runtimes, status: u!.status, daemonVersion: u!.daemonVersion, isComputer: u!.isComputer, apiKeyPrefix: u!.apiKeyPrefix, lastHeartbeat: u!.lastHeartbeat }), true);
  }
```

(Note: the DELETE handler's regex `dmach` matches the same `/machines/:id` shape; PATCH is gated by `method === "PATCH"` so order with DELETE is irrelevant. `readJson`, `requireCap`, `and`, `eq`, `sendErr`, `sendJson`, `db`, `schema` are already imported in this file.)

- [ ] **Step 4: Run the test, verify it PASSES (GREEN)**

Run: `npx tsx test/machineRename.integration.ts`
Expected: `ALL PASS ✅`, exit 0 — all of `[1]`–`[5]` green.

- [ ] **Step 5: Update ARCHITECTURE.md**

Find the routes-api machine routes list (search `machines/:` or the `/api/servers/:id/machines` contract) and add a row:
`PATCH /api/servers/:serverId/machines/:machineId { name } → rename a machine (manageMachines; tenant-isolated)`.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: passes.

```bash
git add test/machineRename.integration.ts src/server/routes-api/servers.ts ARCHITECTURE.md
git commit -m "feat(api): PATCH machines/:id rename endpoint (cap-gated, tenant-isolated)"
```

---

### Task 2: `daemonConnectCommand` shared helper (DRY the connect command string)

**Files:**
- Test: `test/daemonConnectCommand.unit.test.ts` (create)
- Modify: `web/src/machineUi.ts`

**Interfaces:**
- Produces: `daemonConnectCommand(origin: string, key: string): string` →
  `npx @fancyboi999/open-tag-daemon@latest --server-url <origin> --api-key <key>`.

- [ ] **Step 1: Write the failing test**

Create `test/daemonConnectCommand.unit.test.ts`:

```ts
// Run: npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { daemonConnectCommand } from "../web/src/machineUi.ts";

test("daemonConnectCommand embeds origin and key", () => {
  const cmd = daemonConnectCommand("https://x.test", "sk_machine_abc");
  assert.equal(cmd, "npx @fancyboi999/open-tag-daemon@latest --server-url https://x.test --api-key sk_machine_abc");
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts`
Expected: FAIL — `daemonConnectCommand` not exported.

- [ ] **Step 3: Implement**

In `web/src/machineUi.ts`, add (and keep `daemonUpdateCommandTemplate` as-is — different consumer, placeholder key):

```ts
export function daemonConnectCommand(origin: string, key: string): string {
  return `npx @fancyboi999/open-tag-daemon@latest --server-url ${origin} --api-key ${key}`;
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `npx tsx --test --test-force-exit test/daemonConnectCommand.unit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/machineUi.ts test/daemonConnectCommand.unit.test.ts
git commit -m "feat(web): daemonConnectCommand helper (single source for connect command)"
```

---

### Task 3: `ConnectComputerWizard` component + i18n keys + success-card CSS

**Files:**
- Create: `web/src/views/ConnectComputerWizard.tsx`
- Modify: `web/src/locales/en.json`, `web/src/locales/zh.json`
- Modify: `web/src/styles.css` (success card)

**Interfaces:**
- Produces: `export function ConnectComputerWizard({ mode, machine, onClose }: { mode: "onboard" | "add" | "reconnect"; machine?: { id: string; name: string }; onClose?: () => void })`.
  - `onboard`: self-shows when `machines.length === 0 && capabilities.manageMachines && !dismissed`; owns its own dismiss (no `onClose` needed). Starts at `intro`.
  - `add`: parent-mounted; starts at `connect`; closes via `onClose`.
  - `reconnect`: parent-mounted; `machine` required; starts at `connect`, rotates key via `/reconnect`; pre-fills rename with current name.
- Consumes: `daemonConnectCommand` (Task 2); store `{ machines, capabilities, api, serverId, reload }`.

- [ ] **Step 1: Add i18n keys to `en.json`** under the `misc` object (alongside the existing `connectModal*` keys):

```json
    "wizardCmdIntro": "Run this command on your computer to connect:",
    "wizardWaiting": "Waiting for computer to connect…",
    "wizardGenError": "Couldn't generate a connection command.",
    "wizardRetry": "Retry",
    "wizardConnectedTitle": "Computer Connected",
    "wizardConnectedSuccess": "Computer connected successfully!",
    "wizardNameLabel": "Computer Name",
    "wizardNameHint": "A friendly name for this computer.",
```

- [ ] **Step 2: Add the same keys to `zh.json`** under `misc`:

```json
    "wizardCmdIntro": "在你的电脑上运行此命令以接入：",
    "wizardWaiting": "等待电脑接入…",
    "wizardGenError": "生成接入命令失败。",
    "wizardRetry": "重试",
    "wizardConnectedTitle": "电脑已接入",
    "wizardConnectedSuccess": "电脑接入成功！",
    "wizardNameLabel": "电脑名称",
    "wizardNameHint": "给这台电脑起一个好记的名字。",
```

(intro step reuses existing `chat.addComputer*`; connect/connected reuse `misc.connectModalCancel|CopyBtn|Copied|Done|Generating` and `misc.reconnectModalNote`.)

- [ ] **Step 3: Add the success-card CSS** to `web/src/styles.css` (place near the existing `.codebox` / modal rules):

```css
/* Connect-computer wizard: connected success card + waiting row */
.wiz-ok { display: flex; align-items: center; gap: 12px; border: 2px solid var(--line, #000); background: rgba(120, 200, 60, .18); padding: 14px; margin-bottom: 14px; }
.wiz-ok .wiz-ok-ico { flex-shrink: 0; }
.wiz-ok .wiz-ok-meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; opacity: .65; margin-top: 2px; }
.wiz-wait { display: flex; align-items: center; gap: 10px; margin: 12px 0; font-size: 13px; }
.wiz-wait .wiz-pulse { width: 9px; height: 9px; border-radius: 50%; background: #ff8a3d; animation: wizPulse 1.1s ease-in-out infinite; }
@keyframes wizPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
.wiz-hint { font-size: 12px; opacity: .5; margin-top: 4px; }
```

(These are additive utility classes; if a matching design token/color already exists in `styles.css`, prefer it during the impeccable pass.)

- [ ] **Step 4: Create the component** `web/src/views/ConnectComputerWizard.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import { useStore } from "../store.tsx";
import { useTranslation } from "react-i18next";
import { IconMonitor } from "../icons.tsx";
import { CheckCircle2 } from "lucide-react";
import { daemonConnectCommand } from "../machineUi.ts";

// Self-contained onboarding nudge state (reused from the old AddComputerModal): once-per-tab session
// dismiss + a permanent global opt-out checkbox. Only the "onboard" mode reads/writes these.
const COMPUTER_OPTOUT_KEY = "open-tag.onboard.computer.optout";        // localStorage: permanent opt-out
const COMPUTER_DISMISSED_KEY = "open-tag.onboard.computer.dismissed";  // sessionStorage: this tab session

type Mode = "onboard" | "add" | "reconnect";
type Step = "intro" | "connect" | "connected";

// One wizard for all three add-a-computer entry points. It carries the user end-to-end inside the modal:
// intro → generate a ready-to-run daemon command → wait for the daemon to come online (socket-driven) →
// connected (optional friendly rename) → Done. Replaces AddComputerModal + ConnectMachineModal.
export function ConnectComputerWizard({ mode, machine, onClose }: { mode: Mode; machine?: { id: string; name: string }; onClose?: () => void }) {
  const { machines, capabilities, api, serverId, reload } = useStore();
  const { t } = useTranslation();

  const [dontRemind, setDontRemind] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    if (mode !== "onboard") return false;
    try { return sessionStorage.getItem(COMPUTER_DISMISSED_KEY) === "1" || localStorage.getItem(COMPUTER_OPTOUT_KEY) === "1"; } catch { return false; }
  });
  const [step, setStep] = useState<Step>(mode === "onboard" ? "intro" : "connect");
  const [res, setRes] = useState<{ id: string; key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  // onboard auto-show gate (same condition the old modal used). Other modes are mounted by their parent.
  const onboardVisible = mode === "onboard" && machines.length === 0 && !!capabilities.manageMachines && !dismissed;
  const shown = mode === "onboard" ? onboardVisible : true;

  const close = useCallback(() => {
    if (mode === "onboard") {
      try { sessionStorage.setItem(COMPUTER_DISMISSED_KEY, "1"); if (dontRemind) localStorage.setItem(COMPUTER_OPTOUT_KEY, "1"); } catch { /* storage unavailable — dismiss in memory only */ }
      setDismissed(true);
    }
    onClose?.();
  }, [mode, dontRemind, onClose]);

  // Esc-to-dismiss, only while shown.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, close]);

  // Generate (or rotate) the connection key. add/onboard create a new machine; reconnect rotates the existing key.
  const gen = useCallback(async () => {
    setBusy(true); setGenErr("");
    try {
      const r = mode === "reconnect" && machine
        ? await api("POST", `/api/servers/${serverId}/machines/${machine.id}/reconnect`, {})
        : await api("POST", `/api/servers/${serverId}/machines`, {});
      if (r?.key) { setRes({ id: r.id, key: r.key, name: r.name }); await reload(); }
      else setGenErr(r?.error || t("misc.wizardGenError"));
    } catch { setGenErr(t("misc.wizardGenError")); }
    finally { setBusy(false); }
  }, [mode, machine, api, serverId, reload, t]);

  // Auto-generate once on entering the connect step.
  useEffect(() => { if (shown && step === "connect" && !res && !busy && !genErr) gen(); }, [shown, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // The just-touched machine (created or reconnected) and whether its daemon is online yet.
  const targetId = res?.id ?? machine?.id;
  const liveMachine = targetId ? machines.find((m) => m.id === targetId) : undefined;
  const isOnline = liveMachine?.status === "online";

  // Online transition → connected step. Pre-fill rename with the current name on reconnect.
  useEffect(() => {
    if (step === "connect" && res && isOnline) { setNameInput(mode === "reconnect" ? (machine?.name ?? "") : ""); setStep("connected"); }
  }, [step, res, isOnline, mode, machine]);

  const cmd = res ? daemonConnectCommand(window.location.origin, res.key) : "";
  const copy = (text: string) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  const finish = async () => {
    const newName = nameInput.trim();
    const curName = res?.name ?? machine?.name ?? "";
    if (newName && newName !== curName && targetId) {
      setSavingName(true);
      try { await api("PATCH", `/api/servers/${serverId}/machines/${targetId}`, { name: newName }); await reload(); }
      finally { setSavingName(false); }
    }
    close();
  };

  if (!shown) return null;
  const meta = liveMachine ? [liveMachine.hostname, liveMachine.os, (liveMachine.runtimes || []).join(", ")].filter(Boolean).join(" · ") : "";

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {step === "intro" && (<>
          <h3>{t("chat.addComputerTitle")}</h3>
          <div className="onboard-lead"><span className="onboard-ico"><IconMonitor size={22} /></span><p>{t("chat.addComputerBody")}</p></div>
          <p className="modal-note">{t("chat.addComputerRuntimes")}</p>
          <div className="acts">
            <label className="onboard-optout"><input type="checkbox" checked={dontRemind} onChange={(e) => setDontRemind(e.target.checked)} /> {t("chat.addComputerDontRemind")}</label>
            <button className="cancel" onClick={close}>{t("chat.addComputerSkip")}</button>
            <button className="ok" onClick={() => setStep("connect")}><IconMonitor size={14} /> {t("chat.addComputerConnect")}</button>
          </div>
        </>)}

        {step === "connect" && (<>
          <h3>{mode === "reconnect" && machine ? t("misc.reconnectModalTitle", { name: machine.name }) : t("misc.connectModalTitle")}</h3>
          {mode === "reconnect" ? <p className="modal-note">{t("misc.reconnectModalNote")}</p> : null}
          {genErr ? (<>
            <p className="form-err">{genErr}</p>
            <div className="acts"><button className="cancel" onClick={close}>{t("misc.connectModalCancel")}</button><button className="ok" onClick={gen} disabled={busy}>{busy ? t("misc.connectModalGenerating") : t("misc.wizardRetry")}</button></div>
          </>) : !res ? (
            <div className="wiz-wait"><span className="wiz-pulse" /> {t("misc.connectModalGenerating")}</div>
          ) : (<>
            <label>{t("misc.wizardCmdIntro")}</label>
            <div className="codebox"><code className="grow">{cmd}</code><button className="joinbtn" onClick={() => copy(cmd)}>{copied ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
            <div className="wiz-wait"><span className="wiz-pulse" /> {t("misc.wizardWaiting")}</div>
            <div className="acts"><button className="cancel" onClick={close}>{t("misc.connectModalCancel")}</button></div>
          </>)}
        </>)}

        {step === "connected" && (<>
          <h3>{t("misc.wizardConnectedTitle")}</h3>
          <div className="wiz-ok">
            <CheckCircle2 size={24} className="wiz-ok-ico" />
            <div><div><b>{t("misc.wizardConnectedSuccess")}</b></div>{meta ? <div className="wiz-ok-meta">{meta}</div> : null}</div>
          </div>
          <label>{t("misc.wizardNameLabel")}</label>
          <input autoFocus value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder={liveMachine?.hostname || ""} maxLength={80} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(); }} />
          <p className="wiz-hint">{t("misc.wizardNameHint")}</p>
          <div className="acts"><button className="ok" onClick={finish} disabled={savingName}>{t("misc.connectModalDone")}</button></div>
        </>)}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck` (root) and `cd web && npm run typecheck`
Expected: passes. (At this point the component compiles but isn't wired in yet — Task 4 wires it and deletes the old modals.)

- [ ] **Step 6: Commit**

```bash
git add web/src/views/ConnectComputerWizard.tsx web/src/locales/en.json web/src/locales/zh.json web/src/styles.css
git commit -m "feat(web): ConnectComputerWizard multi-step modal + i18n + success card"
```

---

### Task 4: Wire all three entry points to the wizard; delete the two old modals

**Files:**
- Modify: `web/src/views/Chat.tsx` (line 20 import, line 411 render)
- Modify: `web/src/views/misc.tsx` (Computers `connect`/`reconnect` render lines 252-253; delete `ConnectMachineModal` 284-333 and `AddComputerModal` 335-385 + its two storage constants)

**Interfaces:**
- Consumes: `ConnectComputerWizard` (Task 3).

- [ ] **Step 1: Re-point `Chat.tsx`**

Line 20: `import { AddComputerModal } from "./misc.tsx";` → `import { ConnectComputerWizard } from "./ConnectComputerWizard.tsx";`
Line 411: `<AddComputerModal />` → `<ConnectComputerWizard mode="onboard" />`

- [ ] **Step 2: Re-point the Computers page entry points in `misc.tsx`**

Replace lines 252-253:

```tsx
      {connect && <ConnectComputerWizard mode="add" onClose={() => setConnect(false)} />}
      {reconnect && <ConnectComputerWizard mode="reconnect" machine={reconnect} onClose={() => setReconnect(null)} />}
```

Add the import near the other view imports at the top of `misc.tsx`:

```tsx
import { ConnectComputerWizard } from "./ConnectComputerWizard.tsx";
```

- [ ] **Step 3: Delete the two old modals + their constants from `misc.tsx`**

Remove the entire `ConnectMachineModal` function (was lines 284-333), the `COMPUTER_OPTOUT_KEY` / `COMPUTER_DISMISSED_KEY` constants + the comment block (340-341 and the preceding comment), and the entire `AddComputerModal` function (343-end of that function ~385). Keep `DaemonUpdateModal` (it still uses `daemonUpdateCommandTemplate`).

- [ ] **Step 4: Prune now-unused imports in `misc.tsx`**

After deletion, check whether `useNavigate`/`useCallback`/`AlertTriangle` are still referenced elsewhere in the file (DaemonUpdateModal uses `AlertTriangle`; Computers uses `useNavigate`). Remove only the ones with zero remaining references. Let typecheck guide this.

- [ ] **Step 5: Typecheck (root + web)**

Run: `npm run typecheck` then `cd web && npm run typecheck`
Expected: both pass, no unused-symbol errors, no dangling `AddComputerModal`/`ConnectMachineModal` references.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/Chat.tsx web/src/views/misc.tsx
git commit -m "refactor(web): route all add-computer entry points through ConnectComputerWizard; drop old modals"
```

---

### Task 5: Real-run verification (curl + chrome-devtools against a live daemon) + doc-sync

**Files:**
- Modify: `FEATURES.md`, `README.md` (Verified section)
- Evidence: screenshots to `.shots/` (gitignored)

- [ ] **Step 1: Bring up the isolated dev E2E stack**

From the worktree root: `npm run dev:e2e:up`
Expected: builds web, starts server (:7801) + daemon (auto-connects), seeds `@dev-bot`, prints `http://localhost:7801/?as=you`.

- [ ] **Step 2: curl the rename endpoint against the live server**

Mint a dev session + grab a machine id, then:

```bash
# dev-login → token (ALLOW_DEV_LOGIN is on in dev:e2e)
TOKEN=$(curl -s -X POST localhost:7801/api/auth/dev-login -H 'content-type: application/json' -d '{"username":"you"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
SID=$(curl -s localhost:7801/api/servers -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
# create a machine, capture id
MID=$(curl -s -X POST localhost:7801/api/servers/$SID/machines -H "authorization: Bearer $TOKEN" -H "x-server-id: $SID" -H 'content-type: application/json' -d '{}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# rename it
curl -s -X PATCH localhost:7801/api/servers/$SID/machines/$MID -H "authorization: Bearer $TOKEN" -H "x-server-id: $SID" -H 'content-type: application/json' -d '{"name":"Renamed via curl"}'
# confirm
curl -s localhost:7801/api/servers/$SID/machines -H "authorization: Bearer $TOKEN" -H "x-server-id: $SID" | python3 -m json.tool
```

Expected: PATCH returns the machine with `"name":"Renamed via curl"`; the list reflects it.

- [ ] **Step 3: Browser-verify the full wizard with chrome-devtools**

Open the dev-login URL. To exercise the **onboard** auto-pop you need zero machines — delete any seeded machine first (or use a fresh workspace). Then:
1. Confirm the wizard auto-pops at the **intro** step (no machine).
2. Click **Add Computer** → it advances to **connect**, shows the `npx @fancyboi999/open-tag-daemon…` command + a pulsing "Waiting…" row. Copy works.
3. In a terminal, run the printed command (the dev:e2e daemon, or a fresh `npx` in the worktree) so a daemon actually connects with that key.
4. Confirm the wizard auto-advances to **connected** (green card, `hostname · os · runtimes`).
5. Type a friendly name → **Done** → modal closes; Computers page shows the machine with the new name.
6. Repeat for the `add` entry (Computers `+`, starts at connect) and `reconnect` (offline machine → starts at connect, rotates key, pre-filled name).
Capture screenshots of intro / connect / connected to `.shots/`.

> Fallback (fail loud) if a real daemon can't connect in this environment: drive the online transition by flipping the machine row to `status='online'` in the worktree DB (`psql`) so the socket `machine:status` event fires, and **state explicitly in the PR that the online step was DB-driven, not daemon-driven**.

- [ ] **Step 4: Update FEATURES.md + README.md**

`FEATURES.md`: tick/update the add-computer onboarding item to note the in-modal end-to-end wizard.
`README.md` "Verified" section: add a line that the connect-computer flow completes inside the modal (intro → command → online → rename), with the evidence.

- [ ] **Step 5: Tear down + commit docs**

```bash
npm run dev:e2e:down
git add FEATURES.md README.md
git commit -m "docs: connect-computer wizard verified end-to-end; sync FEATURES/README"
```

---

## Self-review (done at write time)

- **Spec coverage:** intro/connect/connected steps (Task 3) ✓; three modes onboard/add/reconnect (Task 3+4) ✓; PATCH rename + authz (Task 1) ✓; no-arch / os·runtimes display (Task 3 `meta`) ✓; delete old modals, no hybrid (Task 4) ✓; i18n en+zh (Task 3) ✓; DRY command (Task 2) ✓; verification curl+browser+verifier (Task 5 + develop Phase 6) ✓; doc-sync ARCHITECTURE/FEATURES/README (Task 1 + 5) ✓.
- **Placeholder scan:** none — all code blocks are concrete.
- **Type consistency:** `ConnectComputerWizard` prop shape identical in Tasks 3/4; `daemonConnectCommand(origin,key)` identical in Tasks 2/3; PATCH response shape matches the GET list row shape used by the store.
- **Known edge handled:** generate failure → inline error + Retry; Cancel mid-wait → close (machine row stays offline, harmless); reconnect-on-online → backend 409 (UI only offers reconnect when offline); rename empty/unchanged → no PATCH.
