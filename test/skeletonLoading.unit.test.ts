// Unit regression for the loading skeletons (WorkspaceSkeleton / ChatSkeleton).
// Run: npx tsx --test --test-force-exit test/skeletonLoading.unit.test.ts
//
// Guards three things that are easy to silently break:
//   1. ready=false / switch-in-flight renders a SKELETON, not a blank null (main.tsx route guards).
//   2. The shell skeleton reuses the real app grid (.app.has-traj) so the swap is layout-shift-free.
//   3. The shimmer is disabled under prefers-reduced-motion (accessibility — non-negotiable per DESIGN.md).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const mainTsx = fs.readFileSync(new URL("../web/src/main.tsx", import.meta.url), "utf8");
const skeletonTsx = fs.readFileSync(new URL("../web/src/views/Skeleton.tsx", import.meta.url), "utf8");

test("route guards render the skeleton (not a blank null) while bootstrapping / switching", () => {
  // Both WorkspaceRoute and RootRedirect must paint the skeleton when !ready.
  const skeletonHits = (mainTsx.match(/<WorkspaceSkeleton\s*\/>/g) || []).length;
  assert.ok(skeletonHits >= 2, `expected WorkspaceSkeleton in both route guards, found ${skeletonHits}`);
  // The old blank-screen behavior must be gone: no `if (!ready) return null` left in the guards.
  assert.doesNotMatch(mainTsx, /!ready\)\s*return null/, "ready=false must no longer fall through to a blank null");
});

test("shell skeleton reuses the real app grid so the swap is layout-shift-free", () => {
  // WorkspaceSkeleton mounts under the same `.app` grid as <Layout/>, adding the `has-traj` trace column ONLY for
  // chat routes (mirrors Layout's isChat) so a deep-link/refresh to any route swaps without a column-width shift.
  assert.match(skeletonTsx, /className=\{"app skel-app"/, "WorkspaceSkeleton must mount under the .app shell grid");
  assert.match(skeletonTsx, /isChat[\s\S]*has-traj/, "skeleton must add has-traj only for chat routes (mirrors <Layout/>)");
  assert.match(skeletonTsx, /className="rail skel-rail"/, "skeleton rail must reuse the real .rail column");
});

test("skeleton blocks shimmer, and the shimmer is removed under prefers-reduced-motion", () => {
  assert.match(css, /@keyframes\s+skel-shimmer/, "skel-shimmer keyframes must exist");
  const after = /\.skel-box::after\s*\{([^}]*)\}/.exec(css);
  assert.ok(after, "missing .skel-box::after rule (the shimmer sweep)");
  assert.match(after![1]!, /animation:\s*skel-shimmer/, "the shimmer must run on .skel-box::after");
  // Accessibility: reduced-motion must kill the shimmer.
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.skel-box::after\s*\{\s*display:\s*none/,
    "prefers-reduced-motion must disable the skeleton shimmer",
  );
});
