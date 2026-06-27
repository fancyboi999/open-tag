import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { StoreProvider, useStore } from "./store.tsx";
import { WorkspaceSkeleton } from "./views/Skeleton.tsx";
import { ConfirmProvider } from "./ConfirmModal.tsx";
import { ToastProvider } from "./toast.tsx";
import { Layout } from "./Layout.tsx";
import { Chat } from "./views/Chat.tsx";
import { Showcase } from "./views/Showcase.tsx";
import { Members } from "./views/Members.tsx";
import { Tasks, Computers, Search, Settings, Inbox, Saved } from "./views/misc.tsx";
import { AuthPage, JoinPage } from "./views/Auth.tsx";
import { Landing } from "./views/Landing.tsx";
import { Features } from "./views/Features.tsx";
import { homeRoute } from "./routing.ts";
import "./i18n";
import "./styles.css";

// Public home ("/"). The marketing Landing is for anonymous visitors only; a user who has — or is
// still resolving — a session must never see it. While the bootstrap runs we show the workspace
// skeleton (NOT the marketing page, and NOT a blank screen), then send an authed user to their
// workspace. Same "wait for bootstrap before deciding" gate as RootRedirect/WorkspaceRoute, so
// every route is consistent and there is no flash of the wrong screen on refresh/deep-link.
function PublicHome() {
  const { slug, ready, authState } = useStore();
  switch (homeRoute({ authState, ready })) {
    case "redirect": return <Navigate to={`/s/${slug}/channel`} replace />;
    case "skeleton": return <WorkspaceSkeleton chat />; // bootstrap → we'll land on /channel, so render the 4-col chat skeleton now (shift-free)
    default: return <Landing />;
  }
}

// Root / unmatched path → wait for bootstrap, then redirect to the current user's own workspace (or /login if anonymous).
function RootRedirect() {
  const { slug, ready, authState } = useStore();
  if (!ready) return <WorkspaceSkeleton />; // bootstrap in flight: show the workspace skeleton, not a blank screen
  if (authState !== "authed") return <Navigate to="/login" replace />;
  return <Navigate to={`/s/${slug}/channel`} replace />;
}

// Auth guard + workspace activation for /s/:server/*. The URL is the source of truth for the active workspace: if it
// names a known workspace that isn't active yet, switch to it client-side (no full-page reload) and show the skeleton
// while it loads. The auth check runs BEFORE <Layout/> renders, so an unauthenticated visitor is redirected to /login
// without the workspace ever painting (no flash of protected UI).
function WorkspaceRoute() {
  const { slug, ready, authState, servers, switchServer } = useStore();
  const { server } = useParams();
  const loc = useLocation();
  const known = !!server && servers.some((s) => s.slug === server); // is the URL's slug a workspace this user belongs to?
  // URL → store: a known-but-not-active slug (server switcher, deep link, browser back/forward) drives a client-side switch.
  useEffect(() => { if (ready && authState === "authed" && known && server !== slug) switchServer(server!); }, [ready, authState, known, server, slug, switchServer]);
  if (!ready || (known && server !== slug)) return <WorkspaceSkeleton />; // bootstrap or a switch in flight → skeleton (do NOT bounce the URL while slug catches up)
  if (authState !== "authed") return <Navigate to="/login" replace />; // hard auth gate
  if (server !== slug) { // unknown / stale slug (not a member, typo) → canonicalize to the active workspace
    const pathname = loc.pathname.replace(/^\/s\/[^/]+/, `/s/${slug}`);
    return <Navigate to={`${pathname}${loc.search}${loc.hash}`} replace />;
  }
  return <Layout />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StoreProvider>
      <ConfirmProvider>
      <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<PublicHome />} />
          <Route path="/features" element={<Features />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/join/:token" element={<JoinPage />} />
          <Route path="/s/:server" element={<WorkspaceRoute />}>
            <Route index element={<Navigate to="channel" replace />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="saved" element={<Saved />} />
            <Route path="showcase" element={<Showcase />} />
            <Route path="channel" element={<Chat />} />
            <Route path="channel/:channelId" element={<Chat />} />
            <Route path="agent" element={<Members />} />
            <Route path="agent/:agentId" element={<Members />} />
            <Route path="human/:userId" element={<Members />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/:channelId" element={<Tasks />} />
            <Route path="computer" element={<Computers />} />
            <Route path="computer/:machineId" element={<Computers />} />
            <Route path="search" element={<Search />} />
            <Route path="settings" element={<Settings />} />
            <Route path="settings/:section" element={<Settings />} />
          </Route>
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
      </ToastProvider>
      </ConfirmProvider>
    </StoreProvider>
  </React.StrictMode>,
);
