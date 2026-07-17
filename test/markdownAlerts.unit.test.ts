import test from "node:test";
import assert from "node:assert/strict";
import { remarkGithubAlerts } from "../web/src/messageRender.tsx";

function runAlertTransform(tree: any): any {
  const transform = remarkGithubAlerts();
  transform(tree);
  return tree;
}

function collectText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return String(node.value ?? "");
  if (node.type === "break") return "\n";
  if (Array.isArray(node.children)) return node.children.map(collectText).join("");
  return "";
}

test("GitHub alert blockquotes get a typed class and lose the marker line", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "[!WARNING]" }] },
        { type: "paragraph", children: [{ type: "text", value: "Watch the context before replying." }] },
      ],
    }],
  };

  runAlertTransform(tree);

  const quote = tree.children[0];
  assert.deepEqual(quote.data.hProperties.className, ["github-alert", "github-alert-warning"]);
  assert.deepEqual(quote.data.hProperties["data-alert"], "warning");
  assert.equal(quote.children.length, 1);
  assert.equal(quote.children[0].children[0].value, "Watch the context before replying.");
});

test("GitHub alert marker may share the first paragraph with soft-line content", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [{
        type: "paragraph",
        children: [
          { type: "text", value: "[!NOTE]" },
          { type: "break" },
          { type: "text", value: "Useful information for skimming." },
        ],
      }],
    }],
  };

  runAlertTransform(tree);

  const quote = tree.children[0];
  assert.deepEqual(quote.data.hProperties.className, ["github-alert", "github-alert-note"]);
  assert.equal(quote.children.length, 1);
  assert.equal(collectText(quote.children[0]), "Useful information for skimming.");
});

test("compact pasted alert syntax strips the marker delimiter without corrupting later text", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [{
        type: "paragraph",
        children: [
          { type: "text", value: "[!TIP] > " },
          { type: "strong", children: [{ type: "text", value: "建议 (Tip)" }] },
          { type: "text", value: " > Optional information. > 可选建议。" },
        ],
      }],
    }],
  };

  runAlertTransform(tree);

  const quote = tree.children[0];
  assert.deepEqual(quote.data.hProperties.className, ["github-alert", "github-alert-tip"]);
  assert.equal(collectText(quote), "建议 (Tip)\nOptional information. > 可选建议。");
  assert.doesNotMatch(collectText(quote), /\[!TIP\]/);
});

test("GitHub alert body preserves literal greater-than comparisons", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [
        { type: "paragraph", children: [{ type: "text", value: "[!NOTE]" }] },
        { type: "paragraph", children: [{ type: "text", value: "compare a > b here" }] },
      ],
    }],
  };

  runAlertTransform(tree);

  const quote = tree.children[0];
  assert.deepEqual(quote.data.hProperties.className, ["github-alert", "github-alert-note"]);
  assert.equal(collectText(quote), "compare a > b here");
});

test("ordinary blockquotes are not converted into alerts", () => {
  const tree = {
    type: "root",
    children: [{
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ type: "text", value: "Just quoted text." }] }],
    }],
  };

  runAlertTransform(tree);

  assert.equal(tree.children[0].data, undefined);
  assert.equal(tree.children[0].children[0].children[0].value, "Just quoted text.");
});
