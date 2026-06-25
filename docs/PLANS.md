# Plans (PLANS)

> Plans are first-class artifacts, versioned in the repository, so any agent or contributor can pick up work without needing external context.
>
> Conventions:
> - **Small changes**: a lightweight plan is enough — one-sentence goal + verification criterion, written in the PR description or as a short entry below.
> - **Complex work**: write a full execution plan in `docs/exec-plans/active/<slug>.md` (containing goal, steps, progress log, decision log). Move to `docs/exec-plans/completed/` when done.
> - Every step carries a **verifiable criterion** — translate vague tasks into testable goals and loop until the criterion passes.

## Active

- **Authorization hardening** — a two-plane security audit (human `routes-api` + agent `routes-agent`)
  surfaced ~20 access-control gaps. The canonical model + the full prioritized findings register live in
  **[`docs/authorization.md`](./authorization.md)** (§6 roadmap). Shipped: (1) cross-tenant IDOR batch
  (F4/F6/F7/F9/F10 + C9) + machine `manageMachines` (F1/F2) + C11; (2) the **agent-plane channel-access
  layer** (C1/C2/C3/C6/C7/C8 + server/info) via `canAgentReadChannel` — agents freely use public channels +
  their threads, but private/DM are invite-only (real agent-api E2E verified). This is the security boundary
  the "agents join channels/threads" feature sits on. Remaining slices — each its own PR with a
  cross-tenant/cross-channel test: human capability gates (F3/F5/F8); task-ownership (C5); auth primitives
  (C4 deleted-agent token still valid → HIGH; C10/C12). **越权很危险 — verify each fix.**

- **Harness engineering rollout** — ordered checklist: git init → slim CLAUDE.md → mechanically enforce invariants → independent evaluator loop → one-command instance start → plans in repo / doc-gardening → planner/generator/evaluator personas. Current state: `ARCHITECTURE.md` ✅, `docs/` skeleton ✅, `CLAUDE.md` slimmed ✅, git ✅; remaining items ⬜.

### Capability Slice Progress (evidence-driven; specs in `docs/exec-plans/active/`)

- **01 Agent communication loop + agent ↔ agent collaboration** ✅ closed-loop verified (`01-agent-comm-loop.md`)
- **02 Saved Messages** ✅ full-stack implemented (`02-saved-messages.md`)
- **03 Tasks end-to-end** ✅ core loop closed (card navigation / socket bug / enum validation / thread-on-create / DELETE; `03-tasks.md`)
- **03b Task interaction rework** ⬜ in progress — several interaction details were wrong on first pass (`03-tasks.md` §9): thread-on-create ✅ fixed and verified; remaining: D2 card click → open thread panel / D4 DONE·CLOSED column collapse / D5 status dropdown permissions / D6 drag-and-drop / D7 legacy / card styling
- **04 Rich text / syntax-highlighted message rendering** ⬜ researching — no unified rich-text renderer yet (`04-message-rendering.md`)
- **Fixed bugs**: double message delivery (StrictMode double-socket) / Chinese IME Enter mis-send → tech-debt I9/I10

## Roadmap (index only — most items already implemented)

1. Foundation (PG + Redis + Drizzle + TS) ✅
2. Agent lifecycle (idle-sleep + resume) ✅
3. Channel core (multi-channel / DM / private + seq + real-time) ✅
4. Tasks / threads ✅ (code done; `FEATURES.md` markers pending cleanup, see tech-debt D4)
5. Agent ↔ agent messaging 🟡
6. Agent profile (seven facets) ✅
7. Advanced capabilities: knowledge base / search 🟡, integrations ⬜, credential proxy ⬜, wake hints ⬜

> Ground truth is the code; `FEATURES.md` checkbox state may lag (see `tech-debt-tracker.md` D4).
