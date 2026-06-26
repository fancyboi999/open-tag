// Global state + API + socket.io event bus (React Context). Chat messages and traces are consumed by views via onEvent.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { appendCapped, type TrajItem } from "./trajBuffer.ts";

export interface Channel { id: string; name: string; description?: string; type: string; joined?: boolean; lastMessageAt?: string; archivedAt?: string | null }
export interface Dm { id: string; name: string; type: string; description?: string; lastMessageAt?: string; peerId?: string | null; peerName?: string | null; peerDisplayName?: string | null; peerType?: string | null; peerAvatarUrl?: string | null }
export interface Agent { id: string; name: string; displayName: string; description?: string; status: string; activity?: string; activityDetail?: string; model?: string; runtime: string; machineId?: string; avatarUrl?: string | null; creatorType?: string }
export interface Machine { id: string; name?: string; hostname?: string; os?: string; runtimes?: string[]; status?: string; daemonVersion?: string; isComputer?: boolean }
export interface Human { userId: string; name: string; displayName?: string; role?: string; description?: string; avatarUrl?: string | null }
export interface ServerInfo { id: string; name: string; slug: string; avatarUrl?: string | null; role?: string; capabilities?: Record<string, boolean> }
export interface Me { id: string; name: string; displayName?: string }
export interface Att { id: string; filename: string; mimeType?: string; sizeBytes?: number }
export interface Reaction { emoji: string; count: number; reactorIds: string[]; reactorNames: string[] }
export interface ActionMeta { kind: string; state: "prepared" | "executed"; action: { type: string; name: string; description?: string | null; visibility?: string; initialHumans?: string[]; initialAgents?: string[]; requiredComputer?: string | null; suggestedComputer?: string | null }; executedByUserName?: string | null; result?: { kind: string; id: string; name: string } | null }
export interface Msg { id: string; seq: number; channelId: string; senderType: string; senderId?: string | null; senderName: string; content: string; messageType?: string; actionMetadata?: ActionMeta | null; createdAt?: string; taskStatus?: string | null; taskNumber?: number | null; taskAssigneeType?: string | null; taskAssigneeId?: string | null; mentions?: { type?: string; id?: string; name: string }[]; attachments?: Att[]; reactions?: Reaction[] }
type Ev = { type: string; [k: string]: any };

