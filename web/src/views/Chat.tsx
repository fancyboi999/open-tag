import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useStore, fmtTime, type Msg, type Att } from "../store.tsx";
import { PAGE_SIZE, appendWithCap } from "../lib/msgPaging";
import { MessageContent } from "../messageRender.tsx";
import { nextThreadMeta } from "../threadUnread";
import { Smile, X, ExternalLink, CheckCircle2, MessageCircle, MoreHorizontal, Link2, Clipboard, Bookmark, CheckSquare, Circle, Play, Eye, Ban, ArrowDown, BellOff, Lock, Globe, Archive, Trash2 } from "lucide-react";
// Task badge per message row: icon changes with task status; color tokens from DESIGN.md (see .task-pill.st-* styles)
const TASK_ICON: Record<string, typeof Circle> = { todo: Circle, in_progress: Play, in_review: Eye, done: CheckCircle2, closed: Ban };
import { IconWrench, IconFile, IconExternalLink, IconDownload } from "../icons.tsx";
import { Avatar, resolveAvatar } from "../Avatar.tsx";
import { Lightbox } from "../Lightbox.tsx";
import { TaskBoard, ynOptions, ST_LABEL } from "../TaskBoard.tsx";
import { PaneEmpty } from "../PaneEmpty.tsx";
import { ChatSkeleton } from "./Skeleton.tsx";
import { AgentProfile, HumanProfile, CreateAgentModal } from "./Members.tsx";
import { ChatSidebar, CreateChannelModal } from "./ChatSidebar.tsx";
import { ConnectComputerWizard } from "./ConnectComputerWizard.tsx";
import { Composer } from "./Composer.tsx";
import { useConfirm, useEscClose } from "../ConfirmModal.tsx";

