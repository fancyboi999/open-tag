// Tests that auth.ts throws at module-load time when required env vars are missing.
// Uses a subprocess so the module-cache isn't polluted by the main test process.
// Run: npx tsx --test --test-force-exit test/authFailFast.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// tsx's real JS entrypoint: `npx`/`.bin/tsx` are shell shims spawnSync can't exec
// on Windows, but `node tsx/dist/cli.mjs` works on every platform.
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

/** Run a small snippet in a fresh tsx subprocess with a given environment.
 *  Returns { status, stderr }. */
function runSnippet(snippet: string, extraEnv: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [TSX_CLI, "--input-type=module", "--eval", snippet],
    {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      timeout: 15_000,
    }
  );
  return { status: r.status, stderr: r.stderr ?? "" };
}

// Use an absolute file:// URL — when running via --eval there's no "file" base for
// relative imports, and on Windows a bare drive-letter path (D:\...) is not a valid
// ESM specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const AUTH_PATH = path.join(ROOT, "src/server/auth.ts");
const LOAD_AUTH = `import ${JSON.stringify(pathToFileURL(AUTH_PATH).href)};`;

test("auth.ts throws at load time when JWT_SECRET is missing", () => {
  const { status, stderr } = runSnippet(LOAD_AUTH, {
    JWT_SECRET: "",            // unset
    DAEMON_BOOTSTRAP_KEY: "test-key",
  });
  assert.notEqual(status, 0, "expected non-zero exit code when JWT_SECRET is missing");
  assert.ok(stderr.includes("JWT_SECRET"), `expected error message to mention JWT_SECRET, got:\n${stderr}`);
});

test("auth.ts throws at load time when DAEMON_BOOTSTRAP_KEY is missing", () => {
  const { status, stderr } = runSnippet(LOAD_AUTH, {
    JWT_SECRET: "test-secret",
    DAEMON_BOOTSTRAP_KEY: "", // unset
  });
  assert.notEqual(status, 0, "expected non-zero exit code when DAEMON_BOOTSTRAP_KEY is missing");
  assert.ok(stderr.includes("DAEMON_BOOTSTRAP_KEY"), `expected error message to mention DAEMON_BOOTSTRAP_KEY, got:\n${stderr}`);
});

test("auth.ts loads successfully when both env vars are set", () => {
  const { status } = runSnippet(LOAD_AUTH, {
    JWT_SECRET: "test-secret",
    DAEMON_BOOTSTRAP_KEY: "test-bootstrap-key",
  });
  assert.equal(status, 0, "expected successful load when both env vars are set");
});
