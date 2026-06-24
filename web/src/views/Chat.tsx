import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent as RClipboardEvent, type DragEvent as RDragEvent } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useStore, fmtTime, type Msg, type Att } from "../store.tsx";
import { MessageContent } from "../messageRender.tsx";
import { Smile, X, ExternalLink, CheckCircle2, MessageCircle, MoreHorizontal, ImagePlus, Paperclip, Send, Link2, Clipboard, Bookmark, CheckSquare, Circle, Play, Eye, Ban, ArrowDown, BellOff, Moon, Power, Lock, Globe, Archive, Trash2 } from "lucide-react";
// Task badge per message row: icon changes with task status; color tokens from DESIGN.md (see .task-pill.st-* styles)
const TASK_ICON: Record<string, typeof Circle> = { todo: Circle, in_progress: Play, in_review: Eye, done: CheckCircle2, closed: Ban };
import { IconWrench, IconFile, IconExternalLink, IconDownload } from "../icons.tsx";
import { Avatar } from "../Avatar.tsx";
import { TaskBoard, ynOptions, ST_LABEL } from "../TaskBoard.tsx";
import { AgentProfile, CreateAgentModal } from "./Members.tsx";
import { ChatSidebar, CreateChannelModal } from "./ChatSidebar.tsx";
import { useConfirm, useEscClose } from "../ConfirmModal.tsx";

