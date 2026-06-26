import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const astroConfig = read("astro.config.mjs");
const packageJson = read("package.json");

if (astroConfig.includes("@astrojs/starlight") || astroConfig.includes("starlight(")) {
  fail("docs-site still uses the Starlight docs framework.");
}

if (packageJson.includes("@astrojs/starlight")) {
  fail("docs-site still depends on @astrojs/starlight.");
}

if (!existsSync(join(root, "src/pages/index.astro"))) {
  fail("docs-site is missing src/pages/index.astro.");
}

if (existsSync(join(root, "src/pages/index.astro"))) {
  const page = read("src/pages/index.astro");
  for (const token of ["#3369ff", "#7c3aed", "Starlight", "template: splash"]) {
    if (page.includes(token)) fail(`docs one-page source still contains ${token}.`);
  }
  for (const required of ["Quickstart", "Machines", "Agents", "Collaboration", "Self-hosting", "中文"]) {
    if (!page.includes(required)) fail(`docs one-page source is missing ${required}.`);
  }
  if (!page.includes("data-lang-toggle")) {
    fail("docs one-page source is missing the language toggle button.");
  }
  if (!page.includes('href="https://getopentag.com/"')) {
    fail("docs one-page brand link must point to the landing page.");
  }
  if (!page.includes('src="/favicon.svg"')) {
    fail("docs one-page brand mark must use the existing SVG logo.");
  }
  if (!page.includes("data-i18n-meta")) {
    fail("docs one-page source is missing localized metadata hooks.");
  }
  if (!page.includes("openedLegacyChineseHash")) {
    fail("docs one-page source is missing legacy #chinese handling.");
  }
  if (page.includes('href="#chinese"') || page.includes('id="chinese"')) {
    fail("Chinese support must be a page-level language toggle, not a separate #chinese section.");
  }
  for (const requiredZh of ["快速开始", "自托管", "频道就是工作记忆", "生产环境先把 secrets 配好"]) {
    if (!page.includes(requiredZh)) fail(`docs one-page source is missing Chinese copy: ${requiredZh}`);
  }
  for (const sourcePath of ["README.md", "docs/self-host.md", "FEATURES.md", "ARCHITECTURE.md", "docs/authorization.md"]) {
    if (!page.includes(sourcePath)) fail(`docs one-page source is missing source link: ${sourcePath}`);
  }
}

const files = [];
const collect = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else files.push(path);
  }
};

collect(join(root, "src"));
collect(join(root, "public"));

if (files.some((file) => file.includes("/src/content/"))) {
  fail("docs-site still has src/content files from the old docs framework.");
}

for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const token of ["#3369ff", "#7c3aed", "radial-gradient", "clamp(", "template: splash"]) {
    if (text.includes(token)) fail(`${file.replace(root, "")} still contains ${token}.`);
  }
  for (const line of text.split("\n")) {
    const match = line.match(/letter-spacing:\s*([^;]+);/);
    if (match && !["0", "0px", "0rem"].includes(match[1].trim())) {
      fail(`${file.replace(root, "")} uses ${line.trim()}`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("one-page docs checks passed");
