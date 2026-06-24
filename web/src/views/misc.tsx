import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Star, Bookmark, AlertTriangle, Lock, MessageCircle } from "lucide-react";
import { useStore, fmtTime } from "../store.tsx";
import { Avatar, resolveAvatar } from "../Avatar.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { IconMonitor } from "../icons.tsx";
import { TaskBoard } from "../TaskBoard.tsx";
import { useConfirm, useEscClose } from "../ConfirmModal.tsx";
import { useTranslation } from "react-i18next";

export function Tasks() {
  const { channels, slug } = useStore();
  const { channelId } = useParams(); // "server" = all channels; otherwise a specific channelId
  const nav = useNavigate();
  const { t } = useTranslation();
  const scope = channelId || "server";
  const cur = scope === "server" ? null : channels.find((c) => c.id === scope);

  return (
    <>
      <aside className="sidebar">
        <div className="sb-title">{t("nav.tasks")}</div>
        <div className="sec">{t("misc.tasksScope")}</div>
        <button className={"item" + (scope === "server" ? " active" : "")} onClick={() => nav(`/s/${slug}/tasks/server`)}><Star size={14} /><span className="grow">{t("misc.tasksAll")}</span></button>
        <div className="sec">{t("common.channels")}</div>
        {channels.filter((c) => c.type !== "dm").map((c) => <button key={c.id} className={"item" + (c.id === scope ? " active" : "")} onClick={() => nav(`/s/${slug}/tasks/${c.id}`)}># {c.name}</button>)}
      </aside>
      <main className="content-col">
        <div className="head"><h1>{t("nav.tasks")}</h1><small>{scope === "server" ? t("misc.tasksAllCross") : cur ? "# " + cur.name : ""}</small></div>
        <TaskBoard channelId={scope === "server" ? null : scope} />
      </main>
    </>
  );
}

// Unified inbox (GET /api/channels/inbox): aggregates recent activity across channels/DMs/threads, including unread counts and mentions.
interface InboxItem {
  kind: string; channelId: string; channelName: string; channelType: string;
  parentMessageId?: string | null; parentChannelId?: string | null; parentChannelName?: string | null; // thread entry: navigate to parent channel and open thread panel
  lastMessageId: string; firstUnreadMessageId: string | null;
  lastMessageAt: string; lastMessagePreview: string;
  lastMessageSenderType: string; lastMessageSenderId: string | null; lastMessageSenderName: string;
  unreadCount: number; hasMention: boolean;
}
// One @-mention of me, message-grained (GET /api/mentions): read & unread alike, deep-links to that message.
interface MentionItem {
  messageId: string; channelId: string; channelName: string; channelType: string;
  parentMessageId?: string | null; parentChannelId?: string | null; parentChannelName?: string | null; // thread mention → open the parent thread panel
  senderType: string; senderId: string | null; senderName: string;
  preview: string; createdAt: string; seq: number; read: boolean;
}
// INBOX_FILTERS labels are i18n keys; call t(label) at render time
const INBOX_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "misc.inboxFilterAll" },
  { key: "unread", label: "misc.inboxFilterUnread" },
  { key: "mentions", label: "misc.inboxFilterMentions" },
];
// Channel type glyph: private/thread use lucide SVG icons; public channels/DMs use # / @ text characters
function KindGlyph({ type }: { type: string }) {
  if (type === "private") return <Lock size={13} />;
  if (type === "thread") return <MessageCircle size={13} />;
  return <>{type === "dm" ? "@" : "#"}</>;
}

