// Post-build prerender: SSR-renders the landing page (/) and injects the HTML
// into dist/index.html so crawlers receive body text without executing JS.
//
// Run automatically after `vite build` via the npm `build` script.
// Uses Vite's SSR build API so CSS imports are stripped without errors.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dir, "..");
const distDir = join(webDir, "dist");
const ssrOutDir = join(distDir, "_ssr");

// 1. Build an isolated SSR bundle of entry-server.tsx.
//    configFile:false avoids the client-side manualChunks / proxy config;
//    we only need the react JSX transform here.
await build({
  root: webDir,
  configFile: false,
  plugins: [react()],
  build: {
    ssr: "src/entry-server.tsx",
    outDir: ssrOutDir,
    emptyOutDir: true,
    minify: false,
  },
  logLevel: "warn",
});

// 2. Import the SSR entry and render the landing page to an HTML string.
//    pathToFileURL converts the absolute path to a file:// URL, which is
//    required for dynamic import() in Node.js ESM.
const entryPath = join(ssrOutDir, "entry-server.js");
const { renderLanding } = await import(pathToFileURL(entryPath).href);
const appHtml = renderLanding();

// 3. Patch dist/index.html — replace the empty root div with prerendered HTML.
const template = readFileSync(join(distDir, "index.html"), "utf-8");
if (!template.includes('<div id="root"></div>')) {
  throw new Error("prerender: could not find '<div id=\"root\"></div>' in dist/index.html");
}
const html = template.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);
writeFileSync(join(distDir, "index.html"), html);

// 4. Remove the temporary SSR bundle — it is not needed at runtime.
rmSync(ssrOutDir, { recursive: true, force: true });

console.log("prerender: landing page HTML injected into dist/index.html");