const fmtSize = (n?: number) => (!n ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB");
const isImage = (m?: string) => !!m && m.startsWith("image/");
const isVideo = (m?: string) => !!m && m.startsWith("video/");

// Image lightbox: full-screen overlay with scroll-to-zoom, drag-to-pan, double-click to reset, Esc/backdrop to close
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  return (
    <div className="lightbox-bg" onClick={onClose} onWheel={(e) => { setScale((s) => Math.min(8, Math.max(1, s - e.deltaY * 0.0016 * s))); }}>
      <button className="lightbox-x" onClick={onClose} aria-label={i18n.t("chat.close")}><X size={20} /></button>
      <img src={src} alt={alt} className="lightbox-img" draggable={false}
        style={{ transform: `translate(${pos.x}px,${pos.y}px) scale(${scale})`, cursor: scale > 1 ? (drag.current ? "grabbing" : "grab") : "zoom-in" }}
        onClick={(e) => { e.stopPropagation(); if (scale === 1) setScale(2); }}
        onDoubleClick={(e) => { e.stopPropagation(); setScale(1); setPos({ x: 0, y: 0 }); }}
        onMouseDown={(e) => { if (scale > 1) { e.preventDefault(); drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; } }}
        onMouseMove={(e) => { if (drag.current) setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
        onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }} />
    </div>
  );
}

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
        return <button key={r.emoji} className={"rx-chip" + (did ? " on" : "")} title={(r.reactorNames || []).join(", ")} onClick={() => onReact(r.emoji, !!did)}>{r.emoji} {r.count}</button>;
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
  const { createChannel, markActionExecuted, slug } = useStore();
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
      <Avatar seed={m.senderName} size={36} />
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
  const { api, channels, dms, unread, agents, humans, machines, slug, me, myRole, capabilities, reload, onEvent, subscribeChannel, openDM, markRead, uploadFiles, uploadOne, attachmentUrl, react, openThread, savedIds, saveMsg, unsaveMsg } = useStore();
  const confirm = useConfirm();
  const [showEdit, setShowEdit] = useState(false);
  const manageServer = myRole === "owner" || myRole === "admin"; // server admins get the full task-status dropdown (matches TaskBoard permission model)
  const { channelId } = useParams();
  const nav = useNavigate();
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null); // clicking an agent avatar opens the profile panel in the right column
  const [taskMenu, setTaskMenu] = useState<string | null>(null); // task badge status menu: id of the currently open message (clicking the badge changes status, does not open thread)
  const [hoverAgent, setHoverAgent] = useState<{ id: string; x: number; y: number } | null>(null); // hovering over an agent shows a quick-info hover card
  const [ctxMenu, setCtxMenu] = useState<{ m: Msg; x: number; y: number } | null>(null); // right-clicking a message opens the context action menu
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [traj, setTraj] = useState<{ name?: string; text: string; tool?: boolean }[]>([]);
  const [sub, setSub] = useState("");
  const [asTask, setAsTask] = useState(false);
  const [text, setText] = useState("");
  const [atQuery, setAtQuery] = useState<string | null>(null); // @ mention autocomplete: null = hidden
  const [atSel, setAtSel] = useState(0); // highlighted candidate index for ↑/↓ keyboard navigation in the @ menu
  const [showMembers, setShowMembers] = useState(false);
  const [pendingAtts, setPendingAtts] = useState<any[]>([]); // attachments that have been uploaded and are queued to be sent with the next message
  const [uploading, setUploading] = useState(false);
  const [thread, setThread] = useState<{ channelId: string; parent: Msg } | null>(null); // currently open thread panel
  const [threadMeta, setThreadMeta] = useState<Record<string, { threadChannelId: string; replyCount: number; unreadCount?: number }>>({}); // parent message id → thread metadata (reply count, unread count)
  const atPosRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true); // tracks whether the scroll position is at the bottom; new messages auto-scroll only when already at the bottom, preserving history browsing
  const [showJump, setShowJump] = useState(false); // when not at the bottom, show the "Back to bottom" jump button
  const cur = [...channels, ...dms].find((c) => c.id === channelId) || channels.find((c) => c.name === "all") || channels[0];
  const isDm = !!dms.find((d) => d.id === cur?.id);
  const dmPeer = dms.find((d) => d.id === cur?.id);
  const dmAgent = dmPeer?.peerType === "agent" ? agents.find((a) => a.id === dmPeer.peerId) : undefined; // DM peer agent → used for the live status indicator in the header
  const [sp, setSp] = useSearchParams();
  const chatTab = (!isDm && sp.get("chatTab")) || "chat"; // active tab within a channel: chat | tasks | files
  const msgParam = sp.get("msg"); // when present, scroll to and highlight the specified message id
  const threadParam = sp.get("thread"); // auto-open a thread panel (from inbox, in-message thread link, or cross-page link); value is the parent message id (full or 8-char short) or channelId:shortid

  useEffect(() => { if (!channelId && cur) nav(`/s/${slug}/channel/${cur.id}`, { replace: true }); }, [channelId, cur, slug, nav]);
  useEffect(() => { if (!cur) return; setThread(null); subscribeChannel(cur.id); (async () => { // join the room while viewing so message:new arrives live (covers public non-member channels + channels relevant after connect)
    const d = await api("GET", `/api/messages/channel/${cur.id}?limit=200`); const ms: Msg[] = d.messages || []; setMsgs(ms); setTraj([]); markRead(cur.id);
    const ids = ms.map((m) => m.id);
    if (ids.length) { try { setThreadMeta(await api("GET", `/api/channels/${cur.id}/threads?parentMessageIds=${ids.join(",")}`) || {}); } catch { setThreadMeta({}); } } else setThreadMeta({});
  })(); }, [cur?.id]);
  useEffect(() => onEvent((e) => {
    if (e.type === "message" && e.channelId === cur?.id) { setMsgs((m) => [...m, e.message]); markRead(cur.id); }
    else if (e.type === "message:updated" && e.message) setMsgs((m) => m.map((x) => (x.id === e.message.id ? { ...x, ...e.message } : x))); // sync reactions and task fields
    else if (e.type === "thread:updated" && e.parentMessageId) setThreadMeta((tm) => { // live reply count update; unreadCount is approximated from the replyCount delta (socket does not carry unreadCount; the authoritative value is corrected on channel switch via GET)
      const prev = tm[e.parentMessageId]; const delta = prev ? Math.max(0, e.replyCount - prev.replyCount) : 0;
      return { ...tm, [e.parentMessageId]: { threadChannelId: e.threadChannelId, replyCount: e.replyCount, unreadCount: (prev?.unreadCount ?? 0) + delta } };
    });
    else if (e.type === "trajectory") setTraj((t) => [...t, ...(e.entries || []).map((x: any) => ({ name: e.name, tool: !!x.toolName, text: x.text || (x.toolName ? `${x.toolName}${x.toolInput ? " — " + x.toolInput : ""}` : "") || x.detail || "" }))]);
    else if (e.type === "agent") setSub(e.activity ? `${e.name} · ${e.activity}${e.detail ? " · " + e.detail : ""}` : "");
  }), [cur?.id]);
  useEffect(() => { const el = scrollRef.current; if (!el || msgParam) return; if (atBottomRef.current) el.scrollTop = el.scrollHeight; }, [msgs, msgParam]); // auto-scroll only when already pinned to the bottom
  useEffect(() => { atBottomRef.current = true; setShowJump(false); }, [cur?.id]); // reset bottom-pin state on channel switch
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; atBottomRef.current = true; setShowJump(false); };
  const onScroll = () => { const el = scrollRef.current; if (!el) return; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120; atBottomRef.current = near; setShowJump(!near); };
  useEffect(() => { const el = inputRef.current; if (!el) return; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; }, [text]); // composer textarea auto-grows up to 160px max height
  useEffect(() => { // scroll to and highlight the target message for 2s when msgParam is set
    if (!msgParam || chatTab !== "chat") return;
    const el = document.getElementById("m-" + msgParam);
    if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("msg-hl"); const t = setTimeout(() => el.classList.remove("msg-hl"), 2200); return () => clearTimeout(t); }
  }, [msgParam, msgs, chatTab]);
  useEffect(() => { // ?thread= auto-opens the thread panel: finds the parent message (full id or 8-char short id) in the loaded list and calls startThread; each threadParam is only opened once
    if (!threadParam || !msgs.length) return;
    if (thread) return; // panel already open, do not re-open
    const short = threadParam.includes(":") ? threadParam.split(":").pop()! : threadParam;
    const m = msgs.find((x) => x.id === threadParam || x.id.startsWith(short));
    if (m) startThread(m);
    // eslint-disable-next-line
  }, [threadParam, msgs]);

  const send = async (forceTask?: boolean) => {
    const v = text.trim(); if ((!v && !pendingAtts.length) || !cur) return;
    const t = forceTask ?? asTask; // ⌘/Ctrl+Shift+Enter forces the message to be sent as a task, independent of the checkbox state
    setText(""); setAtQuery(null); setAsTask(false);
    const ids = pendingAtts.filter((a) => a.status === "done" || !a.status).map((a) => a.id); setPendingAtts([]); // only include fully uploaded attachments
    await api("POST", "/api/messages", { channelId: cur.id, content: v, asTask: t, attachmentIds: ids });
  };
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => { if (e.target.files?.length) addFiles(Array.from(e.target.files)); e.target.value = ""; };
  // Upload with progress state: each file is first pushed as a placeholder (images get a localUrl preview + "uploading" status) → uploadOne updates progress in real time → on success, the placeholder is replaced with the real attachment (thumbnail + checkmark); on failure, status is set to "error". Paste accepts only images; drag-and-drop accepts all file types.
  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files); if (!arr.length || !cur) return;
    for (const f of arr) {
      const tmpId = "tmp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      const localUrl = f.type.startsWith("image/") ? URL.createObjectURL(f) : "";
      setPendingAtts((p) => [...p, { id: tmpId, filename: f.name, mimeType: f.type, localUrl, status: "uploading", progress: 0 }]);
      try {
        const att = await uploadOne(cur.id, f, (pct) => setPendingAtts((p) => p.map((x) => (x.id === tmpId ? { ...x, progress: pct } : x))));
        setPendingAtts((p) => p.map((x) => (x.id === tmpId ? { ...x, ...att, localUrl, status: "done", progress: 100 } : x)));
      } catch { setPendingAtts((p) => p.map((x) => (x.id === tmpId ? { ...x, status: "error" } : x))); }
    }
  };
  const onPaste = (e: RClipboardEvent) => { const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/")).map((f, i) => new File([f], `pasted-${Date.now()}${i ? "-" + i : ""}.${f.type.split("/")[1] || "png"}`, { type: f.type })); if (imgs.length) { e.preventDefault(); addFiles(imgs); } };
  const onDrop = (e: RDragEvent) => { const fs = Array.from(e.dataTransfer?.files ?? []); if (fs.length) { e.preventDefault(); addFiles(fs); } };
  const setTab = (t: string) => { const n = new URLSearchParams(sp); if (t === "chat") n.delete("chatTab"); else n.set("chatTab", t); setSp(n, { replace: true }); };
  const doDM = async (agentId: string) => { const id = await openDM("agent", agentId); if (id) nav(`/s/${slug}/channel/${id}`); }; // used by AgentProfile onMessage callback
  const startThread = async (m: Msg) => { if (!cur) return; const tid = threadMeta[m.id]?.threadChannelId || await openThread(cur.id, m.id); if (tid) { setThread({ channelId: tid, parent: m }); setThreadMeta((tm) => (tm[m.id] ? { ...tm, [m.id]: { ...tm[m.id]!, unreadCount: 0 } } : tm)); markRead(tid); } }; // opening a thread clears the unread count optimistically and marks the thread channel as read
  // Returns the display name of the task assignee, used by the task pill
  const taskAssignee = (m: Msg) => { if (!m.taskAssigneeId) return ""; const a = agents.find((x) => x.id === m.taskAssigneeId); if (a) return " @" + (a.displayName || a.name); const h = humans.find((x) => x.userId === m.taskAssigneeId); return h ? " @" + (h.displayName || h.name) : ""; };
  // Handles task status change / claim from the task badge; socket message:updated event refreshes the message automatically
  const doTask = async (m: Msg, action: string, body?: unknown) => { try { await api("PATCH", `/api/tasks/${m.id}/${action}`, body); } catch { /* will self-correct on next reload */ } };
  // Routes inline token clicks (@mention / #channel / thread / task #N) inside MessageContent
  const navToken = async (type: string, args: string[]) => {
    if (type === "agent") return setProfileAgentId(args[0]);
    if (type === "human") return nav(`/s/${slug}/human/${args[0]}`); // @human click → member profile page
    if (type === "channel") return nav(`/s/${slug}/channel/${args[0]}`);
    if (type === "thread") return nav(`/s/${slug}/channel/${args[0]}?thread=${args[0]}:${args[1]}`);
    if (type === "task") {
      const num = Number(args[0]);
      const local = msgs.find((x) => x.taskNumber === num);
      if (local && cur) return nav(`/s/${slug}/channel/${cur.id}?msg=${local.id}`);
      try { const r = await api("GET", "/api/tasks/server"); const tk = (r?.tasks ?? r ?? []).find((x: any) => x.taskNumber === num); if (tk) nav(`/s/${slug}/channel/${tk.channelId}?msg=${tk.id}`); } catch { /* */ }
    }
  };

  // @ mention autocomplete: candidates are all workspace agents + humans (not just current channel members) —
  // in a public channel, @-ing a non-member pulls them in (server-side auto-join), so suggesting them is intended.
  const onInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value; setText(v);
    const pos = e.target.selectionStart ?? v.length;
    const m = /@([\p{L}\p{N}_-]*)$/u.exec(v.slice(0, pos)); // same Unicode character class as the messageRender side (\p{L}), supports CJK and diacritic names
    if (m) { setAtQuery(m[1]); atPosRef.current = pos - m[0].length; } else setAtQuery(null);
    setAtSel(0); // typing narrows the list → restart highlight at the top
  };
  const cands = atQuery === null ? [] : [
    ...agents.map((a) => ({ name: a.name, label: a.displayName || a.name, kind: "agent" })),
    ...humans.map((h) => ({ name: h.name, label: h.displayName || h.name, kind: "human" })),
  ].filter((c) => c.name && c.name.toLowerCase().includes((atQuery || "").toLowerCase())).slice(0, 8);
  const pick = (c: { name: string }) => {
    const start = atPosRef.current;
    const after = text.slice(start + 1 + (atQuery?.length ?? 0));
    setText(text.slice(0, start) + "@" + c.name + " " + after);
    setAtQuery(null); setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <>
      <ChatSidebar />
      <main className="content-col">
        <div className="head">
          <h1>{isDm ? "@ " + (cur?.name || "") : "# " + (cur?.name || "…")}</h1>
          {dmAgent
            ? <span className="head-status"><span className={"dot " + (dmAgent.activity || "offline")} />{dmAgent.activityDetail || dmAgent.activity || "offline"}</span>
            : <small>{sub || cur?.description || ""}</small>}
          {!isDm && cur && <div className="chtabs">{["chat", "tasks", "files"].map((tt) => <button key={tt} className={chatTab === tt ? "on" : ""} onClick={() => setTab(tt)}>{tt === "chat" ? t("nav.channel") : tt === "tasks" ? t("nav.tasks") : t("common.files")}</button>)}</div>}
          {!isDm && cur && <button className="joinbtn" style={{ marginLeft: "auto" }} title={t("chat.channelMembers")} onClick={() => setShowMembers(true)}>{t("chat.members")}</button>}
          {!isDm && cur && capabilities.manageChannels && (
            <button className="joinbtn" title={t("chat.channelSettings")} onClick={() => setShowEdit(true)}>⋯</button>
          )}
        </div>
        {machines.length === 0 && capabilities.manageMachines && (
          <div className="onboard-banner">
            <span>{t("chat.noComputerBanner")}</span>
            <button onClick={() => nav(`/s/${slug}/computer`)}>{t("chat.connectComputer")}</button>
          </div>
        )}
        {chatTab === "tasks" && cur ? <TaskBoard channelId={cur.id} onOpenThread={startThread} />
          : chatTab === "files" && cur ? <ChannelFiles channelId={cur.id} />
          : <>
            <div className="scroll" ref={scrollRef} onScroll={onScroll}>
              {msgs.map((m) => {
                const ag = m.senderType === "agent" && m.senderId ? agents.find((a) => a.id === m.senderId) : undefined; // used for role description and avatar status dot
                const tm = threadMeta[m.id];
                const isMember = m.senderType !== "agent" && m.senderType !== "system"; // human/user senders get a "member" badge
                // action card (agent proposal card) → rendered by dedicated ActionCardMsg component
                if (m.messageType === "action" && m.actionMetadata?.kind === "action-card") return <ActionCardMsg m={m} key={m.id} />;
                // system messages (task lifecycle events, etc.) → centered grey bar (no avatar, no full message block)
                if (m.senderType === "system") return <div className="msg-sys" id={"m-" + m.id} key={m.id}>{m.content}</div>;
                return (
                <div className="msg" id={"m-" + m.id} key={m.id} onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ m, x: e.clientX, y: e.clientY }); }}>
                  <div className="msg-toolbar">
                    <button title={t("chat.emojiActions")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ m, x: r.left - 180, y: r.bottom + 4 }); }}><Smile size={15} /></button>
                    <button title={t("chat.openThread")} onClick={() => startThread(m)}><MessageCircle size={15} /></button>
                    <button title={t("chat.more")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxMenu({ m, x: r.right - 212, y: r.bottom + 4 }); }}><MoreHorizontal size={15} /></button>
                  </div>
                  {ag
                    ? <span className="msg-av clickable" onClick={() => setProfileAgentId(m.senderId!)}
                        onMouseEnter={(e) => setHoverAgent({ id: m.senderId!, x: e.currentTarget.getBoundingClientRect().right + 8, y: e.currentTarget.getBoundingClientRect().top })}
                        onMouseLeave={() => setHoverAgent(null)}><Avatar seed={m.senderName} size={36} />{ag.activity && ag.activity !== "offline" && <span className={"av-status " + ag.activity} />}</span>
                    : <Avatar seed={m.senderName} size={36} />}
                  <div className="msg-col">
                    <div className="msg-head">
                      {ag
                        ? <span className="who clickable" onClick={() => setProfileAgentId(m.senderId!)}
                            onMouseEnter={(e) => setHoverAgent({ id: m.senderId!, x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 6 })}
                            onMouseLeave={() => setHoverAgent(null)}>{m.senderName}</span>
                        : <span className="who">{m.senderName}</span>}
                      {ag?.description ? <span className="msg-role">{ag.description}</span> : isMember ? <span className="member-badge">member</span> : null}
                      <span className="ts">{fmtTime(m.createdAt)}</span></div>
                    {!!m.content && <div className="mbody"><MessageContent content={m.content} mentions={m.mentions || []} channels={channels} nav={navToken} /></div>}
                    {!!m.attachments?.length && <div className="msg-atts">{m.attachments.map((a) => <AttCard key={a.id} a={a} url={attachmentUrl(a.id)} />)}</div>}
                    {/* persistent meta row: task badge + thread button + reactions all on the same line (reactions no longer occupy a separate row) */}
                    <div className="msg-meta">
                        {m.taskStatus && (() => {
                          const TI = TASK_ICON[m.taskStatus] || Circle;
                          const claimable = !m.taskAssigneeId && m.taskStatus === "todo";
                          const claimedByMe = m.taskAssigneeType === "user" && m.taskAssigneeId === me?.id;
                          const opts = ynOptions(m.taskStatus, manageServer, claimedByMe);
                          const open = taskMenu === m.id;
                          return (
                            <span className="task-pill-wrap">
                              {/* clicking the badge changes status (does not open thread; use the reply / thread button for that) */}
                              <button className={"task-pill st-" + m.taskStatus} onClick={(e) => { e.stopPropagation(); setTaskMenu(open ? null : m.id); }} title={t("chat.taskChangeStatus", { number: m.taskNumber })}><TI size={11} /> #{m.taskNumber} {ST_LABEL[m.taskStatus] ?? m.taskStatus}{taskAssignee(m)}</button>
                              {open && <div className="st-menu" onMouseLeave={() => setTaskMenu(null)}>
                                {claimable && <button onClick={() => { setTaskMenu(null); doTask(m, "claim"); }}>{t("chat.claim")}</button>}
                                {opts.map((s) => <button key={s} className={s === m.taskStatus ? "on" : ""} onClick={() => { setTaskMenu(null); if (s !== m.taskStatus) doTask(m, "status", { status: s }); }}><span className={"st-dot st-" + s} />{ST_LABEL[s]}</button>)}
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
            <div className="composer">
              {isDm && dmAgent && (() => {
                // Wake-state hint: sending a message to a sleeping agent causes the backend to wake it up (resuming the previous session), but the user should be informed; if the machine is offline the wake-up has no effect and the message is queued.
                const mc = machines.find((m) => m.id === dmAgent.machineId);
                const offline = !dmAgent.machineId || mc?.status !== "online";
                const st = dmAgent.activity || dmAgent.status;
                const nm = dmAgent.displayName || dmAgent.name;
                if (offline) return <div className="wake-hint wh-off"><Power size={13} /> {t("chat.machineOffline", { name: nm })}</div>;
                if (st === "sleeping" || st === "inactive" || st === "offline") return <div className="wake-hint"><Moon size={13} /> {t("chat.agentSleeping", { name: nm })}</div>;
                return null;
              })()}
              {atQuery !== null && cands.length > 0 && (
                <div className="mention-menu">
                  {cands.map((c, i) => (
                    <button key={c.kind + c.name} className={"mention-opt" + (i === atSel ? " sel" : "")} aria-selected={i === atSel}
                      onMouseEnter={() => setAtSel(i)} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
                      <Avatar seed={c.name} size={22} />
                      <span className="grow">{c.label} <span className="mk-name">@{c.name}</span></span>
                      <span className="mk">{c.kind === "agent" ? "agent" : t("chat.memberKind")}</span>
                    </button>
                  ))}
                </div>
              )}
              {pendingAtts.length > 0 && <div className="pending-atts">{pendingAtts.map((a) => {
                const img = isImage(a.mimeType);
                const src = a.localUrl || (a.status !== "uploading" ? attachmentUrl(a.id) : "");
                return <span key={a.id} className={"patt" + (img ? " patt-img" : "") + (a.status ? " st-" + a.status : "")} title={a.filename}>
                  {img && src ? <img src={src} alt={a.filename} /> : <><IconFile size={13} />{!img && a.filename}</>}
                  {a.status === "uploading" && <span className="patt-prog" style={{ ["--pct" as string]: (a.progress || 0) + "%" } as React.CSSProperties}>{a.progress || 0}%</span>}
                  {a.status === "done" && <span className="patt-ok"><CheckCircle2 size={13} /></span>}
                  {a.status === "error" && <span className="patt-err">!</span>}
                  <button onClick={() => setPendingAtts((p) => p.filter((x) => x.id !== a.id))}>×</button>
                </span>;
              })}</div>}
              <input type="file" ref={imgRef} accept="image/*" multiple style={{ display: "none" }} onChange={onPickFiles} />
              <input type="file" ref={fileRef} multiple style={{ display: "none" }} onChange={onPickFiles} />
              <div className="composer-box" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
                <textarea className="composer-input" ref={inputRef} rows={1} value={text} onChange={onInput} onPaste={onPaste}
                  placeholder={asTask ? t("chat.taskPlaceholder") : isDm ? t("chat.dmPlaceholder", { name: cur?.name }) : t("chat.channelPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return; // IME composition in progress (CJK input): Enter is for candidate selection, not send
                    if (atQuery !== null && cands.length) { // @ menu open: ↑/↓ move the highlight, Enter/Tab pick it, Esc closes
                      if (e.key === "ArrowDown") { e.preventDefault(); setAtSel((i) => Math.min(i + 1, cands.length - 1)); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setAtSel((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(cands[Math.min(atSel, cands.length - 1)]!); return; }
                      if (e.key === "Escape") { e.preventDefault(); setAtQuery(null); return; }
                    }
                    if (e.key === "Enter") {
                      if ((e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); send(true); return; } // ⌘/Ctrl+Shift+Enter sends as a task
                      if (e.shiftKey) return; // Shift+Enter inserts a line break
                      e.preventDefault(); send(); // Enter sends
                    }
                  }} />
                <div className="composer-bar">
                  <div className="cb-left">
                    <button className="cb-icon" title={t("chat.uploadImage")} disabled={uploading} onClick={() => imgRef.current?.click()}><ImagePlus size={16} /></button>
                    <button className="cb-icon" title={t("chat.uploadFile")} disabled={uploading} onClick={() => fileRef.current?.click()}><Paperclip size={16} /></button>
                  </div>
                  <div className="cb-right">
                    <label className={"astask" + (asTask ? " on" : "")} title={t("chat.sendAsTaskTitle")}><input type="checkbox" checked={asTask} onChange={(e) => setAsTask(e.target.checked)} />{t("chat.asTask")}</label>
                    <button className="send-btn" title={t("chat.sendTitle")} disabled={!text.trim() && !pendingAtts.length} onClick={() => send()}><Send size={15} /></button>
                  </div>
                </div>
              </div>
            </div>
          </>}
      </main>
      {thread
        ? <ThreadPanel channelId={thread.channelId} parent={thread.parent} onClose={() => setThread(null)} onOpenProfile={setProfileAgentId} />
        : <aside className="traj-col">
        {profileAgentId
          ? <AgentProfile id={profileAgentId} onDeleted={() => setProfileAgentId(null)} onClose={() => setProfileAgentId(null)} onMessage={() => { const a = profileAgentId; setProfileAgentId(null); doDM(a); }} />
          : <>
              <h2>{t("chat.agentLiveTrace")}</h2>
              {traj.length === 0
                ? <div className="hint">{t("chat.agentTraceHint")}</div>
                : traj.map((t, i) => <div className={"traj" + (t.tool ? " tool" : "")} key={i}>{t.tool && <IconWrench size={12} />}{t.name ? "@" + t.name + " · " : ""}{t.text}</div>)}
            </>}
      </aside>}
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
            <Avatar seed={a.name} size={40} />
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
function ThreadPanel({ channelId, parent, onClose, onOpenProfile }: { channelId: string; parent: Msg; onClose: () => void; onOpenProfile: (id: string) => void }) {
  const { t } = useTranslation();
  const { api, onEvent, subscribeChannel, attachmentUrl, me, react, agents, humans, channels, slug } = useStore();
  const nav = useNavigate();
  const navToken = async (type: string, args: string[]) => {
    if (type === "agent") return onOpenProfile(args[0]!); // @agent click inside a thread also opens the profile panel (profile state is owned by the parent component)
    if (type === "human") return nav(`/s/${slug}/human/${args[0]}`); // @human click → member profile page
    if (type === "channel") return nav(`/s/${slug}/channel/${args[0]}`);
    if (type === "thread") return nav(`/s/${slug}/channel/${args[0]}?thread=${args[0]}:${args[1]}`);
    if (type === "task") { try { const r = await api("GET", "/api/tasks/server"); const tk = (r?.tasks ?? r ?? []).find((x: any) => x.taskNumber === Number(args[0])); if (tk) nav(`/s/${slug}/channel/${tk.channelId}?msg=${tk.id}`); } catch { /* */ } }
  };
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = taRef.current; if (!el) return; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px"; }, [text]); // thread reply textarea auto-grows
  useEffect(() => { subscribeChannel(channelId); (async () => { const d = await api("GET", `/api/messages/channel/${channelId}?limit=200`); setMsgs(d.messages || []); })(); }, [channelId]); // join the thread room so replies arrive live (openThread/startThread do not make the socket a room member on their own)
  useEffect(() => onEvent((e) => {
    if (e.type === "message" && e.channelId === channelId) setMsgs((m) => [...m, e.message]);
    else if (e.type === "message:updated" && e.message?.channelId === channelId) setMsgs((m) => m.map((x) => (x.id === e.message.id ? { ...x, ...e.message } : x)));
  }), [channelId]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs]);
  const send = async () => { const v = text.trim(); if (!v) return; setText(""); await api("POST", "/api/messages", { channelId, content: v }); };
  const row = (m: Msg) => {
    if (m.senderType === "system") return <div className="msg-sys" id={"m-" + m.id} key={m.id}>{m.content}</div>; // system messages render as a banner with no avatar
    const ag = m.senderType === "agent" && m.senderId ? agents.find((a) => a.id === m.senderId) : undefined; // agent sender → avatar and name are clickable to open the profile panel
    return (
    <div className="msg" key={m.id}>
      {ag ? <span className="msg-av clickable" onClick={() => onOpenProfile(m.senderId!)}><Avatar seed={m.senderName} size={32} /></span> : <Avatar seed={m.senderName} size={32} />}
      {/* content column reuses .msg-col (flex:1;min-width:0) like the main chat — without it a flex child defaults to min-width:auto and a long unbreakable token blows the message past this narrow thread panel */}
      <div className="msg-col">
        <div>{ag ? <span className="who clickable" onClick={() => onOpenProfile(m.senderId!)}>{m.senderName}</span> : <span className="who">{m.senderName}</span>}<span className="ts">{fmtTime(m.createdAt)}</span></div>
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
      <div className="composer thread-composer">
        <div className="composer-box">
          <textarea className="composer-input" ref={taRef} rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("chat.threadReplyPlaceholder")}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { if (e.shiftKey) return; e.preventDefault(); send(); } }} />
          <div className="composer-bar">
            <span className="grow" />
            <button className="send-btn" title={t("chat.sendTitle")} disabled={!text.trim()} onClick={send}><Send size={15} /></button>
          </div>
        </div>
      </div>
    </aside>
  );
}

// Channel members modal: lists Agents (with online status) and Humans; allows adding or removing agents from the channel
function ChannelMembersModal({ channelId, channelName, onClose }: { channelId: string; channelName: string; onClose: () => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const { api, agents } = useStore();
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
          <div key={a.id} className="item"><Avatar seed={a.name} size={22} /><span className="grow">{a.displayName || a.name}</span><span className={"dot " + (a.activity || a.status)} /><button className="joinbtn" onClick={() => remove(a.id)}>{t("chat.remove")}</button></div>
        ))}
        <div className="sec">{t("common.humans")} <span className="cnt">{data.humans.length}</span></div>
        {data.humans.map((u) => (
          <div key={u.userId} className="item"><Avatar seed={u.name} size={22} /><span className="grow">{u.displayName || u.name}</span></div>
        ))}
        {addable.length > 0 && <>
          <div className="sec sec-sub">{t("chat.addAgent")}</div>
          {addable.map((a) => (
            <div key={a.id} className="item ghost"><Avatar seed={a.name} size={22} /><span className="grow">{a.displayName || a.name}</span><button className="joinbtn" onClick={() => add(a.id)}>{t("chat.join")}</button></div>
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
    <div className="scroll">
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
