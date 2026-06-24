// Unit tests for the remark transform that keeps raw-HTML message bodies VISIBLE.
// react-markdown intentionally never renders raw HTML (no rehype-raw — no arbitrary-HTML/XSS surface),
// but its default is to SILENTLY DROP html nodes, so a message that is entirely HTML rendered as an empty
// bubble (content delivered, but invisible). remarkHtmlAsText downgrades every mdast `html` node to a
// literal `text` node so the source is always shown (Slack-style "what you typed, you see"), still escaped
// by React on render. Run: npx tsx --test --test-force-exit test/messageRender.html.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { remarkHtmlAsText } from "../web/src/messageRender.tsx";

test("a top-level html block node is downgraded to literal text (not dropped)", () => {
  const tree: any = { type: "root", children: [{ type: "html", value: '<div class="head head-agent"><h1>Code-review master</h1></div>' }] };
  remarkHtmlAsText()(tree);
  assert.equal(tree.children[0].type, "text");
  assert.equal(tree.children[0].value, '<div class="head head-agent"><h1>Code-review master</h1></div>');
});

test("inline html nodes nested inside a paragraph are downgraded too", () => {
  const tree: any = { type: "root", children: [{ type: "paragraph", children: [
    { type: "html", value: "<b>" }, { type: "text", value: "hi" }, { type: "html", value: "</b>" },
  ] }] };
  remarkHtmlAsText()(tree);
  const kids = tree.children[0].children;
  assert.equal(kids[0].type, "text");
  assert.equal(kids[0].value, "<b>");
  assert.equal(kids[2].type, "text");
  assert.equal(kids[2].value, "</b>");
});

test("non-html nodes are left untouched", () => {
  const tree: any = { type: "root", children: [
    { type: "paragraph", children: [{ type: "text", value: "plain" }] },
    { type: "code", lang: "js", value: "const x = 1;" },
  ] };
  remarkHtmlAsText()(tree);
  assert.equal(tree.children[0].children[0].type, "text");
  assert.equal(tree.children[1].type, "code");
  assert.equal(tree.children[1].value, "const x = 1;");
});
