# Raft reference baseline

This directory is a measurement contract for the temporary, Preview-only UI baseline. It is
not a copy of Raft source code, brand assets, private workspace content, or a specification for
OpenTag business behavior.

## Fixed capture environment

- Browser: ego-browser task space `raft baseline issue 304`, Chromium 150.
- Zoom and screenshot scale: page scale `1`, device scale factor `1`.
- Required viewports: `1440x900`, `390x844`, and `375x812`.
- Responsive seam: `768px` is the last desktop layout; `767px` is the first mobile layout.
- Theme: light. Emulating a dark operating-system preference did not change the reference; the
  appearance page exposed text-size choices, not a second color theme.
- Language: use one fixed locale per comparison. Do not compare different translations.

The same ego-browser task space is reused for all reference captures. Authentication, CAPTCHA,
or verification must use browser handoff; never bypass it. Raw screenshots and full semantic
snapshots belong under `.shots/raft-baseline/` (gitignored), because they can contain private
workspace data. Committed evidence is deliberately limited to routes, redacted labels, geometry,
computed styles, hashes, and aggregate image statistics.

## Capture protocol

For every matrix row implemented by a later ticket:

1. Set the exact viewport, device scale factor, page scale, locale, theme, route, test fixture, and
   precondition recorded in `matrix.json`.
2. Capture the reference before coding: a semantic snapshot, full-page screenshot, critical-region
   screenshot, bounding rectangles, and computed styles named in `evidence.schema.json`.
3. Capture OpenTag after coding under the same conditions. Do not substitute demo data for the
   existing auth, store, REST, Socket.IO, capability, Agent, or machine state.
4. Mask only dynamic user text, timestamps, avatars, cursors, and notification counters. A mask
   must use the same rectangle on both images and must not cover layout edges, controls, borders,
   or status indicators.
5. Record the reference/local artifact hashes, mask rectangles, aggregate diff, critical-region
   diff, and every intentional difference. License and accessibility exceptions require a reason,
   owner, and affected selectors; they are never silently treated as a pass.
6. Fail when a critical layout edge differs by more than `2 CSS px`, horizontal overflow appears,
   or a threshold below is exceeded. Thresholds are fixed by this file for tickets #305-#315.

## Locked visual gates

Three repeated `1440x900` captures at a stable account-detail state produced two byte-identical
images and one antialias-only delta: SSIM `1.000000` (79.24 dB), mean luma delta
`0.0000192901 / 255`, and maximum luma delta `8 / 255`. The following budgets are deliberately
above that measured noise while still making visible drift fail:

- Full page after masks: SSIM at least `0.995` and changed-pixel ratio at most `0.5%`.
- Critical region after masks: SSIM at least `0.998` and changed-pixel ratio at most `0.25%`.
- Critical layout boundaries: at most `2 CSS px` per edge.
- Horizontal overflow: exactly `0 CSS px` beyond the viewport.

Do not relax these numbers after implementation begins. If a browser upgrade changes the noise
floor, record a new three-sample calibration in a separate commit before changing product code.

## Representative measured facts

- Desktop global rail: `64px`; chat section sidebar begins at `x=64` and ends at `x=304`.
- Desktop global navigation buttons: `40x40`; focused server switcher uses a `3px` focus outline.
- Desktop body is fixed to the viewport and clips page-level overflow; internal regions scroll.
- Mobile primary navigation at `390x844`: a `2px` top divider at `y=791`, then four `51px`
  touch items at `y=793` with widths `98/98/98/96px`.
- Mobile detail pages have no primary bottom navigation. Channel, human profile, and account detail
  remained `390px` wide with no horizontal overflow.
- Mobile detail Back uses a `44px` touch target at `x=12,y=8` around a visible `28px` square at
  `x=20,y=16`; the top detail divider is the `2px` line at `y=60..61`.
- Mobile channel detail uses a top back control and reserves the lower viewport for status notice
  and Composer instead of showing the primary navigation.
- Reference typography resolved to `Raft Quote Glyphs`, `Space Grotesk`, `system-ui`, sans-serif.
  These names are measurements, not permission to copy a private font. OpenTag must use only assets
  with a verified license and record any resulting intentional difference.

## Known gaps

`matrix.json` explicitly marks states that could not be reached without mutating account or
workspace data, including anonymous auth screens in an already authenticated task space, invite
success/expiry variants, destructive settings states, and server-supplied loading/error cases.
Those rows remain mandatory for the corresponding implementation ticket, using OpenTag fixtures
and a handoff-backed reference session when available. A gap is not evidence of parity.
