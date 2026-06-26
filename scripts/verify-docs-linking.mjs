import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const fail = (message) => {
  console.error(message);
  process.exitCode = 1;
};

const packageJson = JSON.parse(read("package.json"));
const server = read("src/server/index.ts");
const landing = read("web/src/views/Landing.tsx");
const docsPage = read("docs-site/src/pages/index.astro");
const docsVerify = read("docs-site/scripts/verify-onepage.mjs");
const dockerfile = read("Dockerfile");

if (packageJson.scripts["site:build"] !== "npm run web:build && npm run docs:build") {
  fail("package.json must expose one site:build command for web + docs.");
}

if (packageJson.scripts["docs:build"] !== "npm --prefix docs-site run build") {
  fail("package.json must expose docs:build.");
}

for (const required of ["DOCSDIST", "serveDocs", "serveDocsAsset", 'method === "HEAD"', 'url.pathname === "/docs"', 'url.pathname.startsWith("/docs/")', 'url.pathname.startsWith("/_astro/")', "redirect(res, \"/docs/\")"]) {
  if (!server.includes(required)) fail(`server must mount docs-site/dist at /docs: missing ${required}`);
}

for (const required of ["docsUrl(", "MARKETING_ORIGINS", "https://docs.getopentag.com/", "window.location.origin", "/docs/"]) {
  if (!landing.includes(required)) fail(`landing Docs link must derive from the current app base URL: missing ${required}`);
}

if (landing.includes('<a href={GITHUB_URL} target="_blank" rel="noreferrer">Docs</a>')) {
  fail("landing Docs links must not point to GitHub.");
}

for (const required of ["docs-site/package.json", "docs-site/package-lock.json", "/app/docs-site/dist", "npm run site:build"]) {
  if (!dockerfile.includes(required)) fail(`Dockerfile must build and ship docs-site: missing ${required}`);
}

for (const forbidden of ['href="/', 'src="/favicon.svg"', 'src="/workspace.png"']) {
  if (docsPage.includes(forbidden)) fail(`docs page must be mountable under /docs, but contains ${forbidden}`);
}

for (const required of ["data-home-link", "resolveHomeHref", "window.location.origin"]) {
  if (!docsPage.includes(required)) fail(`docs page brand link must resolve to the app landing URL: missing ${required}`);
}

if (!docsVerify.includes("data-home-link") || !docsVerify.includes('src="./favicon.svg"')) {
  fail("docs one-page guard must enforce mount-safe assets and brand home link.");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("docs linking checks passed");