interface Store {
  ready: boolean; authState: "loading" | "authed" | "anon"; serverId: string; slug: string; me: Me | null; myRole: string; serverAvatar: string | null;
  servers: ServerInfo[]; capabilities: Record<string, boolean>;
  uploadServerAvatar: (file: File) => Promise<void>;
  uploadAgentAvatar: (agentId: string, file: File) => Promise<string>;
  uploadUserAvatar: (file: File) => Promise<string>;
  createServer: (name: string, slug?: string) => Promise<string | null>; // POST → optimistically add to servers; returns the new slug so the caller navigates client-side (no full-page reload)
  switchServer: (slug: string) => void;                          // client-side workspace switch: re-point the active server, reset per-workspace state, reconnect the socket (no full-page reload)
  logout: () => void;
  channels: Channel[]; dms: Dm[]; unread: Record<string, number>;
  agents: Agent[];        // ALL agents incl. system-seeded showcase demo agents — resolve a sender's avatar/name/profile by id (incl. #showcase history)
  visibleAgents: Agent[]; // agents minus system-seeded showcase demo agents — use for member rosters and every agent picker / @mention candidate list
  machines: Machine[]; humans: Human[];
  latestDaemonVersion: string;                                    // newest published daemon version (packages/daemon); online machines below it are flagged outdated in the system-alert center
  traj: TrajItem[];                                               // global Agent Live Trace ring buffer (newest TRAJ_CAP entries); survives channel/DM switch, fed by agent:activity
  api: (m: string, p: string, b?: unknown) => Promise<any>;
  reload: () => Promise<void>;
  onEvent: (cb: (e: Ev) => void) => () => void;
  subscribeChannel: (id: string) => void;                         // join the channel/thread's realtime room while it is being viewed (idempotent; re-emitted on reconnect)
  createChannel: (opts: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => Promise<{ id: string } | null>;
  markActionExecuted: (messageId: string, result?: { kind: string; id: string; name: string }) => Promise<void>; // mark action card as executed after submission
  createTasks: (channelId: string, titles: string[]) => Promise<any[]>;
  openDM: (memberType: string, memberId: string) => Promise<string | null>;
  joinChannel: (id: string) => Promise<void>;
  leaveChannel: (id: string) => Promise<void>;
  markRead: (id: string) => void;
  uploadFiles: (channelId: string, files: FileList | File[]) => Promise<any[]>;
  uploadOne: (channelId: string, file: File, onProgress?: (pct: number) => void) => Promise<any>;
  attachmentUrl: (id: string) => string;
  react: (messageId: string, emoji: string, remove?: boolean) => Promise<void>;
  openThread: (parentChannelId: string, parentMessageId: string) => Promise<string | null>;
  openAgentPanel: (agentId: string) => void;                      // request the agent profile panel (Activity tab) to open in the chat right column; consumed once by the Chat view
  agentPanelReq: string | null;                                   // pending open-agent-panel request (agent id); null when none
  clearAgentPanelReq: () => void;                                 // clear the pending request after the Chat view has consumed it
  savedIds: Set<string>;                                          // saved message ids known in this session (bookmark state + Saved count source)
  saveMsg: (messageId: string) => Promise<void>;
  unsaveMsg: (messageId: string) => Promise<void>;
  listSaved: (limit?: number, offset?: number) => Promise<{ saved: any[]; hasMore: boolean }>;
}
const Ctx = createContext<Store>(null as any);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authState, setAuthState] = useState<"loading" | "authed" | "anon">("loading"); // human-auth gate: drives the /s/* route guard (no dev-login fallback)
  const [serverId, setServerId] = useState("");
  const [slug, setSlug] = useState("open-tag");
  const [servers, setServers] = useState<ServerInfo[]>([]);          // all servers the user belongs to (used by server switcher)
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({}); // capability flags for the current server (used to show/hide UI)
  const [serverAvatar, setServerAvatar] = useState<string | null>(null); // workspace avatar URL (token-signed for sidebar display); null = use first letter
  const [me, setMe] = useState<Me | null>(null);
  const [myRole, setMyRole] = useState(""); // current workspace role (owner/admin/member) — used for manageServer permission check on task board
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<Dm[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [latestDaemonVersion, setLatestDaemonVersion] = useState(""); // newest published daemon version from the machines endpoint; "" until first load (→ raises no outdated alert)
  const [humans, setHumans] = useState<Human[]>([]);
  const [traj, setTraj] = useState<TrajItem[]>([]); // global live-trace feed: bounded ring buffer held here (not per Chat view) so it persists across channel/DM switches
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [agentPanelReq, setAgentPanelReq] = useState<string | null>(null); // cross-component signal: LiveAgentBar (sidebar) → Chat view opens the agent profile panel
  const [activeId, setActiveId] = useState(""); // id of the workspace to activate; changing it drives the activation effect (initial pick + every client-side switch)
  const tokenRef = useRef("");
  const sidRef = useRef("");
  const serversRef = useRef<ServerInfo[]>([]); // mirror of `servers` for lookups in effects/handlers without taking a render dependency on it
  const meIdRef = useRef<string | undefined>(undefined); // current user id; read by socket handlers (own-message unread suppression) and stable across workspace switches
  const sockRef = useRef<Socket | null>(null); // active socket connection; emits join:channel when joining/creating a channel mid-session for room isolation
  const subscribedRef = useRef<Set<string>>(new Set()); // channels/threads explicitly subscribed by the active view; re-emitted on every (re)connect so a reconnect re-joins them
  const listeners = useRef(new Set<(e: Ev) => void>());

  const api = async (method: string, path: string, body?: unknown) => {
    // Race condition on first render: views may call api before dev-login completes; wait until both token and serverId are ready.
    // (Waiting only for token would send requests with empty x-server-id, causing empty data on first load, e.g. AgentProfile.)
    for (let i = 0; i < 60 && (!tokenRef.current || !sidRef.current); i++) await new Promise((r) => setTimeout(r, 30));
    const r = await fetch(path, { method, headers: { "content-type": "application/json", authorization: "Bearer " + tokenRef.current, "x-server-id": sidRef.current }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const reload = async () => {
    // Pin the target server at entry. A client-side workspace switch re-points sidRef mid-flight; `fresh()` then
    // turns false, so this (now-stale) reload's results are dropped instead of landing mixed with the new
    // workspace's data — guards rapid A→B→C switches (the sequential awaits below each read the shared sidRef).
    const sid = sidRef.current;
    const fresh = () => sidRef.current === sid;
    const ch = await api("GET", "/api/channels"); if (fresh()) setChannels(ch);
    try { const dm = await api("GET", "/api/channels/dm"); if (fresh()) setDms(dm); } catch { if (fresh()) setDms([]); }
    try { const un = (await api("GET", "/api/channels/unread")) || {}; if (fresh()) setUnread(un); } catch { if (fresh()) setUnread({}); }
    const ag = await api("GET", "/api/agents"); if (fresh()) setAgents(ag);
    try { const mc = await api("GET", `/api/servers/${sid}/machines`); if (fresh()) { setMachines(mc.machines || []); setLatestDaemonVersion(mc.latestDaemonVersion || ""); } } catch { if (fresh()) setMachines([]); }
    try { const hm = await api("GET", `/api/servers/${sid}/members`); if (fresh()) setHumans(hm); } catch { if (fresh()) setHumans([]); }
  };
  const onEvent = (cb: (e: Ev) => void) => { listeners.current.add(cb); return () => { listeners.current.delete(cb); }; };
  // View-driven realtime subscription: opening a channel/thread joins its room so message:new arrives live, regardless of how the
  // channel became relevant (public non-member, thread, or appeared after connect). Tracked so a reconnect re-joins. Idempotent.
  const subscribeChannel = (id: string) => { if (!id) return; subscribedRef.current.add(id); sockRef.current?.emit("join:channel", id); };

  const createChannel = async (opts: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => { const r = await api("POST", "/api/channels", { name: opts.name, description: opts.description, visibility: opts.visibility, agentIds: opts.agentIds ?? [], userIds: opts.userIds ?? [] }); if (r?.id) { await reload(); sockRef.current?.emit("join:channel", r.id); } return r?.id ? r : null; };
  // Create workspace → optimistically add it to the server list (POST returns role+capabilities so no re-fetch needed) and
  // return the new slug. The caller navigates client-side to /s/<slug>/channel; the URL drives activation (see main.tsx),
  // so there is no full-page reload — the workspace skeleton shows while the new workspace's data loads.
  const createServer = async (name: string, slug?: string): Promise<string | null> => {
    const r = await api("POST", "/api/servers", { name, slug });
    if (!r?.id) return null;
    const info: ServerInfo = { id: r.id, name: r.name, slug: r.slug, avatarUrl: null, role: r.role || "owner", capabilities: r.capabilities || {} };
    const next = [...serversRef.current.filter((s) => s.id !== r.id), info];
    serversRef.current = next; setServers(next);
    return r.slug;
  };
  // Client-side workspace switch: re-point the active server by slug. The activation effect (keyed on activeId) resets
  // per-workspace state and reconnects the socket. No-op if the target is unknown or already active.
  const switchServer = (targetSlug: string) => { const cur = serversRef.current.find((s) => s.slug === targetSlug); if (cur && cur.id !== sidRef.current) setActiveId(cur.id); };
  const logout = () => { localStorage.removeItem("open-tag.token"); localStorage.removeItem("open-tag.devuser"); window.location.assign("/login"); }; // clear token + dev user → redirect to login (JWT is short-lived; client-side removal is sufficient)
  const markActionExecuted = async (messageId: string, result?: { kind: string; id: string; name: string }) => { await api("POST", `/api/actions/${messageId}/mark-executed`, { result: result ?? null }); };
  const createTasks = async (channelId: string, titles: string[]) => { const r = await api("POST", `/api/tasks/channel/${channelId}`, { tasks: titles.map((title) => ({ title })) }); return r?.tasks || []; };
  const openDM = async (memberType: string, memberId: string) => { const body = memberType === "user" ? { userId: memberId } : { agentId: memberId }; const r = await api("POST", "/api/channels/dm", body); if (r?.id) { await reload(); sockRef.current?.emit("join:channel", r.id); } return r?.id ?? null; };
  const joinChannel = async (id: string) => { await api("POST", `/api/channels/${id}/join`); await reload(); sockRef.current?.emit("join:channel", id); };
  const leaveChannel = async (id: string) => { await api("POST", `/api/channels/${id}/leave`); await reload(); };
  const markRead = (id: string) => { setUnread((u) => { const n = { ...u }; delete n[id]; return n; }); api("POST", `/api/channels/${id}/read`, {}).catch(() => {}); };
  const uploadFiles = async (channelId: string, files: FileList | File[]) => {
    const fd = new FormData(); fd.append("channelId", channelId);
    for (const f of Array.from(files)) fd.append("files", f);
    const r = await fetch("/api/attachments/upload", { method: "POST", headers: { authorization: "Bearer " + tokenRef.current, "x-server-id": sidRef.current }, body: fd });
    return (await r.json())?.attachments || [];
  };
  // Single-file upload with progress tracking (XHR; fetch does not expose upload progress). Returns one attachment.
  const uploadOne = (channelId: string, file: File, onProgress?: (pct: number) => void) => new Promise<any>((resolve, reject) => {
    const fd = new FormData(); fd.append("channelId", channelId); fd.append("files", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments/upload");
    xhr.setRequestHeader("authorization", "Bearer " + tokenRef.current);
    xhr.setRequestHeader("x-server-id", sidRef.current);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)?.attachments?.[0]); } catch { reject(new Error("parse")); } } else reject(new Error("status " + xhr.status)); };
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(fd);
  });
  const attachmentUrl = (id: string) => `/api/attachments/${id}?token=${encodeURIComponent(tokenRef.current)}`;
  const uploadServerAvatar = async (file: File) => { // workspace avatar upload (owner/admin only): upload image → refresh sidebar tile
    const fd = new FormData(); fd.append("files", file);
    const r = await fetch(`/api/servers/${sidRef.current}/avatar`, { method: "POST", headers: { authorization: "Bearer " + tokenRef.current, "x-server-id": sidRef.current }, body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "upload failed");
    const { avatarUrl } = await r.json();
    setServerAvatar(avatarUrl ? `${avatarUrl}?token=${encodeURIComponent(tokenRef.current)}` : null);
  };
  const uploadAgentAvatar = async (agentId: string, file: File): Promise<string> => {
    const fd = new FormData(); fd.append("files", file);
    const r = await fetch(`/api/agents/${agentId}/avatar`, { method: "POST", headers: { authorization: "Bearer " + tokenRef.current, "x-server-id": sidRef.current }, body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "upload failed");
    const { avatarUrl } = await r.json();
    return `${avatarUrl}?token=${encodeURIComponent(tokenRef.current)}`;
  };
  const uploadUserAvatar = async (file: File): Promise<string> => {
    const fd = new FormData(); fd.append("files", file);
    const r = await fetch("/api/auth/me/avatar", { method: "POST", headers: { authorization: "Bearer " + tokenRef.current, "x-server-id": sidRef.current }, body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "upload failed");
    const { avatarUrl } = await r.json();
    return `${avatarUrl}?token=${encodeURIComponent(tokenRef.current)}`;
  };
  const react = async (messageId: string, emoji: string, remove = false) => { await api(remove ? "DELETE" : "POST", `/api/messages/${messageId}/reactions`, { emoji }); };
  const openThread = async (parentChannelId: string, parentMessageId: string) => { const r = await api("POST", `/api/channels/${parentChannelId}/threads`, { parentMessageId }); return r?.threadChannelId ?? null; };
  const openAgentPanel = (agentId: string) => setAgentPanelReq(agentId); // LiveAgentBar → Chat: open the agent profile panel (Activity tab); Chat consumes & clears
  const clearAgentPanelReq = () => setAgentPanelReq(null);
  // Saved messages: private bookmarks, optimistically update savedIds.
  const saveMsg = async (messageId: string) => { setSavedIds((s) => new Set(s).add(messageId)); await api("POST", "/api/channels/saved", { messageId }); };
  const unsaveMsg = async (messageId: string) => { setSavedIds((s) => { const n = new Set(s); n.delete(messageId); return n; }); await api("DELETE", `/api/channels/saved/${messageId}`); };
  const listSaved = async (limit = 20, offset = 0) => { const r = await api("GET", `/api/channels/saved?limit=${limit}&offset=${offset}`); return { saved: r?.saved ?? [], hasMore: !!r?.hasMore }; };

  // ── Auth bootstrap (runs once): resolve a session token + the user's workspace list, then pick the initial workspace
  //    from the URL. Loading that workspace (its data + socket) is the activation effect below, keyed on activeId — the
  //    SAME path a client-side switch takes, so there is one load path, not two.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Resolve a session token. Precedence: explicit ?as= dev-login (dev only) > stored JWT. NO silent fallback —
      // an anonymous visitor never auto-logs-in; the /s/* route guard sends them to /login (see main.tsx).
      const asParam = new URLSearchParams(window.location.search).get("as");
      let token: string | null = null;
      let user: Me | null = null;
      if (asParam) { // explicit developer action: dev-login only succeeds when the backend has ALLOW_DEV_LOGIN=true; on success persist the JWT as a normal session
        const r = await fetch("/api/auth/dev-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: asParam }) });
        if (r.ok) { const d = await r.json().catch(() => null); if (d?.token) { token = d.token; user = d.user ?? null; localStorage.setItem("open-tag.token", d.token); } }
      }
      if (!token) {
        const storedToken = localStorage.getItem("open-tag.token"); // JWT persisted after real register/login (or dev-login above)
        if (storedToken) {
          const meRes = await (await fetch("/api/auth/me", { headers: { authorization: "Bearer " + storedToken } })).json().catch(() => null);
          if (meRes?.id) { token = storedToken; user = meRes; }
          else localStorage.removeItem("open-tag.token"); // expired / invalid / 401 → drop it so the guard redirects to /login
        }
      }
      if (cancelled) return;
      if (!token) { setAuthState("anon"); setReady(true); return; } // unauthenticated: auth pages & landing render; protected routes redirect to /login
      tokenRef.current = token;
      meIdRef.current = user?.id;
      setMe(user);
      setAuthState("authed");
      const serverList: ServerInfo[] = await (await fetch("/api/servers", { headers: { authorization: "Bearer " + tokenRef.current } })).json();
      if (cancelled) return;
      serversRef.current = serverList;
      setServers(serverList);
      const urlSlug = location.pathname.match(/\/s\/([^/]+)/)?.[1]; // resolve workspace from URL /s/:slug (multi-workspace support); fall back to first
      const cur = serverList.find((s) => s.slug === urlSlug) || serverList[0];
      if (!cur) { setReady(true); return; } // no workspace found: prevent white screen (defensive fallback; workspace is normally created on register/dev-login)
      setActiveId(cur.id); // → activation effect loads this workspace + opens the socket
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Workspace activation (runs on the initial pick + every client-side switch): load the active workspace's data and
  //    open a socket scoped to it. Resets all per-workspace state first so nothing leaks across a switch, and flips
  //    `ready` false→true so the route guard shows the workspace skeleton during the gap (no blank screen, no reload).
  useEffect(() => {
    if (!activeId) return; // nothing to activate yet (pre-auth / anon / no-workspace)
    const cur = serversRef.current.find((s) => s.id === activeId);
    if (!cur) return; // unknown id (should not happen: serversRef is always seeded before setActiveId)
    let sock: Socket | null = null;
    // StrictMode / switch guard: socket is built asynchronously; if this effect is cleaned up (unmount or a newer
    // switch) before the socket connects, the flag ensures the late connection is closed immediately.
    let cancelled = false;
    const dispatch = (d: Ev) => listeners.current.forEach((cb) => cb(d));
    // Unread badge correction: optimistic ++ gives instant feedback; after each incoming message a debounced
    // re-fetch of /channels/unread overwrites store.unread with the DB truth, fixing badge drift caused by
    // cross-view messages or reconnect catch-up double-counting.
    let unreadTimer: ReturnType<typeof setTimeout> | null = null;
    const syncUnread = () => { if (unreadTimer) clearTimeout(unreadTimer); unreadTimer = setTimeout(async () => { try { setUnread((await api("GET", "/api/channels/unread")) || {}); } catch { /* keep stale value on error */ } }, 400); };
    const myId = meIdRef.current;
    // Point at the active workspace + clear the previous one's state so a switch starts from a clean slate; the
    // ready=false → workspace skeleton shows while it reloads.
    setReady(false);
    sidRef.current = cur.id; setServerId(cur.id); setSlug(cur.slug || "open-tag"); setMyRole(cur.role || "member"); setCapabilities(cur.capabilities || {});
    setServerAvatar(cur.avatarUrl ? `${cur.avatarUrl}?token=${encodeURIComponent(tokenRef.current)}` : null);
    setChannels([]); setDms([]); setUnread({}); setAgents([]); setMachines([]); setHumans([]); setTraj([]); setSavedIds(new Set()); setAgentPanelReq(null);
    subscribedRef.current = new Set(); // the previous workspace's view-subscriptions don't carry over
    sockRef.current = null; // the previous socket is closed by this effect's cleanup; drop the stale ref until the new one connects
    let lastSeq = 0;
    (async () => {
      await reload();
      if (cancelled) return;
      // Pre-load saved message id set (small enough for a single full fetch; drives bookmark state + Saved count).
      try { const sv = await api("GET", "/api/channels/saved?limit=100"); setSavedIds(new Set((sv?.saved ?? []).map((s: any) => s.messageId))); } catch { /* */ }
      // Track highest seq so reconnect can fetch only missed messages incrementally.
      try { const s = await api("GET", "/api/messages/sync?since=0"); lastSeq = s?.maxSeq ?? 0; } catch { /* */ }
      if (cancelled) return;
      setReady(true);
      // Socket.io handshake auth carries {token, serverId}; event names follow the workspace protocol
      // (message:new / agent:activity / machine:status).
      sock = io("/", { auth: { token: tokenRef.current, serverId: sidRef.current }, transports: ["websocket"] });
      if (cancelled) { sock.close(); sock = null; return; } // late connect after unmount/switch → close immediately
      sockRef.current = sock; // exposed so joinChannel/createChannel/openDM can emit join:channel for room isolation
      let firstConnect = true;
      sock.on("connect", async () => {
        for (const id of subscribedRef.current) sock!.emit("join:channel", id); // re-join view-subscribed rooms (the server only auto-joins member channels at connect; reconnect would otherwise drop non-member/thread rooms)
        if (firstConnect) { firstConnect = false; return; } // first connect is covered by the initial reload()
        // Reconnect: fetch only messages missed during disconnect (incremental, not full reload).
        try {
          const r = await api("GET", `/api/messages/sync?since=${lastSeq}`);
          for (const msg of (r?.messages || [])) {
            if (msg.senderId !== myId && msg.channelId) setUnread((u) => ({ ...u, [msg.channelId]: (u[msg.channelId] || 0) + 1 }));
            dispatch({ type: "message", channelId: msg.channelId, message: msg });
          }
          syncUnread(); // correct badge after catch-up (prevent double-count inflation)
          if (r?.maxSeq) lastSeq = Math.max(lastSeq, r.maxSeq);
        } catch { /* */ }
      });
      sock.on("message:new", (msg: any) => {
        if (msg?.seq) lastSeq = Math.max(lastSeq, msg.seq);
        if (msg?.channelId) {
          // Own messages don't increment unread; all others do.
          if (msg.senderId !== myId) { setUnread((u) => ({ ...u, [msg.channelId]: (u[msg.channelId] || 0) + 1 })); syncUnread(); } // optimistic ++ for instant feedback; debounced re-fetch corrects stale counts
          setChannels((cs) => cs.map((c) => (c.id === msg.channelId ? { ...c, lastMessageAt: msg.createdAt } : c)));
          setDms((ds) => ds.map((d) => (d.id === msg.channelId ? { ...d, lastMessageAt: msg.createdAt } : d)));
        }
        dispatch({ type: "message", channelId: msg.channelId, message: msg }); // normalize to internal event bus shape; views stay unchanged
      });
      sock.on("agent:activity", (p: any) => {
        if (p?.entries) {
          dispatch({ type: "trajectory", agentId: p.agentId, name: p.name, entries: p.entries });
          // Also accumulate into the global live-trace ring buffer (capped at TRAJ_CAP) so the panel keeps history across channel/DM switches. Mapping mirrors the panel's render shape.
          setTraj((prev) => appendCapped(prev, (p.entries as any[]).map((x) => ({ name: p.name, tool: !!x.toolName, text: x.text || (x.toolName ? `${x.toolName}${x.toolInput ? " — " + x.toolInput : ""}` : "") || x.detail || "" }))));
        }
        else {
          setAgents((as) => as.map((a) => (a.id === p.agentId ? { ...a, status: p.status ?? a.status, activity: p.activity ?? a.activity, activityDetail: p.detail ?? a.activityDetail } : a))); // real-time status dot + activity text used by header and sidebar
          dispatch({ type: "agent", id: p.agentId, name: p.name, activity: p.activity, status: p.status, detail: p.detail });
        }
      });
      sock.on("agent:created", () => reload());
      sock.on("agent:deleted", () => reload());
      // Real-time: new DM / channel membership change → reload lists + join the new channel room
      // (the server validates membership; non-member join requests are rejected).
      sock.on("dm:new", (p: any) => { reload(); if (p?.channelId) sockRef.current?.emit("join:channel", p.channelId); });
      sock.on("channel:members-updated", (p: any) => { reload(); if (p?.channelId) sockRef.current?.emit("join:channel", p.channelId); });
      // Machine online/offline → reload machine list (DB is source of truth for status/daemon version/runtimes/new rows).
      // Note: machine:status payload omits id (only forwards {online,hostname,runtimes}), so targeted row update is not possible → full reload is safest.
      sock.on("machine:status", async (p: any) => {
        try { const mc = await api("GET", `/api/servers/${sidRef.current}/machines`); setMachines(mc.machines || []); setLatestDaemonVersion(mc.latestDaemonVersion || ""); } catch { /* keep stale value on error */ }
        dispatch({ type: "machine", ...p });
      });
      sock.on("task:created", (p: any) => (p.tasks || []).forEach((t: any) => dispatch({ type: "task", op: "created", task: t }))); // payload={channelId,tasks:[]}
      sock.on("task:updated", (p: any) => dispatch({ type: "task", op: "updated", task: p.task }));                                  // payload={channelId,task}
      sock.on("task:deleted", (p: any) => dispatch({ type: "task", op: "deleted", taskId: p.taskId, channelId: p.channelId }));      // payload={channelId,taskId}
      sock.on("message:updated", (m: any) => dispatch({ type: "message:updated", message: m }));
      sock.on("thread:updated", (p: any) => dispatch({ type: "thread:updated", ...p }));
    })();
    return () => { cancelled = true; sock?.close(); sockRef.current = null; if (unreadTimer) clearTimeout(unreadTimer); };
  }, [activeId]);

  // Showcase demo agents (creatorType="system") stay in `agents` so #showcase history still resolves their
  // avatar/name/profile by id — but they are not real members, so every roster / picker uses `visibleAgents`.
  const visibleAgents = agents.filter((a) => a.creatorType !== "system");
  return <Ctx.Provider value={{ ready, authState, serverId, slug, me, myRole, serverAvatar, servers, capabilities, createServer, switchServer, logout, uploadServerAvatar, uploadAgentAvatar, uploadUserAvatar, channels, dms, unread, agents, visibleAgents, machines, latestDaemonVersion, humans, traj, api, reload, onEvent, subscribeChannel, createChannel, markActionExecuted, createTasks, openDM, joinChannel, leaveChannel, markRead, uploadFiles, uploadOne, attachmentUrl, react, openThread, openAgentPanel, agentPanelReq, clearAgentPanelReq, savedIds, saveMsg, unsaveMsg, listSaved }}>{children}</Ctx.Provider>;
}

export const fmtTime = (iso?: string) => { try { return iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false }) : ""; } catch { return ""; } };
