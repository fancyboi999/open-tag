import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { StoreProvider, useStore } from "./store.tsx";
import { ConfirmProvider } from "./ConfirmModal.tsx";
import { Layout } from "./Layout.tsx";
import { Chat } from "./views/Chat.tsx";
import { Members } from "./views/Members.tsx";
import { Tasks, Computers, Search, Settings, Inbox, Saved } from "./views/misc.tsx";
import { AuthPage, JoinPage } from "./views/Auth.tsx";
import { Landing } from "./views/Landing.tsx";
import "./i18n";
import "./styles.css";

// Root / unmatched path → wait for bootstrap, then redirect to the current user's own workspace (or /login if anonymous).
function RootRedirect() {
  const { slug, ready, authState } = useStore();
  if (!ready) return null; // wait for bootstrap to resolve auth + slug before redirecting
  if (authState !== "authed") return <Navigate to="/login" replace />;
  return <Navigate to={`/s/${slug}/channel`} replace />;
}

// Auth guard + slug canonicalization for /s/:server/*. The auth check runs BEFORE <Layout/> renders, so an
// unauthenticated visitor is redirected to /login without the workspace ever painting (no flash of protected UI).
function WorkspaceRoute() {
  const { slug, ready, authState } = useStore();
  const { server } = useParams();
  const loc = useLocation();
  if (!ready) return null; // bootstrap in flight: render nothing (not the workspace)
  if (authState !== "authed") return <Navigate to="/login" replace />; // hard auth gate
  if (server !== slug) {
    const pathname = loc.pathname.replace(/^\/s\/[^/]+/, `/s/${slug}`);
    return <Navigate to={`${pathname}${loc.search}${loc.hash}`} replace />;
  }
  return <Layout />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StoreProvider>
      <ConfirmProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/join/:token" element={<JoinPage />} />
          <Route path="/s/:server" element={<WorkspaceRoute />}>
            <Route index element={<Navigate to="channel" replace />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="saved" element={<Saved />} />
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
      </ConfirmProvider>
    </StoreProvider>
  </React.StrictMode>,
);
