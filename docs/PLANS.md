# Plans (PLANS)

> Plans are first-class artifacts, versioned in the repository, so any agent or contributor can pick up work without needing external context.
>
> Conventions:
> - **Small changes**: a lightweight plan is enough — one-sentence goal + verification criterion, written in the PR description or as a short entry below.
> - **Complex work**: write a full execution plan in `docs/exec-plans/active/<slug>.md` (containing goal, steps, progress log, decision log). Move to `docs/exec-plans/completed/` when done.
> - Every step carries a **verifiable criterion** — translate vague tasks into testable goals and loop until the criterion passes.
> - **Historical archive**: `docs/superpowers/specs/` holds design-spec documents from an earlier planning workflow (2026-06-24 → 2026-07-01); kept read-only because code still cites them as design rationale. The matching execution-log `plans/` were deleted 2026-07-29 (shipped work; recover via git history). New plans go in `docs/exec-plans/`, not there.
>
> **Status single-source rule**: this file *indexes* work; it does not mirror per-item states owned elsewhere. Security/authorization item states live **only** in `docs/authorization.md` §6; feature completion lives in `FEATURES.md`; drift/debt lives in `docs/tech-debt-tracker.md`. (A mirrored list here once kept C10 marked "remaining" for ten days after it was fixed.)

## Active

- **Authorization hardening** — a two-plane security audit (human `routes-api` + agent `routes-agent`)
  surfaced ~20 access-control gaps; nearly all are closed. The canonical model + the **live status
  register** are in **[`docs/authorization.md`](./authorization.md)** §6 — check there, not here
  (per the single-source rule above, this file names no per-item states). **越权很危险 — verify each fix.**

- **Harness engineering rollout** — remaining: mechanically enforce invariants (lint/CI — tech-debt I5),
  independent evaluator loop, scheduled doc-gardening. Done: `ARCHITECTURE.md` codemap, `docs/` skeleton,
  `CLAUDE.md` slimmed to an `AGENTS.md` import, git, `/doc-sync` skill (`.agents/skills/doc-sync/`).

- **Reasonix runtime** — new compute-plane adapter (experimental) for the DeepSeek-native Reasonix CLI: one-shot-per-turn via `reasonix run --output-format stream-json`, resumed by `--resume <session-file>` (session file under `$REASONIX_HOME/projects/<encoded-cwd>/sessions/`), model enumeration via `reasonix doctor --json`. Execution plan: [`docs/exec-plans/active/reasonix-runtime.md`](./exec-plans/active/reasonix-runtime.md).

*(Completed plans live in `docs/exec-plans/completed/`.)*

## Completed slice history (index only)

The early capability slices shipped and their working notes were not retained as plan files;
their verified end state is recorded in `FEATURES.md`:

- **Safe daemon project browser** - manual entry plus a machine-targeted shared-root picker and
  bounded marker discovery, with the same fail-closed policy applied again at runtime start.
  Evidence: [`docs/exec-plans/completed/project-directory-browser.md`](./exec-plans/completed/project-directory-browser.md).
- **Per-agent project directory binding** — runtime cwd/state separation across all eight adapters,
  machine-local canonicalization, no project instruction rewrites, symlink-safe state operations, and
  capability/stop race hardening. Evidence: [`docs/exec-plans/completed/project-directory-binding.md`](./exec-plans/completed/project-directory-binding.md).
- **Reply coordination** — observation remains broad while trigger-bound primary/supplemental
  grants constrain publication; mistaken mentions transfer through audited intent and private
  coordination. Contract: [`docs/reply-coordination.md`](./reply-coordination.md); evidence:
  [`docs/exec-plans/completed/reply-coordination.md`](./exec-plans/completed/reply-coordination.md).
- **Directed reply coordination** — explicit mentions get independent one-shot grants,
  Tasks retain one coordinator while named contributors publish in-thread, and active
  agent-authored mentions remain work edges. Evidence:
  [`docs/exec-plans/completed/directed-reply-coordination.md`](./exec-plans/completed/directed-reply-coordination.md).
- **Conversation Turns** — sender/channel-scoped burst admission, durable responsibility,
  stable-check visibility, idempotent daemon delivery, and bounded agent causality. Evidence:
  [`docs/exec-plans/completed/conversation-turns.md`](./exec-plans/completed/conversation-turns.md).
- **01 Agent communication loop + agent ↔ agent collaboration** ✅ (FEATURES P5)
- **02 Saved Messages** ✅ (FEATURES P3)
- **03 / 03b Tasks end-to-end + interaction rework** ✅ (FEATURES P4 — board move UX, layout toggle, DM tasks, handoff)
- **04 Message rendering** ✅ (markdown + structured-mention links + no-raw-HTML invariant, `web/src/messageRender.tsx`; ARCHITECTURE §III)
- **Inline Agent Activity** ✅ — channel/DM/thread runs now keep their status, thinking, and tool calls in durable per-message disclosures; no-message runs leave a quiet handled/error receipt; the permanent Live Trace column is gone. [Execution plan](./exec-plans/completed/inline-agent-activity.md).
- Early fixed bugs: double message delivery (StrictMode double-socket) / Chinese IME Enter mis-send → tech-debt I9/I10

## Roadmap (index only — ground truth is the code + `FEATURES.md`)

1. Foundation (PG + Redis + Drizzle + TS) ✅
2. Agent lifecycle (idle-sleep + resume) ✅
3. Channel core (multi-channel / DM / private + seq + real-time) ✅
4. Tasks / threads ✅
5. Agent ↔ agent messaging + task handoff ✅
6. Agent profile (seven facets) ✅
7. Advanced capabilities: human message search ✅ · knowledge base ⬜ · integrations ⬜ · credential proxy ⬜ · web push ⬜