const fmtSize = (n?: number) => (!n ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const isImage = (m?: string) => !!m && m.startsWith("image/");
const isVideo = (m?: string) => !!m && m.startsWith("video/");

// Message attachments: images shown inline with lightbox, videos shown with inline player; other files shown as a file card. Videos that fail to play fall back to a download card.
function AttCard({ a, url }: { a: Att; url: string }) {
  const [lb, setLb] = useState(false);
  const [vErr, setVErr] = useState(false);
  if (isImage(a.mimeType)) return (<>
    <button className="msg-att-img" title={a.filename} onClick={() => setLb(true)}><img src={url} alt={a.filename} loading="lazy" /></button>
    {lb && <Lightbox src={url} alt={a.filename} onClose={() => setLb(false)} />}
  </>);
  if (isVideo(a.mimeType) && !vErr) return <video className="msg-att-video" src={url} controls playsInline preload="metadata" title={a.filename} onError={() => setVErr(true)} />;
  return <a className="msg-att" href={url} target="_blank" rel="noreferrer"><IconFile size={14} /><span className="grow">{a.filename}{vErr ? i18n.t("chat.videoUnsupported") : ""}</span><span className="asz">{fmtSize(a.sizeBytes)}</span></a>;
}

// Message emoji reactions: chip shows emoji×count (highlighted if the current user reacted), click to toggle; hovering the add button reveals a quick picker
const QUICK_EMOJIS = ["👍", "✅", "❤️", "😂", "🎉", "👀", "🚀", "🙏"];
function Reactions({ m, mine, onReact }: { m: Msg; mine: string; onReact: (emoji: string, remove: boolean) => void }) {
  const [pick, setPick] = useState(false);
  const rs = m.reactions || [];
  return (
    <div className="msg-rx">
      {rs.map((r) => {
        const did = !!mine && r.reactorIds?.includes(mine);
        const names = (r.reactorNames || []).filter(Boolean).join(", "); // who reacted — shown in a custom hover tooltip (native title is slow/unstyled/missing on touch)
        return <button key={r.emoji} className={"rx-chip" + (did ? " on" : "")} onClick={() => onReact(r.emoji, !!did)}>{r.emoji} {r.count}{names ? <span className="rx-tip" role="tooltip">{names}</span> : null}</button>;
      })}
      <span className="rx-add-wrap">
        <button className="rx-add" title={i18n.t("chat.addReaction")} onMouseDown={(e) => { e.preventDefault(); setPick((v) => !v); }}><Smile size={15} /></button>
        {pick && <span className="rx-pop" onMouseLeave={() => setPick(false)}>{QUICK_EMOJIS.map((e) => <button key={e} onMouseDown={(ev) => { ev.preventDefault(); onReact(e, false); setPick(false); }}>{e}</button>)}</span>}
      </span>
    </div>
  );
}

// Action card: a proposal card sent by an agent. User clicks it → a pre-filled creation dialog opens → resource is created on behalf of the user → markExecuted is called.
function ActionCardMsg({ m }: { m: Msg }) {
  const { t } = useTranslation();
  const { createChannel, markActionExecuted, slug, agents, attachmentUrl } = useStore();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const meta = m.actionMetadata!;
  const a = meta.action;
  const executed = meta.state === "executed";
  const isChan = a.type === "channel:create";
  const title = isChan
    ? <>{t(a.visibility === "private" ? "chat.createPrivateChannel" : "chat.createPublicChannel", { name: a.name })}</>
    : <>{t("chat.createAgent", { name: a.name })}</>;
  return (
    <div className="msg action-card-msg" id={"m-" + m.id} key={m.id}>
      <Avatar seed={m.senderName} url={resolveAvatar(agents.find((a) => a.id === m.senderId)?.avatarUrl, attachmentUrl)} size={36} />
      <div className="msg-col">
        <div className="msg-head"><span className="who">{m.senderName}</span><span className="member-badge">{t("chat.proposed")}</span><span className="ts">{fmtTime(m.createdAt)}</span></div>
        <div className="action-card">
          <div className="ac-title">{title}</div>
          {a.description ? <div className="ac-detail"><span className="ac-k">{t("chat.description")}</span> {a.description}</div> : null}
          {executed
            ? <div className="ac-done"><CheckCircle2 size={13} /> {t("chat.executedBy", { name: meta.executedByUserName || t("chat.someone") })}</div>
            : <button className="ac-btn" onClick={() => setOpen(true)}>{isChan ? t("chat.createChannel") : t("chat.createAgentBtn")}</button>}
        </div>
      </div>
      {open && isChan && (
        <CreateChannelModal
          prefill={{ name: a.name, description: a.description ?? "", visibility: a.visibility, agentIds: a.initialAgents ?? [], userIds: a.initialHumans ?? [] }}
          submitLabel={t("chat.createChannel")} onClose={() => setOpen(false)}
          onCreate={async (opts) => { const r = await createChannel(opts); setOpen(false); if (r?.id) { await markActionExecuted(m.id, { kind: "channel", id: r.id, name: opts.name }); nav(`/s/${slug}/channel/${r.id}`); } }}
        />
      )}
      {open && !isChan && (
        <CreateAgentModal
          prefill={{ name: a.name, description: a.description ?? "" }} onClose={() => setOpen(false)}
          onCreated={async (r) => { await markActionExecuted(m.id, { kind: "agent", id: r.id, name: r.name }); }}
        />
      )}
    </div>
  );
}

export function Chat() {
  const { t } = useTranslation();
  const { api, channels, dms, unread, agents, humans, traj, slug, me, myRole, capabilities, reload, onEvent, subscribeChannel, openDM, markRead, uploadFiles, uploadOne, attachmentUrl, react, openThread, savedIds, saveMsg, unsaveMsg, agentPanelReq, clearAgentPanelReq } = useStore();
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  // A message's sender avatar: look the sender up in the loaded agents/humans lists (carry avatarUrl) — no message-schema change needed.
  const senderAvatar = (m: Msg) => avFor(m.senderType === "agent" ? agents.find((a) => a.id === m.senderId)?.avatarUrl : humans.find((h) => h.userId === m.senderId)?.avatarUrl);
  const confirm = useConfirm();
  const [showEdit, setShowEdit] = useState(false);
  const manageServer = myRole === "owner" || myRole === "admin"; // server admins get the full task-status dropdown (matches TaskBoard permission model)
  const { channelId } = useParams();
  const nav = useNavigate();
  const [profile, setProfile] = useState<{ type: "agent" | "human"; id: string } | null>(null); // right-column profile overlay: clicking an avatar / name / @mention (agent, human, or yourself) opens it ON TOP of the thread/trajectory ("click X → show X"); closing it reveals the layer underneath
  const [taskMenu, setTaskMenu] = useState<string | null>(null); // task badge status menu: id of the currently open message (clicking the badge changes status, does not open thread)
  const [hoverAgent, setHoverAgent] = useState<{ id: string; x: number; y: number } | null>(null); // hovering over an agent shows a quick-info hover card
  const [ctxMenu, setCtxMenu] = useState<{ m: Msg; x: number; y: number } | null>(null); // right-clicking a message opens the context action menu
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [loaded, setLoaded] = useState(false); // first fetch for the current channel done — gates the empty-channel state so it never flashes mid-load
  const [loadError, setLoadError] = useState(false); // first fetch failed — exits the skeleton into a retryable error state
  const [sub, setSub] = useState("");
  const [showMembers, setShowMembers] = useState(false);
  const [thread, setThread] = useState<{ channelId: string; parent: Msg } | null>(null); // currently open thread panel
  const [threadMeta, setThreadMeta] = useState<Record<string, { threadChannelId: string; replyCount: number; unreadCount?: number }>>({}); // parent message id → thread metadata (reply count, unread count)
  const [unreadThreads, setUnreadThreads] = useState<{ threadChannelId: string; parentMessageId: string; parentChannelId: string; unreadCount: number }[]>([]); // unread that lives in this channel's threads (invisible in the main timeline) → "jump to unread thread" bar
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // tracks whether the scroll position is at the bottom; new messages auto-scroll only when already at the bottom, preserving history browsing
  const [showJump, setShowJump] = useState(false); // when not at the bottom, show the "Back to bottom" jump button
  const [hasMore, setHasMore] = useState(false); // older messages remain before the loaded window → drives scroll-to-top "load more"
  const loadingOlderRef = useRef(false); // de-dupes concurrent "load older" fetches while one is in flight
  const prependRestoreRef = useRef<number | null>(null); // scrollHeight captured before a prepend; restored after so the viewport doesn't jump
  const trimmedRef = useRef(false); // a live-tail trim dropped the oldest in-memory messages → mark hasMore so they stay re-fetchable
  // Message enter animation tracking: id → stagger index (0–7) for messages that arrived via socket (true new).
  // Historical loads (initial fetch, loadOlder) never touch this map, so they never get the enter class.
  const newMsgOrderRef = useRef(new Map<string, number>());
  const burstCountRef = useRef(0); // how many messages have arrived in the current burst window
  const burstTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // resets burstCount after 600ms silence
  const cur = [...channels, ...dms].find((c) => c.id === channelId) || channels.find((c) => c.name === "all") || channels[0];
  const curIdRef = useRef<string | undefined>(undefined);
  curIdRef.current = cur?.id; // latest channel id for async guards: a loadOlder that resolves after a channel switch must drop its stale-channel result (no cross-channel prepend / hasMore clobber)
  const isDm = !!dms.find((d) => d.id === cur?.id);
  const dmPeer = dms.find((d) => d.id === cur?.id);
  const dmAgent = dmPeer?.peerType === "agent" ? agents.find((a) => a.id === dmPeer.peerId) : undefined; // DM peer agent → used for the live status indicator in the header
  const [sp, setSp] = useSearchParams();
  const chatTab = sp.get("chatTab") || "chat"; // active tab: chat | tasks (| files in channels). DMs get chat + tasks (per-DM task board); files/members stay channel-only.
  const msgParam = sp.get("msg"); // when present, scroll to and highlight the specified message id
  const threadParam = sp.get("thread"); // auto-open a thread panel (from inbox, in-message thread link, or cross-page link); value is the parent message id (full or 8-char short) or channelId:shortid

  // Closing the agent panel clears the Activity-tab deep-link so the next avatar-open defaults to Overview
  // (the live bar deep-links to Activity via ?agentTab=activity; without this it would stick across opens).
  const closeProfile = () => { setProfile(null); setSp((prev) => { const n = new URLSearchParams(prev); n.delete("agentTab"); return n; }, { replace: true }); };

  // Channel-scoped state (loaded messages + load gate + has-more) belongs to one channel. When the
  // channel changes, reset it *synchronously during render* (React's "adjust state when a prop changes"
  // pattern) rather than in the effect below — effects run after paint, so resetting there leaves one
  // painted frame (and the whole skeleton phase) showing the previous channel's messages. Resetting here
  // makes the new channel paint its skeleton immediately, never the prior channel's stale list.
  const [shownChannelId, setShownChannelId] = useState(cur?.id);
  if (cur?.id !== shownChannelId) {
    setShownChannelId(cur?.id);
    setMsgs([]);
    setLoaded(false);
    setLoadError(false);
    setHasMore(false);
  }

  useEffect(() => { if (!channelId && cur) nav(`/s/${slug}/channel/${cur.id}`, { replace: true }); }, [channelId, cur, slug, nav]);
  const loadCurrentMessages = async () => {
    if (!cur) return;
    const chId = cur.id;
    setLoaded(false);
    setLoadError(false);
    try {
      const d = await api("GET", `/api/messages/channel/${chId}?limit=${PAGE_SIZE}`);
      if (curIdRef.current !== chId) return;
      const ms: Msg[] = d.messages || [];
      setMsgs(ms);
      setHasMore(!!d.hasMore);
      markRead(chId);
      const ids = ms.map((m) => m.id);
      if (ids.length) {
        try { setThreadMeta(await api("GET", `/api/channels/${chId}/threads?parentMessageIds=${ids.join(",")}`) || {}); }
        catch { setThreadMeta({}); }
      } else setThreadMeta({});
    } catch {
      if (curIdRef.current !== chId) return;
      setMsgs([]);
      setThreadMeta({});
      setHasMore(false);
      setLoadError(true);
    } finally {
      if (curIdRef.current === chId) setLoaded(true);
    }
  };
  useEffect(() => { if (!cur) return; setThread(null); setProfile(null); loadingOlderRef.current = false; prependRestoreRef.current = null; subscribeChannel(cur.id); void loadCurrentMessages(); }, [cur?.id]);
  // Surface unread that lives in this channel's threads (folded away, invisible in the main timeline → "滑不到").
  // Re-runs when the channel's badge changes: entry, a new thread reply bumping it, or opening a thread clearing it.
  useEffect(() => {
    if (!cur || cur.type === "dm" || cur.type === "thread") { setUnreadThreads([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await api("GET", "/api/channels/threads/followed");
        if (cancelled) return;
        setUnreadThreads((r?.threads || []).filter((th: any) => th.parentChannelId === cur.id && th.unreadCount > 0 && th.parentMessageId)
          .map((th: any) => ({ threadChannelId: th.threadChannelId, parentMessageId: th.parentMessageId, parentChannelId: th.parentChannelId, unreadCount: th.unreadCount })));
      } catch { if (!cancelled) setUnreadThreads([]); }
    })();
    return () => { cancelled = true; };
  }, [cur?.id, unread[cur?.id ?? ""]]);
  // LiveAgentBar (sidebar) → open this agent's profile panel on the Activity tab in the right column,
  // reusing the existing avatar-click overlay (setProfile). Consumed once and cleared. MUST be declared
  // after the channel-switch effect above: when the click navigates here from a non-channel view (Saved),
  // both effects fire on mount and the channel-switch one resets setProfile(null) — declaring this later
  // makes its setProfile win. In-channel clicks only re-run this effect (cur.id unchanged), so order is moot there.
  useEffect(() => {
    if (!agentPanelReq) return;
    setProfile({ type: "agent", id: agentPanelReq });
    setSp((prev) => { const n = new URLSearchParams(prev); n.set("agentTab", "activity"); return n; }, { replace: true });
    clearAgentPanelReq();
    // eslint-disable-next-line
  }, [agentPanelReq]);
  useEffect(() => onEvent((e) => {
    if (e.type === "message" && e.channelId === cur?.id) { const idx = Math.min(burstCountRef.current, 7); newMsgOrderRef.current.set(e.message.id, idx); burstCountRef.current += 1; if (burstTimerRef.current) clearTimeout(burstTimerRef.current); burstTimerRef.current = setTimeout(() => { burstCountRef.current = 0; burstTimerRef.current = null; }, 600); setMsgs((m) => { const { next, trimmed } = appendWithCap(m, e.message, atBottomRef.current && !loadingOlderRef.current); if (trimmed) trimmedRef.current = true; return next; }); markRead(cur.id); } // don't trim mid-pagination: a trim's setHasMore(true) would race the in-flight loadOlder's setHasMore — suppressing it closes the window (the next message trims instead)
    else if (e.type === "message:updated" && e.message) setMsgs((m) => m.map((x) => (x.id === e.message.id ? { ...x, ...e.message } : x))); // sync reactions and task fields
    else if (e.type === "thread:updated" && e.parentMessageId) setThreadMeta((tm) => ({ // live reply count update; unreadCount is approximated from the replyCount delta (the authoritative value is corrected on channel switch via GET)
      ...tm,
      [e.parentMessageId]: nextThreadMeta(tm[e.parentMessageId], { threadChannelId: e.threadChannelId, replyCount: e.replyCount, senderId: e.senderId }, me?.id),
    }));
    else if (e.type === "agent") setSub(e.activity ? `${e.name} · ${e.activity}${e.detail ? " · " + e.detail : ""}` : ""); // live-trace entries are accumulated globally in the store (see store.tsx agent:activity handler), so they persist across channel/DM switches
  }), [cur?.id]);
  useEffect(() => { const el = scrollRef.current; if (!el || msgParam) return; if (atBottomRef.current) el.scrollTop = el.scrollHeight; }, [msgs, msgParam]); // auto-scroll only when already pinned to the bottom
  // Keep the viewport anchored across an older-page prepend: restore scrollTop before paint. Runs before the auto-scroll effect above, which is a no-op here anyway (a prepend only happens while scrolled up, so atBottomRef is false).
  useLayoutEffect(() => { const el = scrollRef.current; if (el && prependRestoreRef.current != null) { el.scrollTop = el.scrollHeight - prependRestoreRef.current; prependRestoreRef.current = null; } }, [msgs]);
  useEffect(() => { if (trimmedRef.current) { trimmedRef.current = false; setHasMore(true); } }, [msgs]); // a live-tail trim opened a gap at the top → older messages stay re-fetchable
  useEffect(() => { atBottomRef.current = true; setShowJump(false); newMsgOrderRef.current.clear(); burstCountRef.current = 0; }, [cur?.id]); // reset bottom-pin state + new-msg enter animation tracking on channel switch
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; atBottomRef.current = true; setShowJump(false); };
  // Fetch the previous (older) page via the `before` keyset cursor and prepend it; guarded so concurrent scroll events can't fire duplicate loads.
  const loadOlder = async () => {
    if (!cur || loadingOlderRef.current || !hasMore || !msgs.length) return;
    const chId = cur.id; // pin the channel this fetch belongs to
    loadingOlderRef.current = true;
    try {
      const d = await api("GET", `/api/messages/channel/${chId}?limit=${PAGE_SIZE}&before=${msgs[0]!.seq}`);
      if (curIdRef.current !== chId) return; // channel switched mid-fetch → drop the stale result (finally still clears the in-flight flag)
      const older: Msg[] = d.messages || [];
      if (older.length) { const el = scrollRef.current; prependRestoreRef.current = el ? el.scrollHeight : null; setMsgs((m) => [...older, ...m]); } // capture height right before prepend; layout effect restores after
      setHasMore(!!d.hasMore);
    } catch { /* transient — the next scroll-to-top retries */ } finally { loadingOlderRef.current = false; }
  };
  const onScroll = () => { const el = scrollRef.current; if (!el) return; if (el.scrollTop < 80 && hasMore && !loadingOlderRef.current) void loadOlder(); const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120; atBottomRef.current = near; setShowJump(!near); };
  // highlightedMsgRef guards the flash to once per target. The deps below include `msgs`, so without it every
  // incoming live message (msgs changes) would re-run this while ?msg= is still in the URL and re-flash the
  // inbox-clicked message on each new message. Re-armed on channel switch so re-opening the same target flashes again.
  const highlightedMsgRef = useRef<string | null>(null);
  useEffect(() => { highlightedMsgRef.current = null; }, [cur?.id]);
  useEffect(() => { // scroll to and highlight the target message for ~2s when msgParam is set (once per target)
    if (!msgParam || chatTab !== "chat") return;
    if (highlightedMsgRef.current === msgParam) return; // already flashed this target — ignore msgs/live-update re-runs
    const el = document.getElementById("m-" + msgParam);
    if (el) { highlightedMsgRef.current = msgParam; el.scrollIntoView({ block: "center" }); el.classList.add("msg-hl"); setTimeout(() => el.classList.remove("msg-hl"), 2200); } // no cleanup-cancel: the removal must outlive re-renders, else a re-render cancels the timer and the highlight sticks
    else if (hasMore && !loadingOlderRef.current) void loadOlder(); // target outside the loaded window → page older history (re-runs on each prepend via the msgs dep) until it appears or the channel start is reached
  }, [msgParam, msgs, chatTab, hasMore]);
  useEffect(() => { // ?thread= auto-opens the thread panel: finds the parent message (full id or 8-char short id) in the loaded list and calls startThread; each threadParam is only opened once
    if (!threadParam || !msgs.length) return;
    if (thread) return; // panel already open, do not re-open
    const short = threadParam.includes(":") ? threadParam.split(":").pop()! : threadParam;
    const m = msgs.find((x) => x.id === threadParam || x.id.startsWith(short));
    if (m) startThread(m);
    else if (hasMore && !loadingOlderRef.current) void loadOlder(); // parent outside the loaded window → page older history until it appears or the channel start is reached
    // eslint-disable-next-line
  }, [threadParam, msgs, hasMore]);

  const setTab = (t: string) => { const n = new URLSearchParams(sp); if (t === "chat") n.delete("chatTab"); else n.set("chatTab", t); setSp(n, { replace: true }); };
  const doDM = async (agentId: string) => { const id = await openDM("agent", agentId); if (id) nav(`/s/${slug}/channel/${id}`); }; // used by AgentProfile onMessage callback
  const doDMHuman = async (uid: string) => { const id = await openDM("user", uid); if (id) nav(`/s/${slug}/channel/${id}`); }; // used by HumanProfile onMessage callback
  // Opening a thread is an explicit "show me this thread" action → it becomes the right-column base layer and clears any profile overlay on top of it (otherwise the just-opened thread would stay hidden behind a stale profile).
  const startThread = async (m: Msg) => { if (!cur) return; const tid = threadMeta[m.id]?.threadChannelId || await openThread(cur.id, m.id); if (tid) { setProfile(null); setThread({ channelId: tid, parent: m }); setThreadMeta((tm) => (tm[m.id] ? { ...tm, [m.id]: { ...tm[m.id]!, unreadCount: 0 } } : tm)); markRead(tid); } }; // opening a thread clears the unread count optimistically and marks the thread channel as read
  // "Jump to unread thread" bar: open a thread whose parent message may not be in the loaded page — fetch the parent
  // by id (it isn't on screen to pass through startThread), open the panel, mark it read, and drop it from the bar.
  const openUnreadThread = async (item: { threadChannelId: string; parentMessageId: string }) => {
    if (!cur) return;
    try {
      const parent = (await api("GET", `/api/messages/${item.parentMessageId}`))?.message as Msg | undefined;
      if (!parent) return;
      setProfile(null); setThread({ channelId: item.threadChannelId, parent });
      setThreadMeta((tm) => (tm[parent.id] ? { ...tm, [parent.id]: { ...tm[parent.id]!, unreadCount: 0 } } : tm));
      markRead(item.threadChannelId);
      setUnreadThreads((list) => list.filter((th) => th.threadChannelId !== item.threadChannelId));
    } catch { /* parent fetch failed (deleted / no access) — leave the bar untouched */ }
  };
  // Returns the display name of the task assignee, used by the task pill
  const taskAssignee = (m: Msg) => { if (!m.taskAssigneeId) return ""; const a = agents.find((x) => x.id === m.taskAssigneeId); if (a) return " @" + (a.displayName || a.name); const h = humans.find((x) => x.userId === m.taskAssigneeId); return h ? " @" + (h.displayName || h.name) : ""; };
  // Handles task status change / claim from the task badge; socket message:updated event refreshes the message automatically
  const doTask = async (m: Msg, action: string, body?: unknown) => { try { await api("PATCH", `/api/tasks/${m.id}/${action}`, body); } catch { /* will self-correct on next reload */ } };
  // Routes inline token clicks (@mention / #channel / thread / task #N) inside MessageContent
  const navToken = async (type: string, args: string[]) => {
    if (type === "agent") return setProfile({ type: "agent", id: args[0]! });
    if (type === "human") return setProfile({ type: "human", id: args[0]! }); // @human click → profile panel (same overlay as agents, not a full-page route)
    if (type === "channel") return nav(`/s/${slug}/channel/${args[0]}`);
    if (type === "thread") return nav(`/s/${slug}/channel/${args[0]}?thread=${args[0]}:${args[1]}`);
    if (type === "task") {
      const num = Number(args[0]);
      const local = msgs.find((x) => x.taskNumber === num);
      if (local && cur) return nav(`/s/${slug}/channel/${cur.id}?msg=${local.id}`);
      try { const r = await api("GET", "/api/tasks/server"); const tk = (r?.tasks ?? r ?? []).find((x: any) => x.taskNumber === num); if (tk) nav(`/s/${slug}/channel/${tk.channelId}?msg=${tk.id}`); } catch { /* */ }
    }
  };


  return (
    <>
      <ChatSidebar />
      <main className="content-col">
        <div className="head chat-head">
          <h1>{isDm ? "@ " + (cur?.name || "") : cur?.type === "showcase" ? <><Eye size={16} style={{ verticalAlign: "-3px", opacity: 0.7 }} /> {cur?.name || "…"}</> : "# " + (cur?.name || "…")}</h1>
          {dmAgent
            ? <span className="head-status"><span className={"dot " + (dmAgent.activity || "offline")} />{dmAgent.activityDetail || dmAgent.activity || "offline"}</span>
            : <small>{sub || cur?.description || ""}</small>}
          {cur && <div className="chtabs">{(isDm ? ["chat", "tasks"] : ["chat", "tasks", "files"]).map((tt) => <button key={tt} className={chatTab === tt ? "on" : ""} onClick={() => setTab(tt)}>{tt === "chat" ? t("nav.channel") : tt === "tasks" ? t("nav.tasks") : t("common.files")}</button>)}</div>}
          {!isDm && cur && cur.type !== "showcase" && <button className="joinbtn" style={{ marginLeft: "auto" }} title={t("chat.channelMembers")} onClick={() => setShowMembers(true)}>{t("chat.members")}</button>}
          {!isDm && cur && cur.type !== "showcase" && capabilities.manageChannels && (
            <button className="joinbtn" title={t("chat.channelSettings")} onClick={() => setShowEdit(true)}>⋯</button>
          )}
        </div>
        {chatTab === "tasks" && cur ? <TaskBoard channelId={cur.id} onOpenThread={startThread} />
          : chatTab === "files" && cur ? <ChannelFiles channelId={cur.id} />
          : <>
            {chatTab === "chat" && unreadThreads.length > 0 && (
              <button className="unread-threads-bar" onClick={() => openUnreadThread(unreadThreads[0]!)}>
                <MessageCircle size={14} />
                <span className="utb-label">{t("chat.unreadThreads", { count: unreadThreads.reduce((s, th) => s + th.unreadCount, 0) })}</span>
                <span className="utb-cta">{t("chat.viewUnreadThread")}</span>
              </button>
            )}
            <div key={cur?.id} className="scroll ch-view-enter" ref={scrollRef} onScroll={onScroll}>
              {!loaded && <ChatSkeleton />}
              {loaded && loadError && <PaneEmpty icon={<MessageCircle size={30} />} title={t("chat.loadFailedTitle")} sub={<><span>{t("chat.loadFailedBody")}</span><button className="joinbtn" onClick={loadCurrentMessages}>{t("chat.retryLoad")}</button></>} />}
              {loaded && !loadError && !msgs.length && <PaneEmpty icon={<MessageCircle size={30} />} title={t("chat.channelEmpty")} />}
              {loaded && !loadError && msgs.map((m) => {
                const ag = m.senderType === "agent" && m.senderId ? agents.find((a) => a.id === m.senderId) : undefined; // used for role description and avatar status dot
                const tm = threadMeta[m.id];
                const isMember = m.senderType !== "agent" && m.senderType !== "system"; // human/user senders get a "member" badge
                // action card (agent proposal card) → rendered by dedicated ActionCardMsg component
                if (m.messageType === "action" && m.actionMetadata?.kind === "action-card") return <ActionCardMsg m={m} key={m.id} />;
                // system messages (task lifecycle events, etc.) → centered grey bar (no avatar, no full message block)
                // If the system message has thread replies (e.g. showcase case anchors), render a thread-pill below the bar so it's clickable.
                if (m.senderType === "system") return (
                  <div className="msg-sys" id={"m-" + m.id} key={m.id}>
                    <MessageContent content={m.content} mentions={m.mentions || []} channels={channels} nav={navToken} />
                    {tm?.replyCount ? <button className="thread-pill" onClick={() => startThread(m)}><MessageCircle size={12} /> {t("chat.replyCount", { count: tm.replyCount })}</button> : null}
                  </div>
                );
                const staggerIdx = newMsgOrderRef.current.get(m.id);
                const isNewMsg = staggerIdx !== undefined;
                return (
                <div className={"msg" + (isNewMsg ? " msg-enter" : "")} id={"m-" + m.id} key={m.id} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ m, x: e.clientX, y: e.clientY }); }} style={isNewMsg ? { "--msg-delay": `${staggerIdx * 60}ms` } as CSSProperties : undefined}>
                  <div className="msg-toolbar">
                    <button title={t("chat.emojiActions")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ m, x: r.left - 180, y: r.bottom + 4 }); }}><Smile size={15} /></button>
                    <button title={t("chat.openThread")} onClick={() => startThread(m)}><MessageCircle size={15} /></button>
                    <button title={t("chat.more")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ m, x: r.right - 212, y: r.bottom + 4 }); }}><MoreHorizontal size={15} /></button>
                  </div>
                  {ag
                    ? <span className="msg-av clickable" onClick={() => setProfile({ type: "agent", id: m.senderId! })}
                        onMouseEnter={(e) => setHoverAgent({ id: m.senderId!, x: e.currentTarget.getBoundingClientRect().right + 8, y: e.currentTarget.getBoundingClientRect().top })}
                        onMouseLeave={() => setHoverAgent(null)}><Avatar seed={m.senderName} url={senderAvatar(m)} size={36} />{ag.activity && ag.activity !== "offline" && <span className={"av-status " + ag.activity} />}</span>
                    : m.senderId
                      ? <span className="msg-av clickable" onClick={() => setProfile({ type: "human", id: m.senderId! })}><Avatar seed={m.senderName} url={senderAvatar(m)} size={36} /></span>
                      : <Avatar seed={m.senderName} url={senderAvatar(m)} size={36} />}
                  <div className="msg-col">
                    <div className="msg-head">
                      {ag
                        ? <span className="who clickable" onClick={() => setProfile({ type: "agent", id: m.senderId! })}
                            onMouseEnter={(e) => setHoverAgent({ id: m.senderId!, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 6 })}
                            onMouseLeave={() => setHoverAgent(null)}>{m.senderName}</span>
                        : m.senderId
                          ? <span className="who clickable" onClick={() => setProfile({ type: "human", id: m.senderId! })}>{m.senderName}</span>
                          : <span className="who">{m.senderName}</span>}
                      {ag?.description ? <span className="msg-role">{ag.description}</span> : isMember ? <span className="member-badge">member</span> : null}
                      <span className="ts">{fmtTime(m.createdAt)}</span></div>
                    {!!m.content && <div className="mbody"><MessageContent content={m.content} mentions={m.mentions || []} channels={channels} nav={navToken} /></div>}
                    {!!m.attachments?.length && <div className="msg-atts">{m.attachments.map((a) => <AttCard key={a.id} a={a} url={attachmentUrl(a.id)} />)}</div>}
                    {/* persistent meta row: task badge + thread button + reactions all on the same line (reactions no longer occupy a separate row) */}
                    <div className="msg-meta">
                        {m.taskStatus && (() => {
                          const TI = TASK_ICON[m.taskStatus] || Circle;
                          const isShowcase = cur?.type === "showcase";
                          const claimable = !isShowcase && !m.taskAssigneeId && m.taskStatus === "todo";
                          const claimedByMe = m.taskAssigneeType === "user" && m.taskAssigneeId === me?.id;
                          const opts = ynOptions(m.taskStatus, manageServer, claimedByMe);
                          const open = !isShowcase && taskMenu === m.id;
                          return (
                            <span className="task-pill-wrap">
                              {/* clicking the badge changes status; in showcase channels the pill is a read-only label */}
                              <button className={"task-pill st-" + m.taskStatus} onClick={(e) => { e.stopPropagation(); if (!isShowcase) setTaskMenu(open ? null : m.id); }} title={isShowcase ? undefined : t("chat.taskChangeStatus", { number: m.taskNumber })} style={isShowcase ? { cursor: "default" } : undefined}><TI size={11} /> #{m.taskNumber} {t(ST_LABEL[m.taskStatus] ?? m.taskStatus)}{taskAssignee(m)}</button>
                              {open && <div className="st-menu" onMouseLeave={() => setTaskMenu(null)}>
                                {claimable && <button onClick={() => { setTaskMenu(null); doTask(m, "claim"); }}>{t("chat.claim")}</button>}
                                {opts.map((s) => <button key={s} className={s === m.taskStatus ? "on" : ""} onClick={() => { setTaskMenu(null); if (s !== m.taskStatus) doTask(m, "status", { status: s }); }}><span className={"st-dot st-" + s} />{t(ST_LABEL[s])}</button>)}
                              </div>}
                            </span>
                          );
                        })()}
                        {tm?.replyCount ? <button className="thread-pill" onClick={() => startThread(m)}><MessageCircle size={12} /> {t("chat.replyCount", { count: tm.replyCount })}{tm.unreadCount ? <span className="thread-new"> · {tm.unreadCount} new</span> : ""}</button> : null}
                        <Reactions m={m} mine={me?.id ?? ""} onReact={(emoji, remove) => react(m.id, emoji, remove)} />
                      </div>
                  </div>
                </div>
                );
              })}
            </div>
            {showJump && <button className="jump-bottom" onClick={toBottom}><ArrowDown size={14} /> {t("chat.backToBottom")}</button>}
            {cur?.type === "showcase"
              ? <div className="showcase-readonly"><Eye size={14} />{t("chat.showcaseReadOnly")}</div>
              : <Composer
                  channelId={cur?.id ?? ""}
                  placeholder={isDm ? t("chat.dmPlaceholder", { name: cur?.name }) : t("chat.channelPlaceholder")}
                  allowAsTask
                  dmAgent={isDm ? dmAgent : undefined}
                />}
          </>}
      </main>
      {/* Right column = one base layer (thread, else trajectory) with a profile overlay on top. Priority: profile > thread > trajectory, so a profile opened from anywhere ("click X → show X") covers the thread; closing it reveals the thread again. */}
      {profile
        ? <aside className="traj-col profile-mode">
            {profile.type === "agent"
              ? <AgentProfile id={profile.id} onDeleted={closeProfile} onClose={closeProfile} onMessage={() => { const id = profile.id; closeProfile(); doDM(id); }} />
              : <HumanProfile uid={profile.id} onClose={() => setProfile(null)} onMessage={() => { const id = profile.id; setProfile(null); doDMHuman(id); }} />}
          </aside>
        : thread
        ? <ThreadPanel channelId={thread.channelId} parent={thread.parent} onClose={() => setThread(null)} onOpenProfile={(type, id) => setProfile({ type, id })} />
        : <aside className="traj-col">
              <h2>{t("chat.agentLiveTrace")}</h2>
              {traj.length === 0
                ? <div className="hint">{t("chat.agentTraceHint")}</div>
                : traj.map((t, i) => <div className={"traj" + (t.tool ? " tool" : "")} key={i}>{t.tool && <IconWrench size={12} />}{t.name ? "@" + t.name + " · " : ""}{t.text}</div>)}
      </aside>}
      <ConnectComputerWizard mode="onboard" />
      {showMembers && cur && <ChannelMembersModal channelId={cur.id} channelName={cur.name} onClose={() => setShowMembers(false)} />}
      {showEdit && cur && <EditChannelModal channel={cur} onClose={() => setShowEdit(false)} onDone={async () => { setShowEdit(false); await reload(); }} onDeleted={() => { setShowEdit(false); reload(); nav(`/s/${slug}/channel`); }} />}
      {ctxMenu && (() => {
        const m = ctxMenu.m;
        const close = () => setCtxMenu(null);
        const copy = (t: string) => { navigator.clipboard?.writeText(t).catch(() => {}); close(); };
        const link = `${location.origin}/s/${slug}/channel/${m.channelId}?msg=${m.id}`;
        return (
          <div className="ctx-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }}>
            <div className="ctx-menu" style={{ left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - 320) }} onClick={(e) => e.stopPropagation()}>
              <div className="ctx-rx">{QUICK_EMOJIS.slice(0, 6).map((e) => <button key={e} title={e} onClick={() => { react(m.id, e, false); close(); }}>{e}</button>)}</div>
              <button className="ctx-item" onClick={() => copy(link)}><Link2 size={14} /> {t("chat.copyLink")}</button>
              <button className="ctx-item" onClick={() => copy(m.content)}><Clipboard size={14} /> {t("chat.copyMarkdown")}</button>
              <button className="ctx-item" onClick={() => { startThread(m); close(); }}><MessageCircle size={14} /> {t("chat.openThread")}</button>
              <button className="ctx-item" onClick={() => { savedIds.has(m.id) ? unsaveMsg(m.id) : saveMsg(m.id); close(); }}><Bookmark size={14} fill={savedIds.has(m.id) ? "currentColor" : "none"} /> {savedIds.has(m.id) ? t("chat.unsave") : t("chat.saveMessage")}</button>
              <button className="ctx-item" onClick={async () => { close(); await api("POST", "/api/tasks/convert-message", { messageId: m.id }); }}><CheckSquare size={14} /> {t("chat.convertToTask")}</button>
            </div>
          </div>
        );
      })()}
      {hoverAgent && (() => {
        const a = agents.find((x) => x.id === hoverAgent.id);
        if (!a) return null;
        const live = (a.activity && a.activity !== "offline" ? a.activity : a.status) || "offline";
        return (
          <div className="agent-hovercard" style={{ left: Math.min(hoverAgent.x, window.innerWidth - 260), top: Math.min(hoverAgent.y, window.innerHeight - 120) }}>
            <Avatar seed={a.name} url={avFor(a.avatarUrl)} size={40} />
            <div className="ahc-body">
              <div className="ahc-name">{a.displayName || a.name} <span className={"dot " + live} /></div>
              <div className="ahc-handle">@{a.name}</div>
              <div className="ahc-rt">{a.runtime}{a.model ? " · " + a.model : ""}</div>
            </div>
          </div>
        );
      })()}
    </>
  );
}

