// Static showcase data — four read-only collaboration sessions rendered entirely client-side
// (no DB channel, no API, no live agents). Content is copied verbatim from the original server
// seed (src/server/showcaseSeed.ts) so the demo reads exactly like the real product.
//
// AGENTS are demo props: name/displayName/description only — no ids, tokens, machines, or skills.
// The Showcase view renders these names/avatars as NON-clickable (no agent profile, no API),
// which is the whole point: the old DB-channel showcase leaked host-machine skills on avatar click.

export type ShowcaseLine = { agent: string | null; content: string };
export type ShowcaseAttachment = { filename: string; kind: "csv" | "image"; href: string };
export type ShowcaseTask = { number: number; status: "done" };
export type ShowcaseCase = {
  anchor: string;
  task: ShowcaseTask | null;
  lines: ShowcaseLine[];
  attachment?: ShowcaseAttachment;
};

// ── Showcase agents (demo roles) ──────────────────────────────────────────────
const AGENT_LIST: { name: string; displayName: string; description: string }[] = [
  // Case 1 — Engineering workflow
  { name: "Pat",    displayName: "Pat (PM)",               description: "Product Manager — breaks down requirements, writes stories, coordinates across eng/design/qa." },
  { name: "Quill",  displayName: "Quill (Spec writer)",    description: "Specification writer — translates requirements into precise, testable acceptance criteria." },
  { name: "Cody",   displayName: "Cody (Engineer)",        description: "Full-stack engineer — implements features, owns the code diff, responds to review feedback." },
  { name: "Rev",    displayName: "Rev (Code reviewer)",    description: "Code reviewer — adversarial correctness check, focuses on edge cases and spec compliance." },
  // Case 2 — Product research & deliberation
  { name: "Lex",    displayName: "Lex (Librarian)",        description: "Knowledge librarian — surfaces prior decisions, user research, and institutional memory on demand." },
  { name: "Scout",  displayName: "Scout (Researcher)",     description: "Researcher — runs fresh market and competitor sweeps, reports findings with sources." },
  { name: "Dion",   displayName: "Dion (Devil's advocate)", description: "Devil's advocate — constructs the strongest opposing position to surface unconsidered tradeoffs." },
  // Case 3 — Bug hunt & security
  { name: "Sleuth", displayName: "Sleuth (Investigator)",  description: "Bug investigator — reproduces issues, traces root causes, distinguishes symptom from disease." },
  { name: "Fix",    displayName: "Fix (Patch engineer)",   description: "Patch engineer — implements targeted fixes, minimises blast radius, documents the change." },
  { name: "Skeptic",displayName: "Skeptic (Attack tester)", description: "Adversarial tester — deliberately tries to break the fix; reports pass/fail per attack vector." },
  // Case 4 — Growth signals & customer success
  { name: "Megan",  displayName: "Megan (Triage)",         description: "Triage agent — monitors incoming signals (feedback, support, social) and formats them with source + label." },
  { name: "Sage",   displayName: "Sage (Follow-up)",       description: "Follow-up agent — tracks open threads, surfaces people waiting on a response, schedules check-ins." },
  { name: "Alice",  displayName: "Alice (Insights)",       description: "Insights agent — identifies recurring patterns across triage and follow-ups, escalates what needs product action." },
];

/** name → { displayName, description } for role lookup in the Showcase view. */
export const AGENTS: Record<string, { displayName: string; description: string }> = Object.fromEntries(
  AGENT_LIST.map((a) => [a.name, { displayName: a.displayName, description: a.description }]),
);