export function Inbox() {
  const { api, slug, markRead, onEvent } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [filter, setFilter] = useState("all");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [mentionsHasMore, setMentionsHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const filterRef = useRef("all");
  const MENTIONS_PAGE = 50;

  const load = (f: string, silent = false) => {
    if (!silent) setLoading(true);
    // Mentions is a message-grained activity stream (every @ of me, read or not — GET /api/mentions), paginated
    // with a Load-more button; all/unread stay channel-aggregated via the inbox endpoint. A realtime reload
    // resets to the first page (newest @s are at the top).
    const req = f === "mentions"
      ? api("GET", `/api/mentions?limit=${MENTIONS_PAGE}`).then((r) => { setMentions(r?.items || []); setMentionsHasMore(!!r?.hasMore); }).catch(() => { setMentions([]); setMentionsHasMore(false); })
      : api("GET", `/api/channels/inbox?filter=${f}&limit=50`).then((r) => setItems(r?.items || [])).catch(() => setItems([]));
    req.finally(() => setLoading(false));
  };
  // Append the next page of mentions (offset = how many we already hold).
  const loadMoreMentions = () => api("GET", `/api/mentions?limit=${MENTIONS_PAGE}&offset=${mentions.length}`)
    .then((r) => { setMentions((prev) => [...prev, ...(r?.items || [])]); setMentionsHasMore(!!r?.hasMore); }).catch(() => {});
  useEffect(() => { filterRef.current = filter; load(filter); /* eslint-disable-next-line */ }, [filter]);

  // Real-time: on incoming message/message:updated socket events, debounce a silent re-fetch of the current filter to stay fresh without manual refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onEvent((e) => {
      if (e.type !== "message" && e.type !== "message:updated") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => load(filterRef.current, true), 400);
    });
    return () => { if (timer) clearTimeout(timer); off(); };
    /* eslint-disable-next-line */
  }, []);

  const open = (it: InboxItem) => {
    if (it.unreadCount > 0) markRead(it.channelId);
    // Thread entry → navigate to parent channel and open the thread panel; non-thread unread → jump to first unread message; otherwise navigate to channel
    if (it.kind === "thread" && it.parentChannelId && it.parentMessageId) nav(`/s/${slug}/channel/${it.parentChannelId}?thread=${it.parentMessageId}`);
    else if (it.firstUnreadMessageId) nav(`/s/${slug}/channel/${it.channelId}?msg=${it.firstUnreadMessageId}`);
    else nav(`/s/${slug}/channel/${it.channelId}`);
  };
  // Jump straight to the @-mention: highlight that message via ?msg=; a thread mention opens the parent thread panel.
  const openMention = (m: MentionItem) => {
    if (m.channelType === "thread" && m.parentChannelId && m.parentMessageId) nav(`/s/${slug}/channel/${m.parentChannelId}?thread=${m.parentMessageId}`);
    else nav(`/s/${slug}/channel/${m.channelId}?msg=${m.messageId}`);
  };

  const curFilter = INBOX_FILTERS.find((f) => f.key === filter);
  const curFilterLabel = curFilter ? t(curFilter.label) : filter;
  const isMentions = filter === "mentions";
  const listCount = isMentions ? mentions.length : items.length;
  const isEmpty = isMentions ? !mentions.length : !items.length;

  return (
    <>
      <aside className="sidebar">
        <div className="sb-title">{t("misc.inboxTitle")}</div>
        <div className="sec">{t("misc.inboxFilter")}</div>
        {INBOX_FILTERS.map((f) => (
          <button key={f.key} className={"item" + (filter === f.key ? " active" : "")} onClick={() => setFilter(f.key)}>
            <span className="grow">{t(f.label)}</span>
          </button>
        ))}
      </aside>
      <main className="content-col">
        <div className="head"><h1>{t("misc.inboxTitle")}</h1><small>{loading ? t("misc.inboxLoading") : t("misc.inboxSummary", { count: listCount, filter: curFilterLabel })}</small></div>
        <div className="inbox-list">
          {!loading && isEmpty && (
            filter === "all"
              ? <div className="empty">{t("misc.inboxEmptyAll")}</div>
              : <div className="empty">{t("misc.inboxEmptyFilter", { filter: curFilterLabel })}</div>
          )}
          {!isMentions && items.map((it) => (
            <button key={it.channelId} className={"inbox-row" + (it.unreadCount > 0 ? " unread" : "")} onClick={() => open(it)}>
              <span className={"ib-glyph k-" + it.kind}><KindGlyph type={it.channelType} /></span>
              <span className="ib-main">
                <span className="ib-top">
                  <span className="ib-name">{it.channelName}</span>
                  {it.hasMention && <span className="ib-mention" title={t("misc.inboxMentionTitle")}>@</span>}
                  <span className="ib-time">{fmtTime(it.lastMessageAt)}</span>
                </span>
                <span className="ib-preview"><b>{it.lastMessageSenderName}</b>: {it.lastMessagePreview}</span>
              </span>
              {it.unreadCount > 0 && <span className="ib-badge">{it.unreadCount}</span>}
            </button>
          ))}
          {isMentions && mentions.map((m) => (
            <button key={m.messageId} className={"inbox-row" + (m.read ? "" : " unread")} onClick={() => openMention(m)}>
              <span className={"ib-glyph k-" + (m.channelType === "dm" ? "dm" : m.channelType === "thread" ? "thread" : "channel")}><KindGlyph type={m.channelType} /></span>
              <span className="ib-main">
                <span className="ib-top">
                  <span className="ib-name">{m.channelName}</span>
                  {!m.read && <span className="ib-mention" title={t("misc.inboxMentionTitle")}>@</span>}
                  <span className="ib-time">{fmtTime(m.createdAt)}</span>
                </span>
                <span className="ib-preview"><b>{m.senderName}</b>: {m.preview}</span>
              </span>
            </button>
          ))}
          {isMentions && mentionsHasMore && !loading && <button className="loadmore" onClick={loadMoreMentions}>{t("misc.loadMore")}</button>}
        </div>
      </main>
    </>
  );
}

