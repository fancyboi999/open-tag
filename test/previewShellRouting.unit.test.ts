import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseNativeParentBack,
  resolveParentBackMode,
  canonicalWorkspaceHref,
  describeAppPage,
  resolveShellMode,
} from "../web/src/shellRouting.ts";

test("classic stays default and the baseline shell requires both a non-production capability and an explicit choice", () => {
  const common = { storedChoice: null, previewFlag: "enabled" } as const;

  assert.equal(resolveShellMode({ ...common, buildMode: "development", search: "" }), "classic");
  assert.equal(
    resolveShellMode({ ...common, buildMode: "development", search: "?ui=baseline" }),
    "baseline",
  );
  assert.equal(
    resolveShellMode({ ...common, buildMode: "preview", search: "?ui=baseline" }),
    "baseline",
  );
  assert.equal(
    resolveShellMode({ ...common, buildMode: "production", search: "?ui=baseline" }),
    "classic",
  );
  assert.equal(
    resolveShellMode({
      buildMode: "development",
      previewFlag: undefined,
      search: "?ui=baseline",
      storedChoice: null,
    }),
    "classic",
  );
});

test("a permitted baseline choice survives route navigation and an explicit classic choice rolls back immediately", () => {
  const common = { buildMode: "preview", previewFlag: "enabled" } as const;

  assert.equal(
    resolveShellMode({ ...common, search: "", storedChoice: "baseline" }),
    "baseline",
  );
  assert.equal(
    resolveShellMode({ ...common, search: "?ui=classic", storedChoice: "baseline" }),
    "classic",
  );
  assert.equal(
    resolveShellMode({
      buildMode: "production",
      previewFlag: "enabled",
      search: "",
      storedChoice: "baseline",
    }),
    "classic",
  );
});

test("page metadata centrally classifies public, auth, workspace roots, and details with deterministic parents", () => {
  assert.deepEqual(describeAppPage({ pathname: "/", search: "", hash: "" }), {
    id: "marketing",
    kind: "public",
    workspaceSlug: null,
    currentHref: "/",
    parentHref: null,
  });
  assert.equal(
    describeAppPage({ pathname: "/join/invite", search: "", hash: "" }).kind,
    "auth",
  );
  assert.deepEqual(describeAppPage({ pathname: "/s/acme", search: "", hash: "" }), {
    id: "workspace-home",
    kind: "workspace-root",
    workspaceSlug: "acme",
    currentHref: "/s/acme",
    parentHref: null,
  });
  assert.deepEqual(describeAppPage({ pathname: "/s/acme/channel", search: "", hash: "" }), {
    id: "channel",
    kind: "workspace-detail",
    workspaceSlug: "acme",
    currentHref: "/s/acme/channel",
    parentHref: "/s/acme",
  });
  assert.deepEqual(
    describeAppPage({ pathname: "/s/acme/tasks", search: "?view=list", hash: "#todo" }),
    {
      id: "tasks",
      kind: "workspace-root",
      workspaceSlug: "acme",
      currentHref: "/s/acme/tasks?view=list#todo",
      parentHref: null,
    },
  );
  assert.deepEqual(
    describeAppPage({ pathname: "/s/acme/human/user-1", search: "?tab=activity", hash: "#run" }),
    {
      id: "human-profile",
      kind: "workspace-detail",
      workspaceSlug: "acme",
      currentHref: "/s/acme/human/user-1?tab=activity#run",
      parentHref: "/s/acme/agent",
    },
  );
  assert.deepEqual(
    describeAppPage({ pathname: "/s/acme/channel/channel-1", search: "?thread=message-1", hash: "#latest" }),
    {
      id: "thread",
      kind: "workspace-detail",
      workspaceSlug: "acme",
      currentHref: "/s/acme/channel/channel-1?thread=message-1#latest",
      parentHref: "/s/acme/channel/channel-1#latest",
    },
  );
});

test("unknown or stale workspace canonicalization preserves the detail path, query, and hash", () => {
  assert.equal(
    canonicalWorkspaceHref(
      {
        pathname: "/s/stale/human/user-1",
        search: "?tab=activity",
        hash: "#run",
      },
      "current",
    ),
    "/s/current/human/user-1?tab=activity#run",
  );
});

