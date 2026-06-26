// Unit regression for online outdated daemon update guidance.
// Run: npx tsx --test --test-force-exit test/machineUpdateGuide.unit.test.ts
//
// The browser cannot update or kill a user's local daemon process. It also cannot recover a
// machine key after the one-time connect/reconnect modal closes because the server stores only
// the hash/prefix. The UI helper must therefore classify only online stale machines as needing
// update guidance, and the generated command must be a placeholder template, not a fake
// executable command with an invented key.
import test from "node:test";
import assert from "node:assert/strict";
import { daemonUpdateCommandTemplate, isDaemonUpdateAvailable } from "../web/src/machineUi.ts";

test("online machine on an older daemon version needs update guidance", () => {
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.5.0" }, "0.6.0"), true);
});

test("update guidance is not shown for offline, current, unknown, or no-latest states", () => {
  assert.equal(isDaemonUpdateAvailable({ status: "offline", daemonVersion: "0.5.0" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.6.0" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "" }, "0.6.0"), false);
  assert.equal(isDaemonUpdateAvailable({ status: "online", daemonVersion: "0.5.0" }, ""), false);
});

test("command template uses @latest and a visible placeholder instead of inventing a machine key", () => {
  const cmd = daemonUpdateCommandTemplate("https://tag.example.com");
  assert.equal(
    cmd,
    "npx @fancyboi999/open-tag-daemon@latest --server-url https://tag.example.com --api-key <your sk_machine_... key>",
  );
  assert.match(cmd, /@latest/);
  assert.match(cmd, /<your sk_machine_\.\.\. key>/);
  assert.doesNotMatch(cmd, /sk_machine_[A-Za-z0-9]{8,}/, "template must not pretend to know the stored machine key");
});
