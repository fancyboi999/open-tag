// Global state + API + socket.io event bus (React Context). Chat messages and traces are consumed by views via onEvent.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";

export interface Channel { id: string; name: string; description?: string; type: string; joined?: boolean; lastMessageAt?: string; archivedAt?: string | null }
export interface Dm { id: string; name: string; type: string; description?: string; lastMessageAt?: string; peerId?: string | null; peerName?: string | null; peerDisplayName?: string | null; peerType?: string | null; peerAvatarUrl?: string | null }
export interface Agent { id: string; name: string; displayName: string; description?: string; status: string; activity?: string; activityDetail?: string; model?: string; runtime: string; machineId?: string }
export interface Machine { id: string; name?: string; hostname?: string; os?: string; runtimes?: string[]; status?: string; daemonVersion?: string; isComputer?: boolean }
export interface Human { userId: string; name: string; displayName?: string; role?: string }
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
  createServer: (name: string, slug?: string) => Promise<void>;
  logout: () => void;
  channels: Channel[]; dms: Dm[]; unread: Record<string, number>; agents: Agent[]; machines: Machine[]; humans: Human[];
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
  const [humans, setHumans] = useState<Human[]>([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const tokenRef = useRef("");
  const sidRef = useRef("");
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
    setChannels(await api("GET", "/api/channels"));
    try { setDms(await api("GET", "/api/channels/dm")); } catch { setDms([]); }
    try { setUnread(await api("GET", "/api/channels/unread") || {}); } catch { setUnread({}); }
    setAgents(await api("GET", "/api/agents"));
    try { const mc = await api("GET", `/api/servers/${sidRef.current}/machines`); setMachines(mc.machines || []); } catch { setMachines([]); }
    try { setHumans(await api("GET", `/api/servers/${sidRef.current}/members`)); } catch { setHumans([]); }
  };
  const onEvent = (cb: (e: Ev) => void) => { listeners.current.add(cb); return () => { listeners.current.delete(cb); }; };
  // View-driven realtime subscription: opening a channel/thread joins its room so message:new arrives live, regardless of how the
  // channel became relevant (public non-member, thread, or appeared after connect). Tracked so a reconnect re-joins. Idempotent.
  const subscribeChannel = (id: string) => { if (!id) return; subscribedRef.current.add(id); sockRef.current?.emit("join:channel", id); };

  const createChannel = async (opts: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => { const r = await api("POST", "/api/channels", { name: opts.name, description: opts.description, visibility: opts.visibility, agentIds: opts.agentIds ?? [], userIds: opts.userIds ?? [] }); if (r?.id) { await reload(); sockRef.current?.emit("join:channel", r.id); } return r?.id ? r : null; };
  const createServer = async (name: string, slug?: string) => { const r = await api("POST", "/api/servers", { name, slug }); if (r?.slug) window.location.assign(`/s/${r.slug}/channel`); }; // create workspace → full-page redirect to re-run bootstrap
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
  // Saved messages: private bookmarks, optimistically update savedIds.
  const saveMsg = async (messageId: string) => { setSavedIds((s) => new Set(s).add(messageId)); await api("POST", "/api/channels/saved", { messageId }); };
  const unsaveMsg = async (messageId: string) => { setSavedIds((s) => { const n = new Set(s); n.delete(messageId); return n; }); await api("DELETE", `/api/channels/saved/${messageId}`); };
  const listSaved = async (limit = 20, offset = 0) => { const r = await api("GET", `/api/channels/saved?limit=${limit}&offset=${offset}`); return { saved: r?.saved ?? [], hasMore: !!r?.hasMore }; };

  useEffect(() => {
    let sock: Socket | null = null;
    // StrictMode double-mount guard: socket is built asynchronously; if the component unmounts before the
    // socket connects, the flag ensures the late connection is closed immediately (prevents duplicate sockets).
    let cancelled = false;
    const dispatch = (d: Ev) => listeners.current.forEach((cb) => cb(d));
    // Unread badge correction: optimistic ++ gives instant feedback; after each incoming message a debounced
    // re-fetch of /channels/unread overwrites store.unread with the DB truth, fixing badge drift caused by
    // cross-view messages or reconnect catch-up double-counting.
    let unreadTimer: ReturnType<typeof setTimeout> | null = null;
    const syncUnread = () => { if (unreadTimer) clearTimeout(unreadTimer); unreadTimer = setTimeout(async () => { try { setUnread((await api("GET", "/api/channels/unread")) || {}); } catch { /* keep stale value on error */ } }, 400); };
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
      if (!token) { setAuthState("anon"); setReady(true); return; } // unauthenticated: auth pages & landing render; protected routes redirect to /login
      tokenRef.current = token;
      setMe(user);
      setAuthState("authed");
      const myId = user?.id;
      const serverList: ServerInfo[] = await (await fetch("/api/servers", { headers: { authorization: "Bearer " + tokenRef.current } })).json();
      setServers(serverList);
      const urlSlug = location.pathname.match(/\/s\/([^/]+)/)?.[1]; // resolve workspace from URL /s/:slug (multi-workspace support); fall back to first
      const cur = serverList.find((s) => s.slug === urlSlug) || serverList[0];
      if (!cur) { setReady(true); return; } // no workspace found: prevent white screen (defensive fallback; workspace is normally created on register/dev-login)
      sidRef.current = cur.id; setServerId(cur.id); setSlug(cur.slug || "open-tag"); setMyRole(cur.role || "member"); setCapabilities(cur.capabilities || {});
      setServerAvatar(cur.avatarUrl ? `${cur.avatarUrl}?token=${encodeURIComponent(tokenRef.current)}` : null);
      await reload();
      // Pre-load saved message id set (small enough for a single full fetch; drives bookmark state + Saved count).
      try { const sv = await api("GET", "/api/channels/saved?limit=100"); setSavedIds(new Set((sv?.saved ?? []).map((s: any) => s.messageId))); } catch { /* */ }
      // Track highest seq so reconnect can fetch only missed messages incrementally.
      let lastSeq = 0;
      try { const s = await api("GET", "/api/messages/sync?since=0"); lastSeq = s?.maxSeq ?? 0; } catch { /* */ }
      setReady(true);
      // Socket.io handshake auth carries {token, serverId}; event names follow the workspace protocol
      // (message:new / agent:activity / machine:status).
      sock = io("/", { auth: { token: tokenRef.current, serverId: sidRef.current }, transports: ["websocket"] });
      if (cancelled) { sock.close(); sock = null; return; } // late connect after unmount (StrictMode first mount) → close immediately
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
        if (p?.entries) dispatch({ type: "trajectory", agentId: p.agentId, name: p.name, entries: p.entries });
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
        try { const mc = await api("GET", `/api/servers/${sidRef.current}/machines`); setMachines(mc.machines || []); } catch { /* keep stale value on error */ }
        dispatch({ type: "machine", ...p });
      });
      sock.on("task:created", (p: any) => (p.tasks || []).forEach((t: any) => dispatch({ type: "task", op: "created", task: t }))); // payload={channelId,tasks:[]}
      sock.on("task:updated", (p: any) => dispatch({ type: "task", op: "updated", task: p.task }));                                  // payload={channelId,task}
      sock.on("task:deleted", (p: any) => dispatch({ type: "task", op: "deleted", taskId: p.taskId, channelId: p.channelId }));      // payload={channelId,taskId}
      sock.on("message:updated", (m: any) => dispatch({ type: "message:updated", message: m }));
      sock.on("thread:updated", (p: any) => dispatch({ type: "thread:updated", ...p }));
    })();
    return () => { cancelled = true; sock?.close(); if (unreadTimer) clearTimeout(unreadTimer); };
  }, []);

  return <Ctx.Provider value={{ ready, authState, serverId, slug, me, myRole, serverAvatar, servers, capabilities, createServer, logout, uploadServerAvatar, uploadAgentAvatar, uploadUserAvatar, channels, dms, unread, agents, machines, humans, api, reload, onEvent, subscribeChannel, createChannel, markActionExecuted, createTasks, openDM, joinChannel, leaveChannel, markRead, uploadFiles, uploadOne, attachmentUrl, react, openThread, savedIds, saveMsg, unsaveMsg, listSaved }}>{children}</Ctx.Provider>;
}

export const fmtTime = (iso?: string) => { try { return iso ? new Date(iso).toLocaleTimeString("zh-CN", { hour12: false }) : ""; } catch { return ""; } };