// Edit-channel modal: name + description + visibility toggle + archive + delete. Replaces the old prompt()-based rename dropdown.
function EditChannelModal({ channel, onClose, onDone, onDeleted }: { channel: any; onClose: () => void; onDone: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const { api } = useStore();
  const confirm = useConfirm();
  const [name, setName] = useState(channel.name as string);
  const [desc, setDesc] = useState((channel.description ?? "") as string);
  const [saving, setSaving] = useState(false);
  const isPrivate = channel.type === "private";

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try { await api("PATCH", `/api/channels/${channel.id}`, { name: name.trim(), description: desc.trim() }); onDone(); }
    finally { setSaving(false); }
  };
  const toggleVisibility = async () => {
    await api("PATCH", `/api/channels/${channel.id}`, { visibility: isPrivate ? "public" : "private" });
    onDone();
  };
  const doArchive = async () => {
    await api("POST", `/api/channels/${channel.id}/archive`);
    onDeleted();
  };
  const doDelete = async () => {
    if (!(await confirm({ title: t("chat.deleteChannelTitle", { name: channel.name }), message: t("chat.deleteChannelMsg"), confirmLabel: t("chat.delete"), danger: true }))) return;
    await api("DELETE", `/api/channels/${channel.id}`);
    onDeleted();
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("chat.editChannel")}</h3>
        <label>{t("sidebar.fieldName")}</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sidebar.namePlaceholder")} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) save(); }} />
        <label>{t("sidebar.descLabel")}</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("sidebar.descPlaceholder")} />
        <div className="acts">
          <button className="cancel" onClick={onClose}>{t("sidebar.cancelBtn")}</button>
          <button className="ok" onClick={save} disabled={!name.trim() || saving}>{t("chat.saveChanges")}</button>
        </div>
        <hr className="ch-sep" />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="ch-act" onClick={toggleVisibility}>
            {isPrivate ? <Globe size={14} /> : <Lock size={14} />}
            {isPrivate ? t("chat.makePublic") : t("chat.makePrivate")}
          </button>
          <button className="ch-act ch-act-danger" onClick={doArchive}>
            <Archive size={14} /> {t("chat.archive")}
          </button>
          <button className="ch-act ch-act-danger" onClick={doDelete}>
            <Trash2 size={14} /> {t("chat.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Thread panel: right-side overlay showing the parent message, its replies, and a reply composer.
function ThreadPanel({ channelId, parent, onClose, onOpenProfile }: { channelId: string; parent: Msg; onClose: () => void; onOpenProfile: (type: "agent" | "human", id: string) => void }) {
  const { t } = useTranslation();
  const { api, onEvent, subscribeChannel, attachmentUrl, me, react, agents, humans, channels, slug } = useStore();
  const senderAvatar = (m: Msg) => resolveAvatar(m.senderType === "agent" ? agents.find((a) => a.id === m.senderId)?.avatarUrl : humans.find((h) => h.userId === m.senderId)?.avatarUrl, attachmentUrl);
  const nav = useNavigate();
  const navToken = async (type: string, args: string[]) => {
    if (type === "agent") return onOpenProfile("agent", args[0]!); // @agent click inside a thread opens the profile overlay (profile state is owned by the parent component)
    if (type === "human") return onOpenProfile("human", args[0]!); // @human click → profile overlay too (parent renders it on top of the thread)
    if (type === "channel") return nav(`/s/${slug}/channel/${args[0]}`);
    if (type === "thread") return nav(`/s/${slug}/channel/${args[0]}?thread=${args[0]}:${args[1]}`);
    if (type === "task") { try { const r = await api("GET", "/api/tasks/server"); const tk = (r?.tasks ?? r ?? []).find((x: any) => x.taskNumber === Number(args[0])); if (tk) nav(`/s/${slug}/channel/${tk.channelId}?msg=${tk.id}`); } catch { /* */ } }
  };
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { subscribeChannel(channelId); (async () => { const d = await api("GET", `/api/messages/channel/${channelId}?limit=200`); setMsgs(d.messages || []); })(); }, [channelId]); // join the thread room so replies arrive live (openThread/startThread do not make the socket a room member on their own)
  useEffect(() => onEvent((e) => {
    if (e.type === "message" && e.channelId === channelId) setMsgs((m) => [...m, e.message]);
    else if (e.type === "message:updated" && e.message?.channelId === channelId) setMsgs((m) => m.map((x) => (x.id === e.message.id ? { ...x, ...e.message } : x)));
  }), [channelId]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs]);
  const row = (m: Msg) => {
    if (m.senderType === "system") return <div className="msg-sys" id={"m-" + m.id} key={m.id}>{m.content}</div>; // system messages render as a banner with no avatar
    const ag = m.senderType === "agent" && m.senderId ? agents.find((a) => a.id === m.senderId) : undefined; // agent sender → avatar and name are clickable to open the profile panel
    return (
    <div className="msg" key={m.id}>
      {ag ? <span className="msg-av clickable" onClick={() => onOpenProfile("agent", m.senderId!)}><Avatar seed={m.senderName} url={senderAvatar(m)} size={32} /></span>
        : m.senderId ? <span className="msg-av clickable" onClick={() => onOpenProfile("human", m.senderId!)}><Avatar seed={m.senderName} url={senderAvatar(m)} size={32} /></span>
        : <Avatar seed={m.senderName} url={senderAvatar(m)} size={32} />}
      {/* content column reuses .msg-col (flex:1;min-width:0) like the main chat — without it a flex child defaults to min-width:auto and a long unbreakable token blows the message past this narrow thread panel */}
      <div className="msg-col">
        <div>{ag ? <span className="who clickable" onClick={() => onOpenProfile("agent", m.senderId!)}>{m.senderName}</span>
          : m.senderId ? <span className="who clickable" onClick={() => onOpenProfile("human", m.senderId!)}>{m.senderName}</span>
          : <span className="who">{m.senderName}</span>}<span className="ts">{fmtTime(m.createdAt)}</span></div>
        {!!m.content && <div className="mbody"><MessageContent content={m.content} mentions={m.mentions || []} channels={channels} nav={navToken} /></div>}
        {!!m.attachments?.length && <div className="msg-atts">{m.attachments.map((a) => <AttCard key={a.id} a={a} url={attachmentUrl(a.id)} />)}</div>}
        <Reactions m={m} mine={me?.id ?? ""} onReact={(emoji, remove) => react(m.id, emoji, remove)} />
      </div>
    </div>
    );
  };
  return (
    <aside className="thread-panel">
      <div className="thread-head"><span className="grow">{t("chat.thread")}</span>
        <button className="tp-link" title={t("chat.markDone")} onClick={async () => { await api("POST", "/api/channels/threads/done", { threadChannelId: channelId }); onClose(); }}><CheckCircle2 size={14} /></button>
        <button className="tp-link" title={t("chat.unfollowThread")} onClick={async () => { await api("POST", "/api/channels/threads/unfollow", { threadChannelId: channelId }); onClose(); }}><BellOff size={14} /></button>
        <button className="tp-link" onClick={() => nav(`/s/${slug}/channel/${parent.channelId}?msg=${parent.id}`)} title={t("chat.viewInChannel")}><ExternalLink size={14} /></button>
        <button className="tp-close" onClick={onClose} title={t("chat.close")}><X size={15} /></button></div>
      <div className="scroll" ref={scrollRef}>
        <div className="thread-parent">{row(parent)}</div>
        <div className="thread-sep">{t("chat.replyCount", { count: msgs.length })}</div>
        {msgs.map(row)}
      </div>
      {channels.find((c) => c.id === parent.channelId)?.type === "showcase"
        ? <div className="showcase-readonly"><Eye size={14} />{t("chat.showcaseReadOnly")}</div>
        : <Composer channelId={channelId} placeholder={t("chat.threadReplyPlaceholder")} className="thread-composer" />}
    </aside>
  );
}

