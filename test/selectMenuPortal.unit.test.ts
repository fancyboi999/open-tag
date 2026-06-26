// Unit regression for the custom <Select> dropdown menu escaping an ancestor transform's containing block.
// Run: npx tsx --test --test-force-exit test/selectMenuPortal.unit.test.ts
//
// The bug (introduced by the #96 motion pass): `.modal` carries `animation: modal-enter ... both`. With
// fill-mode `both`, after the enter animation finishes the element RETAINS the `to` frame's transform — and
// even though that frame is `transform: none`, the browser serializes the retained value to `matrix(1,0,0,1,0,0)`,
// which is NOT the string "none". ANY non-none transform makes the element the containing block of a
// `position:fixed` descendant. The Select menu (`.sel-menu`, position:fixed, positioned with viewport coords
// from getBoundingClientRect) therefore got re-anchored to `.modal` instead of the viewport and drifted ~370px
// off its trigger — the menu opened but landed on empty space, so clicks "did nothing".
//
// The fix: render the menu through createPortal into <body>, so it lives outside `.modal`'s subtree and is
// immune to any ancestor transform (now and in the future). This test locks that invariant in source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../web/src/Select.tsx", import.meta.url), "utf8");

test("Select imports createPortal from react-dom", () => {
  assert.match(src, /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/);
});

test("Select renders the .sel-menu through createPortal into document.body (escapes ancestor transform containing block)", () => {
  // createPortal( <div className="sel-menu" …> … </div>, document.body )
  const portaled = /createPortal\(\s*[\s\S]*?className="sel-menu"[\s\S]*?,\s*document\.body\s*,?\s*\)/;
  assert.match(
    src,
    portaled,
    "the .sel-menu must be wrapped in createPortal(..., document.body); rendering it inline in the component subtree re-exposes it to an ancestor transform's containing block (see #96 .modal regression)",
  );
});
