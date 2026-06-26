import { useState, useEffect } from "react";
import { Pin, Bookmark, Check, Eye } from "lucide-react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "../store.tsx";
import { Avatar, resolveAvatar } from "../Avatar.tsx";
import { useEscClose } from "../ConfirmModal.tsx";
import { LiveAgentBar } from "./LiveAgentBar.tsx";

// Shared chat sidebar (Saved/Channels/DMs share the same sidebar; persists unchanged when switching between the channel view and the Saved view).
// Both the Chat view and the Saved view (misc.tsx) render this component so the channel list stays visible when navigating to Saved.
export function ChatSidebar() {
  const { t } = useTranslation();
  const { api, serverId, channels, dms, unread, agents, visibleAgents, slug, savedIds, capabilities, createChannel, openDM, joinChannel, attachmentUrl } = useStore();
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  const { channelId } = useParams();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [pinned, setPinned] = useState<string[]>([]);
  const [mkChan, setMkChan] = useState(false);
  const [dmPick, setDmPick] = useState(false);
  const onSaved = pathname.endsWith("/saved");

  const allJoined = channels.filter((c: any) => c.joined);
  const showcaseChans = channels.filter((c: any) => c.type === "showcase");
  const otherChans = channels.filter((c: any) => !c.joined && c.type !== "showcase");
  const pinnedChans = pinned.map((id) => allJoined.find((c) => c.id === id)).filter(Boolean) as typeof allJoined;
  const joinedChans = allJoined.filter((c) => !pinned.includes(c.id));
  const togglePin = async (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
    setPinned(next);
    try { await api("PUT", `/api/servers/${serverId}/sidebar-order`, { pinnedChannelIds: next }); } catch { /* rollback deferred to next load */ }
  };
  useEffect(() => { if (!serverId) return; api("GET", `/api/servers/${serverId}/sidebar-order`).then((p) => setPinned(p?.pinnedChannelIds || [])).catch(() => {}); }, [serverId]);
  const doCreate = async (opts: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => { const r = await createChannel(opts); setMkChan(false); if (r?.id) nav(`/s/${slug}/channel/${r.id}`); };
  const doDM = async (agentId: string) => { const id = await openDM("agent", agentId); setDmPick(false); if (id) nav(`/s/${slug}/channel/${id}`); };

  const chanRow = (c: any) => (
    <div key={c.id} className={"item chan-row" + (c.id === channelId ? " active" : "")} onClick={() => nav(`/s/${slug}/channel/${c.id}`)}>
      <span className="grow"># {c.name}</span>
      <button className={"pinbtn" + (pinned.includes(c.id) ? " on" : "")} title={pinned.includes(c.id) ? t("sidebar.unpinChannel") : t("sidebar.pinChannel")} onClick={(e) => { e.stopPropagation(); togglePin(c.id); }}><Pin size={12} /></button>
      {!!unread[c.id] && <span className="badge">{unread[c.id]}</span>}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="sb-scroll">
      <div className="sb-title">{t("nav.channel")}</div>
      <div className={"item nav-row" + (onSaved ? " active" : "")} onClick={() => nav(`/s/${slug}/saved`)}>
        <span className="grow"><Bookmark size={14} style={{ verticalAlign: "-2px" }} /> {t("common.saved")}</span>
        {savedIds.size > 0 && <span className="badge">{savedIds.size}</span>}
      </div>
      {/* Showcase pinned to the very top: it's a read-only demo (browsed a few times, then ignored). Kept above
          Channels/DMs by product call so the two high-traffic sections stay adjacent and uninterrupted. */}
      {showcaseChans.length > 0 && <>
        <div className="sec sec-sub">{t("sidebar.showcaseSection")}</div>
        {showcaseChans.map((c) => (
          <div key={c.id} className={"item" + (c.id === channelId ? " active" : "")} style={{ cursor: "pointer" }} onClick={() => nav(`/s/${slug}/channel/${c.id}`)}>
            <Eye size={13} style={{ flexShrink: 0, opacity: 0.7 }} /><span className="grow">{c.name}</span>
          </div>
        ))}
      </>}
      {pinnedChans.length > 0 && <><div className="sec">{t("sidebar.pinnedSection")}</div>{pinnedChans.map(chanRow)}</>}
      <div className="sec">{t("common.channels")} {capabilities.manageChannels && <button className="addbtn" title={t("sidebar.createChannelTitle")} onClick={() => { setMkChan(true); setDmPick(false); }}>+</button>}</div>
      {joinedChans.map(chanRow)}
      {otherChans.length > 0 && <>
        <div className="sec sec-sub">{t("sidebar.joinableSection")}</div>
        {otherChans.map((c) => (
          <div key={c.id} className="item ghost"><span className="grow"># {c.name}</span><button className="joinbtn" onClick={() => joinChannel(c.id)}>{t("sidebar.joinBtn")}</button></div>
        ))}
      </>}
      <div className="sec">{t("common.directMessages")} <button className="addbtn" title={t("sidebar.newDmTitle")} onClick={() => { setDmPick((v) => !v); setMkChan(false); }}>+</button></div>
      {dmPick && <div className="dm-pick">{visibleAgents.length ? visibleAgents.map((a) => <button key={a.id} className="item" onClick={() => doDM(a.id)}><Avatar seed={a.name} url={avFor(a.avatarUrl)} size={20} /><span className="grow">{a.displayName || a.name}</span></button>) : <div className="empty">{t("sidebar.dmPickEmpty")}</div>}</div>}
      {dms.map((c) => {
        const a = c.peerType === "agent" ? agents.find((x) => x.id === c.peerId) : undefined; // agent DM → show real-time status dot
        return (
        <button key={c.id} className={"item" + (c.id === channelId ? " active" : "")} onClick={() => nav(`/s/${slug}/channel/${c.id}`)}>
          <Avatar seed={c.peerDisplayName || c.peerName || c.peerId || c.id} url={avFor(c.peerAvatarUrl)} size={20} /><span className="grow">{c.peerDisplayName || c.peerName || t("sidebar.unknownUser")}</span>
          {a && <span className={"dot " + (a.activity || "offline")} role="img" aria-label={t("members.statusLabel", { status: a.activity || "offline" })} title={a.activityDetail || a.activity || "offline"} />}
          {!!unread[c.id] && <span className="badge">{unread[c.id]}</span>}
        </button>
        );
      })}
      {mkChan && <CreateChannelModal onCreate={doCreate} onClose={() => setMkChan(false)} />}
      </div>
      <LiveAgentBar />
    </aside>
  );
}

// Full create-channel form: name + description + visibility (public/private) + initial member selection (agents/humans).
// POST /api/channels { name, visibility, agentIds, userIds }. prefill = pre-populated values from action card.
export function CreateChannelModal({ onCreate, onClose, prefill, submitLabel }: { onCreate: (opts: { name: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }) => void; onClose: () => void; prefill?: { name?: string; description?: string; visibility?: string; agentIds?: string[]; userIds?: string[] }; submitLabel?: string }) {
  useEscClose(onClose);
  const { t } = useTranslation();
  const { visibleAgents: agents, humans, me, attachmentUrl } = useStore(); // visibleAgents: showcase demo props are not offered as channel members
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  const [name, setName] = useState(prefill?.name ?? "");
  const [desc, setDesc] = useState(prefill?.description ?? "");
  const [visibility, setVisibility] = useState(prefill?.visibility ?? "public");
  const [pickAgents, setPickAgents] = useState<Set<string>>(new Set(prefill?.agentIds ?? []));
  const [pickUsers, setPickUsers] = useState<Set<string>>(new Set(prefill?.userIds ?? []));
  const [mq, setMq] = useState("");
  const toggle = (set: Set<string>, id: string, upd: (s: Set<string>) => void) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); upd(n); };
  const ql = mq.trim().toLowerCase();
  const fAgents = agents.filter((a) => !ql || (a.displayName || a.name).toLowerCase().includes(ql));
  const fUsers = humans.filter((h) => h.userId !== me?.id && (!ql || (h.displayName || h.name).toLowerCase().includes(ql)));
  const submit = () => { if (name.trim()) onCreate({ name: name.trim(), description: desc.trim(), visibility, agentIds: [...pickAgents], userIds: [...pickUsers] }); };
  const total = pickAgents.size + pickUsers.size;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("sidebar.createChannelHeading")}</h3>
        <label>{t("sidebar.fieldName")}</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("sidebar.namePlaceholder")} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) submit(); }} />
        <label>{t("sidebar.descLabel")}</label><textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t("sidebar.descPlaceholder")} />
        <label>{t("sidebar.visibilityLabel")}</label>
        <div className="ck"><input type="radio" name="ct" checked={visibility === "public"} onChange={() => setVisibility("public")} /><span>{t("sidebar.visibilityPublic")}</span></div>
        <div className="ck"><input type="radio" name="ct" checked={visibility === "private"} onChange={() => setVisibility("private")} /><span>{t("sidebar.visibilityPrivate")}</span></div>
        <label>{t("sidebar.membersLabel")}{total ? ` · ${t("sidebar.membersSelected", { count: total })}` : t("sidebar.membersOptional")}</label>
        <input value={mq} onChange={(e) => setMq(e.target.value)} placeholder={t("sidebar.memberSearchPlaceholder")} />
        <div className="member-pick">
          {fAgents.length > 0 && <div className="sec sec-sub">{t("common.agents")}</div>}
          {fAgents.map((a) => (
            <button key={a.id} className={"item pickable" + (pickAgents.has(a.id) ? " picked" : "")} onClick={() => toggle(pickAgents, a.id, setPickAgents)}>
              <Avatar seed={a.name} url={avFor(a.avatarUrl)} size={22} /><span className="grow">{a.displayName || a.name}</span>{pickAgents.has(a.id) && <Check size={14} className="ck-mark" />}
            </button>
          ))}
          {fUsers.length > 0 && <div className="sec sec-sub">{t("sidebar.humanSection")}</div>}
          {fUsers.map((u) => (
            <button key={u.userId} className={"item pickable" + (pickUsers.has(u.userId) ? " picked" : "")} onClick={() => toggle(pickUsers, u.userId, setPickUsers)}>
              <Avatar seed={u.name} url={avFor(u.avatarUrl)} size={22} /><span className="grow">{u.displayName || u.name}</span>{pickUsers.has(u.userId) && <Check size={14} className="ck-mark" />}
            </button>
          ))}
          {fAgents.length === 0 && fUsers.length === 0 && <div className="empty">{t("sidebar.noMembers")}</div>}
        </div>
        <div className="acts"><button className="cancel" onClick={onClose}>{t("sidebar.cancelBtn")}</button><button className="ok" onClick={submit}>{submitLabel ?? t("sidebar.createBtn")}</button></div>
      </div>
    </div>
  );
}