// Runtime name → display label mapping
const RT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", opencode: "OpenCode", copilot: "Copilot CLI", cursor: "Cursor CLI", gemini: "Gemini CLI", kimi: "Kimi" };
export function Computers() {
  const { machines, agents, slug, api, serverId, reload, attachmentUrl } = useStore();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const { machineId } = useParams();
  const nav = useNavigate();
  const [connect, setConnect] = useState(false);
  const [delErr, setDelErr] = useState("");
  const [deleting, setDeleting] = useState(false);
  const cur = machines.find((m) => m.id === machineId) || machines[0];
  const onMachine = agents.filter((a) => a.machineId === cur?.id);
  const removeMachine = async () => {
    if (!cur) return;
    setDelErr("");
    if (onMachine.length) { setDelErr(t("misc.computersAgentsBlocked", { count: onMachine.length })); return; }
    if (!(await confirm({ title: t("misc.computersDeleteTitle", { name: cur.name || cur.hostname }), message: t("misc.computersDeleteMessage"), confirmLabel: t("misc.computersDeleteConfirm"), danger: true }))) return;
    setDeleting(true);
    try {
      const r = await api("DELETE", `/api/servers/${serverId}/machines/${cur.id}`);
      if (r?.error) { setDelErr(r.error); return; }
      await reload(); nav(`/s/${slug}/computer`);
    } finally { setDeleting(false); }
  };
  return (
    <>
      <aside className="sidebar">
        <div className="sb-title">{t("misc.computersTitle")}</div>
        <div className="sec">{t("misc.computersMachines")} <span className="cnt">{machines.length}</span><button className="addbtn" title={t("misc.computersConnectBtn")} onClick={() => setConnect(true)}>+</button></div>
        {machines.length ? machines.map((m) => (
          <button key={m.id} className={"item" + (m.id === cur?.id ? " active" : "")} onClick={() => nav(`/s/${slug}/computer/${m.id}`)}>
            <IconMonitor size={15} /><span className="grow">{m.name || m.hostname}</span><span className={"dot " + (m.status === "online" ? "online" : "")} />
          </button>
        )) : <div className="empty">{t("misc.computersNoMachine")}</div>}
      </aside>
      <main className="content-col">
        {!cur ? <><div className="head"><h1>{t("misc.computersTitle")}</h1></div><div className="scroll"><div className="empty">{t("misc.computersNoMachineHint")}</div></div></>
          : <>
            <div className="head"><h1>{cur.name || cur.hostname}</h1><small>{cur.status === "online" ? t("misc.computersOnline") : t("misc.computersOffline")} · {t("misc.computersDaemonLabel")} {cur.daemonVersion || "?"}</small>
              <button className="danger-btn" style={{ marginLeft: "auto" }} onClick={removeMachine} disabled={deleting}>{deleting ? t("misc.computersDeleting") : t("misc.computersDeleteBtn")}</button>
            </div>
            <div className="scroll">
              {delErr && <div className="form-err" style={{ marginBottom: 14 }}>{delErr}</div>}
              <div className="card">
                <div className="kv"><b>{t("common.hostname")}</b> {cur.hostname || ""}</div>
                <div className="kv"><b>OS</b> {cur.os || ""}</div>
                <div className="kv"><b>{t("misc.computersTypeLabel")}</b> {cur.isComputer ? t("misc.computersTypeSandbox") : t("misc.computersTypeDaemon")}</div>
                <div className="kv"><b>{t("misc.computersStatusLabel")}</b> <span className={"dot " + (cur.status === "online" ? "online" : "")} style={{ display: "inline-block", verticalAlign: "middle" }} /> {cur.status}</div>
              </div>
              <div className="sec">{t("common.detectedRuntimes")} <span className="cnt">{(cur.runtimes || []).length}</span></div>
              <div className="rt-list">{(cur.runtimes || []).length ? (cur.runtimes || []).map((r) => <span key={r} className="rt-chip">{RT_LABEL[r] || r}</span>) : <span className="empty">{t("misc.computersNoRuntime")}</span>}</div>
              <div className="sec">{t("misc.computersAgentsSection")} <span className="cnt">{onMachine.length}</span></div>
              {onMachine.length ? onMachine.map((a) => (
                <button key={a.id} className="item" onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                  <Avatar seed={a.name} url={resolveAvatar(a.avatarUrl, attachmentUrl)} size={20} /><span className="grow">{a.displayName || a.name}</span><span className="meta">{a.runtime}</span><span className={"dot " + (a.activity || a.status)} />
                </button>
              )) : <div className="empty">{t("misc.computersNoAgent")}</div>}
            </div>
          </>}
      </main>
      {connect && <ConnectMachineModal onClose={() => setConnect(false)} />}
    </>
  );
}

