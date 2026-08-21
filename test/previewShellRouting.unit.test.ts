import assert from "node:assert/strict";
import test from "node:test";
import {
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
      id: "channel",
      kind: "workspace-detail",
      workspaceSlug: "acme",
      currentHref: "/s/acme/channel/channel-1?thread=message-1#latest",
      parentHref: "/s/acme",
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
