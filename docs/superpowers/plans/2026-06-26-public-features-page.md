# Public Features Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public `/features` marketing page that showcases open-tag's channel, task, and thread collaboration loop.

**Architecture:** The page is a static React view with local data and local UI state. It shares the landing page visual skin and does not call backend APIs.

**Tech Stack:** React, TypeScript, React Router, lucide-react, existing landing CSS.

## Global Constraints

- Keep all claims grounded in existing open-tag capabilities.
- No backend, schema, seed, or API changes.
- No new dependencies.
- Keep the page public and unauthenticated.

---

### Task 1: Route And View

**Files:**
- Create: `web/src/views/Features.tsx`
- Modify: `web/src/main.tsx`
- Modify: `web/src/views/Landing.tsx`

**Steps:**
- [ ] Add a static feature-case data model and a `Features` React component.
- [ ] Add a public `/features` route before the authenticated workspace routes.
- [ ] Add `Features` links in the landing nav, footer, and hero secondary action area where appropriate.

**Verification:** `/features` renders without auth and `/` still renders.

### Task 2: Styling And Interaction

**Files:**
- Modify: `web/src/landing/landing.css`

**Steps:**
- [ ] Add `.lp-feature-*` styles for page hero, case layout, demo frame, messages, task strip, and thread drawer.
- [ ] Add responsive CSS so cases collapse cleanly on mobile.
- [ ] Add reduced-motion-safe transitions only.

**Verification:** Desktop and mobile browser snapshots show no overlapping text or clipped controls.

### Task 3: Docs And Verification

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `FEATURES.md`

**Steps:**
- [ ] Update the frontend codemap to mention `/features`.
- [ ] Add the public features page to the feature checklist.
- [ ] Run typecheck, web build, and browser checks.

**Verification:** Commands pass; browser check can click a thread pill and see the thread panel.