// Connect machine modal: generates an API key and a ready-to-run daemon connection command
function ConnectMachineModal({ onClose }: { onClose: () => void }) {
  useEscClose(onClose);
  const { api, serverId, reload } = useStore();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState("");
  const gen = async () => {
    setBusy(true);
    try { const r = await api("POST", `/api/servers/${serverId}/machines`, { name: name.trim() }); if (r?.key) { setRes({ key: r.key, name: r.name }); await reload(); } }
    finally { setBusy(false); }
  };
  const cmd = res ? `npx @fancyboi999/open-tag-daemon --server-url ${window.location.origin} --api-key ${res.key}` : "";
  const copy = (text: string, tag: string) => { navigator.clipboard?.writeText(text); setCopied(tag); setTimeout(() => setCopied(""), 1500); };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {!res ? <>
          <h3>{t("misc.connectModalTitle")}</h3>
          <p className="modal-note">{t("misc.connectModalNote")}</p>
          <label>{t("misc.connectModalNameLabel")}</label>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("misc.connectModalNamePlaceholder")} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) gen(); }} />
          <div className="acts"><button className="cancel" onClick={onClose}>{t("misc.connectModalCancel")}</button><button className="ok" onClick={gen} disabled={busy}>{busy ? t("misc.connectModalGenerating") : t("misc.connectModalGenerateBtn")}</button></div>
        </> : <>
          <h3>{t("misc.connectModalReadyTitle", { name: res.name })}</h3>
          <p className="modal-note"><AlertTriangle size={14} /> {t("misc.connectModalReadyNote")}</p>
          <label>{t("misc.connectModalKeyLabel")}</label>
          <div className="codebox"><code className="grow">{res.key}</code><button className="joinbtn" onClick={() => copy(res.key, "key")}>{copied === "key" ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
          <label>{t("misc.connectModalCmdLabel")}</label>
          <div className="codebox"><code className="grow">{cmd}</code><button className="joinbtn" onClick={() => copy(cmd, "cmd")}>{copied === "cmd" ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
          <div className="acts"><button className="ok" onClick={onClose}>{t("misc.connectModalDone")}</button></div>
        </>}
      </div>
    </div>
  );
}

