// Unit tests for Slack-style mention auto-join decision logic (pure; no DB writes).
// Run: npx tsx --test --test-force-exit test/mention.unit.test.ts
// Importing core.ts opens a Redis connection (redis://localhost:6380) at module load; the functions
// under test never touch it, and --test-force-exit tears the connection down when the tests finish.
// core.ts → auth.ts: auth.ts now requires these env vars at load time (fail-fast, no weak defaults).
// Static imports are hoisted, so we must use a dynamic import and set env vars before it.
import test from "node:test";
import assert from "node:assert/strict";
process.env.JWT_SECRET ??= "test-secret";
process.env.DAEMON_BOOTSTRAP_KEY ??= "test-bootstrap-key";
const { parseMentions, membersToAutoJoin } = await import("../src/server/core.ts");
// Re-declare the Member type locally (avoids a static type-import from core.ts which would be hoisted).
type Member = { type: "agent" | "user"; id: string; name: string; displayName: string };

const agent = (name: string): Member => ({ type: "agent", id: "a-" + name, name, displayName: name });
const human = (name: string): Member => ({ type: "user", id: "u-" + name, name, displayName: name });

const ghost = agent("ghost");
const alice = human("alice");
const bob = human("bob");
const carol = human("carol");
const workspace = [ghost, alice, bob, carol];

const names = (ms: Member[]) => ms.map((m) => m.name).sort();

test("auto-joins referenced workspace members who aren't channel members yet", () => {
  // channel currently has only alice; message @s ghost (agent) and bob (human), both non-members
  const toAdd = membersToAutoJoin("@ghost please help, @bob you too", workspace, [alice]);
  assert.deepEqual(names(toAdd), ["bob", "ghost"]);
});

test("never re-adds an existing channel member", () => {
  // alice is already a member → must not be returned even though she's @-mentioned
  const toAdd = membersToAutoJoin("hey @alice and @bob", workspace, [alice]);
  assert.deepEqual(names(toAdd), ["bob"]);
});

test("ignores @names that don't resolve to a workspace member", () => {
  // @nobody is not in the workspace (e.g. a non-member human or another server's agent) → never auto-joined
  const toAdd = membersToAutoJoin("@nobody @ghost", workspace, []);
  assert.deepEqual(names(toAdd), ["ghost"]);
});

test("returns nothing when there are no mentions", () => {
  assert.deepEqual(membersToAutoJoin("just a plain message", workspace, [alice]), []);
});

test("matching is case-insensitive and de-duplicated", () => {
  // @GHOST resolves to ghost; repeated mentions collapse to a single add
  const toAdd = membersToAutoJoin("@GHOST @ghost @Ghost", workspace, []);
  assert.deepEqual(names(toAdd), ["ghost"]);
});

test("membersToAutoJoin stays consistent with parseMentions (no matching drift)", () => {
  // Whatever parseMentions records against the channel set, auto-join resolves against the workspace set
  // using the exact same matcher — so a name can never be "added but not recorded" or vice-versa.
  const content = "@ghost @bob @carol";
  const recorded = parseMentions(content, workspace); // ghost, bob, carol all in workspace
  const toAdd = membersToAutoJoin(content, workspace, [alice]);
  assert.deepEqual(names(toAdd), names(recorded)); // none are current members → all referenced get added
});

// The `pool` argument is the @-reach of the space (mentionAutoJoinPool): the whole workspace for a public
// channel / a thread under a public channel, but only the *current members* for private / DM channels and the
// threads under them. These two tests pin the security boundary of the thread @-wake fix: a public thread pulls
// any teammate in, a private/DM space never pulls an outsider in (no leak).
test("public space (channel or thread under a public channel) auto-joins any @-ed teammate", () => {
  // pool = whole workspace → a teammate who never spoke in the thread is still pulled in + woken
  const toAdd = membersToAutoJoin("@ghost can you take this thread?", workspace, [alice]);
  assert.deepEqual(names(toAdd), ["ghost"]);
});

test("members-only space (private / DM, and threads under them) never pulls in an outsider", () => {
  // pool = current members only [alice, bob] → @ghost (outside the space) resolves to nobody, so a private
  // thread can't leak by @-mentioning a non-member; bob is already in, so he's not re-added either.
  const membersOnly = [alice, bob];
  const toAdd = membersToAutoJoin("@ghost get in here, @bob you too", membersOnly, [alice, bob]);
  assert.deepEqual(names(toAdd), []);
});
