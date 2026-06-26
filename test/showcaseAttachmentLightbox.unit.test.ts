// Unit regression for the Showcase (landing demo) image attachment.
// Run: npx tsx --test --test-force-exit test/showcaseAttachmentLightbox.unit.test.ts
//
// Bug: on the static Showcase page the image attachment was a plain `<a target="_blank">`, so clicking
// the avatar/preview navigated the browser away to the raw image instead of opening the in-app lightbox
// overlay the real Chat view uses. Lock the contract that Showcase reuses the shared Lightbox so the
// preview opens a floating dialog in place (matching Chat) and never bounces the visitor to a raw asset.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const showcaseSrc = fs.readFileSync(new URL("../web/src/views/Showcase.tsx", import.meta.url), "utf8");

test("Showcase image attachment opens the in-app lightbox, not a new browser tab", () => {
  // The preview must NOT be a new-tab anchor — that is exactly the bug (navigates away to the raw image).
  assert.doesNotMatch(
    showcaseSrc,
    /<a[^>]*className="msg-att-img"/,
    "Showcase image attachment must not be an <a> (new-tab navigation); it should be a lightbox button",
  );
  // It must be a button that opens the lightbox in place, mirroring Chat.tsx's AttCard image branch.
  assert.match(showcaseSrc, /<button className="msg-att-img"[^>]*onClick=\{\(\) => setLb\(true\)\}/);
  assert.match(showcaseSrc, /\{lb && <Lightbox /);
});

test("Showcase reuses the shared Lightbox component instead of duplicating it", () => {
  assert.match(showcaseSrc, /import\s*\{\s*Lightbox\s*\}\s*from\s*"\.\.\/Lightbox/);
});
