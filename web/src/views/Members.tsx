import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, ChevronRight, Check, Copy, Eye, EyeOff, Search, AlertTriangle } from "lucide-react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize from "rehype-sanitize";
import { useTranslation } from "react-i18next";
import { useStore } from "../store.tsx";
import { fmtDateTime } from "../format";
import { IconMonitor } from "../icons.tsx";
import { Avatar, AvatarPicker, resolveAvatar } from "../Avatar.tsx";
import { ActivityEventRow } from "../AgentActivity.tsx";
import { Select } from "../Select.tsx";
import { useConfirm, useDialogFocus, useEscClose } from "../ConfirmModal.tsx";
import { useToast } from "../toast.tsx";
import { startFailReasonKey } from "../startFailReason.ts";
import { CodeBlock, ColorSwatch, GithubAlertBlockquote, colorValueFromTag, markdownSchema, markdownUrlTransform, remarkColorSwatches, remarkGithubAlerts, remarkHtmlAsText } from "../messageRender.tsx";
import i18n from "../i18n";
import { ProjectDirectoryField } from "./ProjectDirectoryPicker.tsx";
import { copyText } from "../lib/clipboard.ts";
import { filterMemberDirectory } from "../memberDirectory.ts";

// Unified agent status label: fine-grained activity (working/thinking/online) takes priority;
// offline/absent falls back to lifecycle status (active/sleeping/inactive).
// Shared by sidebar and roster to keep both views in sync (daemon emits activity=sleeping when idle-sleeping).
function statusOf(a: { activity?: string | null; status: string }): string {
  return a.activity && a.activity !== "offline" ? a.activity : a.status;
}

export function Members() {
  const { t } = useTranslation();
  const { visibleAgents: agents, humans, machines, slug, capabilities, attachmentUrl, membersState, reloadMembers } = useStore(); // visibleAgents: showcase demo props are hidden from the roster (they stay in the store for #showcase history)
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  const { agentId, userId } = useParams();
  const nav = useNavigate();
  const [modal, setModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [directoryParams, setDirectoryParams] = useSearchParams();
  const memberQ = directoryParams.get("memberQ") || "";
  const memberKind = directoryParams.get("memberKind") || "all";
  const memberStatus = directoryParams.get("memberStatus") || "all";
  const memberRole = directoryParams.get("memberRole") || "all";
  const setDirectoryParam = (key: string, value: string, fallback = "all") => setDirectoryParams((prev) => {
    const next = new URLSearchParams(prev);
    if (!value || value === fallback) next.delete(key); else next.set(key, value);
    return next;
  }, { replace: true });

  const byMachine: Record<string, typeof agents> = {};
  for (const a of agents) { const k = a.machineId || "_none"; (byMachine[k] = byMachine[k] || []).push(a); }
  const mName = (id: string) => { const m = machines.find((x) => x.id === id); return m?.name || m?.hostname || i18n.t("members.unassigned"); };

  return (
    <>
      <aside className="sidebar">
        <div className="sb-scroll">
        <div className="sb-title">{t("nav.members")}</div>
        <div className="sec">{t("common.agents")} <span className="cnt">{agents.length}</span>{capabilities.manageAgents && <button className="addbtn" title={t("members.createAgent")} aria-label={t("members.createAgent")} onClick={() => setModal(true)}>+</button>}</div>
        {Object.keys(byMachine).map((k) => (
          <div key={k}>
            <div className="machine"><IconMonitor size={13} /> {k === "_none" ? t("members.unassigned") : mName(k)}</div>
            {byMachine[k].map((a) => (
              <button key={a.id} className={"item" + (a.id === agentId ? " active" : "")} onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                <Avatar seed={a.name} url={avFor(a.avatarUrl)} size={20} /><span className="grow">{a.name}</span><span className={"dot " + statusOf(a)} role="img" aria-label={t("members.statusLabel", { status: statusOf(a) })} title={statusOf(a)} />
              </button>
            ))}
          </div>
        ))}
        <div className="sec">{t("common.humans")} <span className="cnt">{humans.length}</span>{capabilities.manageMembers && <button className="addbtn" title={t("members.inviteMember")} aria-label={t("members.inviteMember")} onClick={() => setInviteModal(true)}>+</button>}</div>
        {humans.map((u) => (
          <button key={u.userId} className={"item" + (u.userId === userId ? " active" : "")} onClick={() => nav(`/s/${slug}/human/${u.userId}`)}>
            <Avatar seed={u.name} url={avFor(u.avatarUrl)} size={20} /><span className="grow">{u.displayName || u.name}</span>
          </button>
        ))}
        </div>
      </aside>
      <main className="content-col">
        {userId ? <HumanProfile uid={userId} /> : agentId ? <AgentProfile id={agentId} onDeleted={() => nav(`/s/${slug}/agent`)} /> : <Roster
          agents={agents} humans={humans} state={membersState} onRetry={reloadMembers}
          onCreate={() => setModal(true)} canCreate={!!capabilities.manageAgents}
          readOnly={!capabilities.manageAgents && !capabilities.manageMembers && !capabilities.changeMemberRoles}
          query={memberQ} kind={memberKind} status={memberStatus} role={memberRole}
          onQuery={(value) => setDirectoryParam("memberQ", value, "")}
          onKind={(value) => setDirectoryParam("memberKind", value)}
          onStatus={(value) => setDirectoryParam("memberStatus", value)}
          onRole={(value) => setDirectoryParam("memberRole", value)}
        />}
      </main>
      {modal && <CreateAgentModal onClose={() => setModal(false)} />}
      {inviteModal && <InviteHumanModal onClose={() => setInviteModal(false)} />}
    </>
  );
}

// Invite member entry point: automatically fetches or creates a member join-link for display and copy. Email invitations require a mail service.
function InviteHumanModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialogRef = useDialogFocus(onClose);
  const { api, serverId } = useStore();
  const [link, setLink] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  useEffect(() => { (async () => {
    setLink(""); setLinkError(false);
    try {
      const links = await api("GET", `/api/servers/${serverId}/join-links`);
      if (!Array.isArray(links)) throw new Error(links?.error || "invalid invite response");
      let l = links.find((x: any) => x.role === "member");
      if (!l) l = await api("POST", `/api/servers/${serverId}/join-links`, { role: "member", maxUses: null });
      if (!l?.token || l.error) throw new Error(l?.error || "invalid invite response");
      setLink(`${location.origin}/join/${l.token}`);
    } catch { setLinkError(true); }
  })(); /* eslint-disable-next-line */ }, [serverId, retry]);
  const copy = async () => {
    if (!await copyText(link)) { window.prompt(t("members.copyLink"), link); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="invite-member-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3 id="invite-member-title">{t("members.inviteTitle")}</h3>
        <p className="modal-note">{t("members.inviteNote")}</p>
        <label>{t("members.inviteLinkLabel")}</label>
        <input readOnly value={link || (linkError ? "" : t("members.inviteLinkGenerating"))} aria-busy={!link && !linkError} onFocus={(e) => e.currentTarget.select()} />
        {linkError && <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("members.inviteLoadFailed")}</span><button onClick={() => setRetry((value) => value + 1)}>{t("members.retry")}</button></div>}
        <div className="acts">
          <button className="cancel" onClick={onClose}>{t("members.close")}</button>
          <button className="ok" onClick={copy} disabled={!link}>{copied ? t("members.copied") : t("members.copyLink")}</button>
        </div>
      </div>
    </div>
  );
}

