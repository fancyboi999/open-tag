// Unit regression for chat image attachments.
// Run: npx tsx --test --test-force-exit test/imageAttachmentLayout.unit.test.ts
//
// Image attachments live in .msg-atts, a column flex container. Flex columns stretch children on the
// cross axis by default, which made the clickable image button fill the whole message column while the
// image itself stayed small on the left. Lock the shrink-to-image contract so previews cannot regress
// into a wide blank card again.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
const chatSrc = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `missing CSS rule for ${selector}`);
  return m[1]!;
}

function assertDecl(body: string, prop: string, value: string): void {
  assert.match(body, new RegExp(`${prop}\\s*:\\s*${value}(?:;|$)`), `expected ${prop}:${value} in:\n${body}`);
}

test("image attachment stack does not stretch image preview buttons to the message width", () => {
  const stack = ruleBody(".msg-atts");
  assertDecl(stack, "display", "flex");
  assertDecl(stack, "flex-direction", "column");
  assertDecl(stack, "align-items", "flex-start");

  const button = ruleBody(".msg-att-img");
  assertDecl(button, "display", "inline-flex");
  assertDecl(button, "align-self", "flex-start");
  assertDecl(button, "max-width", "min\\(100%,320px\\)");

  const image = ruleBody(".msg-att-img img");
  assertDecl(image, "max-width", "100%");
  assertDecl(image, "max-height", "240px");
  assertDecl(image, "object-fit", "contain");
});

test("lightbox has a real dialog panel instead of a bare image floating on the scrim", () => {
  assert.match(chatSrc, /className="lightbox-panel"/);
  assert.match(chatSrc, /role="dialog"/);
  assert.match(chatSrc, /aria-modal="true"/);
  assert.match(chatSrc, /closeRef\.current\?\.focus/);
  assert.match(chatSrc, /prevFocus\.current\?\.focus/);
  assert.match(chatSrc, /e\.key === "Tab"/);
});

test("lightbox is portaled to body so fixed positioning is viewport-relative, not message-transform-relative", () => {
  assert.match(chatSrc, /import\s*\{\s*createPortal\s*\}\s*from\s*"react-dom"/);
  assert.match(
    chatSrc,
    /createPortal\(\s*[\s\S]*?className="lightbox-bg"[\s\S]*?,\s*document\.body\s*,?\s*\)/,
    ".lightbox-bg must render through createPortal(..., document.body); new messages carry transform animations that otherwise make position:fixed relative to the message instead of the viewport",
  );
});

test("lightbox media height subtracts overlay padding so tall images are not clipped", () => {
  const panel = ruleBody(".lightbox-panel");
  assertDecl(panel, "max-height", "calc\\(100vh - 64px\\)");

  const image = ruleBody(".lightbox-img");
  assertDecl(image, "max-height", "calc\\(100vh - 64px\\)");
});
