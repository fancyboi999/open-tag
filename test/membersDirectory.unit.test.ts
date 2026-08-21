import assert from "node:assert/strict";
import test from "node:test";
import { filterMemberDirectory } from "../web/src/memberDirectory.ts";

const agents: any[] = [
  { id: "a1", name: "cindy", displayName: "Cindy", description: "Onboarding", runtime: "codex", status: "inactive", activity: "working" },
  { id: "a2", name: "recover", displayName: "Recovery", description: "Incident agent", runtime: "claude", status: "error", activity: "offline" },
];
const humans: any[] = [
  { userId: "u1", name: "jiachi", displayName: "Jiachi Deng", role: "owner", description: "Builder" },
  { userId: "u2", name: "sam", displayName: "Sam", role: "member" },
];

test("member directory search covers identity, description, role, and runtime", () => {
  assert.deepEqual(filterMemberDirectory(agents, humans, { query: "codex", kind: "all", status: "all", role: "all" }).agents.map((a) => a.id), ["a1"]);
  assert.deepEqual(filterMemberDirectory(agents, humans, { query: "builder", kind: "all", status: "all", role: "all" }).humans.map((h) => h.userId), ["u1"]);
});

test("member directory kind, live status, failure, and role filters compose", () => {
  const working = filterMemberDirectory(agents, humans, { query: "", kind: "agents", status: "working", role: "all" });
  assert.deepEqual(working.agents.map((a) => a.id), ["a1"]);
  assert.deepEqual(working.humans, []);
  assert.deepEqual(filterMemberDirectory(agents, humans, { query: "", kind: "all", status: "failure", role: "all" }).agents.map((a) => a.id), ["a2"]);
  assert.deepEqual(filterMemberDirectory(agents, humans, { query: "", kind: "humans", status: "all", role: "owner" }).humans.map((h) => h.userId), ["u1"]);
});