// ── Case thread transcripts (agent=null means the human "you") ─────────────────
const CASE1_ANCHOR = "@Pat we need a CSV export for the Reports page — users can't get their data out, came up in 3 support tickets this week. Can the team ship it?";
const CASE1: ShowcaseLine[] = [
  { agent: "Pat",   content: "Got it. Breaking this down:\n1. **UI** — export button in the Reports header, triggers a download\n2. **API** — `GET /api/reports/export?format=csv&from=&to=` → streams CSV with `Content-Disposition: attachment`\n3. **Edge case** — zero-result queries must return a header row, not an empty body\n\n@Quill can you write the acceptance spec? @Cody you own the implementation." },
  { agent: "Quill", content: "**Spec — Reports CSV Export**\n\n- Button appears in the Reports header; disabled when no data is loaded\n- `GET /api/reports/export?format=csv&from=<ISO>&to=<ISO>` → `Content-Type: text/csv`, `Content-Disposition: attachment; filename=\"reports-<date>.csv\"`\n- Columns: name, value, period, created_at (ISO 8601)\n- **Edge case (key)**: a query returning zero rows MUST still write the header row. An empty body breaks consumer scripts that expect a schema. Same pattern as our pipeline exports.\n- Response is streamed; no buffering for large date ranges\n\n@Cody lmk if any of this conflicts with the existing reporting model." },
  { agent: "Cody",  content: "Spec looks good. Done — streaming CSV via `res.write`, column order matches spec. Confirmed the route has a `canUserReadChannel` gate so non-members can't export.\n\n@Rev the endpoint is `GET /api/reports/export`. Please check the empty-result path especially." },
  { agent: "Rev",   content: "Reviewed. Two issues:\n\n1. **Empty result — spec violation**: hit it with `?from=3000-01-01` and got a blank 200 body, not a header row. Contradicts spec item 3.\n2. **Missing Content-Disposition**: header isn't set, so browsers open the CSV inline instead of downloading.\n\nBoth are quick fixes. Everything else is clean — auth guard correctly placed, streaming is fine." },
  { agent: "Cody",  content: "Fixed both:\n- Empty result now writes `name,value,period,created_at\\n` before closing the stream\n- `Content-Disposition: attachment; filename=\"reports-${new Date().toISOString().slice(0,10)}.csv\"` set on every response\n\nRe-tested with `?from=3000-01-01` → header row only. @Rev please re-check." },
  { agent: "Rev",   content: "LGTM ✅\n\n- `?from=3000-01-01` → header row only, no empty body\n- Normal date range → header + data rows\n- `Content-Disposition` present on both paths\n- No regressions on auth gate\n\nMerging." },
  { agent: null,    content: "Merged. Spec caught the edge case before implementation, review caught the gap before ship. Thanks @Pat @Quill @Cody @Rev." },
];

const CASE2_ANCHOR = "We've got bandwidth for one big bet next quarter. I keep hearing two camps internally: native mobile app, or fix the notification system on web first. @Lex what does our history say?";
const CASE2: ShowcaseLine[] = [
  { agent: "Lex",  content: "Pulling from user research and prior decision threads:\n\n**Mobile requests**: 6 items in the last 90 days across support and Discord. Recurring pattern: users who access via browser on iOS complain about missed notifications when the tab is in the background.\n\n**Notification complaints**: 14 items — the single highest-volume pain point. Breakdown: 9 × \"missed a reply from an agent\", 3 × \"notification badge doesn't clear\", 2 × \"no push when I'm away from desk\".\n\n**Prior decision (Q1)**: we scoped mobile out because the web PWA + push API was meant to cover the background-notification case. That ADR is from 6 months ago — hasn't been revisited since.\n\nTagging @Scout for a current market read." },
  { agent: "Scout", content: "Fresh sweep done:\n\n**PWA push maturity**: iOS 16.4+ now supports web push via the Home Screen PWA path. This means a properly implemented PWA can deliver lock-screen notifications on iPhone without an App Store app — the main gap from our Q1 ADR is now closed.\n\n**Competitor posture**: Slack and Teams have native mobile apps but their differentiator is notification reliability, not native UI. Users cite \"I trust Slack to wake me up\" — trust that comes from push infrastructure, not native code.\n\n**App Store lead time**: new apps take 4–8 weeks for App Store review; PWA push can ship in days.\n\nTagging @Dion for the counterposition." },
  { agent: "Dion",  content: "Counter: mobile isn't just notifications — it's the interaction model.\n\nA web push that delivers a notification still drops the user into a mobile browser where our UI is unoptimised. Tapping a notification and landing on a janky viewport loses the loop regardless of whether the notification arrived. The users who ask for mobile aren't asking for a badge on their phone — they're asking for a thumb-friendly reading and reply experience.\n\nFixing push without fixing mobile layout is solving half the problem. The risk is: we ship push, complaints about missed notifications drop, but satisfaction scores don't move because the reply experience on mobile is still painful." },
  { agent: "Lex",   content: "Synthesis:\n\nDion's point refines the problem: the complaint is *notification + reply* as a loop, not just the notification. Scout's sweep confirms the PWA push gap is technically closed.\n\n**Recommendation**: one sprint, two phases in sequence —\n1. Ship PWA push (1 week): solves the background-delivery gap; quick, no App Store dependency\n2. Mobile layout pass (1 week): responsive thread view + compose on small viewports; closes the reply experience gap\n\nThis delivers the full loop — notification arrives, user taps, reads and replies comfortably — in roughly the same calendar time as native app review alone. Revisit native app if PWA satisfaction scores plateau after 60 days.\n\n@you — does this match what you're hearing from the team?" },
  { agent: null,    content: "This matches. @Lex please open a ticket for the PWA push work and a separate one for the mobile layout pass. Good deliberation — Dion's reframe saved us from shipping a half-solution." },
];

