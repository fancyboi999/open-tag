# Product

## Users

**Human engineers/members** and **resident AI agents** inside a self-hosted team workspace, collaborating as colleagues.
- **Humans**: send messages in channels/threads/tasks, @ -mention agents to wake them, assign work, review output, manage members and permissions. Context: "keeping this workspace open as the collaboration hub" — like using Slack, except your teammates include AI.
- **Agents**: multi-runtime (claude / codex / copilot / opencode / kimi / pi / cursor / hermes), resident "employees" attached to a daemon host — they have memory (MEMORY.md), wake on @-mention, claim tasks, DM each other for collaboration, idle-sleep when quiet, and resume on events.
- **Deployment requirement**: self-hosted, data never leaves your network; credentials centralized, agents never touch plaintext keys.

## Product Purpose

An open-source, self-hosted alternative to managed multi-agent workspace products — Slack-style **multi-agent collaboration workspace**. Humans and AI agents work together as colleagues in channels, threads, and task boards; agents are resident employees with memory attached to a daemon host, can be @-mentioned, claim tasks, message each other, and wake on events.

Key difference from SaaS alternatives: **code is yours, self-hostable, data stays in your network**. Protocol and data model are designed to be production-grade rather than demo-ware, and every capability is verified with real running software — not stubs.

Success = a **genuinely shippable open-source product**: core collaboration capabilities (channels/threads/tasks/members/permissions/invites/multi-agent runtimes) end-to-end usable, verified with real runtime evidence — not a demo, not a stub.

## Brand Personality

**Quietly editorial** — a multi-agent collaboration tool whose interface reads like an editorial print magazine.

- 3 words: **editorial · calm · expert** (restrained, professional, unobtrusive).
- Visual energy comes from **whitespace, font weight, hairline dividers** — not saturated color or neon accents. Off-white canvas (`#f5f5f5`) + warm near-black ink (`#292524`); soft gradient orbs (mint/peach/lavender/sky) are the only "color" moments.
- Typography: EB Garamond serif as **editorial signature** (brand mark/sidebar headings/modal titles/empty state headings), Inter for body/navigation/labels.
- Restrained CTAs: near-black pill is the primary action (used sparingly), transparent outline is secondary.
- Full visual specification: **DESIGN.md** (a warm-editorial design system — the project's own visual language).

## Anti-references

- **Brutal visual skin** (`bg-brutal-*`, thick black borders, `shadow-brutal`, saturated pastel blocks) — **load-bearing red line**: we take the **UI structure/interactions** from established Slack-style workspaces (channels/threads/tasks/members layout, click navigation, right-click menus, hover states), **never the visual style**; all skinning follows DESIGN.md editorial approach.
- SaaS-cream / sand / parchment warm-white cookie-cutter aesthetics.
- Developer-tool dark canvas.
- Saturated CTA colors, neon accents, gradient text, glass morphism as default.
- Emoji as UI icons (icons are always lucide-react SVGs).

## Design Principles

1. **Take structure, not skin**: UI structure/interactions align closely with established Slack-style workspace conventions (so people familiar with such tools are immediately at home), visual skin always follows DESIGN.md editorial approach. These two are intentionally decoupled.
2. **Evidence-driven, no guesswork**: before building any feature, verify the expected behavior with real running software (browser interaction + curl against real endpoints + code inspection); never guess behavior from API names or impressions alone.
3. **Data never leaves your network**: self-hosted first; credentials centrally managed, agents work through a proxy and never touch plaintext; storage backend is swappable but storageKey is driver-agnostic.
4. **Agent as "employee"**: single-threaded like a human — one task at a time, has an inbox, idle-sleeps, picks up via MEMORY.md. Scale by "hiring more people" (parallel agents), not by making one agent multi-thread; collaborate via messages.
5. **Real verification means done**: completing code ≠ completing the task. Every capability is verified with real running software (curl real endpoints + browser interaction + evidence attached), and failures are reported loudly including what was skipped/warned/not covered.
6. **Provider-agnostic**: agent standing prompt is shared across all runtimes; describes only general capabilities, never names provider-specific tool names — shared prompts must not overfit to any provider.

## Accessibility & Inclusion

- Contrast: body text ≥4.5:1, large text ≥3:1 (avoid light-grey body on off-white).
- `prefers-reduced-motion` degraded gracefully (gradients/animations have static fallbacks).
- Icons use lucide-react SVG (semantic, scalable), not emoji.
- Mixed CJK/Latin text handled correctly (PingFang SC font stack, URL/punctuation handling).
- Keyboard-accessible: modal Esc to close, interactive elements are real `<button>`/`<a>`.
