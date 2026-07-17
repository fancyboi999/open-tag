# MISSION — Build open-tag into a Shippable Open-Source Product

> open-tag's north star and working directive. Any session that adds or changes a capability **must read this first**, alongside `AGENTS.md`, `docs/core-beliefs.md`, and `docs/tech-debt-tracker.md`.

## Goal

Build **open-tag** — an open-source, self-hosted, privacy-first alternative to Claude Tag — into a product that is ready to publish on GitHub and safe to run on-premises with data that never leaves the internal network. Not a toy. Not a demo. A real multi-agent workspace where humans and AI agents collaborate as teammates in channels, threads, and DMs, with agents that have memory, stay alive on a daemon host, can be @-mentioned, claim tasks, message each other, and wake on events.

The construction method is **harness engineering**: give agents a codemap (ARCHITECTURE.md), encode architectural invariants as constraints, publish composable skills, and use doc-sync as a continuous feedback loop. Every capability slice is verified end-to-end in a real browser before it counts as done.

## Iron Rules (violate → redo)

1. **Evidence-driven, no speculation.** Before implementing any feature: read the existing code to understand what is already built (a great deal is), read `ARCHITECTURE.md` to find the right place to change, and read `docs/tech-debt-tracker.md` for known issues in that area. Do not invent payload shapes or behavior from memory. If a behavior is ambiguous, write a small curl probe against the real running server and observe.

2. **Advance in user-visible capability slices, not REST endpoints.** The unit of work is a capability a user can perceive — "sent messages appear in real time", "task card moves across the board", "agent ↔ agent DM produces a reply". Each slice must cut **vertically** through REST + socket + DB + daemon + agent in one go. Ship one working slice before starting the next. `ARCHITECTURE.md` and `FEATURES.md` are the spec lists; they are not the work queue itself.

3. **Understand before changing; do not rebuild what exists.** Read `ARCHITECTURE.md` to locate the right module, read the actual source to confirm what is already implemented (channels / DM / tasks / threads / members / agent profile / the runtime adapters / idle-sleep are largely done), then make a surgical change. Scan `docs/tech-debt-tracker.md` for related debt before touching anything.

4. **Close the loop with real verification on every slice.** A slice is not done until: ① the server is running and accepts real HTTP/WS traffic → ② `curl` hits the real endpoint and returns the expected shape → ③ `chrome-devtools` opens our own web UI and the interaction works end-to-end in a real browser → ④ `/doc-sync` is run to reconcile docs. **Claiming "done" requires attaching real evidence** (command output, screenshot). Follow the global "real verification criteria + Fail loud" rules without exception.

5. **Scope discipline — focus on the collaboration core.** Features that are not relevant to a self-hosted open-source workspace can be deferred or omitted: billing, OAuth marketplace, cross-workspace channels, message translation, proprietary telemetry uploads. The core is: channels / DM / threads / tasks / @mentions / real-time sync / agent communication & collaboration / agent lifecycle.

## What "Done" Looks Like for a Slice

A slice is complete when **all four** hold:

- The feature works end-to-end in our own web UI (real click, real network, real DB write).
- The relevant REST endpoint and socket event match the shape described in `ARCHITECTURE.md`.
- Documentation is updated in the same commit (schema → `docs/generated/db-schema.md`, routes → `ARCHITECTURE.md`, features → `FEATURES.md`).
- Real evidence (curl output or screenshot) is attached to the PR or session summary.

## When Something Is Unclear (in order)

1. **Unclear product requirement** → Re-read `FEATURES.md` and `ARCHITECTURE.md`. If still ambiguous, write a minimal probe (curl / browser) against the running server and observe actual behavior.
2. **Unclear implementation approach** → Read the existing source in `src/`. Most patterns are already established; follow them. Consult open-source references only when the codebase gives no signal.
3. **Unclear Claude Code / Codex behavior** → Read the official documentation.
4. **Runtime choice**: prefer **claude / codex** runtimes (subscription quota, low cost). Only use other runtimes when there is a specific architectural reason.

## Obey Existing Repository Conventions

`AGENTS.md` (the repo map) · `docs/core-beliefs.md` (load-bearing beliefs) · **doc-sync discipline** (changing code = changing docs; run `/doc-sync` at the end) · committed files must contain **zero personal / machine-specific references** (core belief #9). For complex changes, write a short spec in `docs/exec-plans/active/` before writing code.

## Success Criteria

Every capability works with a real click in our own web UI, is backed by real running evidence, and has up-to-date documentation — slice by slice, accumulating into a product that is genuinely ready to open-source on GitHub.