// Members roster: agents + humans as two labelled sections (mirrors the left sidebar order),
// every card a navigable entry into that member's profile (agent → /agent/:id, human → /human/:userId).
function Roster({ agents, humans, state, onRetry, onCreate, canCreate, readOnly, query, kind, status, role, onQuery, onKind, onStatus, onRole }: {
  agents: any[]; humans: any[]; state: "loading" | "refreshing" | "ready" | "error"; onRetry: () => Promise<void>;
  onCreate: () => void; canCreate?: boolean; readOnly?: boolean;
  query: string; kind: string; status: string; role: string;
  onQuery: (value: string) => void; onKind: (value: string) => void; onStatus: (value: string) => void; onRole: (value: string) => void;
}) {
  const { t } = useTranslation();
  const { attachmentUrl, slug } = useStore();
  const nav = useNavigate();
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);
  const filtered = filterMemberDirectory(agents, humans, { query, kind, status, role });
  const filteredAgents = filtered.agents;
  const filteredHumans = filtered.humans;
  const total = agents.length + humans.length;
  const filteredTotal = filteredAgents.length + filteredHumans.length;
  return (
    <>
      <div className="head members-head"><h1>{t("nav.members")}</h1><small>{t("common.membersCount", { count: total })}</small></div>
      <div className="members-toolbar" aria-label={t("members.directoryFilters")}>
        <label className="members-search"><Search size={16} aria-hidden="true" /><input type="search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t("members.searchPlaceholder")} aria-label={t("members.searchPlaceholder")} /></label>
        <Select ariaLabel={t("members.kindFilter")} value={kind} onChange={onKind} options={[
          { value: "all", label: t("members.kindAll") }, { value: "agents", label: t("common.agents") }, { value: "humans", label: t("common.humans") },
        ]} />
        <Select ariaLabel={t("members.statusFilter")} value={status} onChange={onStatus} options={[
          { value: "all", label: t("members.statusAll") }, { value: "active", label: t("members.statusActive") }, { value: "working", label: t("members.statusWorking") }, { value: "sleeping", label: t("members.statusSleeping") }, { value: "offline", label: t("members.statusOffline") }, { value: "failure", label: t("members.statusFailure") },
        ]} />
        <Select ariaLabel={t("members.roleFilter")} value={role} onChange={onRole} options={[
          { value: "all", label: t("members.roleAll") }, ...["owner", "admin", "member"].map((value) => ({ value, label: t(`members.roles.${value}`) })),
        ]} />
      </div>
      <div className="scroll members-directory" aria-busy={state === "loading" || state === "refreshing"}>
        {readOnly && <div className="members-limited">{t("members.readOnlyDirectory")}</div>}
        {state === "loading" ? <div className="page-loading" role="status" aria-label={t("members.loading")}><span /><span /><span /></div>
          : state === "error" ? <div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("members.loadFailed")}</span><button onClick={() => void onRetry()}>{t("members.retry")}</button></div>
          : total === 0 ? <div className="empty">{t("members.rosterEmpty")}{canCreate && <> {t("members.rosterEmptyCreate")} <button className="addbtn" aria-label={t("members.createAgent")} onClick={onCreate}>+</button></>}</div>
          : filteredTotal === 0 ? <div className="empty">{t("members.noMatches")}</div>
          : <>
            {filteredAgents.length > 0 && <div className="sec">{t("common.agents")} <span className="cnt">{filteredAgents.length}</span></div>}
            {filteredAgents.map((a) => {
              const to = `/s/${slug}/agent/${a.id}`;
              return (
                <button type="button" className="card card-link" key={a.id} onClick={() => nav(to)} aria-label={t("members.openProfile", { name: a.displayName || a.name })}>
                  <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar seed={a.name} url={avFor(a.avatarUrl)} size={24} />{a.displayName || a.name} <small className="meta">@{a.name}</small></h3>
                  <div className="meta">{a.description || t("members.generalAgent")}</div>
                  <div className="kv"><b>{t("common.runtime")}</b> {a.runtime} · {a.model || t("members.useLocalDefault")}</div>
                  <div className="kv"><b>{t("common.status")}</b> {statusOf(a)}</div>
                </button>
              );
            })}
            {filteredHumans.length > 0 && <div className="sec">{t("common.humans")} <span className="cnt">{filteredHumans.length}</span></div>}
            {filteredHumans.map((u) => {
              const to = `/s/${slug}/human/${u.userId}`;
              return (
                <button type="button" className="card card-link" key={u.userId} onClick={() => nav(to)} aria-label={t("members.openProfile", { name: u.displayName || u.name })}>
                  <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar seed={u.name} url={avFor(u.avatarUrl)} size={24} />{u.displayName || u.name} <small className="meta">@{u.name}</small></h3>
                  <div className="meta">{u.description || t("members.noDescription")}</div>
                  <div className="kv"><b>{t("members.role")}</b> {u.role || "member"}</div>
                </button>
              );
            })}
          </>}
      </div>
    </>
  );
}