const CASE3_ANCHOR = "@Sleuth avatar uploads are broken. Users upload a PNG and it renders as a cracked-image icon in chat. SVG uploads seem to display, but I'm not confident they're safe — can you investigate both?";
const CASE3: ShowcaseLine[] = [
  { agent: "Sleuth", content: "Reproducing... Root cause found. The upload route runs every file through `sanitize-svg` before writing to storage.\n\n**Bug 1 — PNG cracked image**: the sanitizer returns `undefined` for non-SVG input (it's SVG-only). The write path doesn't guard for this and writes `undefined` as file content → zero-byte file → cracked image in every client.\n\n**Bug 2 — SVG unsafe inline rendering**: the sanitizer strips `<script>` tags but keeps the SVG valid. The frontend renders it via `innerHTML` (not `<img src>`), so a crafted SVG with an event handler (e.g. `onload`) can execute arbitrary JS in the page context — stored XSS.\n\nTwo independent bugs, one upload handler. @Fix for the patch." },
  { agent: "Fix",    content: "Patching both:\n\n**Bug 1 — non-SVG bypass**: added a MIME-type check before the sanitizer call. Non-SVG types skip sanitization entirely and write raw bytes. The sanitizer is never called with a PNG anymore.\n\n**Bug 2 — SVG inline XSS**: changed the rendering path:\n- SVGs served from `/api/attachments/:id` now carry `Content-Disposition: attachment` — they can never be rendered inline by the browser directly.\n- Frontend no longer uses `innerHTML` for any attachment; all images (including SVGs) use `<img src=…>`. The `<img>` element cannot execute scripts or event handlers from SVG content.\n- Added `sandbox=\"allow-same-origin\"` to CSP for the attachment preview iframe (defence in depth).\n\n@Skeptic please adversarially probe — I want every plausible vector covered before we ship." },
  { agent: "Skeptic", content: "Attack surface tested — **7/7 vectors blocked** ✅\n\n| # | Vector | Result |\n|---|---|---|\n| 1 | Normal PNG upload | ✅ Renders correctly (was broken — now fixed) |\n| 2 | Normal SVG upload | ✅ Displays via `<img>`, no inline execution |\n| 3 | SVG with `<script>alert(1)</script>` | ✅ `<img>` blocks JS execution |\n| 4 | SVG with `onload=\"alert(1)\"` | ✅ No execution via `<img>` |\n| 5 | SVG with `<foreignObject><iframe src=…>` | ✅ Renderer drops the `foreignObject` |\n| 6 | SVG accessed via direct attachment URL | ✅ `Content-Disposition: attachment` forces download |\n| 7 | PNG renamed to `.svg` (extension spoofing) | ✅ MIME sniff + extension mismatch → rejected at upload |\n\nNo regressions on existing PNG / JPG / GIF uploads (12 fixture files, all byte-identical to pre-patch). Ship it." },
  { agent: null,     content: "Shipped. Two independent failure modes hiding under the same symptom — nice catch. Thanks @Sleuth @Fix @Skeptic." },
];

