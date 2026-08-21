import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
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
  previousHref: string | null;
  previousNavigationWasPush: boolean;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function AppShellProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const page = useMemo(
    () => describeAppPage(location),
    [location.pathname, location.search, location.hash],
  );
  const historyIndex = typeof window.history.state?.idx === "number" ? window.history.state.idx : null;
  const lastPageRef = useRef({ page, historyIndex });
  const previousHrefRef = useRef<string | null>(null);
  const previousNavigationWasPushRef = useRef(false);
  if (page.currentHref !== lastPageRef.current.page.currentHref) {
    if (page.id !== lastPageRef.current.page.id || page.kind !== lastPageRef.current.page.kind) {
      previousHrefRef.current = lastPageRef.current.page.currentHref;
      previousNavigationWasPushRef.current = historyIndex !== null && lastPageRef.current.historyIndex !== null && historyIndex > lastPageRef.current.historyIndex;
    }
    lastPageRef.current = { page, historyIndex };
  }
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

  const previousHref = previousHrefRef.current;
  const previousNavigationWasPush = previousNavigationWasPushRef.current;
  const value = useMemo(() => ({ mode, page, previousHref, previousNavigationWasPush }), [mode, page, previousHref, previousNavigationWasPush]);
  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);
  if (!value) throw new Error("useAppShell must be used within AppShellProvider");
  return value;
}

export function WorkspaceShell() {
  const { mode, page, previousHref, previousNavigationWasPush } = useAppShell();
  return <Layout shellMode={mode} page={page} previousHref={previousHref} previousNavigationWasPush={previousNavigationWasPush} />;
}
