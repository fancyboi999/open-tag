import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Layout } from "./Layout.tsx";
import {
  describeAppPage,
  resolveShellMode,
  type AppPageDescriptor,
  type ShellMode,
} from "./shellRouting.ts";

const SHELL_CHOICE_KEY = "open-tag.preview-shell";

interface AppShellContextValue {
  mode: ShellMode;
  page: AppPageDescriptor;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function AppShellProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const page = useMemo(
    () => describeAppPage(location),
    [location.pathname, location.search, location.hash],
  );
  const mode = resolveShellMode({
    buildMode: import.meta.env.MODE,
    previewFlag: import.meta.env.VITE_PREVIEW_SHELL,
    search: location.search,
    storedChoice: sessionStorage.getItem(SHELL_CHOICE_KEY),
  });

  useEffect(() => {
    sessionStorage.setItem(SHELL_CHOICE_KEY, mode);
    document.documentElement.dataset.shell = mode;
    document.documentElement.dataset.pageId = page.id;
    document.documentElement.dataset.pageKind = page.kind;
    if (page.parentHref) document.documentElement.dataset.parentHref = page.parentHref;
    else delete document.documentElement.dataset.parentHref;
  }, [mode, page]);

  const value = useMemo(() => ({ mode, page }), [mode, page]);
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) throw new Error("useAppShell must be used within AppShellProvider");
  return value;
}

export function WorkspaceShell() {
  const { mode, page } = useAppShell();
  return <Layout shellMode={mode} page={page} />;
}