// Add-computer onboarding modal: when the current workspace has no machine connected and the viewer
// can manage machines, nudge them to connect one (agents have nowhere to run otherwise). Replaces the
// old persistent onboard-banner. Self-contained — Chat.tsx renders it unconditionally and this owns its
// own show/dismiss state. Auto-shows once per browser-tab session; the "Don't remind me again" checkbox
// opts out permanently. Dismiss = Skip button / Esc / backdrop click.
const COMPUTER_OPTOUT_KEY = "open-tag.onboard.computer.optout";        // localStorage: permanent opt-out (global, not per-workspace)
const COMPUTER_DISMISSED_KEY = "open-tag.onboard.computer.dismissed";  // sessionStorage: closed for this tab session

export function AddComputerModal() {
  const { machines, capabilities, slug } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [dontRemind, setDontRemind] = useState(false);
  // Seed the dismissed flag from storage so a same-tab refresh stays closed (session key) and an
  // opted-out user never sees it again (local key). Reads are guarded — storage access can throw.
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(COMPUTER_DISMISSED_KEY) === "1" || localStorage.getItem(COMPUTER_OPTOUT_KEY) === "1"; } catch { return false; }
  });
  const visible = machines.length === 0 && !!capabilities.manageMachines && !dismissed;
  const close = useCallback(() => {
    try { sessionStorage.setItem(COMPUTER_DISMISSED_KEY, "1"); if (dontRemind) localStorage.setItem(COMPUTER_OPTOUT_KEY, "1"); } catch { /* storage unavailable — dismiss in memory only */ }
    setDismissed(true);
  }, [dontRemind]);
  // Esc-to-dismiss, registered only while visible. (useEscClose is unconditional and would keep a
  // listener alive after dismissal — wrong for a self-contained, conditionally-shown modal.)
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, close]);
  if (!visible) return null;
  const goConnect = () => { close(); nav(`/s/${slug}/computer`); };
  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("chat.addComputerTitle")}</h3>
        <div className="onboard-lead">
          <span className="onboard-ico"><IconMonitor size={22} /></span>
          <p>{t("chat.addComputerBody")}</p>
        </div>
        <p className="modal-note">{t("chat.addComputerRuntimes")}</p>
        <div className="acts">
          <label className="onboard-optout"><input type="checkbox" checked={dontRemind} onChange={(e) => setDontRemind(e.target.checked)} /> {t("chat.addComputerDontRemind")}</label>
          <button className="cancel" onClick={close}>{t("chat.addComputerSkip")}</button>
          <button className="ok" onClick={goConnect}><IconMonitor size={14} /> {t("chat.addComputerConnect")}</button>
        </div>
      </div>
    </div>
  );
}

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const hilite = (s: string, q: string) => { const e = escHtml(s); if (!q) return e; const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"); return e.replace(re, "<mark>$1</mark>"); };

export function Search() {
  const { api, slug } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  useEffect(() => {
    const v = q.trim();
    if (!v) { setResults([]); setSearched(false); return; }
    const h = setTimeout(async () => { const d = await api("GET", `/api/messages/search?q=${encodeURIComponent(v)}`); setResults(d?.results || []); setSearched(true); }, 300);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <>
      <aside className="sidebar"><div className="sb-title">{t("nav.search")}</div><div className="empty">{t("misc.searchSidebarHint")}</div></aside>
      <main className="content-col">
        <div className="head"><h1>{t("nav.search")}</h1><small>{searched ? t("misc.searchResults", { count: results.length }) : ""}</small></div>
        <div className="scroll">
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder={t("misc.searchPlaceholder")} style={{ width: "100%", fontSize: 16, padding: "11px 16px", border: "1px solid var(--hair-strong)", borderRadius: 8, marginBottom: 16, outline: "none" }} />
          {searched && results.length === 0 && <div className="empty">{t("misc.searchNoResults", { q })}</div>}
          {results.map((r) => (
            <div className="card" key={r.id} style={{ cursor: "pointer" }} onClick={() => nav(`/s/${slug}/channel/${r.channelId}?msg=${r.id}`)}>
              <div className="kv"><b># {r.channelName}</b> · {r.senderName} · {fmtTime(r.createdAt)}</div>
              <div className="mbody" dangerouslySetInnerHTML={{ __html: hilite(r.snippet || r.content, q) }} />
            </div>
          ))}
        </div>
      </main>
    </>
  );
}

// Settings sub-pages (account/server implemented; remaining entries are navigation placeholders)
// SETTINGS labels are i18n keys; call t(label) at render time
const SETTINGS: [string, string][] = [
  ["account", "misc.settingsNavAccount"],
  ["server", "misc.settingsNavServer"],
  ["invites", "misc.settingsNavInvites"],
  ["notifications", "misc.settingsNavNotifications"],
]; // Machine/Daemon management lives in the Computers view, not duplicated here
export function Settings() {
  const { section } = useParams();
  const { slug, serverId, api } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const cur = section || "account";
  const curLabel = t(SETTINGS.find((s) => s[0] === cur)?.[1] || cur);
  return (
    <>
      <aside className="sidebar">
        <div className="sb-title">{t("nav.settings")}</div>
        <div className="settings-nav">{SETTINGS.map(([k, labelKey]) => <button key={k} className={"item" + (cur === k ? " active" : "")} onClick={() => nav(`/s/${slug}/settings/${k}`)}>{t(labelKey)}</button>)}</div>
      </aside>
      <main className="content-col">
        <div className="head"><h1>{t("misc.settingsTitle", { section: curLabel })}</h1></div>
        <div className="scroll">
          {cur === "account" ? <AccountSettings api={api} /> : cur === "server" ? <ServerSettings api={api} serverId={serverId} /> : cur === "invites" ? <InvitesSettings api={api} serverId={serverId} /> : cur === "notifications" ? <NotificationsSettings api={api} serverId={serverId} /> : <div className="empty">{t("misc.settingsWip", { section: cur })}</div>}
        </div>
      </main>
    </>
  );
}
function AccountSettings({ api }: { api: any }) {
  const { logout } = useStore();
  const { t, i18n } = useTranslation();
  const setLang = (l: string) => { i18n.changeLanguage(l); localStorage.setItem("open-tag.lang", l); };
  const [u, setU] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { (async () => setU(await api("GET", "/api/auth/me")))(); }, []);
  if (!u) return <div className="empty">{t("misc.accountLoading")}</div>;
  const save = async () => { await api("PATCH", "/api/auth/me", { displayName: u.displayName, description: u.description }); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  return (
    <div className="setform">
      <label>{t("misc.accountDisplayName")}</label><input value={u.displayName || ""} onChange={(e) => setU({ ...u, displayName: e.target.value })} />
      <label>{t("misc.accountDescription")}</label>
      <textarea value={u.description || ""} maxLength={3000} onChange={(e) => setU({ ...u, description: e.target.value })} placeholder="Describe yourself for other humans and agents in this server" />
      <div className="ta-count">{(u.description || "").length}/3000</div>
      <label>{t("misc.accountEmail")}</label><input value={u.email || ""} disabled />
      <div className="setrow"><button className="ok" onClick={save}>{t("misc.accountSave")}</button>{saved && <span className="saved">{t("misc.accountSaved")}</span>}</div>
      <div className="lang-row">
        <div><div className="logout-title">{t("settings.language")}</div><div className="logout-desc">{t("settings.languageDesc")}</div></div>
        <div className="seg" role="group" aria-label={t("settings.language")}>
          <button className={"seg-opt" + (i18n.language.startsWith("en") ? " on" : "")} onClick={() => setLang("en")}>{t("settings.langEnglish")}</button>
          <button className={"seg-opt" + (i18n.language.startsWith("zh") ? " on" : "")} onClick={() => setLang("zh")}>{t("settings.langChinese")}</button>
        </div>
      </div>
      <div className="logout-row">
        <div><div className="logout-title">{t("misc.logoutTitle")}</div><div className="logout-desc">{t("misc.logoutDesc")}</div></div>
        <button className="logout-btn" onClick={logout}>{t("misc.logoutBtn")}</button>
      </div>
    </div>
  );
}
function ServerSettings({ api, serverId }: { api: any; serverId: string }) {
  const { serverAvatar, uploadServerAvatar } = useStore();
  const { t } = useTranslation();
  const [s, setS] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [avErr, setAvErr] = useState("");
  const [avBusy, setAvBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { (async () => setS(await api("GET", "/api/servers/" + serverId)))(); }, [serverId]);
  if (!s) return <div className="empty">{t("misc.serverLoading")}</div>;
  const save = async () => { await api("PATCH", "/api/servers/" + serverId, { name: s.name, slug: s.slug }); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  const onPick = async (e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setAvErr(""); setAvBusy(true); try { await uploadServerAvatar(f); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  return (
    <div className="setform">
      <label>{t("misc.serverAvatarLabel")}</label>
      <div className="avatar-edit">
        {serverAvatar ? <img className="avatar-edit-img" src={serverAvatar} alt="" /> : <div className="avatar-edit-ph">{(s.name || "?")[0].toUpperCase()}</div>}
        <button className="ghost" disabled={avBusy} onClick={() => fileRef.current?.click()}>{avBusy ? t("misc.serverAvatarUploading") : serverAvatar ? t("misc.serverAvatarChange") : t("misc.serverAvatarUpload")}</button>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPick} />
      </div>
      {avErr && <div className="form-err">{avErr}</div>}
      <label>{t("misc.serverNameLabel")}</label><input value={s.name || ""} onChange={(e) => setS({ ...s, name: e.target.value })} />
      <label>{t("misc.serverSlugLabel")}</label><input value={s.slug || ""} onChange={(e) => setS({ ...s, slug: e.target.value })} />
      <label>{t("misc.serverPlanLabel")}</label><input value={s.plan || "free"} disabled />
      <div className="setrow"><button className="ok" onClick={save}>{t("misc.serverSave")}</button>{saved && <span className="saved">{t("misc.serverSaved")}</span>}</div>
    </div>
  );
}
// Notification settings (GET/PATCH /api/servers/:id/notification-settings): per-user mute toggle for this workspace.
function NotificationsSettings({ api, serverId }: { api: any; serverId: string }) {
  const { t } = useTranslation();
  const [muted, setMuted] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!serverId) return; (async () => { const r = await api("GET", `/api/servers/${serverId}/notification-settings`); setMuted(!!r?.serverPushMuted); })(); }, [serverId]);
  if (muted === null) return <div className="empty">{t("misc.notifLoading")}</div>;
  const toggle = async () => {
    const next = !muted; setMuted(next);
    await api("PATCH", `/api/servers/${serverId}/notification-settings`, { serverPushMuted: next });
    setSaved(true); setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="setform">
      <div className="toggle-row">
        <div className="toggle-text">
          <div className="toggle-title">{t("misc.notifMuteTitle")}</div>
          <div className="toggle-sub">{t("misc.notifMuteDesc")}</div>
        </div>
        <button role="switch" aria-checked={muted} className={"switch" + (muted ? " on" : "")} onClick={toggle}><span className="knob" /></button>
      </div>
      {saved && <div className="setrow"><span className="saved">{t("misc.notifSaved")}</span></div>}
    </div>
  );
}

// Saved messages view (/s/:server/saved): bookmark list with source channel/thread, sender, relative time, content, and unsave action; clicking a card navigates to the message.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relTime = (iso?: string, tFn?: (k: string, opts?: any) => string) => {
  try {
    const d = Date.now() - new Date(iso!).getTime();
    const m = Math.floor(d / 60000);
    if (!tFn) return "";
    if (m < 1) return tFn("misc.relTimeJustNow");
    if (m < 60) return tFn("misc.relTimeMinutes", { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return tFn("misc.relTimeHours", { count: h });
    return tFn("misc.relTimeDays", { count: Math.floor(h / 24) });
  } catch { return ""; }
};
export function Saved() {
  const { slug, listSaved, unsaveMsg } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const load = (offset = 0) => listSaved(20, offset).then((r) => {
    setItems((prev) => (offset ? [...prev, ...r.saved] : r.saved));
    setHasMore(r.hasMore);
  }).finally(() => setLoading(false));
  useEffect(() => { load(0); /* eslint-disable-next-line */ }, []);
  const open = (it: any) => nav(`/s/${slug}/channel/${it.channelId}?msg=${it.messageId}`);
  const unsave = (e: React.MouseEvent, it: any) => { e.stopPropagation(); unsaveMsg(it.messageId); setItems((p) => p.filter((x) => x.messageId !== it.messageId)); };
  const source = (it: any) => it.channelType === "thread"
    ? <><MessageCircle size={12} /> {t("misc.savedThread")}{it.parentChannelType === "dm" ? "@" : "#"}{it.parentChannelName ?? "?"}</>
    : it.channelType === "private"
    ? <><Lock size={12} /> {it.channelName ?? "?"}</>
    : <>{it.channelType === "dm" ? "@" : "#"} {it.channelName ?? "?"}</>;
  return (
    <>
      <ChatSidebar />
      <main className="content-col">
        <div className="head"><h1>{t("common.saved")}</h1><small>{loading ? t("misc.savedLoading") : t("misc.savedCount", { count: items.length })}</small></div>
        <div className="inbox-list">
          {!loading && !items.length && <div className="empty">{t("misc.savedEmpty")}</div>}
          {items.map((it) => (
            <button key={it.messageId} className="inbox-row" onClick={() => open(it)}>
              <span className="ib-main">
                <span className="ib-top">
                  <span className="ib-name">{source(it)}</span>
                  <span className="ib-time">{relTime(it.createdAt, t)}</span>
                </span>
                <span className="ib-preview"><b>{it.senderName ?? (it.senderType === "agent" ? "agent" : "user")}</b>: {it.content}</span>
              </span>
              <span className="ib-save on" title={t("misc.savedUnsave")} onClick={(e) => unsave(e, it)}><Bookmark size={15} fill="currentColor" /></span>
            </button>
          ))}
          {hasMore && !loading && <button className="loadmore" onClick={() => load(items.length)}>{t("misc.savedLoadMore")}</button>}
        </div>
      </main>
    </>
  );
}

// Invite members (join-links): owner/admin generates invite links (configurable role/max-uses) → share → recipient registers or logs in to join.
function InvitesSettings({ api, serverId }: { api: any; serverId: string }) {
  const { capabilities } = useStore();
  const { t } = useTranslation();
  const [links, setLinks] = useState<any[]>([]);
  const [role, setRole] = useState("member");
  const [maxUses, setMaxUses] = useState("");
  const [copied, setCopied] = useState("");
  const load = async () => { try { const r = await api("GET", `/api/servers/${serverId}/join-links`); setLinks(Array.isArray(r) ? r : []); } catch { setLinks([]); } };
  useEffect(() => { load(); }, [serverId]);
  if (!capabilities.manageMembers) return <div className="empty">{t("misc.invitesAdminOnly")}</div>;
  const create = async () => { await api("POST", `/api/servers/${serverId}/join-links`, { role, maxUses: maxUses ? Number(maxUses) : null }); setMaxUses(""); load(); };
  const del = async (id: string) => { await api("DELETE", `/api/servers/${serverId}/join-links/${id}`); load(); };
  const urlOf = (tok: string) => `${location.origin}/join/${tok}`;
  const copy = async (tok: string) => { try { await navigator.clipboard.writeText(urlOf(tok)); setCopied(tok); setTimeout(() => setCopied(""), 1500); } catch { /* */ } };
  return (
    <div className="setform">
      <label>{t("misc.invitesLabel")}</label>
      <p className="modal-note">{t("misc.invitesNote")}</p>
      <div className="inv-new">
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">{t("misc.invitesRoleMember")}</option>
          <option value="admin">{t("misc.invitesRoleAdmin")}</option>
        </select>
        <input type="number" min="1" placeholder={t("misc.invitesMaxUsesPlaceholder")} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        <button className="ok" onClick={create}>{t("misc.invitesGenerateBtn")}</button>
      </div>
      <div className="inv-list">
        {links.length === 0 ? <div className="empty">{t("misc.invitesEmpty")}</div> : links.map((l) => (
          <div className="inv-item" key={l.id}>
            <div className="inv-meta">
              <span className="inv-role">{l.role}</span>
              <code className="inv-url">{urlOf(l.token)}</code>
              <span className="inv-uses">{l.maxUses != null ? t("misc.invitesUsesCapped", { used: l.useCount, max: l.maxUses }) : t("misc.invitesUses", { count: l.useCount })}</span>
            </div>
            <div className="inv-acts">
              <button className="joinbtn" onClick={() => copy(l.token)}>{copied === l.token ? t("misc.invitesCopied") : t("misc.invitesCopyBtn")}</button>
              <button className="joinbtn" style={{ color: "var(--error)" }} onClick={() => del(l.id)}>{t("misc.invitesDeleteBtn")}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