// Channel members modal: lists Agents (with online status) and Humans; allows adding or removing agents from the channel
function ChannelMembersModal({ channelId, channelName, onClose }: { channelId: string; channelName: string; onClose: () => void }) {
  /* avatars: data.agents/humans come from /channels/:id/members (carry avatarUrl); resolve to signed/scheme via resolveAvatar */
  const { t } = useTranslation();
  useEscClose(onClose);
  const { api, visibleAgents: agents, attachmentUrl, capabilities } = useStore(); // visibleAgents: showcase demo props are not offered in the "add agent" list
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  const [data, setData] = useState<{ agents: any[]; humans: any[] }>({ agents: [], humans: [] });
  const load = async () => { const d = await api("GET", `/api/channels/${channelId}/members`); setData({ agents: d?.agents || [], humans: d?.humans || [] }); };
  useEffect(() => { load(); }, [channelId]);
  const inCh = new Set(data.agents.map((a) => a.id));
  const addable = agents.filter((a) => !inCh.has(a.id));
  const add = async (agentId: string) => { await api("POST", `/api/channels/${channelId}/members`, { agentId }); load(); };
  const remove = async (agentId: string) => { await api("DELETE", `/api/channels/${channelId}/members`, { agentId }); load(); };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3># {channelName} · {t("chat.membersCount", { count: data.agents.length + data.humans.length })}</h3>
        <div className="sec">{t("common.agents")} <span className="cnt">{data.agents.length}</span></div>
        {data.agents.map((a) => (
          <div key={a.id} className="item"><Avatar seed={a.name} url={avFor(a.avatarUrl)} size={22} /><span className="grow">{a.displayName || a.name}</span><span className={"dot " + (a.activity || a.status)} />{capabilities.manageChannels && <button className="joinbtn" onClick={() => remove(a.id)}>{t("chat.remove")}</button>}</div>
        ))}
        <div className="sec">{t("common.humans")} <span className="cnt">{data.humans.length}</span></div>
        {data.humans.map((u) => (
          <div key={u.userId} className="item"><Avatar seed={u.name} url={avFor(u.avatarUrl)} size={22} /><span className="grow">{u.displayName || u.name}</span></div>
        ))}
        {capabilities.manageChannels && addable.length > 0 && <>
          <div className="sec sec-sub">{t("chat.addAgent")}</div>
          {addable.map((a) => (
            <div key={a.id} className="item ghost"><Avatar seed={a.name} url={avFor(a.avatarUrl)} size={22} /><span className="grow">{a.displayName || a.name}</span><button className="joinbtn" onClick={() => add(a.id)}>{t("chat.join")}</button></div>
          ))}
        </>}
        <div className="acts"><button className="cancel" onClick={onClose}>{t("chat.close")}</button></div>
      </div>
    </div>
  );
}