export function AgentProfile({ id, onDeleted, onClose, onMessage }: { id: string; onDeleted: () => void; onClose?: () => void; onMessage?: () => void }) {
  const { t } = useTranslation();
  const { api, machines, reload, onEvent, capabilities, openDM, slug, uploadAgentAvatar, attachmentUrl } = useStore();
  const confirm = useConfirm();
  const toast = useToast();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("agentTab") || "profile";
  const [a, setA] = useState<any>(null);
  const [profileState, setProfileState] = useState<"loading" | "ready" | "error">("loading");
  const [actionBusy, setActionBusy] = useState("");
  const profileRequest = useRef(0);
  const [edit, setEdit] = useState(false); const [dn, setDn] = useState(""); const [ds, setDs] = useState(""); const [projectPath, setProjectPath] = useState(""); // profile edit state
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [showRestart, setShowRestart] = useState(false);
  const [avBusy, setAvBusy] = useState(false); const [avErr, setAvErr] = useState(""); const [signedAvatar, setSignedAvatar] = useState<string | null>(null);
  const [perContent, setPerContent] = useState<string | null>(null); const [perBusy, setPerBusy] = useState(false);
  useEscClose(() => { if (onClose) onClose(); });
  const refetch = async () => {
    const request = ++profileRequest.current;
    if (!a) setProfileState("loading");
    try {
      const data = await api("GET", "/api/agents/" + id);
      if (!data || data.error || !data.id) throw new Error(data?.error || "invalid agent profile");
      if (request !== profileRequest.current) return;
      setA(data); setSignedAvatar(resolveAvatar(data.avatarUrl, attachmentUrl)); setProfileState("ready");
    } catch {
      if (request === profileRequest.current) setProfileState("error");
    }
  };
  useEffect(() => { setA(null); setSignedAvatar(null); setProfileState("loading"); void refetch(); return () => { profileRequest.current += 1; }; }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "agent" && e.id === id) setA((p: any) => (p ? { ...p, status: e.status ?? p.status, activity: e.activity ?? p.activity } : p)); }), [id]);
  const onPickAvatar = async (f: File) => { setAvBusy(true); setAvErr(""); try { const url = await uploadAgentAvatar(id, f); setSignedAvatar(url); await refetch(); await reload(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  const onPickSeed = async (scheme: string) => { setAvBusy(true); setAvErr(""); try { const r = await api("PATCH", "/api/agents/" + id, { avatarUrl: scheme }); if (r?.error) throw new Error(r.error); await refetch(); await reload(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  const fetchPersonality = async () => { try { const r = await api("GET", `/api/agents/${id}/personality`); setPerContent(r.content || null); } catch { setPerContent(null); } };
  useEffect(() => { if (tab === "profile") fetchPersonality(); }, [id, tab]);
  // api() resolves error responses as {error} instead of throwing (store.tsx), so success/failure must be
  // branched on the body — the catch only sees network-level failures.
  const uploadPersonality = async (f: File) => { setPerBusy(true); try { const text = await f.text(); const r = await api("PUT", `/api/agents/${id}/personality`, { content: text }); if (r?.error) { toast.error(t("members.personalitySaveFailed", { error: r.error })); return; } toast.info(t("members.personalitySaved")); await fetchPersonality(); } catch (e: any) { toast.error(String(e?.message || e)); } finally { setPerBusy(false); } };
  const deletePersonality = async () => { if (!(await confirm({ title: t("members.personalityDeleteTitle"), message: t("members.personalityDeleteMessage"), confirmLabel: t("members.delete"), danger: true }))) return; setPerBusy(true); try { const r = await api("DELETE", `/api/agents/${id}/personality`); if (r?.error) { toast.error(t("members.personalityDeleteFailed", { error: r.error })); return; } toast.info(t("members.personalityDeleted")); setPerContent(null); } catch (e: any) { toast.error(String(e?.message || e)); } finally { setPerBusy(false); } };
  if (!a && profileState === "loading") return <div className="scroll"><div className="page-loading" role="status" aria-label={t("members.loading")}><span /><span /><span /></div></div>;
  if (!a || profileState === "error") return <div className="scroll"><div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("members.profileLoadFailed")}</span><button onClick={() => void refetch()}>{t("members.retry")}</button></div></div>;
  // Surface the server's concrete 503 reason ("no daemon online" / "runtime X unavailable on selected machine" …);
  // the generic machine-may-be-offline guess alone made users blind-retry (live 2026-07-05: 3× restart → 503).
  // Known reasons render localized (startFailReasonKey); unknown ones fall back to the raw server string.
  const startFail = (r: any) => {
    if (!r?.error || r.error === "internal") return toast.error(t("members.startFailed"));
    const known = startFailReasonKey(String(r.error));
    toast.error(`${t("members.startFailedWithReason")}: ${known ? t(known.key, known.params) : r.error}`);
  };
  const ctl = async (action: string) => { setActionBusy(action); try { const r = await api("POST", `/api/agents/${id}/${action}`); if (r?.error) { startFail(r); return; } setTimeout(() => void refetch(), 400); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setActionBusy(""); } }; // start/stop: surface daemon-offline failure (503 → {error}) instead of swallowing it
  // Three restart modes: restart=keep session+workspace; reset=clear session, keep workspace; full=clear session+delete workspace. All modes end with a restart.
  const doRestart = async (mode: "restart" | "reset" | "full") => {
    setShowRestart(false);
    setActionBusy(mode);
    try {
      let r: any;
      if (mode === "restart") r = await api("POST", `/api/agents/${id}/restart`);
      else if (mode === "reset") r = await api("POST", `/api/agents/${id}/reset`, { restart: true });
      else r = await api("POST", `/api/agents/${id}/reset`, { wipeWorkspace: true, restart: true });
      if (r?.error) { startFail(r); return; } // lifecycle RPCs settle before return; a failed reset/stop returns 503 and aborts the restart phase
      setTimeout(() => void refetch(), 500);
    } catch (error: any) { toast.error(String(error?.message || error)); } finally { setActionBusy(""); }
  };
  const del = async () => { if (!(await confirm({ title: t("members.deleteAgentTitle", { name: a.name }), message: t("members.deleteAgentMessage"), confirmLabel: t("members.delete"), danger: true }))) return; setActionBusy("delete"); try { const r = await api("DELETE", "/api/agents/" + id); if (r?.error) { toast.error(r.error); return; } await reload(); onDeleted(); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setActionBusy(""); } };
  const startEdit = () => { setDn(a.displayName || a.name); setDs(a.description || ""); setProjectPath(a.projectPath || ""); setProjectPickerOpen(false); setEdit(true); };
  const saveProfile = async () => {
    setActionBusy("save");
    const body: Record<string, unknown> = { displayName: dn.trim() || a.name, description: ds.trim() };
    if (projectPath.trim() !== (a.projectPath || "")) body.projectPath = projectPath.trim();
    try {
      const r = await api("PATCH", "/api/agents/" + id, body);
      if (r?.error) { toast.error(r.error); return; }
      setEdit(false); await refetch(); await reload();
    } catch (error: any) { toast.error(String(error?.message || error)); } finally { setActionBusy(""); }
  };
  const live = statusOf(a);
  const msgAgent = async () => { const cid = await openDM("agent", id); if (cid) nav(`/s/${slug}/channel/${cid}`); else toast.error(t("members.dmFailed")); };
  // Header action bar: Message available to everyone; start/stop/restart/delete gated by manageAgents capability
  const acts = (
    <div className="agent-acts">
      <button className="joinbtn" disabled={!!actionBusy} onClick={onMessage ?? msgAgent}><MessageCircle size={13} style={{ verticalAlign: "-2px" }} /> {t("members.dm")}</button>
      {capabilities.manageAgents && <>
        <button className="joinbtn" disabled={!!actionBusy} aria-busy={actionBusy === "start" || actionBusy === "stop"} onClick={() => void ctl(a.status === "active" ? "stop" : "start")}>{a.status === "active" ? t("members.stop") : t("members.start")}</button>
        {a.status === "queued" && <button className="joinbtn" disabled={!!actionBusy} aria-label={t("members.dequeue")} style={{ color: "var(--status-orange)" }} onClick={async () => { setActionBusy("dequeue"); try { const r = await api("POST", `/api/agents/${id}/dequeue`); if (r?.error) { toast.error(r.error); return; } setTimeout(() => void refetch(), 300); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setActionBusy(""); } }}>✕</button>}
        <button className="joinbtn" disabled={!!actionBusy} onClick={() => setShowRestart(true)}>{t("members.restart")}</button>
        <button className="joinbtn" disabled={!!actionBusy} style={{ color: "var(--error)" }} onClick={() => void del()}>{t("members.delete")}</button>
      </>}
    </div>
  );
  return (
    <>
      {onClose ? ( // panel mode (embedded in chat right sidebar: click avatar → profile panel)
        <div className="profile-panel-head">
          <Avatar seed={a.name} url={signedAvatar} size={28} />
          <div className="pph-id"><span className="pph-name">{a.displayName || a.name} <span className={"dot " + live} /></span><span className="pph-handle">@{a.name}</span></div>
          <button className="joinbtn pph-close" title={t("members.close")} aria-label={t("members.close")} onClick={onClose}><X size={14} /></button>
          {acts}
        </div>
      ) : <div className="head head-agent"><AvatarPicker name={a.name} url={signedAvatar} size={48} editable={!!capabilities.manageAgents} busy={avBusy} onPickSeed={onPickSeed} onPickFile={onPickAvatar} /><div className="head-id"><h1>{a.displayName || a.name}</h1><small>@{a.name} <span className={"dot " + live} />{avErr ? <span className="form-err" style={{ marginLeft: 8 }}>{avErr}</span> : null}</small></div>{acts}</div>}
      <div className="ptabs">
        {/* Tab order follows AgentDetailPanel spec: integrations (not apps) */}
        {([
          ["profile", t("members.tabProfile")],
          ["permissions", t("members.tabPermissions")],
          ["dms", t("members.tabDms")],
          ["reminders", t("members.tabReminders")],
          ["workspace", t("members.tabWorkspace")],
          ["integrations", t("members.tabIntegrations")],
          ["activity", t("members.tabActivity")],
        ] as [string, string][]).map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setSp((prev) => { const n = new URLSearchParams(prev); n.set("agentTab", k); return n; })}>{label}</button>
        ))}
      </div>
      {tab === "workspace" ? <WorkspaceTab id={id} />
        : tab === "activity" ? <ActivityTab id={id} name={a.name} />
        : tab === "permissions" ? <PermissionsTab id={id} />
        : tab === "integrations" ? <AppsTab id={id} />
        : tab === "dms" ? <DmsTab id={id} name={a.name} />
        : tab === "reminders" ? <RemindersTab id={id} name={a.name} />
        : (
          <div className="scroll">
            <div className="card">
              {edit ? (
                <div className="setform">
                  <label>{t("members.displayName")}</label><input value={dn} onChange={(e) => setDn(e.target.value)} placeholder={a.name} />
                  <label>{t("members.agentDescriptionLabel")}</label><textarea value={ds} maxLength={3000} onChange={(e) => setDs(e.target.value)} placeholder={t("members.agentDescriptionPlaceholder")} />
                  <div className="ta-count">{ds.trim().length}/3000</div>
                  <label>{t("members.projectDirectoryLabel")}</label><ProjectDirectoryField value={projectPath} onChange={setProjectPath} machine={machines.find((machine) => machine.id === a.machineId)} disabled={a.status !== "inactive"} pickerOpen={projectPickerOpen} onPickerOpenChange={setProjectPickerOpen} />
                  <div className="hint">{a.status === "inactive" ? t("members.projectDirectoryHint") : t("members.projectDirectoryStopHint")}</div>
                  <div className="setrow"><button className="ok" disabled={actionBusy === "save"} onClick={() => void saveProfile()}>{t("members.save")}</button><button className="cancel" disabled={actionBusy === "save"} onClick={() => { setProjectPickerOpen(false); setEdit(false); }}>{t("members.cancel")}</button></div>
                </div>
              ) : (<>
                <div className="meta">{a.description || t("members.generalAgent")}</div>
                <div className="kv"><b>{t("common.runtime")}</b> {a.runtime}</div>
                <div className="kv"><b>{t("common.model")}</b> {a.model || t("members.useLocalDefault")}</div>
                {a.runtimeConfig?.reasoningEffort && <div className="kv"><b>{t("common.reasoning")}</b> {a.runtimeConfig.reasoningEffort}</div>}
                <div className="kv"><b>{t("common.status")}</b> <span className="kv-v"><span className={"dot " + live} /> {live}</span></div>
                <div className="kv"><b>{t("common.session")}</b> {a.sessionId || "(none)"}</div>
                <div className="kv"><b>{t("members.agentStateDirectory")}</b> ~/.open-tag/agents/{a.id}</div>
                <div className="kv"><b>{t("members.projectDirectoryLabel")}</b> {a.projectPath || (a.projectBound ? t("members.projectDirectoryPrivate") : t("members.projectDirectoryIsolated"))}</div>
                {a.createdAt && <div className="kv"><b>{t("common.created")}</b> {fmtDateTime(a.createdAt)}</div>}
                {capabilities.manageAgents && <div className="task-acts" style={{ marginTop: 14 }}>
                  <button className="joinbtn" onClick={startEdit}>{t("members.editProfile")}</button>
                </div>}
              </>)}
            </div>
            <div className="card">
              <h3>{t("members.personalityTitle")} <small className="meta">{perContent ? "(personality.md)" : ""}</small></h3>
              {perContent ? <div className="meta" style={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto", marginBottom: 8 }}>{perContent}</div> : <div className="meta" style={{ opacity: .6 }}>{t("members.personalityEmpty")}</div>}
              {capabilities.manageAgents && <div className="task-acts">
                <label className="joinbtn" style={{ cursor: perBusy ? "not-allowed" : "pointer", display: "inline-block" }}>{perBusy ? t("members.uploading") : t("members.personalityUpload")}<input type="file" accept=".md,text/markdown,text/plain" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPersonality(f); e.target.value = ""; }} /></label>
                {perContent && <button className="joinbtn" style={{ color: "var(--error)" }} disabled={perBusy} onClick={deletePersonality}>{t("members.delete")}</button>}
              </div>}
            </div>
            <SkillsSection id={id} projectBound={!!a.projectBound} />
          </div>
        )}
      {showRestart && <RestartModal name={a.displayName || a.name} onClose={() => setShowRestart(false)} onPick={doRestart} />}
    </>
  );
}

// Profile tab SKILLS section (GET /api/agents/:id/skills — daemon reads skills from the host machine)
function SkillsSection({ id, projectBound }: { id: string; projectBound: boolean }) {
  const { t } = useTranslation();
  const { api, capabilities } = useStore();
  const confirm = useConfirm();
  const toast = useToast();
  const [d, setD] = useState<{ global: any[]; workspace: any[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const refetch = async () => { try { setD(await api("GET", `/api/agents/${id}/skills`)); } catch { setD({ global: [], workspace: [] }); } };
  useEffect(() => { refetch(); }, [id]);
  const uploadSkill = async (f: File) => {
    setBusy(true);
    try {
      const raw = await f.text();
      const name = f.name.replace(/\.md$/i, "");
      let content = raw;
      if (!/^---\s*\n/.test(raw)) content = `---\nname: ${name}\nuserInvocable: true\n---\n\n${raw}`;
      const r = await api("PUT", `/api/agents/${id}/skills/${encodeURIComponent(name)}`, { content });
      if (r?.error) { toast.error(t("members.skillUploadFailed", { error: r.error })); return; }
      toast.info(t("members.skillUploaded", { name }));
      await refetch();
    } catch (e: any) { toast.error(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };
  const deleteSkill = async (dirName: string) => {
    if (!(await confirm({ title: t("members.skillDeleteTitle", { name: dirName }), message: t("members.skillDeleteMessage"), confirmLabel: t("members.delete"), danger: true }))) return;
    setBusy(true);
    try {
      const r = await api("DELETE", `/api/agents/${id}/skills/${encodeURIComponent(dirName)}`);
      if (r?.error) { toast.error(t("members.skillDeleteFailed", { error: r.error })); return; }
      toast.info(t("members.skillDeleted", { name: dirName }));
      await refetch();
    } catch (e: any) { toast.error(String(e?.message ?? e)); }
    finally { setBusy(false); }
  };
  if (!d) return null;
  const all = [...(d.workspace || []).map((s) => ({ ...s, scope: t("members.scopeWorkspace") })), ...(d.global || []).map((s) => ({ ...s, scope: t("members.scopeGlobal") }))];
  return (
    <>
      <div className="sec">
        {t("common.skills")} <span className="cnt">{all.length}</span>
        {capabilities.manageAgents && !projectBound && <span style={{ marginLeft: 8 }}>
          <label className="joinbtn" style={{ cursor: busy ? "not-allowed" : "pointer", display: "inline-block", fontSize: "inherit", lineHeight: "inherit", padding: "2px 8px" }}>
            {busy ? t("members.uploading") : t("members.skillAdd")}
            <input type="file" accept=".md,text/markdown" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSkill(f); e.target.value = ""; }} />
          </label>
        </span>}
      </div>
      {all.length === 0 ? <div className="empty">{t("members.skillsEmpty")}</div>
        : all.map((s, i) => (
          <div className="card skill-row" key={i} title={`${s.displayName || s.name}${s.description ? "\n\n" + s.description : ""}`}>
            <div className="who">
              {s.displayName || s.name}
              <span className="meta"> · {s.scope}{s.userInvocable ? ` · ${t("members.skillInvocable")}` : ""}</span>
              {capabilities.manageAgents && s.sourcePath?.includes("<workspace>") && (
                <button className="joinbtn" style={{
                  color: "var(--error)", float: "right", fontSize: "inherit", lineHeight: "inherit",
                  padding: "0 4px", background: "none", border: "none", cursor: busy ? "not-allowed" : "pointer",
                  opacity: busy ? .5 : 1,
                }} disabled={busy} onClick={() => deleteSkill(s.dirName)} title={t("members.skillDeleteFromWorkspace")}>✕</button>
              )}
            </div>
            {s.description ? <div className="meta skill-desc">{s.description}</div> : <div className="meta" style={{ opacity: .6 }}>{t("members.noDescription")}</div>}
          </div>
        ))}
    </>
  );
}

// Permissions tab (GET/PUT /api/agents/:id/scopes — grouped scope checkboxes with enforcement)
function PermissionsTab({ id }: { id: string }) {
  const { t } = useTranslation();
  const { api, capabilities } = useStore();
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const permissionRequest = useRef(0);
  const canEdit = !!capabilities.manageAgents;
  const load = async () => { const request = ++permissionRequest.current; setState("loading"); try { const d = await api("GET", `/api/agents/${id}/scopes`); if (d?.error || !Array.isArray(d?.catalog) || !Array.isArray(d?.granted)) throw new Error(d?.error || "invalid permissions response"); if (request !== permissionRequest.current) return; setData(d); setGranted(new Set(d.granted)); setState("ready"); } catch { if (request === permissionRequest.current) setState("error"); } };
  useEffect(() => { void load(); return () => { permissionRequest.current += 1; }; }, [id]);
  if (state === "loading") return <div className="scroll"><div className="page-loading" role="status" aria-label={t("members.loading")}><span /><span /><span /></div></div>;
  if (state === "error" || !data) return <div className="scroll"><div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("members.permissionsLoadFailed")}</span><button onClick={() => void load()}>{t("members.retry")}</button></div></div>;
  const toggle = (k: string) => setGranted((g) => { const n = new Set(g); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const save = async (scopes: string[]) => { if (!canEdit) return; setBusy(true); try { const d = await api("PUT", `/api/agents/${id}/scopes`, { scopes }); if (d?.error || !Array.isArray(d?.granted)) { toast.error(d?.error || t("members.permissionsSaveFailed")); return; } setData({ ...data, ...d }); setGranted(new Set(d.granted)); setSaved(true); setTimeout(() => setSaved(false), 1500); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setBusy(false); } };
  const groups: Record<string, any[]> = {};
  for (const s of data.catalog || []) (groups[s.group] ||= []).push(s);
  return (
    <div className="scroll">
      <div className="perm-head">
        <span className="meta">{data.mode === "custom" ? t("members.permCustom") : t("members.permDefault")} · rev {data.revision}</span>
        {canEdit ? <>
          <button className="joinbtn" disabled={busy} onClick={() => void save((data.catalog || []).map((s: any) => s.key))}>{t("members.grantAll")}</button>
          <button className="ok" disabled={busy} style={{ marginLeft: "auto" }} onClick={() => void save([...granted])}>{t("members.save")}</button>
        </> : <span className="meta" style={{ marginLeft: "auto" }}>{t("members.permissionsReadOnly")}</span>}
        {saved && <span className="saved">{t("members.savedConfirm")}</span>}
      </div>
      {/* Scope group/label/description come from the server catalog (src/server/scopes.ts, English). Translate
          client-side keyed by the stable scope key — ":" is i18next's ns separator, so swap it for "_"; a scope
          the locale files don't know yet falls back to the server-sent English instead of a bare key. */}
      {Object.entries(groups).map(([g, list]) => (
        <div key={g} className="perm-group">
          <div className="sec sec-sub">{t(`members.scopeGroup.${g}`, { defaultValue: g })}</div>
          {list.map((s: any) => (
            <label key={s.key} className="perm-row">
              <input type="checkbox" checked={granted.has(s.key)} disabled={!canEdit || busy} onChange={() => toggle(s.key)} />
              <span className="grow"><span className="who">{t(`members.scopeLabel.${s.key.replace(/:/g, "_")}`, { defaultValue: s.label })}</span> <code className="perm-key">{s.key}</code><div className="meta">{t(`members.scopeDesc.${s.key.replace(/:/g, "_")}`, { defaultValue: s.description })}</div></span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

// Integrations tab (connected third-party integrations, GET /api/integrations/agents/:id; empty state when none configured)
function AppsTab({ id }: { id: string }) {
  const { t } = useTranslation();
  const { api } = useStore();
  const [apps, setApps] = useState<any[] | null>(null);
  useEffect(() => { (async () => { try { setApps(await api("GET", `/api/integrations/agents/${id}`)); } catch { setApps([]); } })(); }, [id]);
  return <div className="scroll"><div className="sec">{t("members.connectedApps")}</div>{!apps?.length ? <div className="empty">{t("members.appsEmpty")}</div> : apps.map((ap, i) => <div className="card" key={i}><div className="who">{ap.name || ap.id}</div></div>)}</div>;
}

// DMs tab (derived from channels: direct message threads between this agent and others)
function DmsTab({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation();
  const { api, slug } = useStore();
  const nav = useNavigate();
  const [dms, setDms] = useState<any[] | null>(null);
  useEffect(() => { (async () => { try { setDms(await api("GET", `/api/agents/${id}/agent-dms`)); } catch { setDms([]); } })(); }, [id]);
  return <div className="scroll"><div className="sec">{t("members.agentDms")}</div>{!dms?.length ? <div className="empty">{t("members.dmsEmpty", { name })}</div> : dms.map((d) => <button className="item" key={d.id} onClick={() => nav(`/s/${slug}/channel/${d.id}`)}><Avatar seed={d.name} size={22} /><span className="grow">{d.name}</span></button>)}</div>;
}

// Reminders tab (read-only; agents create reminders via CLI, humans can only view)
const REM_STATUS: Record<string, string> = {
  scheduled: "members.remScheduled",
  fired: "members.remFired",
  cancelled: "members.remCancelled",
};
function RemindersTab({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation();
  const { api } = useStore();
  const [rem, setRem] = useState<any[] | null>(null);
  useEffect(() => { (async () => { try { const d = await api("GET", `/api/reminders?ownerAgentId=${id}`); setRem(d?.reminders || []); } catch { setRem([]); } })(); }, [id]);
  const scheduled = (rem || []).filter((r) => r.status === "scheduled").length;
  return <div className="scroll"><div className="sec">{t("members.remindersTitle")} {rem?.length ? <span className="cnt">{t("members.remindersCount", { scheduled, total: rem.length })}</span> : null}</div>
    {!rem?.length ? <div className="empty">{t("members.remindersEmpty", { name })}</div>
      : rem.map((r) => (
        <div className="card" key={r.id}>
          <div className="who">{r.content}{r.recurrence ? <span className="meta"> · {t("members.recurrenceEvery", { seconds: r.recurrence })}</span> : null}</div>
          <div className="meta"><span className={"rem-badge " + (r.status || "scheduled")}>{REM_STATUS[r.status] ? t(REM_STATUS[r.status]) : r.status}</span> · {fmtDateTime(r.remindAt)}</div>
        </div>
      ))}</div>;
}

// Activity timeline (GET /api/agents/:id/activity-log for history + live-appended via agent:activity/trajectory events)
function ActivityTab({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation();
  const { api, onEvent } = useStore();
  const [items, setItems] = useState<any[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { (async () => { const d = await api("GET", `/api/agents/${id}/activity-log?limit=120`); setItems(Array.isArray(d) ? d : []); })(); }, [id]);
  useEffect(() => onEvent((e) => {
    if (e.type === "agent" && e.id === id && e.activity) setItems((x) => [...x, { timestamp: Date.now(), entry: { kind: "status", activity: e.activity, detail: e.detail } }]);
    else if (e.type === "trajectory" && e.agentId === id) setItems((x) => [...x, ...(e.entries || []).map((en: any) => ({ timestamp: Date.now(), entry: { kind: en.kind === "tool" ? "tool_start" : (en.kind || (en.toolName ? "tool_start" : "text")), text: en.text, toolName: en.toolName, toolInput: en.toolInput, activity: en.activity, detail: en.detail } }))]);
  }), [id]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [items]);
  const entryOf = (e: any) => ({ ...e, kind: e.kind === "tool" ? "tool_start" : e.kind });
  const visible = (e: any) => !(e.kind === "status" && !e.activity && !e.detail) && !(e.kind === "tool_start" && e.toolName === "agentMessage" && !e.text);
  return (
    <div className="scroll" ref={scrollRef}>
      {items.length === 0 ? <div className="empty">{t("members.activityEmpty", { name })}</div>
        : <div className="actlog">{items.filter((it) => visible(entryOf(it.entry))).map((it, i) => (
          <ActivityEventRow key={i} item={{ ...entryOf(it.entry), timestamp: it.timestamp }} />
        ))}</div>}
    </div>
  );
}

// Agent workspace file tree (GET /api/agents/:id/workspace-files for full tree + /workspace-files/read for file content)
// .md files: Preview (rendered markdown, default) / Raw (monospace source) toggle. Other files: monospace source only.
function WorkspaceTab({ id }: { id: string }) {
  const { t } = useTranslation();
  const { api } = useStore();
  const [files, setFiles] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<{ path: string; content?: string; error?: string } | null>(null);
  const [mode, setMode] = useState<"preview" | "raw">("preview"); // .md files default to preview
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // tracks expanded directories (collapsed by default, toggled via onToggleDir)
  const [copied, setCopied] = useState(false);
  const [showHidden, setShowHidden] = useState(false); // dot-prefixed files hidden by default (like ls; toggle for ls -a behavior)
  const [root, setRoot] = useState(`~/.open-tag/agents/${id}/`); // shown in root bar + copied by copy button; fallback (old daemon/offline) replaced by the real on-disk path from the API
  useEffect(() => { setSel(null); setExpanded(new Set()); setRoot(`~/.open-tag/agents/${id}/`); (async () => { const d = await api("GET", `/api/agents/${id}/workspace-files`); if (d.error) { setErr(d.error); setFiles([]); } else { setErr(""); setFiles(d.files || []); if (d.root) setRoot(d.root.endsWith("/") ? d.root : d.root + "/"); } })(); }, [id]);
  const open = async (f: any) => { setMode("preview"); const d = await api("GET", `/api/agents/${id}/workspace-files/read?path=${encodeURIComponent(f.path)}`); setSel({ path: f.path, content: d.content, error: d.error }); };
  const toggleDir = (path: string) => setExpanded((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n; });
  const copyRoot = async () => {
    if (!await copyText(root)) { window.prompt(t("members.copyPath"), root); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  // Collapse filter: a node is visible iff all its ancestor directories are expanded (top-level visible by default, subdirs collapsed)
  const visible = files.filter((f) => { const parts = f.path.split("/"); if (!showHidden && parts.some((seg: string) => seg.startsWith("."))) return false; for (let i = 1; i < parts.length; i++) if (!expanded.has(parts.slice(0, i).join("/"))) return false; return true; });
  const isMd = !!sel && /\.md$/i.test(sel.path);
  return (
    <div className="ws">
      <div className="ws-tree">
        <div className="ws-rootbar">
          <span className="ws-root" title={root}>{root}</span>
          <button className="ws-copy" title={showHidden ? t("members.hideDotFiles") : t("members.showHiddenFiles")} onClick={() => setShowHidden((v) => !v)}>{showHidden ? <EyeOff size={12} /> : <Eye size={12} />}</button>
          <button className="ws-copy" title={copied ? t("members.copied") : t("members.copyPath")} onClick={copyRoot}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
        </div>
        {err ? <div className="empty">{err}</div> : files.length === 0 ? <div className="empty">{t("members.workspaceEmpty")}</div>
          : visible.map((f) => (
            <div key={f.path} className={"ws-row" + (sel?.path === f.path ? " active" : "")} style={{ paddingLeft: 6 + (f.path.split("/").length - 1) * 14 }}
              onClick={() => (f.isDirectory ? toggleDir(f.path) : open(f))}>
              <span className={"grow" + (f.name?.toLowerCase() === "memory.md" ? " ws-mem" : "")}>{f.isDirectory && <ChevronRight size={12} className={"ws-caret" + (expanded.has(f.path) ? " open" : "")} style={{ verticalAlign: "-2px" }} />}{f.name}</span>{!f.isDirectory && <span className="ws-size">{f.size}</span>}
            </div>
          ))}
      </div>
      <div className="ws-view">
        {!sel ? <div className="hint">{t("members.workspaceHint")}</div>
          : sel.error ? <div className="empty">{sel.error}</div>
            : <>
                <div className="ws-path">{sel.path}
                  {isMd && <span className="ws-toggle">
                    <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>{t("members.filePreview")}</button>
                    <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>{t("members.fileRaw")}</button>
                  </span>}
                </div>
                {isMd && mode === "preview"
                  ? <div className="ws-md"><ReactMarkdown urlTransform={markdownUrlTransform} remarkPlugins={[remarkGfm, remarkBreaks, remarkHtmlAsText, remarkGithubAlerts, remarkColorSwatches]} rehypePlugins={[[rehypeSanitize, markdownSchema]]} components={{ a: ({ href, children }) => { const color = colorValueFromTag(href); return color ? <ColorSwatch value={color} /> : <a href={href} target="_blank" rel="noreferrer">{children}</a>; }, blockquote: ({ node: _node, children, ...props }) => <GithubAlertBlockquote {...props}>{children}</GithubAlertBlockquote>, pre: ({ children }) => <CodeBlock>{children}</CodeBlock> }}>{sel.content || ""}</ReactMarkdown></div>
                  : <pre className="ws-content">{sel.content}</pre>}
              </>}
      </div>
    </div>
  );
}

export function CreateAgentModal({ onClose, prefill, onCreated }: { onClose: () => void; prefill?: { name?: string; description?: string }; onCreated?: (r: { id: string; name: string }) => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { api, serverId, machines, reload } = useStore();
  const [name, setName] = useState(prefill?.name ?? ""); const [desc, setDesc] = useState(prefill?.description ?? "");
  const [projectPath, setProjectPath] = useState("");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [machineId, setMachineId] = useState(machines[0]?.id || "");
  const [runtime, setRuntime] = useState("claude"); const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; label?: string; thinking?: { levels: { value: string; label: string; description?: string }[]; default?: string } }[]>([]);   const [fast, setFast] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [reasoning, setReasoning] = useState(""); // reasoning effort (""=Default/no override); shown when selected model has thinking levels
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const dialogRef = useDialogFocus(() => { if (projectPickerOpen) setProjectPickerOpen(false); else onClose(); });
  // Sentinel + per-runtime capability: claude/codex offer "use local default" (don't pass --model/--effort;
  // the CLI uses ~/.claude / ~/.codex config). Other runtimes keep their original picker behavior.
  const LOCAL_DEFAULT = "__default__";
  const supportsLocalDefault = runtime === "claude" || runtime === "codex";
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    (async () => {
      try {
        const d = await api("GET", `/api/servers/${serverId}/machines/${machineId || "none"}/runtime-models/${runtime}`);
        if (cancelled) return;
        const ms: typeof models = d.models || [];
        setModels(ms);
        // Preserve the current selection if it still exists in the new list; otherwise fall back to the first option.
        setModel((prev) => {
          if (supportsLocalDefault && prev === LOCAL_DEFAULT) return prev;
          const kept = ms.find((m) => m.id === prev);
          return kept ? prev : (supportsLocalDefault ? LOCAL_DEFAULT : (ms[0]?.id || ""));
        });
        setReasoning((prev) => { const kept = ms.find((m) => m.id === model); return kept ? prev : (ms[0]?.thinking?.default ?? ""); });
      } catch { if (!cancelled) setModels([]); }
      finally { if (!cancelled) setModelsLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [runtime, machineId]);
  const create = async () => {
    if (!machineId) { setErr(t("members.machineRequired")); return; } // Computer is required: an unbound agent only runs via the legacy broadcast-to-all-daemons fallback (tech-debt I77) — force an explicit pick.
    const nm = name.trim().normalize("NFC");
    if (!nm) { setErr(t("members.nameRequired")); return; }
    if (!/^\p{L}[\p{L}\p{M}\p{N}_-]*$/u.test(nm) || [...nm].length > 64) { setErr(t("members.nameInvalid")); return; } // Unicode @handle grammar; keep regex + length 64 in sync with core.ts AGENT_NAME_RE / MAX_AGENT_NAME
    setBusy(true); setErr("");
    try {
      const r = await api("POST", "/api/agents", { machineId, name: nm, description: desc.trim() || null, projectPath: projectPath.trim() || null, runtime, model: model && model !== LOCAL_DEFAULT ? model : null, reasoning: thinkingLevels.length ? (reasoning || null) : null, fastMode: fast });
      if (r?.error) { setErr(r.error); return; } // api() resolves the JSON body even on 4xx (fetch only throws on network failure) — an unchecked error here previously closed the modal silently with no feedback, e.g. once the backend started rejecting a stale/deleted machineId.
      await reload();
      if (r?.id) { if (r.started === false) toast.info(t("members.agentCreatedOffline")); onCreated?.({ id: r.id, name: r.name ?? nm }); }
      onClose();
    } catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  const RUNTIMES = [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "copilot", label: "Copilot CLI" }, { value: "opencode", label: "OpenCode" }, { value: "kimi", label: "Kimi Code" }, { value: "pi", label: "Pi" }, { value: "cursor", label: "Cursor" }, { value: "hermes", label: "Hermes" }];
  const machineOpts = machines.length ? machines.map((m) => ({ value: m.id, label: m.name || m.hostname || m.id, hint: m.status === "online" ? t("members.machineOnline") : t("members.machineOffline") })) : [];
  const selModel = models.find((m) => m.id === model);
  const thinkingLevels = selModel?.thinking?.levels ?? [];
  const modelOpts = [
    ...(supportsLocalDefault ? [{ value: LOCAL_DEFAULT, label: t("members.useLocalDefault") }] : []),
    ...(models.length
      ? models.map((m) => ({ value: m.id, label: m.label || m.id }))
      : supportsLocalDefault ? [] : [{ value: "default", label: t("members.modelDefault") }]),
  ];
  const modelLoadingOpts = [{ value: "", label: t("members.modelDetecting") }];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title" tabIndex={-1} aria-busy={busy} onClick={(e) => e.stopPropagation()}>
        <h3 id="create-agent-title">{t("members.createAgentTitle")}</h3>
        <label>{t("members.computerLabel")}<span className="req-mark">*</span></label>
        <Select ariaLabel={t("members.computerAriaLabel")} value={machineId} options={machineOpts} onChange={(nextMachineId) => { setMachineId(nextMachineId); setProjectPath(""); setProjectPickerOpen(false); }} placeholder={t("members.noMachineOnline")} />
        {machineOpts.length === 0 && <div className="hint">{t("members.noMachineHint")}</div>}
        <label>{t("members.nameLabel")}</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("members.namePlaceholder")} />
        <label>{t("members.descriptionLabel")}</label><textarea value={desc} maxLength={3000} onChange={(e) => setDesc(e.target.value)} placeholder={t("members.descriptionPlaceholder")} />
        <label>{t("members.projectDirectoryLabel")}</label><ProjectDirectoryField value={projectPath} onChange={setProjectPath} machine={machines.find((machine) => machine.id === machineId)} pickerOpen={projectPickerOpen} onPickerOpenChange={setProjectPickerOpen} parentHandlesEscape />
        <div className="hint">{t("members.projectDirectoryHint")}</div>
        <label>{t("common.runtime")}</label>
        <Select ariaLabel={t("common.runtime")} value={runtime} options={RUNTIMES} onChange={setRuntime} />
        <label>{t("common.model")}</label>
        {/* During probe flight: disable interaction + show "Detecting models…" placeholder.
            fieldset[disabled] disables all descendant buttons without modifying Select.tsx. */}
        <fieldset disabled={modelsLoading} style={{ border: 0, padding: 0, margin: 0, opacity: modelsLoading ? 0.6 : 1 }}>
          <Select ariaLabel={t("common.model")} value={modelsLoading ? "" : model} options={modelsLoading ? modelLoadingOpts : modelOpts} onChange={(v) => { setModel(v); const m = models.find((m) => m.id === v); setReasoning(m?.thinking?.default ?? ""); }} />
        </fieldset>
        {thinkingLevels.length > 0 && <>
          <label>{t("members.reasoningLabel")}</label>
          <Select ariaLabel={t("common.reasoning")} value={reasoning} onChange={setReasoning}
            options={[{ value: "", label: t("members.reasoningDefault") }, ...thinkingLevels.map((l) => ({ value: l.value, label: l.label }))]} />
        </>}
        <label className="ck-row"><input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /><span>{t("members.fastMode")}</span></label>
        {err && <div className="form-err">{err}</div>}
        <div className="acts"><button className="cancel" onClick={onClose}>{t("members.cancel")}</button><button className="ok" onClick={create} disabled={busy || !machineId} title={!machineId ? t("members.machineRequired") : undefined}>{busy ? t("members.creating") : t("members.create")}</button></div>
      </div>
    </div>
  );
}

// Human member profile (HumanDetailPanel): shows info/role/Created Agents; the member themselves can edit their own description (max 3000 chars).
// Description is visible to other humans and agents in the server; agents fetch it via `open-tag server info` for collaboration context.
export function HumanProfile({ uid, onClose, onMessage }: { uid: string; onClose?: () => void; onMessage?: () => void }) {
  const { t } = useTranslation();
  const { api, serverId, me, reload, slug, capabilities, openDM, uploadUserAvatar, attachmentUrl } = useStore();
  const confirm = useConfirm();
  const toast = useToast();
  const nav = useNavigate();
  const [p, setP] = useState<any>(null);
  const [profileState, setProfileState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const profileRequest = useRef(0);
  const [edit, setEdit] = useState(false); const [ds, setDs] = useState("");
  const [avBusy, setAvBusy] = useState(false); const [avErr, setAvErr] = useState(""); const [signedAvatar, setSignedAvatar] = useState<string | null>(null);
  useEscClose(() => { if (onClose) onClose(); });
  const refetch = async () => {
    const request = ++profileRequest.current;
    if (!p) setProfileState("loading");
    try {
      const data = await api("GET", `/api/servers/${serverId}/members/${uid}/profile`);
      if (!data || data.error || !data.userId) throw new Error(data?.error || "invalid human profile");
      if (request !== profileRequest.current) return;
      setP(data); setSignedAvatar(resolveAvatar(data.avatarUrl, attachmentUrl)); setProfileState("ready");
    } catch {
      if (request === profileRequest.current) setProfileState("error");
    }
  };
  useEffect(() => { setP(null); setSignedAvatar(null); setProfileState("loading"); void refetch(); return () => { profileRequest.current += 1; }; }, [uid, serverId]);
  const onPickAvatar = async (f: File) => { setAvBusy(true); setAvErr(""); try { const url = await uploadUserAvatar(f); setSignedAvatar(url); await refetch(); await reload(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  const onPickSeed = async (scheme: string) => { setAvBusy(true); setAvErr(""); try { const r = await api("PATCH", "/api/auth/me", { avatarUrl: scheme }); if (r?.error) throw new Error(r.error); await refetch(); await reload(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  if (!p && profileState === "loading") return <div className="scroll"><div className="page-loading" role="status" aria-label={t("members.loading")}><span /><span /><span /></div></div>;
  if (!p || profileState === "error") return <div className="scroll"><div className="page-load-error" role="alert"><AlertTriangle size={18} /><span>{t("members.profileLoadFailed")}</span><button onClick={() => void refetch()}>{t("members.retry")}</button></div></div>;
  const isMe = me?.id === uid;
  const roleLabel = (r: string) => t(`members.roles.${r}`, { defaultValue: r }); // unknown role → raw value
  const save = async () => { setBusy(true); try { const r = await api("PATCH", "/api/auth/me", { description: ds.trim() }); if (r?.error) { toast.error(r.error); return; } setEdit(false); await refetch(); await reload(); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setBusy(false); } };
  const dmHuman = async () => { const cid = await openDM("user", uid); if (cid) nav(`/s/${slug}/channel/${cid}`); else toast.error(t("members.dmFailed")); };
  const dmBtn = !isMe ? <button className="joinbtn" disabled={busy} onClick={onMessage ?? dmHuman}><MessageCircle size={13} style={{ verticalAlign: "-2px" }} /> {t("members.dm")}</button> : null;
  return (
    <>
      {onClose ? ( // panel mode (embedded in chat right column: click avatar / name / @mention → profile overlay), mirrors AgentProfile
        <div className="profile-panel-head">
          <Avatar seed={p.name} url={signedAvatar} size={28} />
          <div className="pph-id"><span className="pph-name">{p.displayName || p.name}</span><span className="pph-handle">@{p.name} · {roleLabel(p.role)}</span></div>
          <button className="joinbtn pph-close" title={t("members.close")} aria-label={t("members.close")} onClick={onClose}><X size={14} /></button>
          {dmBtn && <div className="agent-acts">{dmBtn}</div>}
        </div>
      ) : <div className="head head-agent"><AvatarPicker name={p.name} url={signedAvatar} size={48} editable={isMe} busy={avBusy} onPickSeed={onPickSeed} onPickFile={onPickAvatar} /><div className="head-id"><h1>{p.displayName || p.name}</h1><small>@{p.name} · {roleLabel(p.role)}{avErr ? <span className="form-err" style={{ marginLeft: 8 }}>{avErr}</span> : null}</small></div><div className="agent-acts">{dmBtn}</div></div>}
      <div className="scroll">
        <div className="card">
          {edit ? (
            <div className="setform">
              <label>{t("members.humanDescriptionLabel")}</label>
              <textarea value={ds} maxLength={3000} onChange={(e) => setDs(e.target.value)} placeholder={t("common.describeSelfPlaceholder")} />
              <div className="ta-count">{ds.trim().length}/3000</div>
              <div className="setrow"><button className="ok" disabled={busy} onClick={() => void save()}>{t("members.save")}</button><button className="cancel" disabled={busy} onClick={() => setEdit(false)}>{t("members.cancel")}</button></div>
            </div>
          ) : (<>
            <div className="meta">{p.description || t("members.noDescription")}</div>
            <div className="kv"><b>{t("members.role")}</b> {roleLabel(p.role)}</div>
            {p.joinedAt && <div className="kv"><b>{t("members.joined")}</b> {fmtDateTime(p.joinedAt)}</div>}
            {p.email && <div className="kv"><b>{t("members.email")}</b> {p.email}</div>}
            {isMe && <div className="task-acts" style={{ marginTop: 14 }}><button className="joinbtn" onClick={() => { setDs(p.description || ""); setEdit(true); }}>{t("members.editProfile")}</button></div>}
          </>)}
        </div>
        {!isMe && (capabilities.changeMemberRoles || capabilities.manageMembers) && (
          <div className="card">
            <h3>{t("members.memberManagement")}</h3>
            {capabilities.changeMemberRoles && (
              <div className="kv"><b>{t("members.role")}</b> <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, flex: 1 }}><Select ariaLabel={t("members.role")} value={p.role} options={["owner", "admin", "member"].map((r) => ({ value: r, label: roleLabel(r) }))} onChange={async (role) => { setBusy(true); try { const r = await api("PATCH", `/api/servers/${serverId}/members/${uid}`, { role }); if (r?.error) { toast.error(r.error); return; } await refetch(); await reload(); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setBusy(false); } }} /></fieldset></div>
            )}
            {capabilities.manageMembers && <button className="joinbtn" disabled={busy} style={{ color: "var(--error)", marginTop: 12 }} onClick={async () => { if (!(await confirm({ title: t("members.removeMemberTitle", { name: p.name }), message: t("members.removeMemberMessage"), confirmLabel: t("members.remove"), danger: true }))) return; setBusy(true); try { const r = await api("DELETE", `/api/servers/${serverId}/members/${uid}`); if (r?.error) { toast.error(r.error); return; } await reload(); if (onClose) onClose(); else nav(`/s/${slug}/agent`); } catch (error: any) { toast.error(String(error?.message || error)); } finally { setBusy(false); } }}>{t("members.removeMember")}</button>}
          </div>
        )}
        {p.createdAgents?.length > 0 && (
          <div className="card">
            <h3>{t("members.createdAgents")} <small className="meta">· {p.createdAgents.length}</small></h3>
            {p.createdAgents.map((a: any) => (
              <button key={a.id} className="item" onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                <Avatar seed={a.name} url={resolveAvatar(a.avatarUrl, attachmentUrl)} size={20} /><span className="grow">{a.displayName || a.name}</span><span className={"dot " + a.status} role="img" aria-label={t("members.statusLabel", { status: a.status })} title={a.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// Three-mode restart modal: Restart / Reset Session & Restart / Full Reset & Restart
function RestartModal({ name, onClose, onPick }: { name: string; onClose: () => void; onPick: (mode: "restart" | "reset" | "full") => void }) {
  const { t } = useTranslation();
  const dialogRef = useDialogFocus(onClose);
  const [mode, setMode] = useState<"restart" | "reset" | "full">("restart");
  const opts: { k: "restart" | "reset" | "full"; title: string; desc: string }[] = [
    { k: "restart", title: t("members.restart"), desc: t("members.restartDesc") },
    { k: "reset", title: t("members.restartOptReset"), desc: t("members.resetDesc") },
    { k: "full", title: t("members.restartOptFull"), desc: t("members.fullResetDesc") },
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="restart-agent-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3 id="restart-agent-title">{t("members.restartTitle", { name })}</h3>
        <div className="restart-opts">
          {opts.map((o) => (
            <button key={o.k} type="button" className={"restart-opt" + (mode === o.k ? " on" : "")} onClick={() => setMode(o.k)}>
              <div className="ro-title">{o.title}</div>
              <div className="ro-desc">{o.desc}</div>
            </button>
          ))}
        </div>
        <div className="acts"><button className="cancel" onClick={onClose}>{t("members.cancel")}</button><button className="ok" onClick={() => onPick(mode)}>{t("members.restart")}</button></div>
      </div>
    </div>
  );
}
