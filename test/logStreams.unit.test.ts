// Railway classifies stderr as error-level logs. Server/daemon debug/info/warn
// lines must therefore go to stdout, while the CLI keeps all logger output on
// stderr so command stdout remains machine-readable for agents.
//
// Run: npx tsx --test --test-force-exit test/logStreams.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../src/log.ts";

function captureWrites(fn: () => void): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const oldStdout = process.stdout.write;
  const oldStderr = process.stderr.write;
  (process.stdout.write as any) = (chunk: unknown) => { stdout += String(chunk); return true; };
  (process.stderr.write as any) = (chunk: unknown) => { stderr += String(chunk); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = oldStdout;
    process.stderr.write = oldStderr;
  }
  return { stdout, stderr };
}

test("server debug/info/warn logs write to stdout, not stderr", () => {
  const out = captureWrites(() => {
    const log = createLogger("server");
    log.debug("req", { path: "/health", status: 200 });
    log.info("control plane up");
    log.warn("transient warning");
  });

  assert.match(out.stdout, /DEBUG\s+\[server\] req/);
  assert.match(out.stdout, /INFO\s+\[server\] control plane up/);
  assert.match(out.stdout, /WARN\s+\[server\] transient warning/);
  assert.equal(out.stderr, "");
});

test("server errors still write to stderr", () => {
  const out = captureWrites(() => createLogger("server").error("request error"));

  assert.equal(out.stdout, "");
  assert.match(out.stderr, /ERROR\s+\[server\] request error/);
});

test("cli logger output stays on stderr to keep command stdout clean", () => {
  const out = captureWrites(() => createLogger("cli").debug("api", { status: 200 }));

  assert.equal(out.stdout, "");
  assert.match(out.stderr, /DEBUG\s+\[cli\] api/);
});
