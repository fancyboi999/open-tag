# Plans (PLANS)

> Plans are first-class artifacts, versioned in the repository, so any agent or contributor can pick up work without needing external context.
>
> Conventions:
> - **Small changes**: a lightweight plan is enough — one-sentence goal + verification criterion, written in the PR description or as a short entry below.
> - **Complex work**: write a full execution plan in `docs/exec-plans/active/<slug>.md` (containing goal, steps, progress log, decision log). Move to `docs/exec-plans/completed/` when done.
> - Every step carries a **verifiable criterion** — translate vague tasks into testable goals and loop until the criterion passes.
> - **Historical archive**: `docs/superpowers/{plans,specs}` holds plan/spec documents produced by an earlier planning workflow (2026-06-24 → 2026-07-01, e.g. dev-e2e harness, S3 storage, connect-computer wizard, task handoff). They are read-only records of shipped work — new plans go in `docs/exec-plans/`, not there.
>
> **Status single-source rule**: this file *indexes* work; it does not mirror per-item states owned elsewhere. Security/authorization item states live **only** in `docs/authorization.md` §6; feature completion lives in `FEATURES.md`; drift/debt lives in `docs/tech-debt-tracker.md`. (A mirrored list here once kept C10 marked "remaining" for ten days after it was fixed.)

## Active

- **Authorization hardening** — a two-plane security audit (human `routes-api` + agent `routes-agent`)
  surfaced ~20 access-control gaps; nearly all are closed (cross-tenant IDOR batch, agent-plane
  channel-access layer, human capability gates, human-plane IDOR-B1…B6, timing-safe compares).
  The canonical model + the **live status register** are in **[`docs/authorization.md`](./authorization.md)** §6
  — check there, not here. Open at last audit (2026-07-06): **C5** task-ownership (product decision)
  and **C12** agent-token TTL. **越权很危险 — verify each fix.**

- **Harness engineering rollout** — remaining: mechanically enforce invariants (lint/CI — tech-debt I5),
  independent evaluator loop, scheduled doc-gardening. Done: `ARCHITECTURE.md` codemap, `docs/` skeleton,
  `CLAUDE.md` slimmed to an `AGENTS.md` import, git, `/doc-sync` skill (`.agents/skills/doc-sync/`).

*(`docs/exec-plans/active/` is currently empty; completed plans live in `docs/exec-plans/completed/`.)*

## Completed slice history (index only)

The early capability slices shipped and their working notes were not retained as plan files;
their verified end state is recorded in `FEATURES.md`:

- **01 Agent communication loop + agent ↔ agent collaboration** ✅ (FEATURES P5)
- **02 Saved Messages** ✅ (FEATURES P3)
- **03 / 03b Tasks end-to-end + interaction rework** ✅ (FEATURES P4 — board move UX, layout toggle, DM tasks, handoff)
- **04 Message rendering** ✅ (markdown + structured-mention links + no-raw-HTML invariant, `web/src/messageRender.tsx`; ARCHITECTURE §III)
- Early fixed bugs: double message delivery (StrictMode double-socket) / Chinese IME Enter mis-send → tech-debt I9/I10

## Roadmap (index only — ground truth is the code + `FEATURES.md`)

1. Foundation (PG + Redis + Drizzle + TS) ✅
2. Agent lifecycle (idle-sleep + resume) ✅
3. Channel core (multi-channel / DM / private + seq + real-time) ✅
4. Tasks / threads ✅
5. Agent ↔ agent messaging + task handoff ✅
6. Agent profile (seven facets) ✅
7. Advanced capabilities: human message search ✅ · knowledge base ⬜ · integrations ⬜ · credential proxy ⬜ · web push ⬜