test("mobile parent return uses native history only when the previous path is the declared parent", () => {
  assert.equal(canUseNativeParentBack("/s/acme?filter=unread#pinned", "/s/acme"), true);
  assert.equal(canUseNativeParentBack("/s/acme/agent?sort=name", "/s/acme/agent"), true);
  assert.equal(canUseNativeParentBack("/s/other", "/s/acme"), false);
  assert.equal(canUseNativeParentBack("/login", "/s/acme"), false);
  assert.equal(canUseNativeParentBack(null, "/s/acme"), false);
  assert.equal(resolveParentBackMode("/s/acme", "/s/acme", true), "history");
  assert.equal(resolveParentBackMode("/s/acme/channel/c1", "/s/acme/channel/c1", false), "replace-parent");
  assert.equal(resolveParentBackMode(null, "/s/acme", false), "parent");
});

test("channel thread and tab details preserve unrelated query/hash state in their parent href", () => {
  assert.deepEqual(
    describeAppPage({ pathname: "/s/acme/channel/c1", search: "?thread=t1&msg=m1&agentTab=activity", hash: "#latest" }),
    {
      id: "thread",
      kind: "workspace-detail",
      workspaceSlug: "acme",
      currentHref: "/s/acme/channel/c1?thread=t1&msg=m1&agentTab=activity#latest",
      parentHref: "/s/acme/channel/c1?msg=m1#latest",
    },
  );
  assert.equal(
    describeAppPage({ pathname: "/s/acme/channel/c1", search: "?chatTab=files&msg=m1", hash: "#latest" }).parentHref,
    "/s/acme/channel/c1?msg=m1#latest",
  );
});

test("a task source deep-link returns to the Tasks root", () => {
  assert.deepEqual(
    describeAppPage({ pathname: "/s/acme/channel/c1", search: "?msg=m1&from=tasks", hash: "" }),
    {
      id: "task-source",
      kind: "workspace-detail",
      workspaceSlug: "acme",
      currentHref: "/s/acme/channel/c1?msg=m1&from=tasks",
      parentHref: "/s/acme/tasks",
    },
  );
  assert.equal(resolveParentBackMode("/s/acme/tasks?ui=baseline", "/s/acme/tasks", true), "history");
});

test("every implemented workspace matrix route has an explicit root/detail class and parent", () => {
  const cases: Array<[string, string, "workspace-root" | "workspace-detail" | "unknown", string | null]> = [
    ["/s/acme", "workspace-home", "workspace-root", null],
    ["/s/acme/search", "search", "workspace-detail", "/s/acme"],
    ["/s/acme/inbox", "activity", "workspace-detail", "/s/acme"],
    ["/s/acme/saved", "saved", "workspace-detail", "/s/acme"],
    ["/s/acme/showcase", "showcase", "workspace-detail", "/s/acme"],
    ["/s/acme/channel/c1", "channel", "workspace-detail", "/s/acme"],
    ["/s/acme/tasks", "tasks", "workspace-root", null],
    ["/s/acme/tasks/c1", "channel-tasks", "workspace-detail", "/s/acme/tasks"],
    ["/s/acme/agent", "members", "workspace-root", null],
    ["/s/acme/agent/a1", "agent-profile", "workspace-detail", "/s/acme/agent"],
    ["/s/acme/human/u1", "human-profile", "workspace-detail", "/s/acme/agent"],
    ["/s/acme/computer", "computers", "workspace-root", null],
    ["/s/acme/computer/m1", "computer-detail", "workspace-detail", "/s/acme/computer"],
    ["/s/acme/settings", "settings", "workspace-root", null],
    ["/s/acme/settings/account", "settings-account", "workspace-detail", "/s/acme/settings"],
    ["/s/acme/unknown", "unknown", "unknown", "/s/acme"],
  ];
  for (const [pathname, id, kind, parentHref] of cases) {
    const page = describeAppPage({ pathname, search: "", hash: "" });
    assert.deepEqual({ id: page.id, kind: page.kind, parentHref: page.parentHref }, { id, kind, parentHref }, pathname);
  }
});
