import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { Star, Bookmark, AlertTriangle, Lock, MessageCircle, Eye, Plus, UserRound, Languages, Palette, Bell, Building2, UsersRound } from "lucide-react";
import { useStore } from "../store.tsx";
import { fmtDateTime } from "../format";
import { Avatar, resolveAvatar } from "../Avatar.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { IconMonitor, IconInbox } from "../icons.tsx";
import { TaskBoard } from "../TaskBoard.tsx";
import { PaneEmpty } from "../PaneEmpty.tsx";
import { ConnectComputerWizard } from "./ConnectComputerWizard.tsx";
import { useConfirm, useDialogFocus } from "../ConfirmModal.tsx";
import { useTranslation } from "react-i18next";
import { daemonUpdateCommandTemplate, isDaemonUpdateAvailable } from "../machineUi.ts";
import { copyText } from "../lib/clipboard.ts";

export function Tasks() {
  const { channels, slug } = useStore();
  const { channelId } = useParams(); // "server" = all channels; otherwise a specific channelId
  const nav = useNavigate();
  const { t } = useTranslation();
  const [taskCount, setTaskCount] = useState(0);
  const scope = channelId || "server";
  const cur = scope === "server" ? null : channels.find((c) => c.id === scope);

  return (
    <>
      <aside className="sidebar tasks-sidebar">
        <div className="sb-scroll">
        <div className="sb-title">{t("nav.tasks")}</div>
        <div className="sec">{t("misc.tasksScope")}</div>
        <button className={"item" + (scope === "server" ? " active" : "")} onClick={() => nav(`/s/${slug}/tasks/server`)}><Star size={14} /><span className="grow">{t("misc.tasksAll")}</span></button>
        <div className="sec">{t("common.channels")}</div>
        {channels.filter((c) => c.type !== "dm").map((c) => <button key={c.id} className={"item" + (c.id === scope ? " active" : "")} onClick={() => nav(`/s/${slug}/tasks/${c.id}`)}># {c.name}</button>)}
        </div>
      </aside>
      <main className="content-col tasks-page">
        <div className="head tasks-page-head"><h1>{t("nav.tasks")}</h1><small>{scope === "server" ? t("tasks.serverCount", { count: taskCount }) : cur ? "# " + cur.name : ""}</small></div>
        <TaskBoard channelId={scope === "server" ? null : scope} onCountChange={setTaskCount} />
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
// Channel type glyph: private/thread/showcase use lucide SVG icons; public channels/DMs use # / @ text characters
function KindGlyph({ type }: { type: string }) {
  if (type === "private") return <Lock size={13} />;
  if (type === "thread") return <MessageCircle size={13} />;
  if (type === "showcase") return <Eye size={13} />;
  return <>{type === "dm" ? "@" : "#"}</>;
}

export function Inbox() {
  const { api, slug, markRead, onEvent } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilter = INBOX_FILTERS.some((f) => f.key === searchParams.get("filter")) ? searchParams.get("filter")! : "all";
  const [filter, setFilter] = useState(initialFilter);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [mentions, setMentions] = useState<MentionItem[]>([]);
  const [mentionsHasMore, setMentionsHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const filterRef = useRef("all");
  const loadSeqRef = useRef(0);
  const MENTIONS_PAGE = 50;
  const selectFilter = (nextFilter: string) => {
    setFilter(nextFilter);
    const next = new URLSearchParams(searchParams);
    if (nextFilter === "all") next.delete("filter"); else next.set("filter", nextFilter);
    setSearchParams(next, { replace: true });
  };
  const activitySource = () => `from=activity${filter === "all" ? "" : `&activityFilter=${encodeURIComponent(filter)}`}`;

  const load = (f: string, silent = false) => {
    const seq = ++loadSeqRef.current;
    if (!silent) setLoading(true);
    if (!silent) setLoadError(false);
    // Mentions is a message-grained activity stream (every @ of me, read or not — GET /api/mentions), paginated
    // with a Load-more button; all/unread stay channel-aggregated via the inbox endpoint. A realtime reload
    // resets to the first page (newest @s are at the top).
    const req = f === "mentions"
      ? api("GET", `/api/mentions?limit=${MENTIONS_PAGE}`).then((r) => { if (!Array.isArray(r?.items)) throw new Error("invalid mentions response"); if (seq !== loadSeqRef.current) return; setMentions(r.items); setMentionsHasMore(!!r.hasMore); })
      : api("GET", `/api/channels/inbox?filter=${f}&limit=50`).then((r) => { if (!Array.isArray(r?.items)) throw new Error("invalid inbox response"); if (seq !== loadSeqRef.current) return; setItems(r.items); });
    req.catch(() => { if (!silent && seq === loadSeqRef.current) setLoadError(true); }).finally(() => { if (seq === loadSeqRef.current) setLoading(false); });
  };
  // Append the next page of mentions (offset = how many we already hold).
  const loadMoreMentions = () => { setLoadingMore(true); setLoadError(false); return api("GET", `/api/mentions?limit=${MENTIONS_PAGE}&offset=${mentions.length}`)
    .then((r) => { if (!Array.isArray(r?.items)) throw new Error("invalid mentions response"); setMentions((prev) => [...prev, ...r.items]); setMentionsHasMore(!!r.hasMore); })
    .catch(() => setLoadError(true)).finally(() => setLoadingMore(false)); };
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
    if (it.kind === "thread" && it.parentChannelId && it.parentMessageId) nav(`/s/${slug}/channel/${it.parentChannelId}?thread=${it.parentMessageId}&${activitySource()}`);
    else if (it.firstUnreadMessageId) nav(`/s/${slug}/channel/${it.channelId}?msg=${it.firstUnreadMessageId}&${activitySource()}`);
    else nav(`/s/${slug}/channel/${it.channelId}?${activitySource()}`);
  };
  // Jump straight to the @-mention: highlight that message via ?msg=; a thread mention opens the parent thread panel.
  const openMention = (m: MentionItem) => {
    if (m.channelType === "thread" && m.parentChannelId && m.parentMessageId) nav(`/s/${slug}/channel/${m.parentChannelId}?thread=${m.parentMessageId}&${activitySource()}`);
    else nav(`/s/${slug}/channel/${m.channelId}?msg=${m.messageId}&${activitySource()}`);
  };

  const curFilter = INBOX_FILTERS.find((f) => f.key === filter);
  const curFilterLabel = curFilter ? t(curFilter.label) : filter;
  const isMentions = filter === "mentions";
  const listCount = isMentions ? mentions.length : items.length;
  const isEmpty = isMentions ? !mentions.length : !items.length;

  return (
    <>
      <aside className="sidebar">
        <div className="sb-scroll">
        <div className="sb-title">{t("misc.inboxTitle")}</div>
        <div className="sec">{t("misc.inboxFilter")}</div>
        {INBOX_FILTERS.map((f) => (
          <button key={f.key} className={"item" + (filter === f.key ? " active" : "")} onClick={() => selectFilter(f.key)}>
            <span className="grow">{t(f.label)}</span>
          </button>
        ))}
        </div>
      </aside>
      <main className="content-col activity-page">
        <div className="head"><h1>{t("misc.inboxTitle")}</h1><small>{loading ? t("misc.inboxLoading") : t("misc.inboxSummary", { count: listCount, filter: curFilterLabel })}</small></div>
        <div className="activity-filters" role="group" aria-label={t("misc.inboxFilter")}>
          {INBOX_FILTERS.map((f) => <button key={f.key} className={filter === f.key ? "on" : ""} aria-pressed={filter === f.key} onClick={() => selectFilter(f.key)}>{t(f.label)}</button>)}
        </div>
        <div className="inbox-list">
          {loading && <div className="page-loading" role="status" aria-label={t("misc.inboxLoading")}><span /><span /><span /></div>}
          {!loading && loadError && <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("misc.activityLoadError")}</span><button onClick={() => load(filter)}>{t("misc.retry")}</button></div>}
          {!loading && !loadError && isEmpty && (
            <PaneEmpty icon={<IconInbox size={30} />} title={filter === "all" ? t("misc.inboxEmptyAll") : t("misc.inboxEmptyFilter", { filter: curFilterLabel })} />
          )}
          {!isMentions && items.map((it) => (
            <button key={it.channelId} className={"inbox-row" + (it.unreadCount > 0 ? " unread" : "")} onClick={() => open(it)}>
              <span className={"ib-glyph k-" + it.kind}><KindGlyph type={it.channelType} /></span>
              <span className="ib-main">
                <span className="ib-top">
                  <span className="ib-name">{it.channelName}</span>
                  {it.hasMention && <span className="ib-mention" title={t("misc.inboxMentionTitle")}>@</span>}
                  <span className="ib-time">{fmtDateTime(it.lastMessageAt)}</span>
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
                  <span className="ib-time">{fmtDateTime(m.createdAt)}</span>
                </span>
                <span className="ib-preview"><b>{m.senderName}</b>: {m.preview}</span>
              </span>
            </button>
          ))}
          {isMentions && mentionsHasMore && !loading && !loadError && <button className="loadmore" disabled={loadingMore} onClick={loadMoreMentions}>{loadingMore ? t("misc.inboxLoading") : t("misc.loadMore")}</button>}
        </div>
      </main>
    </>
  );
}

// Runtime name → display label mapping
const RT_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex CLI", opencode: "OpenCode", copilot: "Copilot CLI", cursor: "Cursor CLI", gemini: "Gemini CLI", kimi: "Kimi", hermes: "Hermes" };
export function Computers() {
  const { machines, machinesState, reloadMachines, agents, slug, api, serverId, reload, attachmentUrl, capabilities, latestDaemonVersion } = useStore();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const { machineId } = useParams();
  const nav = useNavigate();
  const [computerParams] = useSearchParams();
  const computerSuffix = computerParams.get("from") === "settings" ? "?from=settings" : "";
  const [connect, setConnect] = useState(false);
  const [reconnect, setReconnect] = useState<{ id: string; name: string } | null>(null);
  const [updateGuide, setUpdateGuide] = useState<{ id: string; name: string; currentVersion: string; latestVersion: string; apiKeyPrefix?: string } | null>(null);
  const [delErr, setDelErr] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [budget, setBudget] = useState<any>(null);
  const [budgetState, setBudgetState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [budgetRetry, setBudgetRetry] = useState(0);
  const cur = machineId ? machines.find((m) => m.id === machineId) : undefined;
  const fmtMem = (mb: number) => mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB";
  const onMachine = agents.filter((a) => a.machineId === cur?.id);
  const canUpdateDaemon = isDaemonUpdateAvailable(cur, latestDaemonVersion);
  // Load resource budget for the selected machine
  useEffect(() => {
    if (!cur) { setBudget(null); setBudgetState("idle"); return; }
    let cancelled = false; setBudgetState("loading");
    api("GET", `/api/servers/${slug}/machines/${cur.id}/budget`).then((r) => { if (cancelled) return; if (!r || r.error) throw new Error(r?.error || "invalid budget response"); setBudget(r); setBudgetState("ready"); }).catch(() => { if (!cancelled) { setBudget(null); setBudgetState("error"); } });
    return () => { cancelled = true; };
  }, [slug, cur?.id, budgetRetry]);
  const removeMachine = async () => {
    if (!cur) return;
    setDelErr("");
    if (onMachine.length) { setDelErr(t("misc.computersAgentsBlocked", { count: onMachine.length })); return; }
    if (!(await confirm({ title: t("misc.computersDeleteTitle", { name: cur.name || cur.hostname }), message: t("misc.computersDeleteMessage"), confirmLabel: t("misc.computersDeleteConfirm"), danger: true }))) return;
    setDeleting(true);
    try {
      const r = await api("DELETE", `/api/servers/${serverId}/machines/${cur.id}`);
      if (r?.error) { setDelErr(r.error); return; }
      await reload(); nav(`/s/${slug}/computer${computerSuffix}`);
    } finally { setDeleting(false); }
  };
  return (
    <>
      <aside className="sidebar">
        <div className="sb-scroll">
        <div className="sb-title">{t("misc.computersTitle")}</div>
        <div className="sec">{t("misc.computersMachines")} <span className="cnt">{machines.length}</span>{capabilities.manageMachines && <button className="addbtn" title={t("misc.computersConnectBtn")} onClick={() => setConnect(true)}>+</button>}</div>
        {machinesState === "loading" ? <div className="page-loading compact" role="status" aria-label={t("misc.computersLoading")}><span /><span /><span /></div> : machinesState === "error" ? <div className="page-load-error compact" role="alert"><AlertTriangle size={16} /><span>{t("misc.computersLoadFailed")}</span><button onClick={() => void reloadMachines()}>{t("misc.retry")}</button></div> : machines.length ? machines.map((m) => (
          <button key={m.id} className={"item" + (m.id === cur?.id ? " active" : "")} onClick={() => nav(`/s/${slug}/computer/${m.id}${computerSuffix}`)}>
            <IconMonitor size={15} /><span className="grow">{m.name || m.hostname}</span><span className={"dot " + (m.status === "online" ? "online" : "")} />
          </button>
        )) : <div className="empty">{t("misc.computersNoMachine")}</div>}
        </div>
      </aside>
      <main className="content-col">
        {!cur ? <><div className="head"><h1>{t("misc.computersTitle")}</h1></div><div className="scroll">{machinesState === "loading" ? <div className="page-loading" role="status" aria-label={t("misc.computersLoading")}><span /><span /><span /></div> : machinesState === "error" ? <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("misc.computersLoadFailed")}</span><button onClick={() => void reloadMachines()}>{t("misc.retry")}</button></div> : machineId ? <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("misc.computersMissing")}</span><button onClick={() => nav(`/s/${slug}/computer${computerSuffix}`)}>{t("common.back")}</button></div> : <PaneEmpty icon={<IconMonitor size={30} />} title={machines.length ? t("misc.computersSelectMachine") : t("misc.computersNoMachine")} sub={machines.length ? t("misc.computersSelectMachineHint") : t("misc.computersNoMachineHint")} action={!machines.length && capabilities.manageMachines && <button className="pe-cta" onClick={() => setConnect(true)}><Plus size={15} /> {t("misc.computersConnectBtn")}</button>} />}</div></>
          : <>
            <div className="head"><h1>{cur.name || cur.hostname}</h1><small>{cur.status === "online" ? t("misc.computersOnline") : t("misc.computersOffline")} · {t("misc.computersDaemonLabel")} {cur.daemonVersion || "?"}</small>
              {capabilities.manageMachines && <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                {canUpdateDaemon && <button className="action-btn" onClick={() => setUpdateGuide({ id: cur.id, name: cur.name || cur.hostname || "", currentVersion: cur.daemonVersion || "?", latestVersion: latestDaemonVersion, apiKeyPrefix: cur.apiKeyPrefix })}>{t("misc.computersUpdateDaemonBtn")}</button>}
                {cur.status !== "online" && <button className="action-btn" onClick={() => setReconnect({ id: cur.id, name: cur.name || cur.hostname || "" })}>{t("misc.computersReconnectBtn")}</button>}
                <button className="danger-btn" onClick={removeMachine} disabled={deleting}>{deleting ? t("misc.computersDeleting") : t("misc.computersDeleteBtn")}</button>
              </div>}
            </div>
            <div className="scroll">
              {delErr && <div className="form-err" style={{ marginBottom: 14 }}>{delErr}</div>}
              <div className="card">
                <div className="kv"><b>{t("common.hostname")}</b> {cur.hostname || ""}</div>
                <div className="kv"><b>{t("misc.computersOs")}</b> {cur.os || ""}</div>
                <div className="kv"><b>{t("misc.computersTypeLabel")}</b> {cur.isComputer ? t("misc.computersTypeSandbox") : t("misc.computersTypeDaemon")}</div>
                <div className="kv"><b>{t("misc.computersStatusLabel")}</b> <span className={"dot " + (cur.status === "online" ? "online" : "")} style={{ display: "inline-block", verticalAlign: "middle" }} /> {cur.status}</div>
              </div>
              <div className="sec">{t("common.detectedRuntimes")} <span className="cnt">{(cur.runtimes || []).length}</span></div>
              <div className="rt-list">{(cur.runtimes || []).length ? (cur.runtimes || []).map((r) => <span key={r} className="rt-chip">{RT_LABEL[r] || r}</span>) : <span className="empty">{t("misc.computersNoRuntime")}</span>}</div>
              {budgetState === "loading" && <div className="page-loading compact" role="status" aria-label={t("misc.computersBudgetLoading")}><span /><span /><span /></div>}
              {budgetState === "error" && <div className="page-load-error compact" role="alert"><AlertTriangle size={16} /><span>{t("misc.computersBudgetFailed")}</span><button onClick={() => setBudgetRetry((value) => value + 1)}>{t("misc.retry")}</button></div>}
              {budgetState === "ready" && budget && (
                <div className="card">
                  <div className="meta" style={{ marginBottom: 8 }}>{t("members.resourceBudget")}</div>
                  <div className="kv"><b>{t("misc.computersBudget")}</b> {t("misc.computersBudgetValue", { mem: fmtMem(budget.availableMemMB), cpu: 100 - budget.cpuUsagePct })}</div>
                  <div className="kv"><b>{t("misc.computersRunning")}</b> {t("misc.computersRunningAgents", { count: budget.agentCount })}</div>
                  <div className="kv"><b>{t("misc.computersQueue")}</b> {budget.queueLength}</div>
                </div>
              )}
              <div className="sec">{t("misc.computersAgentsSection")} <span className="cnt">{onMachine.length}</span></div>
              {onMachine.length ? onMachine.map((a) => (
                <button key={a.id} className="item" onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                  <Avatar seed={a.name} url={resolveAvatar(a.avatarUrl, attachmentUrl)} size={20} /><span className="grow">{a.displayName || a.name}</span><span className="meta">{a.runtime}</span><span className={"dot " + (a.activity || a.status)} />
                </button>
              )) : <div className="empty">{t("misc.computersNoAgent")}</div>}
            </div>
          </>}
      </main>
      {connect && <ConnectComputerWizard mode="add" onClose={() => setConnect(false)} />}
      {reconnect && <ConnectComputerWizard mode="reconnect" machine={reconnect} onClose={() => setReconnect(null)} />}
      {updateGuide && <DaemonUpdateModal machine={updateGuide} onClose={() => setUpdateGuide(null)} />}
    </>
  );
}

function DaemonUpdateModal({ onClose, machine }: { onClose: () => void; machine: { id: string; name: string; currentVersion: string; latestVersion: string; apiKeyPrefix?: string } }) {
  const dialogRef = useDialogFocus(onClose);
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const cmd = daemonUpdateCommandTemplate(window.location.origin);
  const copy = async () => {
    if (!await copyText(cmd)) { window.prompt(t("misc.connectModalCopyBtn"), cmd); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="daemon-update-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3 id="daemon-update-title">{t("misc.updateDaemonModalTitle", { name: machine.name })}</h3>
        <p className="modal-note"><AlertTriangle size={14} /> {t("misc.updateDaemonModalNote", { current: machine.currentVersion, latest: machine.latestVersion })}</p>
        <div className="update-steps">
          <p>{t("misc.updateDaemonModalSavedKeyPath")}</p>
          <p>{t("misc.updateDaemonModalLostKeyPath")}</p>
          {machine.apiKeyPrefix && <p>{t("misc.updateDaemonModalKeyPrefix", { prefix: machine.apiKeyPrefix })}</p>}
        </div>
        <label>{t("misc.updateDaemonModalCmdLabel")}</label>
        <div className="codebox"><code className="grow">{cmd}</code><button className="joinbtn" onClick={copy}>{copied ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
        <p className="modal-note">{t("misc.updateDaemonModalPlaceholderNote")}</p>
        <div className="acts"><button className="ok" onClick={onClose}>{t("misc.connectModalDone")}</button></div>
      </div>
    </div>
  );
}

// Add-a-computer flows now live in ConnectComputerWizard.tsx (one multi-step modal for the
// onboard / add / reconnect entry points). The old ConnectMachineModal + AddComputerModal were
// removed in favor of it.

const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const hilite = (s: string, q: string) => { const e = escHtml(s); if (!q) return e; const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"); return e.replace(re, "<mark>$1</mark>"); };

export function Search() {
  const { api, slug } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  const [results, setResults] = useState<any[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const queryRef = useRef(q);
  queryRef.current = q;
  const changeQuery = (value: string) => {
    setQ(value);
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set("q", value); else next.delete("q");
    setSearchParams(next, { replace: true });
  };
  useEffect(() => {
    const v = q.trim();
    if (!v) { setResults([]); setSearched(false); setLoading(false); setLoadError(false); setHasMore(false); return; }
    let cancelled = false;
    const h = setTimeout(async () => {
      setLoading(true); setLoadError(false);
      try {
        const d = await api("GET", `/api/messages/search?q=${encodeURIComponent(v)}`);
        if (cancelled) return;
        if (!Array.isArray(d?.results)) throw new Error("invalid search response");
        setResults(d.results); setHasMore(!!d.hasMore); setSearched(true);
      } catch { if (!cancelled) { setLoadError(true); setSearched(false); } }
      finally { if (!cancelled) setLoading(false); }
    }, 300);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q, retryNonce]);
  const loadMore = async () => {
    const v = q.trim(); setLoading(true); setLoadError(false);
    try { const d = await api("GET", `/api/messages/search?q=${encodeURIComponent(v)}&offset=${results.length}`); if (!Array.isArray(d?.results)) throw new Error("invalid search response"); if (queryRef.current.trim() !== v) return; setResults((prev) => [...prev, ...d.results]); setHasMore(!!d.hasMore); }
    catch { if (queryRef.current.trim() === v) setLoadError(true); } finally { if (queryRef.current.trim() === v) setLoading(false); }
  };
  return (
    <>
      <aside className="sidebar"><div className="sb-scroll"><div className="sb-title">{t("nav.search")}</div><div className="empty">{t("misc.searchSidebarHint")}</div></div></aside>
      <main className="content-col search-page">
        <div className="head"><h1>{t("nav.search")}</h1><small>{searched ? t("misc.searchResults", { count: results.length }) : ""}</small></div>
        <div className="scroll">
          <input className="search-input" type="search" value={q} onChange={(e) => changeQuery(e.target.value)} autoFocus aria-label={t("misc.searchPlaceholder")} placeholder={t("misc.searchPlaceholder")} />
          {loading && !results.length && <div className="page-loading" role="status" aria-label={t("misc.searchLoading")}><span /><span /><span /></div>}
          {loadError && <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("misc.searchLoadError")}</span><button onClick={() => setRetryNonce((n) => n + 1)}>{t("misc.retry")}</button></div>}
          {searched && results.length === 0 && <div className="empty">{t("misc.searchNoResults", { q })}</div>}
          {results.map((r) => (
            <button className="card search-result" key={r.id} onClick={() => nav(`/s/${slug}/channel/${r.channelId}?msg=${r.id}&from=search&searchQ=${encodeURIComponent(q)}`)}>
              <div className="kv"><b># {r.channelName}</b> · {r.senderName} · {fmtDateTime(r.createdAt)}</div>
              <div className="mbody" dangerouslySetInnerHTML={{ __html: hilite(r.snippet || r.content, q) }} />
            </button>
          ))}
          {hasMore && !loadError && <button className="loadmore" disabled={loading} onClick={loadMore}>{loading ? t("misc.searchLoading") : t("misc.loadMore")}</button>}
        </div>
      </main>
    </>
  );
}

// Settings sub-pages
const SETTINGS = [
  { group: "misc.settingsGroupPersonal", items: [
    { key: "account", label: "misc.settingsNavAccount", Icon: UserRound },
    { key: "language-region", label: "misc.settingsNavLanguage", Icon: Languages },
    { key: "appearance", label: "misc.settingsNavAppearance", Icon: Palette },
    { key: "notifications", label: "misc.settingsNavNotifications", Icon: Bell },
  ] },
  { group: "misc.settingsGroupWorkspace", items: [
    { key: "server", label: "misc.settingsNavServer", Icon: Building2 },
    { key: "invites", label: "misc.settingsNavInvites", Icon: UsersRound },
    { key: "machines", label: "misc.settingsNavMachines", Icon: IconMonitor },
  ] },
];
const SETTING_ITEMS = SETTINGS.flatMap((group) => group.items);
export function Settings() {
  const { section } = useParams();
  const { slug, serverId, api } = useStore();
  const nav = useNavigate();
  const { t } = useTranslation();
  const cur = section || "";
  const curLabel = t(SETTING_ITEMS.find((item) => item.key === cur)?.label || "nav.settings");
  return (
    <>
      <aside className="sidebar settings-sidebar">
        <div className="sb-scroll">
        <div className="sb-title">{t("nav.settings")}</div>
        <div className="settings-nav">{SETTINGS.map((group) => <div key={group.group}><div className="sec">{t(group.group)}</div>{group.items.map(({ key, label, Icon }) => <button key={key} className={"item" + (cur === key ? " active" : "")} aria-current={cur === key ? "page" : undefined} onClick={() => nav(key === "machines" ? `/s/${slug}/computer?from=settings` : `/s/${slug}/settings/${key}`)}><Icon size={15} /><span>{t(label)}</span></button>)}</div>)}</div>
        </div>
      </aside>
      <main className="content-col settings-content">
        <div className="head"><h1>{t("misc.settingsTitle", { section: curLabel })}</h1></div>
        <div className="scroll">
          {!cur ? <PaneEmpty icon={<UserRound size={30} />} title={t("misc.settingsChooseTitle")} sub={t("misc.settingsChooseHint")} /> : cur === "account" ? <AccountSettings api={api} /> : cur === "server" ? <ServerSettings api={api} serverId={serverId} /> : cur === "invites" ? <InvitesSettings api={api} serverId={serverId} /> : cur === "notifications" ? <NotificationsSettings api={api} serverId={serverId} /> : cur === "language-region" ? <LanguageSettings /> : cur === "appearance" ? <AppearanceSettings /> : <div className="empty">{t("misc.settingsWip", { section: cur })}</div>}
        </div>
      </main>
    </>
  );
}
function AccountSettings({ api }: { api: any }) {
  const { logout } = useStore();
  const { t } = useTranslation();
  const [u, setU] = useState<any>(null);
  const initial = useRef<any>(null);
  const request = useRef(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = async () => { const id = ++request.current; setState("loading"); setError(""); try { const next = await api("GET", "/api/auth/me"); if (next?.error || !next?.id) throw new Error(next?.error || "invalid account response"); if (id !== request.current) return; initial.current = next; setU(next); setState("ready"); } catch (e: any) { if (id === request.current) { setError(String(e?.message || e)); setState("error"); } } };
  useEffect(() => { void load(); return () => { request.current += 1; }; }, []);
  if (state === "loading") return <div className="page-loading" role="status" aria-label={t("misc.accountLoading")}><span /><span /><span /></div>;
  if (state === "error" || !u) return <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{error || t("misc.accountLoadFailed")}</span><button onClick={() => void load()}>{t("misc.retry")}</button></div>;
  const save = async () => { const displayName = String(u.displayName || "").trim(); if (!displayName) { setError(t("misc.accountNameRequired")); return; } setBusy(true); setError(""); try { const next = await api("PATCH", "/api/auth/me", { displayName, description: u.description }); if (next?.error) throw new Error(next.error); const merged = { ...u, ...next, displayName }; initial.current = merged; setU(merged); setSaved(true); setTimeout(() => setSaved(false), 1500); } catch (e: any) { setError(String(e?.message || e)); } finally { setBusy(false); } };
  return (
    <div className="setform">
      <div className="settings-card">
      <label>{t("misc.accountDisplayName")}</label><input value={u.displayName || ""} disabled={busy} onChange={(e) => setU({ ...u, displayName: e.target.value })} />
      <label>{t("misc.accountDescription")}</label>
      <textarea value={u.description || ""} maxLength={3000} disabled={busy} onChange={(e) => setU({ ...u, description: e.target.value })} placeholder={t("common.describeSelfPlaceholder")} />
      <div className="ta-count">{(u.description || "").length}/3000</div>
      <label>{t("misc.accountEmail")}</label><input value={u.email || ""} disabled />
      {error && <div className="form-err" role="alert">{error}</div>}
      <div className="setrow"><button className="cancel" disabled={busy} onClick={() => { setU(initial.current); setError(""); }}>{t("misc.cancel")}</button><button className="ok" disabled={busy} onClick={() => void save()}>{busy ? t("misc.saving") : t("misc.accountSave")}</button>{saved && <span className="saved">{t("misc.accountSaved")}</span>}</div>
      </div>
      <div className="settings-card logout-row">
        <div><div className="logout-title">{t("misc.logoutTitle")}</div><div className="logout-desc">{t("misc.logoutDesc")}</div></div>
        <button className="logout-btn" onClick={logout}>{t("misc.logoutBtn")}</button>
      </div>
    </div>
  );
}

function LanguageSettings() {
  const { t, i18n } = useTranslation();
  const current = i18n.language.startsWith("zh") ? "zh" : "en";
  const setLang = (value: string) => { void i18n.changeLanguage(value); localStorage.setItem("open-tag.lang", value); };
  return <div className="setform"><div className="settings-card"><h2>{t("misc.settingsNavLanguage")}</h2><p className="modal-note">{t("misc.languageHint")}</p><div className="seg-pill" role="group" aria-label={t("settings.language")}><button className={"seg-opt" + (current === "en" ? " on" : "")} aria-pressed={current === "en"} onClick={() => setLang("en")}>{t("settings.langEnglish")}</button><button className={"seg-opt" + (current === "zh" ? " on" : "")} aria-pressed={current === "zh"} onClick={() => setLang("zh")}>{t("settings.langChinese")}</button></div></div></div>;
}

function AppearanceSettings() {
  const { t } = useTranslation();
  const [size, setSize] = useState(() => localStorage.getItem("open-tag.message-size") || "medium");
  const [activity, setActivity] = useState(() => localStorage.getItem("open-tag.live-activity") !== "off");
  const chooseSize = (next: string) => { setSize(next); localStorage.setItem("open-tag.message-size", next); document.documentElement.dataset.messageSize = next; };
  const chooseActivity = () => { const next = !activity; setActivity(next); localStorage.setItem("open-tag.live-activity", next ? "on" : "off"); };
  return <div className="setform"><div className="settings-card"><h2>{t("misc.appearanceMessageSize")}</h2><p className="modal-note">{t("misc.appearanceMessageSizeHint")}</p><div className="seg-pill" role="group" aria-label={t("misc.appearanceMessageSize")}>{["small", "medium", "large"].map((value) => <button key={value} className={"seg-opt" + (size === value ? " on" : "")} aria-pressed={size === value} onClick={() => chooseSize(value)}>{t(`misc.appearanceSize.${value}`)}</button>)}</div></div><div className="settings-card"><div className="toggle-row"><div className="toggle-text"><div className="toggle-title">{t("misc.appearanceLiveTitle")}</div><div className="toggle-sub">{t("misc.appearanceLiveHint")}</div></div><button role="switch" aria-checked={activity} className={"switch" + (activity ? " on" : "")} onClick={chooseActivity}><span className="knob" /></button></div></div></div>;
}
function ServerSettings({ api, serverId }: { api: any; serverId: string }) {
  const { serverAvatar, uploadServerAvatar, capabilities } = useStore();
  const { t } = useTranslation();
  const [s, setS] = useState<any>(null);
  const initial = useRef<any>(null);
  const request = useRef(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [avErr, setAvErr] = useState("");
  const [avBusy, setAvBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const canEdit = !!capabilities.manageServer;
  const load = async () => { const id = ++request.current; setState("loading"); setError(""); try { const next = await api("GET", "/api/servers/" + serverId); if (next?.error || !next?.id) throw new Error(next?.error || "invalid workspace response"); if (id !== request.current) return; initial.current = next; setS(next); setState("ready"); } catch (e: any) { if (id === request.current) { setError(String(e?.message || e)); setState("error"); } } };
  useEffect(() => { void load(); return () => { request.current += 1; }; }, [serverId]);
  if (state === "loading") return <div className="page-loading" role="status" aria-label={t("misc.serverLoading")}><span /><span /><span /></div>;
  if (state === "error" || !s) return <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{error || t("misc.serverLoadFailed")}</span><button onClick={() => void load()}>{t("misc.retry")}</button></div>;
  const save = async () => { if (!canEdit) return; const name = String(s.name || "").trim(); const nextSlug = String(s.slug || "").trim(); if (!name || !nextSlug) { setError(t("misc.serverFieldsRequired")); return; } setBusy(true); setError(""); try { const next = await api("PATCH", "/api/servers/" + serverId, { name, slug: nextSlug }); if (next?.error) throw new Error(next.error); const merged = { ...s, ...next, name, slug: nextSlug }; initial.current = merged; setS(merged); setSaved(true); setTimeout(() => setSaved(false), 1500); } catch (e: any) { setError(String(e?.message || e)); } finally { setBusy(false); } };
  const onPick = async (e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setAvErr(""); setAvBusy(true); try { await uploadServerAvatar(f); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  return (
    <div className="setform">
      <label>{t("misc.serverAvatarLabel")}</label>
      <div className="avatar-edit">
        {serverAvatar ? <img className="avatar-edit-img" src={serverAvatar} alt="" /> : <div className="avatar-edit-ph">{(s.name || "?")[0].toUpperCase()}</div>}
        {canEdit ? <button className="ghost" disabled={avBusy || busy} onClick={() => fileRef.current?.click()}>{avBusy ? t("misc.serverAvatarUploading") : serverAvatar ? t("misc.serverAvatarChange") : t("misc.serverAvatarUpload")}</button> : <span className="meta">{t("misc.readOnly")}</span>}
        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPick} />
      </div>
      {avErr && <div className="form-err">{avErr}</div>}
      <label>{t("misc.serverNameLabel")}</label><input value={s.name || ""} disabled={!canEdit || busy} onChange={(e) => setS({ ...s, name: e.target.value })} />
      <label>{t("misc.serverSlugLabel")}</label><input value={s.slug || ""} disabled={!canEdit || busy} onChange={(e) => setS({ ...s, slug: e.target.value })} />
      <label>{t("misc.serverPlanLabel")}</label><input value={s.plan || "free"} disabled />
      {error && <div className="form-err" role="alert">{error}</div>}
      {canEdit ? <div className="setrow"><button className="cancel" disabled={busy} onClick={() => { setS(initial.current); setError(""); }}>{t("misc.cancel")}</button><button className="ok" disabled={busy} onClick={() => void save()}>{busy ? t("misc.saving") : t("misc.serverSave")}</button>{saved && <span className="saved">{t("misc.serverSaved")}</span>}</div> : <div className="setrow"><span className="meta">{t("misc.serverReadOnly")}</span></div>}
    </div>
  );
}
// Notification settings (GET/PATCH /api/servers/:id/notification-settings): per-user mute toggle for this workspace.
function NotificationsSettings({ api, serverId }: { api: any; serverId: string }) {
  const { t } = useTranslation();
  const [muted, setMuted] = useState<boolean | null>(null);
  const initial = useRef(false);
  const request = useRef(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = async () => { const id = ++request.current; setState("loading"); setError(""); try { const r = await api("GET", `/api/servers/${serverId}/notification-settings`); if (r?.error || typeof r?.serverPushMuted !== "boolean") throw new Error(r?.error || "invalid notification response"); if (id !== request.current) return; initial.current = r.serverPushMuted; setMuted(r.serverPushMuted); setState("ready"); } catch (e: any) { if (id === request.current) { setError(String(e?.message || e)); setState("error"); } } };
  useEffect(() => { if (serverId) void load(); return () => { request.current += 1; }; }, [serverId]);
  if (state === "error") return <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{error || t("misc.notifLoadFailed")}</span><button onClick={() => void load()}>{t("misc.retry")}</button></div>;
  if (state === "loading" || muted === null) return <div className="page-loading" role="status" aria-label={t("misc.notifLoading")}><span /><span /><span /></div>;
  const save = async () => { setBusy(true); setError(""); try { const r = await api("PATCH", `/api/servers/${serverId}/notification-settings`, { serverPushMuted: muted }); if (r?.error) throw new Error(r.error); initial.current = muted; setSaved(true); setTimeout(() => setSaved(false), 1500); } catch (e: any) { setMuted(initial.current); setError(String(e?.message || e)); } finally { setBusy(false); } };
  return (
    <div className="setform">
      <div className="toggle-row">
        <div className="toggle-text">
          <div className="toggle-title">{t("misc.notifMuteTitle")}</div>
          <div className="toggle-sub">{t("misc.notifMuteDesc")}</div>
        </div>
        <button role="switch" aria-checked={muted} disabled={busy} className={"switch" + (muted ? " on" : "")} onClick={() => setMuted(!muted)}><span className="knob" /></button>
      </div>
      {error && <div className="form-err" role="alert">{error}</div>}
      <div className="setrow"><button className="cancel" disabled={busy || muted === initial.current} onClick={() => { setMuted(initial.current); setError(""); }}>{t("misc.cancel")}</button><button className="ok" disabled={busy || muted === initial.current} onClick={() => void save()}>{busy ? t("misc.saving") : t("misc.save")}</button>{saved && <span className="saved">{t("misc.notifSaved")}</span>}</div>
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
  const PAGE = 20;
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Paginate by DB-row offset, NOT items.length: listSaved now filters out saved rows whose channel the
  // caller can't currently read (IDOR-B5 read-time gate), so the visible count is ≤ the rows the server
  // consumed. Deriving the next offset from items.length would re-request overlapping windows (duplicate
  // bookmarks) or, when a whole window is filtered out, repeat the same offset forever (stuck "load more").
  const [nextOffset, setNextOffset] = useState(0);
  const load = (off = 0) => { if (off) setLoadingMore(true); else setLoading(true); setLoadError(false); return listSaved(PAGE, off).then((r) => {
    setItems((prev) => (off ? [...prev, ...r.saved] : r.saved));
    setHasMore(r.hasMore);
    setNextOffset(off + PAGE);
  }).catch(() => setLoadError(true)).finally(() => { setLoading(false); setLoadingMore(false); }); };
  useEffect(() => { load(0); /* eslint-disable-next-line */ }, []);
  const open = (it: any) => nav(`/s/${slug}/channel/${it.channelId}?msg=${it.messageId}&from=saved`);
  const unsave = async (e: React.MouseEvent, it: any) => { e.stopPropagation(); const index = items.findIndex((x) => x.messageId === it.messageId); setItems((p) => p.filter((x) => x.messageId !== it.messageId)); setNextOffset((n) => Math.max(0, n - 1)); try { await unsaveMsg(it.messageId); } catch { setItems((p) => { const next = [...p]; next.splice(Math.max(0, index), 0, it); return next; }); setNextOffset((n) => n + 1); setLoadError(true); } };
  const source = (it: any) => it.channelType === "thread"
    ? <><MessageCircle size={12} /> {t("misc.savedThread")}{it.parentChannelType === "dm" ? "@" : "#"}{it.parentChannelName ?? "?"}</>
    : it.channelType === "private"
    ? <><Lock size={12} /> {it.channelName ?? "?"}</>
    : <>{it.channelType === "dm" ? "@" : "#"} {it.channelName ?? "?"}</>;
  return (
    <>
      <ChatSidebar />
      <main className="content-col saved-page">
        <div className="head"><h1>{t("common.saved")}</h1><small>{loading ? t("misc.savedLoading") : t("misc.savedCount", { count: items.length })}</small></div>
        <div className="inbox-list">
          {loading && <div className="page-loading" role="status" aria-label={t("misc.savedLoading")}><span /><span /><span /></div>}
          {!loading && loadError && <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("misc.savedLoadError")}</span><button onClick={() => load(0)}>{t("misc.retry")}</button></div>}
          {!loading && !loadError && !items.length && <PaneEmpty icon={<Bookmark size={28} />} title={t("misc.savedEmpty")} />}
          {items.map((it) => (
            <div key={it.messageId} className="inbox-row saved-row">
              <button className="saved-open" onClick={() => open(it)}>
                <span className="ib-main">
                  <span className="ib-top">
                    <span className="ib-name">{source(it)}</span>
                    <span className="ib-time">{relTime(it.createdAt, t)}</span>
                  </span>
                  <span className="ib-preview"><b>{it.senderName ?? (it.senderType === "agent" ? t("chat.agentKind") : t("chat.userKind"))}</b>: {it.content}</span>
                </span>
              </button>
              <button className="ib-save on" aria-label={t("misc.savedUnsave")} title={t("misc.savedUnsave")} onClick={(e) => unsave(e, it)}><Bookmark size={15} fill="currentColor" /></button>
            </div>
          ))}
          {hasMore && !loading && !loadError && <button className="loadmore" disabled={loadingMore} onClick={() => load(nextOffset)}>{loadingMore ? t("misc.savedLoading") : t("misc.savedLoadMore")}</button>}
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
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = async () => { const id = ++request.current; setState("loading"); setError(""); try { const r = await api("GET", `/api/servers/${serverId}/join-links`); if (!Array.isArray(r)) throw new Error(r?.error || "invalid invite response"); if (id !== request.current) return; setLinks(r); setState("ready"); } catch (e: any) { if (id === request.current) { setError(String(e?.message || e)); setState("error"); } } };
  useEffect(() => { if (capabilities.manageMembers) void load(); return () => { request.current += 1; }; }, [serverId, capabilities.manageMembers]);
  if (!capabilities.manageMembers) return <div className="empty">{t("misc.invitesAdminOnly")}</div>;
  if (state === "loading") return <div className="page-loading" role="status" aria-label={t("misc.invitesLoading")}><span /><span /><span /></div>;
  if (state === "error") return <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{error || t("misc.invitesLoadFailed")}</span><button onClick={() => void load()}>{t("misc.retry")}</button></div>;
  const create = async () => { const parsed = maxUses ? Number(maxUses) : null; if (parsed !== null && (!Number.isInteger(parsed) || parsed < 1)) { setError(t("misc.invitesInvalidUses")); return; } setBusy("create"); setError(""); try { const r = await api("POST", `/api/servers/${serverId}/join-links`, { role, maxUses: parsed }); if (r?.error || !r?.id) throw new Error(r?.error || "invalid invite response"); setLinks((current) => [r, ...current]); setMaxUses(""); } catch (e: any) { setError(String(e?.message || e)); } finally { setBusy(""); } };
  const del = async (id: string) => { setBusy(id); setError(""); try { const r = await api("DELETE", `/api/servers/${serverId}/join-links/${id}`); if (r?.error || r?.ok === false) throw new Error(r?.error || "delete failed"); setLinks((current) => current.filter((link) => link.id !== id)); } catch (e: any) { setError(String(e?.message || e)); } finally { setBusy(""); } };
  const urlOf = (tok: string) => `${location.origin}/join/${tok}`;
  const copy = async (tok: string) => {
    const link = urlOf(tok);
    if (await copyText(link)) {
      setCopied(tok);
      setTimeout(() => setCopied(""), 1500);
    } else {
      window.prompt(t("members.copyLink"), link);
    }
  };
  return (
    <div className="setform">
      <label>{t("misc.invitesLabel")}</label>
      <p className="modal-note">{t("misc.invitesNote")}</p>
      <div className="inv-new">
        <select value={role} disabled={!!busy} aria-label={t("misc.invitesRoleLabel")} onChange={(e) => setRole(e.target.value)}>
          <option value="member">{t("misc.invitesRoleMember")}</option>
          <option value="admin">{t("misc.invitesRoleAdmin")}</option>
        </select>
        <input type="number" min="1" disabled={!!busy} placeholder={t("misc.invitesMaxUsesPlaceholder")} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        <button className="ok" disabled={!!busy} onClick={() => void create()}>{busy === "create" ? t("misc.invitesCreating") : t("misc.invitesGenerateBtn")}</button>
      </div>
      {error && <div className="form-err" role="alert">{error}</div>}
      <div className="inv-list">
        {links.length === 0 ? <div className="empty">{t("misc.invitesEmpty")}</div> : links.map((l) => (
          <div className="inv-item" key={l.id}>
            <div className="inv-meta">
              <span className="inv-role">{l.role}</span>
              <code className="inv-url">{urlOf(l.token)}</code>
              <span className="inv-uses">{l.maxUses != null ? t("misc.invitesUsesCapped", { used: l.useCount, max: l.maxUses }) : t("misc.invitesUses", { count: l.useCount })}</span>
            </div>
            <div className="inv-acts">
              <button className="joinbtn" disabled={!!busy} onClick={() => void copy(l.token)}>{copied === l.token ? t("misc.invitesCopied") : t("misc.invitesCopyBtn")}</button>
              <button className="joinbtn" disabled={!!busy} style={{ color: "var(--error)" }} onClick={() => void del(l.id)}>{busy === l.id ? t("misc.invitesDeleting") : t("misc.invitesDeleteBtn")}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