// Channel files tab (chatTab=files): lists attachments associated with channel messages; click to download or preview
function ChannelFiles({ channelId }: { channelId: string }) {
  const { t } = useTranslation();
  const { api, attachmentUrl, slug } = useStore();
  const nav = useNavigate();
  const [files, setFiles] = useState<any[]>([]);
  useEffect(() => { (async () => { const d = await api("GET", `/api/channels/${channelId}/files`); setFiles(d?.files || []); })(); }, [channelId]);
  return (
    <div className="scroll ch-view-enter">
      {files.length === 0 ? <div className="empty">{t("chat.noFiles")}</div>
        : files.map((f) => (
          <div key={f.id} className="card file-row">
            <a className="file-main" href={attachmentUrl(f.id)} target="_blank" rel="noreferrer">
              {isImage(f.mimeType) ? <img className="file-thumb" src={attachmentUrl(f.id)} alt={f.filename} loading="lazy" /> : <IconFile size={22} />}
              <div className="grow"><div className="who">{f.filename}</div><div className="meta">{fmtSize(f.sizeBytes)} · {f.uploader?.displayName || f.uploader?.name || (f.uploader?.type === "agent" ? "agent" : t("chat.memberKind"))} · {fmtTime(f.createdAt)}</div></div>
            </a>
            <div className="file-acts">
              {f.messageId && <button title={t("chat.jumpToMessage")} onClick={() => nav(`/s/${slug}/channel/${f.channelId}?msg=${f.messageId}`)}><IconExternalLink size={14} /></button>}
              <a title={t("chat.download")} href={attachmentUrl(f.id)} download={f.filename}><IconDownload size={14} /></a>
            </div>
          </div>
        ))}
    </div>
  );
}
