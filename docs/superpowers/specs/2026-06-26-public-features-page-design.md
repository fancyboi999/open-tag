# Public Features Page Design

## Goal

Create a public `/features` page for open-tag that can be linked from the landing page and used for promotion. The page should explain the product through concrete collaboration cases, not through a generic feature checklist.

## Scope

- Add a public React route at `/features`.
- Add a landing nav link to `/features`.
- Reuse the existing landing visual system (`.lp-*`) and keep styles scoped under `web/src/landing/landing.css`.
- Show five use-case sections inspired by the public Claude Tag and Loop feature-page structures, rewritten for open-tag and rendered with open-tag UI concepts.
- Make each case expose the core loop: channel message -> task -> thread replies -> result.

## Non-Goals

- No backend routes, DB seed, auth changes, or live demo workspace.
- No copied competitor copy, screenshots, or brand assets.
- No claims about integrations or Slack-native behavior that open-tag does not currently ship.

## Content Model

Each case has:

- A compact narrative panel: title, description, three proof bullets, outcome line.
- A product UI demo panel: workspace chrome, channel messages, task status, and a clickable thread pill.
- A thread drawer that opens inside the demo when the user clicks the reply-count pill.

The five cases are:

1. Tag an agent into a channel.
2. Build from the task thread.
3. Catch up on a long conversation.
4. Monitor what matters.
5. Run one workspace for humans and agents.

## Verification

- `npm run typecheck`
- `npm --prefix web run build`
- Browser check `/features` at desktop width.
- Browser click check: open at least one thread pill and verify the thread drawer appears.
- Browser check `/features` at mobile width for no obvious overlap.
