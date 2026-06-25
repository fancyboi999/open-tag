# Tasks board layout toggle (horizontal columns ↔ vertical stack)

**Date:** 2026-06-25
**Status:** approved (user sign-off 2026-06-25)
**Component:** `web/src/TaskBoard.tsx` + `web/src/styles.css`

## Problem

The Tasks "Board" view renders its five status columns (todo / in_progress /
in_review / done / closed) **stacked vertically** — each `DroppableCol` flows
top-to-bottom in the block-level `.scroll` container. Users expect a real
horizontal Kanban (columns side by side), like every other task board
(Trello / Linear / Jira / Notion) and like the reference product the user showed.

This is also a **doc/implementation drift**: `ARCHITECTURE.md:103` already
describes `TaskBoard.tsx` as a "5-column **kanban**", but the layout was never
laid out horizontally.

### Root cause (located, not guessed)

- `TaskBoard.tsx:192-195` renders `TCOLS.map(... <DroppableCol/>)` directly into
  `.scroll`. `DndContext` contributes no layout.
- `.scroll` (`styles.css:167`) is a plain block container (`flex:1; overflow:auto`,
  **no** `display:flex`), and `.task-col` (`styles.css:256`) has only
  `margin-bottom:20px` — **no horizontal positioning**. So columns stack as normal
  block flow, each full-width.
- The likely reason it was built vertical: `TaskBoard` is mounted in **two** places
  — the full-width global Tasks page (`views/misc.tsx:33`) **and** the narrower
  embedded channel tasks tab (`views/Chat.tsx:237`). Vertical stacking degrades
  gracefully in the narrow panel. Any horizontal solution must keep that working.

## Decision

Add a **persisted layout toggle**, keeping both layouts (user-chosen option). The
horizontal Kanban becomes the default; the vertical stack stays available for the
narrow embedded panel and personal preference.

Rejected alternatives:
- *Replace Board with horizontal only* — removes the vertical option the narrow
  embedded tab benefits from; user explicitly asked for a switch.
- *Three-way Board/Stack/List buttons* — extra control, Board vs Stack overlap;
  over-engineered.

## Design

### State (`TaskBoard.tsx`)
- New `boardLayout: "columns" | "stack"`, initialised from
  `localStorage["open-tag.tasks.boardLayout"]`, default `"columns"` (horizontal).
- Persist on change — **reuse the exact pattern** already used for `collapsed`
  (`TaskBoard.tsx:51-52`). No new persistence mechanism.

### Control (toolbar)
- A second `.seg` segmented control next to the Board/List one, rendered **only when
  `view === "board"`** (layout is meaningless for List).
- Two icon buttons: horizontal columns (`Columns3`) / vertical stack (`Rows3`), each
  with `title` + `aria-label` from new i18n keys `tasks.layoutColumns` /
  `tasks.layoutStack` (added to `zh.json` + `en.json`).

### Render (one wrapper, DnD untouched)
```
<DndContext …>
  <div className={"task-board " + boardLayout}>
    {TCOLS.map(([k, labelKey]) => <DroppableCol key={k} k={k} labelKey={labelKey} />)}
  </div>
</DndContext>
```
DnD is hit-tested by pointer-over rectangle → **layout-agnostic, zero logic change**.
`StatusPill`'s fixed-position menu already closes on any scroll (capture-phase
`scroll` listener), so the horizontal scroll container is handled.

### CSS (`styles.css`)
- `.task-board.columns{display:flex;gap:14px;align-items:flex-start;overflow-x:auto;padding-bottom:6px}`
- `.task-board.columns .task-col{flex:0 0 300px;min-width:280px;margin-bottom:0}`
  — min-width + horizontal scroll is the narrow-panel fallback.
- `.task-board.stack .task-col{margin-bottom:20px}` — current behavior preserved.
- `collapsed` still hides cards / keeps the header; in horizontal mode a collapsed
  column also shrinks to its header
  (`.task-board.columns .task-col.collapsed{flex:0 0 auto;min-width:0}`) so the
  default-collapsed done/closed columns don't leave two wide empty 300px slots at the
  right edge (raised by the independent verifier). Vertical mode is unaffected.

## Out of scope (fail-loud)

- dnd-kit does not auto-scroll the horizontal container when dragging a card past the
  viewport edge; the user scrolls manually before dropping into an off-screen column.
  Not building auto-scroll in this slice.
- No change to task data, API, the List view, collapse persistence, auth/agent
  planes, or the DB schema.

## Verification

1. `node:test` CSS-assertion unit test (mirror `profileActivityScrollLayout.unit.test.ts`)
   — fails on `main` (no `.task-board.columns` rule), passes after.
2. `npm run typecheck` (root + web) green.
3. `npm run build --prefix web` green.
4. chrome-devtools on the running app: default horizontal; toggle to stack; reload
   persists; drag a card across columns in horizontal mode changes status; embedded
   narrow channel tasks tab not broken.

## Doc-sync

- `ARCHITECTURE.md:103` — update the TaskBoard line to note the horizontal/stack
  layout toggle (resolves the "5-column kanban" vs vertical-stack drift).
- `FEATURES.md` — tasks board entry if present.
