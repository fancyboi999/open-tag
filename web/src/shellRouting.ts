export type ShellMode = "classic" | "baseline";
export type AppPageKind = "public" | "auth" | "workspace-root" | "workspace-detail" | "unknown";

export interface AppPageLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface AppPageDescriptor {
  id: string;
  kind: AppPageKind;
  workspaceSlug: string | null;
  currentHref: string;
  parentHref: string | null;
}

export function canUseNativeParentBack(previousHref: string | null, parentHref: string | null): boolean {
  if (!previousHref || !parentHref) return false;
  const base = "https://open-tag.invalid";
  return new URL(previousHref, base).pathname === new URL(parentHref, base).pathname;
}

export type ParentBackMode = "history" | "replace-parent" | "parent";

export function resolveParentBackMode(previousHref: string | null, parentHref: string | null, previousNavigationWasPush: boolean): ParentBackMode {
  if (!canUseNativeParentBack(previousHref, parentHref)) return "parent";
  return previousNavigationWasPush ? "history" : "replace-parent";
}

function detailParentHref(basePath: string, search: string, hash: string, removeKeys: string[]): string {
  const params = new URLSearchParams(search);
  for (const key of removeKeys) params.delete(key);
  const query = params.toString();
  return `${basePath}${query ? `?${query}` : ""}${hash}`;
}

export interface ShellSelectionInput {
  buildMode: string;
  previewFlag: string | undefined;
  search: string;
  storedChoice: string | null;
}

export function resolveShellMode(input: ShellSelectionInput): ShellMode {
  const previewCapable =
    (input.buildMode === "development" || input.buildMode === "preview") &&
    input.previewFlag === "enabled";
  if (!previewCapable) return "classic";

  const requested = new URLSearchParams(input.search).get("ui");
  if (requested === "baseline" || requested === "classic") return requested;
  return input.storedChoice === "baseline" ? "baseline" : "classic";
}

const PUBLIC_PAGES = new Map([
  ["/", "marketing"],
  ["/features", "features"],
]);

const AUTH_PAGES = new Map([
  ["/login", "login"],
  ["/register", "register"],
]);

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function describeAppPage(location: AppPageLocation): AppPageDescriptor {
  const pathname = normalizedPath(location.pathname);
  const currentHref = `${pathname}${location.search}${location.hash}`;
  const publicId = PUBLIC_PAGES.get(pathname);
  if (publicId) {
    return { id: publicId, kind: "public", workspaceSlug: null, currentHref, parentHref: null };
  }

  const authId = AUTH_PAGES.get(pathname) ?? (pathname.startsWith("/join/") ? "join" : null);
  if (authId) {
    return { id: authId, kind: "auth", workspaceSlug: null, currentHref, parentHref: null };
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "s" || !segments[1]) {
    return { id: "unknown", kind: "unknown", workspaceSlug: null, currentHref, parentHref: null };
  }

  const workspaceSlug = segments[1];
  const root = `/s/${workspaceSlug}`;
  const section = segments[2];
  const detail = segments[3];
  if (!section) {
    return { id: "workspace-home", kind: "workspace-root", workspaceSlug, currentHref, parentHref: null };
  }

  if (section === "channel") {
    if (!detail) return { id: "channel", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: root };
    const channelHref = `${root}/channel/${detail}`;
    const params = new URLSearchParams(location.search);
    if (params.get("from") === "tasks") {
      return { id: "task-source", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: `${root}/tasks` };
    }
    if (params.has("thread")) {
      return { id: "thread", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: detailParentHref(channelHref, location.search, location.hash, ["thread", "agentTab"]) };
    }
    const tab = params.get("chatTab");
    if (tab === "tasks" || tab === "files") {
      return { id: `channel-${tab}`, kind: "workspace-detail", workspaceSlug, currentHref, parentHref: detailParentHref(channelHref, location.search, location.hash, ["chatTab"]) };
    }
    return { id: "channel", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: root };
  }

  if (section === "agent") {
    return detail
      ? { id: "agent-profile", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: `${root}/agent` }
      : { id: "members", kind: "workspace-root", workspaceSlug, currentHref, parentHref: null };
  }

  if (section === "human") {
    return {
      id: "human-profile",
      kind: "workspace-detail",
      workspaceSlug,
      currentHref,
      parentHref: `${root}/agent`,
    };
  }

  if (section === "tasks") {
    return detail
      ? { id: "channel-tasks", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: `${root}/tasks` }
      : { id: "tasks", kind: "workspace-root", workspaceSlug, currentHref, parentHref: null };
  }

  if (section === "computer") {
    return detail
      ? { id: "computer-detail", kind: "workspace-detail", workspaceSlug, currentHref, parentHref: `${root}/computer` }
      : { id: "computers", kind: "workspace-root", workspaceSlug, currentHref, parentHref: null };
  }

  if (section === "settings") {
    return detail
      ? { id: `settings-${detail}`, kind: "workspace-detail", workspaceSlug, currentHref, parentHref: `${root}/settings` }
      : { id: "settings", kind: "workspace-root", workspaceSlug, currentHref, parentHref: null };
  }

  const globalDetailIds: Record<string, string> = {
    inbox: "activity",
    saved: "saved",
    showcase: "showcase",
    search: "search",
  };
  if (globalDetailIds[section]) {
    return {
      id: globalDetailIds[section],
      kind: "workspace-detail",
      workspaceSlug,
      currentHref,
      parentHref: root,
    };
  }

  return { id: "unknown", kind: "unknown", workspaceSlug, currentHref, parentHref: root };
}

export function canonicalWorkspaceHref(location: AppPageLocation, workspaceSlug: string): string {
  const pathname = normalizedPath(location.pathname).replace(/^\/s\/[^/]+/, `/s/${workspaceSlug}`);
  return `${pathname}${location.search}${location.hash}`;
}
