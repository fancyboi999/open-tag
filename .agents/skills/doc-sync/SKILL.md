---
name: doc-sync
description: Reconcile docs with code after a change (or as a periodic audit). Use before calling any change "done", at the end of every PR, or when asked to audit doc/code drift. Enforces this repo's hard rule: code change = doc change in the same commit.
---

# doc-sync — keep docs and code converged

This repo treats doc lag as **an unfinished bug** (see AGENTS.md § Doc-sync discipline).
This skill is the executable procedure; the canonical *mapping table* (which change owes
which doc) lives in **AGENTS.md** — read it there, do not copy it here.

## Mode 1 — per-change sync (run at the end of every change)

1. **Determine the change surface.**
   `git diff --stat origin/main...HEAD` (or the staged diff for uncommitted work).

2. **Map each changed path against the AGENTS.md doc-sync table.** Produce the list of
   docs owed by this change. The high-traffic rows:
   - `src/db/schema.ts` → `docs/generated/db-schema.md` (hand-maintained snapshot — update
     the table row *and* any enum lists; prod DB migrates via `prod:up` → `db:push:prod`).
   - Routes / CLI subcommands / daemon protocol → `ARCHITECTURE.md` §II codemap + §IV contracts.
   - Module purpose / boundary / invariant changed → `ARCHITECTURE.md` §II–IV.
   - Feature completed or modified → `FEATURES.md` checkbox (**checkbox + a short note**;
     long verification narratives belong in the PR, not the checklist).
   - TODO / known drift left behind → `docs/tech-debt-tracker.md` new entry
     (next free ID — check the **archive** too so IDs are never reused).
   - `src/daemon/**` shipped in the bundle → bump `packages/daemon/package.json`,
     cut a GitHub Release, **and add the version's `CHANGELOG.md` entry**. Merged ≠ shipped.

3. **Status single-source rule.** Security/authorization item states (F*/C*/IDOR-B*) live
   **only** in `docs/authorization.md` §6. Other docs (PLANS, tech-debt I44) may point
   there but must never mirror per-item states — mirrored lists are how C10 stayed
   "remaining" for weeks after it was fixed.

4. **Staleness check on every doc you touched.** For each edited doc: file paths it names
   exist; `tech-debt I<n>` / `D<n>` references resolve (tracker or archive); counts/enums
   match code (`grep`, `wc -l` — better: drop volatile numbers entirely, per
   ARCHITECTURE.md's header rule).

5. **Hygiene gates.**
   - Committed files carry zero personal/machine refs (core belief #9):
     `grep -rE '~/\.claude|/Users/' <changed committed files>` → expect zero hits.
   - Touched `src/daemon/prompt.ts`? Grep for provider-specific tool names
     (`Read`, `cat`, `grep`, vision hints) → expect zero hits (code-quality red line).

6. **Fail loud.** In the PR/summary, list: docs updated · docs checked-and-clean ·
   drift found but deferred (with its new tech-debt entry ID).

## Mode 2 — periodic full audit (on request / doc-gardening)

Cross-check the four *status* documents against code and each other; they drift fastest:

1. `FEATURES.md` — sample every `[ ]` unchecked line: is the feature actually still
   missing? (grep the endpoint / CLI verb / component). Unchecked-but-shipped is the
   most common rot.
2. `docs/PLANS.md` — every referenced plan file exists; Active items are still active;
   completed plans moved to `docs/exec-plans/completed/`.
3. `docs/tech-debt-tracker.md` — no duplicate IDs (incl. vs the archive); ⬜/🟡 entries
   spot-checked against code; newly-✅ entries moved to the archive with a one-line
   index left behind.
4. `docs/authorization.md` §6 vs any doc that mentions security items — pointers only,
   no mirrored states.
5. `ARCHITECTURE.md` §II — new substantive modules (>50 lines) present in the codemap;
   named files exist; `CHANGELOG.md` covers every published daemon version
   (`packages/daemon/package.json` vs the newest CHANGELOG heading).

Report findings with file:line evidence; fix mechanically-safe drift in the same pass,
open tech-debt entries for anything needing a decision.
