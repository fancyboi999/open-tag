import test from "node:test";
import assert from "node:assert/strict";
import { colorValueFromTag, remarkColorSwatches } from "../web/src/messageRender.tsx";

function runColorTransform(tree: any): any {
  const transform = remarkColorSwatches();
  transform(tree);
  return tree;
}

function paragraphWith(value: string): any {
  return { type: "paragraph", children: [{ type: "text", value }] };
}

test("color swatches cover explicit CSS color tokens", () => {
  const tree = {
    type: "root",
    children: [paragraphWith("Palette: #92B6FF #09c #0f08 rgb(255 0 153 / 80%) rgba(255, 0, 0, .5) hsl(150 30% 60%) hwb(12 50% 0%) lab(50% 40 59.5) lch(52.2% 72.2 50) oklab(59% 0.1 0.1) oklch(60% 0.15 50) color(display-p3 1 0.5 0) color-mix(in oklch, #92B6FF, white)")],
  };

  runColorTransform(tree);

  const links = tree.children[0].children.filter((child: any) => child.type === "link");
  assert.ok(links.length >= 13);
  assert.equal(links[0].url, "tag:color:%2392B6FF");
  assert.equal(links[0].children[0].value, "#92B6FF");
  assert.ok(links.some((link: any) => decodeURIComponent(link.url).includes("rgb(255 0 153 / 80%)")));
  assert.ok(links.some((link: any) => decodeURIComponent(link.url).includes("color-mix(in oklch, #92B6FF, white)")));
});

test("color swatches skip existing links and non-color hashes", () => {
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [
        { type: "text", value: "Use #all and task #1, then " },
        { type: "link", url: "https://example.com/#92B6FF", children: [{ type: "text", value: "#92B6FF" }] },
        { type: "text", value: " plus #92B6FF." },
      ],
    }],
  };

  runColorTransform(tree);

  const children = tree.children[0].children;
  assert.equal(children.filter((child: any) => child.type === "link" && child.url.startsWith("tag:color:")).length, 1);
  assert.equal(children.find((child: any) => child.url === "https://example.com/#92B6FF").children[0].value, "#92B6FF");
  assert.match(children[0].value, /#all and task #1/);
});

test("color swatch tags reject oversized or unsafe values", () => {
  assert.equal(colorValueFromTag("tag:color:%2392B6FF"), "#92B6FF");
  assert.equal(colorValueFromTag(`tag:color:${encodeURIComponent("red;background:url(x)")}`), null);
  assert.equal(colorValueFromTag(`tag:color:${encodeURIComponent("<red>")}`), null);
  assert.equal(colorValueFromTag(`tag:color:${encodeURIComponent("a".repeat(161))}`), null);
});

test("color swatch transform does not tag unsafe function tokens", () => {
  const tree = {
    type: "root",
    children: [paragraphWith("Unsafe: rgb(1;2;3) and safe: rgb(1,2,3)")],
  };

  runColorTransform(tree);

  const links = tree.children[0].children.filter((child: any) => child.type === "link");
  assert.equal(links.length, 1);
  assert.ok(decodeURIComponent(links[0].url).includes("rgb(1,2,3)"));
});
