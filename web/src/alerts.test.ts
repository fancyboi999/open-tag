import { test } from "node:test";
import assert from "node:assert/strict";
import { isDaemonOutdated } from "./alerts.tsx";

test("daemon is outdated only when its semantic version is lower than latest", () => {
  assert.equal(isDaemonOutdated("0.6.0", "0.6.1"), true);
  assert.equal(isDaemonOutdated("0.6.1", "0.6.1"), false);
  assert.equal(isDaemonOutdated("0.6.1", "0.6.0"), false);
});

test("unknown or non-semver daemon versions are not treated as outdated", () => {
  assert.equal(isDaemonOutdated("", "0.6.1"), false);
  assert.equal(isDaemonOutdated("dev", "0.6.1"), false);
  assert.equal(isDaemonOutdated("0.6.0", ""), false);
  assert.equal(isDaemonOutdated("0.6.0", "dev"), false);
});
