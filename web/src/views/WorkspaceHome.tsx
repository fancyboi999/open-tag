import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Activity, ArrowUpDown, Bell, Bookmark, ChevronDown, ChevronRight, Lock, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, resolveAvatar } from "../Avatar.tsx";
import { ServerSwitcher } from "../ServerSwitcher.tsx";
import { useAppShell } from "../AppShell.tsx";
import { useStore } from "../store.tsx";
import { useToast } from "../toast.tsx";
import { channelCreateErrorMsg, CreateChannelModal } from "./ChatSidebar.tsx";

export function WorkspaceHome() {
  const { mode } = useAppShell();
  const { t } = useTranslation();
  const nav = useNavigate();
  const toast = useToast();
  const { api, serverId, slug, channels, dms, unread, savedIds, capabilities, joinChannel, createChannel, agents, attachmentUrl } = useStore();
  const [pinned, setPinned] = useState<string[]>([]);
  const [open, setOpen] = useState({ pinned: true, joinable: false, channels: true, dms: true });
  const [sortAscending, setSortAscending] = useState({ joinable: false, channels: false, dms: false });
  const [creatingChannel, setCreatingChannel] = useState(false);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!serverId) return;
    let current = true;
    api("GET", `/api/servers/${serverId}/sidebar-order`)
      .then((result) => { if (current) setPinned(result?.pinnedChannelIds || []); })
      .catch(() => { if (current) setPinned([]); });
    return () => { current = false; };
  }, [serverId]);

  const joined = useMemo(() => channels.filter((channel) => channel.joined && channel.type !== "showcase"), [channels]);
  const joinable = useMemo(() => channels.filter((channel) => !channel.joined && channel.type !== "showcase"), [channels]);
  const pinnedChannels = useMemo(() => pinned.map((id) => joined.find((channel) => channel.id === id)).filter(Boolean) as typeof joined, [joined, pinned]);
  const regularChannels = useMemo(() => joined.filter((channel) => !pinned.includes(channel.id)), [joined, pinned]);
  const orderedJoinable = useMemo(() => sortAscending.joinable ? [...joinable].sort((a, b) => a.name.localeCompare(b.name)) : joinable, [joinable, sortAscending.joinable]);
  const orderedChannels = useMemo(() => sortAscending.channels ? [...regularChannels].sort((a, b) => a.name.localeCompare(b.name)) : regularChannels, [regularChannels, sortAscending.channels]);
  const orderedDms = useMemo(() => sortAscending.dms ? [...dms].sort((a, b) => (a.peerDisplayName || a.peerName || "").localeCompare(b.peerDisplayName || b.peerName || "")) : dms, [dms, sortAscending.dms]);
  const totalUnread = Object.values(unread).reduce((total, count) => total + count, 0);
  const avatarUrl = (url?: string | null) => resolveAvatar(url, attachmentUrl);
  const toggle = (section: keyof typeof open) => setOpen((state) => ({ ...state, [section]: !state[section] }));
  const toggleSort = (section: keyof typeof sortAscending) => setSortAscending((state) => ({ ...state, [section]: !state[section] }));
  const closeCreate = () => { setCreatingChannel(false); requestAnimationFrame(() => createTriggerRef.current?.focus()); };
  const create = async (options: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => {
    const result = await createChannel(options);
    if (result?.id) { setCreatingChannel(false); nav(`/s/${slug}/channel/${result.id}`); }
    else toast.error(channelCreateErrorMsg(t, result?.error));
  };
  const actions = (section: keyof typeof sortAscending, allowCreate = false) => <>
    <button type="button" aria-label={t("workspaceHome.sortSection")} aria-pressed={sortAscending[section]} onClick={() => toggleSort(section)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleSort(section); } }}><ArrowUpDown size={15} /></button>
    {allowCreate && capabilities.manageChannels && <button type="button" aria-label={t("workspaceHome.createChannel")} onClick={(event) => { createTriggerRef.current = event.currentTarget; setCreatingChannel(true); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); createTriggerRef.current = event.currentTarget; setCreatingChannel(true); } }}><Plus size={17} /></button>}
  </>;

  if (mode === "classic" || !mobile) return <Navigate to={`/s/${slug}/channel`} replace />;

  const channelRow = (channel: (typeof channels)[number], pinnedRow = false) => (
    <button key={channel.id} type="button" className="mobile-home-row" onClick={() => nav(`/s/${slug}/channel/${channel.id}`)}>
      <span className="mobile-home-row-icon" aria-hidden="true">{channel.type === "private" ? <Lock size={15} /> : "#"}</span>
      <span className="mobile-home-row-label">{channel.name}</span>
      {pinnedRow && <span className="mobile-home-meta">{t("workspaceHome.pinned")}</span>}
      {!!unread[channel.id] && <span className="mobile-home-badge" aria-label={t("workspaceHome.unreadCount", { count: unread[channel.id] })}>{unread[channel.id]}</span>}
    </button>
  );

  return (
    <main className="workspace-home" aria-labelledby="workspace-home-title">
      <header className="workspace-home-header">
        <h1 id="workspace-home-title" className="sr-only">{t("workspaceHome.title")}</h1>
        <ServerSwitcher variant="mobile" />
        <button type="button" className="workspace-home-alert" aria-label={t("nav.inbox")} onClick={() => nav(`/s/${slug}/inbox`)}><Bell size={18} />{totalUnread > 0 && <span className="workspace-home-alert-dot" aria-hidden="true" />}</button>
      </header>
      <div className="workspace-home-scroll">
        <nav className="workspace-home-shortcuts" aria-label={t("workspaceHome.shortcuts") }>
          <button type="button" className="mobile-home-row" onClick={() => nav(`/s/${slug}/search`)}><Search size={17} /><span className="mobile-home-row-label">{t("nav.search")}</span></button>
          <button type="button" className="mobile-home-row" onClick={() => nav(`/s/${slug}/inbox`)}><Activity size={17} /><span className="mobile-home-row-label">{t("workspaceHome.activity")}</span>{totalUnread > 0 && <span className="mobile-home-meta">{totalUnread}</span>}</button>
          <button type="button" className="mobile-home-row" onClick={() => nav(`/s/${slug}/saved`)}><Bookmark size={16} /><span className="mobile-home-row-label">{t("common.saved")}</span>{savedIds.size > 0 && <span className="mobile-home-meta">{savedIds.size}</span>}</button>
        </nav>

        <HomeSection label={t("workspaceHome.pinnedSection")} count={pinnedChannels.length} open={open.pinned} onToggle={() => toggle("pinned")}>
          {pinnedChannels.length ? pinnedChannels.map((channel) => channelRow(channel, true)) : <p className="workspace-home-hint">{t("workspaceHome.pinnedHint")}</p>}
        </HomeSection>

        <HomeSection label={t("workspaceHome.joinableSection")} count={joinable.length} open={open.joinable} onToggle={() => toggle("joinable")} action={actions("joinable", true)}>
          {orderedJoinable.map((channel) => <button key={channel.id} type="button" className="mobile-home-row" onClick={() => joinChannel(channel.id)}><span className="mobile-home-row-icon" aria-hidden="true">#</span><span className="mobile-home-row-label">{channel.name}</span><span className="mobile-home-join">{t("sidebar.joinBtn")}</span></button>)}
        </HomeSection>

        <HomeSection label={t("common.channels")} count={regularChannels.length} open={open.channels} onToggle={() => toggle("channels")} action={actions("channels", true)}>
          {orderedChannels.map((channel) => channelRow(channel))}
        </HomeSection>

        <HomeSection label={t("common.directMessages")} count={dms.length} open={open.dms} onToggle={() => toggle("dms")} action={actions("dms")}>
          {orderedDms.map((dm) => {
            const agent = dm.peerType === "agent" ? agents.find((candidate) => candidate.id === dm.peerId) : undefined;
            return <button key={dm.id} type="button" className="mobile-home-row mobile-home-dm" onClick={() => nav(`/s/${slug}/channel/${dm.id}`)}><Avatar seed={dm.peerDisplayName || dm.peerName || dm.id} url={avatarUrl(dm.peerAvatarUrl)} size={22} /><span className="mobile-home-row-label">{dm.peerDisplayName || dm.peerName || t("sidebar.unknownUser")}</span>{agent && <span className={`dot ${agent.activity || "offline"}`} aria-label={t("members.statusLabel", { status: agent.activity || "offline" })} />}{!!unread[dm.id] && <span className="mobile-home-badge" aria-label={t("workspaceHome.unreadCount", { count: unread[dm.id] })}>{unread[dm.id]}</span>}</button>;
          })}
        </HomeSection>
      </div>
      {creatingChannel && <CreateChannelModal onCreate={create} onClose={closeCreate} />}
    </main>
  );
}

function HomeSection({ label, count, open, onToggle, action, children }: { label: string; count: number; open: boolean; onToggle: () => void; action?: ReactNode; children: ReactNode }) {
  return <section className="workspace-home-section">
    <div className="workspace-home-section-head">
      <button type="button" className="workspace-home-section-toggle" aria-expanded={open} onClick={onToggle}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>{label}</span><span className="mobile-home-meta">{count}</span></button>
      {action && <div className="workspace-home-section-actions">{action}</div>}
    </div>
    {open && <div>{children}</div>}
  </section>;
}
