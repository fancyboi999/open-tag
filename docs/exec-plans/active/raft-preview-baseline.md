# Preview-only Raft reference baseline

## Goal

Build a local and Preview-only alternative Web shell while preserving OpenTag's existing routes,
auth, store, REST, Socket.IO, capabilities, Agent runtime, machine state, and classic shell.

The visible structure is measured against the segregated third-party reference contract in
`references/raft-baseline/`. The result is an implementation baseline, not OpenTag branding and
not permission to copy third-party source or assets.

## Delivery order and verification

1. Lock the page-by-viewport-by-state matrix, capture protocol, noise floor, and `2 CSS px` edge
   gate. Verify with `npm run reference:check`.
2. Add a Production-fail-closed Preview selector and centralized page/parent metadata. Verify
   route, deep-link, refresh, history, workspace-switch, and classic-default tests.
3. Align desktop shell, mobile roots, and public/auth/bootstrap surfaces against matched evidence.
4. Add deterministic mobile detail return, then align chat, tasks/files, search/activity/saved/
   showcase, members/profiles, and settings/machines without changing server contracts.
5. Run root/web typecheck, production Web build, focused tests, real desktop/mobile browser journeys,
   exact-head protected-surface diff, visual thresholds, and classic-shell rollback.

## Progress log

- 2026-08-21: created `feature/raft-preview-baseline` from `origin/main` in an isolated worktree.
- 2026-08-21: measured public, Workspace, channel, search, activity, tasks, members, computer, and
  settings surfaces at required desktop/mobile viewports in one ego-browser task space.
- 2026-08-21: measured the `768px`/`767px` responsive seam, representative interaction states,
  light-only theme behavior, and a three-screenshot noise floor; reference artifacts are now
  mechanically checked.
- 2026-08-21: added a development/Preview-only Baseline shell selector, immediate Classic rollback,
  centralized page/parent metadata, and query/hash-preserving workspace canonicalization. Unit tests,
  root/web typecheck, Preview and production builds, and real-browser deep-link/session checks pass;
  the production build rejected a forced Baseline URL and rendered Classic.
- 2026-08-21: aligned the Baseline desktop shell at `1440×900` and the locked `768px` seam: `64px`
  global rail, `240px` section sidebar, main content at `x=304`, a separate channel tab row, fixed
  internal scrolling, and an on-demand `320px` thread/profile column. Real-browser keyboard, hover,
  selected, menu Escape, panel Escape/focus-return, overflow, and Classic rollback journeys pass.

## Decision log

- Raw third-party screenshots and private semantic snapshots remain in gitignored `.shots/`.
- Only redacted routes, measurements, hashes, and aggregate image statistics may be committed.
- The visual thresholds are frozen before UI coding and cannot be relaxed to make later tickets pass.
- Accessibility and licensing conflicts are explicit intentional differences, never silent parity.
- No server, database, REST, Socket.IO, daemon, Agent API, runtime adapter, or connector changes are
  allowed by this plan.
- Ticket #305 establishes only the shell/routing seam. Its browser evidence verifies selection and
  rollback behavior; visual threshold comparisons begin when tickets #306/#307 add visible baseline
  shell geometry.
- Ticket #306 owns desktop shell geometry and interaction chrome, not the final message/task/member/
  settings contents; those dynamic regions remain assigned to tickets #309–#313. The committed #306
  evidence records zero-delta critical shell edges and the corresponding visible content gaps rather
  than masking downstream module layout.