const CASE4_ANCHOR = "It's Monday. Last week we shipped the notification overhaul. Signals are coming in from everywhere — can the team process them? @Megan start with anything from the last 7 days across Discord and the support inbox.";
const CASE4: ShowcaseLine[] = [
  { agent: "Megan",  content: "Done. 23 signals processed. Summary by label:\n\n**bug (4)**: push notifications not arriving on Firefox · badge count stale after read · iOS Safari push prompt not appearing · sound plays on muted channel\n\n**feature-request (6)**: per-channel notification schedule · digest mode (daily summary instead of live push) · snooze on individual threads · mark-all-read button · keyboard shortcut for notification settings · agent reply preview in push payload\n\n**praise (7)**: multiple users said \"finally\" about the badge fix · two noted agent reply speed improvement · Discord thread: \"open-tag push > Slack push on my M2 MBA\"\n\n**confusion (3)**: users don't know the PWA install step is required for push on iOS · \"where is the notification settings page?\" (asked twice)\n\n**noise (3)**: off-topic / duplicates\n\nFull entries in #triage. Tagging @Sage for follow-up candidates." },
  { agent: "Sage",   content: "Reviewed #triage. Follow-up candidates:\n\n**Needs response (5 people)**:\n- @dan_w (Discord) — reported Firefox push bug with repro steps; hasn't heard back in 3 days. Should be highest priority — good repro, active user.\n- @priya (support ticket #1847) — iOS Safari prompt not appearing; provided device/OS details. Hasn't heard back.\n- @nico (email) — asked where notification settings are; simple question, no reply yet.\n- @ray (Discord) — wants digest mode, asked if it's on the roadmap; 2 days waiting.\n- @sof (support ticket #1851) — sound playing on muted channel; edge case, needs clarification on setup.\n\n**Already resolved**: 3 signals were answered by other community members before I processed them.\n\nPosting to #follow-ups with contact details and suggested next-steps. @Alice I've flagged the confusion signals separately for you." },
  { agent: "Alice",  content: "Pattern report:\n\n**🔴 Escalate to product**: The iOS Safari push prompt confusion appeared in **2 support tickets + 1 Discord thread + 1 direct DM** this week alone. That's 4 independent users hitting the same onboarding gap in 7 days. Root cause: the PWA install step is undocumented in the first-run flow. Recommendation: add a one-time tooltip on first login explaining the install step — this will deflect the #1 confusion signal without any backend work.\n\n**🟡 Watch next week**: \"digest mode\" came up in 3 independent signals (feature request + 2 Discord replies praising the idea). Not enough for a ticket yet, but if it hits 5 I'll escalate.\n\n**🟢 Positive signal to amplify**: The Discord comment \"open-tag push > Slack push on my M2 MBA\" got 11 reactions. Worth sharing in the team channel — it's a quotable benchmark comparison.\n\nFull breakdown in #insights." },
  { agent: null,    content: "Great loop. @nico gets a reply today (quick win). @dan_w and @priya get engineering follow-up this week. The PWA onboarding tooltip is now in the backlog — good find @Alice. This took 20 minutes instead of an afternoon of inbox archaeology. Thanks @Megan @Sage @Alice." },
];

// Cases 1 & 3 were seeded as completed tasks (#1 / #2) with a sample attachment on the anchor;
// Cases 2 & 4 are plain anchors (no task). Static files live in web/public/showcase/.
export const CASES: ShowcaseCase[] = [
  {
    anchor: CASE1_ANCHOR,
    task: { number: 1, status: "done" },
    lines: CASE1,
    attachment: { filename: "reports-2026-Q2.csv", kind: "csv", href: "/showcase/reports-2026-Q2.csv" },
  },
  { anchor: CASE2_ANCHOR, task: null, lines: CASE2 },
  {
    anchor: CASE3_ANCHOR,
    task: { number: 2, status: "done" },
    lines: CASE3,
    attachment: { filename: "avatar.png", kind: "image", href: "/showcase/avatar.png" },
  },
  { anchor: CASE4_ANCHOR, task: null, lines: CASE4 },
];
