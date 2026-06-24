import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, Wrench, ChevronRight, Check, Copy, Eye, EyeOff } from "lucide-react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeSanitize from "rehype-sanitize";
import { useTranslation } from "react-i18next";
import { useStore, fmtTime } from "../store.tsx";
import { IconMonitor } from "../icons.tsx";
import { Avatar } from "../Avatar.tsx";
import { Select } from "../Select.tsx";
import { useConfirm, useEscClose } from "../ConfirmModal.tsx";
import i18n from "../i18n";

// Unified agent status label: fine-grained activity (working/thinking/online) takes priority;
// offline/absent falls back to lifecycle status (active/sleeping/inactive).
// Shared by sidebar and roster to keep both views in sync (daemon emits activity=sleeping when idle-sleeping).
function statusOf(a: { activity?: string | null; status: string }): string {
  return a.activity && a.activity !== "offline" ? a.activity : a.status;
}

export function Members() {
  const { t } = useTranslation();
  const { agents, humans, machines, slug, capabilities } = useStore();
  const { agentId, userId } = useParams();
  const nav = useNavigate();
  const [modal, setModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);

  const byMachine: Record<string, typeof agents> = {};
  for (const a of agents) { const k = a.machineId || "_none"; (byMachine[k] = byMachine[k] || []).push(a); }
  const mName = (id: string) => { const m = machines.find((x) => x.id === id); return m?.name || m?.hostname || i18n.t("members.unassigned"); };

  return (
    <>
      <aside className="sidebar">
        <div className="sb-title">{t("nav.members")}</div>
        <div className="sec">{t("common.agents")} <span><span className="cnt">{agents.length}</span> {capabilities.manageAgents && <button className="addbtn" title={t("members.createAgent")} onClick={() => setModal(true)}>+</button>}</span></div>
        {Object.keys(byMachine).map((k) => (
          <div key={k}>
            <div className="machine"><IconMonitor size={13} /> {k === "_none" ? t("members.unassigned") : mName(k)}</div>
            {byMachine[k].map((a) => (
              <button key={a.id} className={"item" + (a.id === agentId ? " active" : "")} onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                <Avatar seed={a.name} size={20} /><span className="grow">{a.name}</span><span className={"dot " + statusOf(a)} role="img" aria-label={t("members.statusLabel", { status: statusOf(a) })} title={statusOf(a)} />
              </button>
            ))}
          </div>
        ))}
        <div className="sec">{t("common.humans")} <span><span className="cnt">{humans.length}</span> {capabilities.manageMembers && <button className="addbtn" title={t("members.inviteMember")} onClick={() => setInviteModal(true)}>+</button>}</span></div>
        {humans.map((u) => (
          <button key={u.userId} className={"item" + (u.userId === userId ? " active" : "")} onClick={() => nav(`/s/${slug}/human/${u.userId}`)}>
            <Avatar seed={u.name} size={20} /><span className="grow">{u.displayName || u.name}</span>
          </button>
        ))}
      </aside>
      <main className="content-col">
        {userId ? <HumanProfile uid={userId} /> : agentId ? <AgentProfile id={agentId} onDeleted={() => nav(`/s/${slug}/agent`)} /> : <Roster agents={agents} onCreate={() => setModal(true)} canCreate={!!capabilities.manageAgents} />}
      </main>
      {modal && <CreateAgentModal onClose={() => setModal(false)} />}
      {inviteModal && <InviteHumanModal onClose={() => setInviteModal(false)} />}
    </>
  );
}

// Invite member entry point: automatically fetches or creates a member join-link for display and copy. Email invitations require a mail service.
function InviteHumanModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const { api, serverId } = useStore();
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { (async () => {
    const links = await api("GET", `/api/servers/${serverId}/join-links`).catch(() => []);
    let l = Array.isArray(links) ? links.find((x: any) => x.role === "member") : null;
    if (!l) l = await api("POST", `/api/servers/${serverId}/join-links`, { role: "member", maxUses: null });
    if (l?.token) setLink(`${location.origin}/join/${l.token}`);
  })(); /* eslint-disable-next-line */ }, [serverId]);
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("members.inviteTitle")}</h3>
        <p className="modal-note">{t("members.inviteNote")}</p>
        <label>{t("members.inviteLinkLabel")}</label>
        <input readOnly value={link || t("members.inviteLinkGenerating")} onFocus={(e) => e.currentTarget.select()} />
        <div className="acts">
          <button className="cancel" onClick={onClose}>{t("members.close")}</button>
          <button className="ok" onClick={copy} disabled={!link}>{copied ? t("members.copied") : t("members.copyLink")}</button>
        </div>
      </div>
    </div>
  );
}

function Roster({ agents, onCreate, canCreate }: { agents: any[]; onCreate: () => void; canCreate?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="head"><h1>{t("nav.members")}</h1><small>{t("common.agentsCount", { count: agents.length })}</small></div>
      <div className="scroll">
        {agents.length === 0 ? <div className="empty">{t("members.rosterEmpty")}{canCreate && <> {t("members.rosterEmptyCreate")} <button className="addbtn" onClick={onCreate}>+</button></>}</div>
          : agents.map((a) => (
            <div className="card" key={a.id}>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar seed={a.name} size={24} />{a.displayName || a.name} <small className="meta">@{a.name}</small></h3>
              <div className="meta">{a.description || t("members.generalAgent")}</div>
              <div className="kv"><b>{t("common.runtime")}</b> {a.runtime} · {a.model || ""}</div>
              <div className="kv"><b>{t("common.status")}</b> {statusOf(a)}</div>
            </div>
          ))}
      </div>
    </>
  );
}

export function AgentProfile({ id, onDeleted, onClose, onMessage }: { id: string; onDeleted: () => void; onClose?: () => void; onMessage?: () => void }) {
  const { t } = useTranslation();
  const { api, reload, onEvent, capabilities, openDM, slug, uploadAgentAvatar, attachmentUrl } = useStore();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get("agentTab") || "profile";
  const [a, setA] = useState<any>(null);
  const [edit, setEdit] = useState(false); const [dn, setDn] = useState(""); const [ds, setDs] = useState(""); // profile edit state (displayName/description)
  const [showRestart, setShowRestart] = useState(false);
  const [avBusy, setAvBusy] = useState(false); const [avErr, setAvErr] = useState(""); const [signedAvatar, setSignedAvatar] = useState<string | null>(null);
  const avFileRef = useRef<HTMLInputElement>(null);
  const refetch = async () => { const data = await api("GET", "/api/agents/" + id); setA(data); setSignedAvatar(data?.avatarUrl ? attachmentUrl(data.avatarUrl.replace("/api/attachments/", "")) : null); };
  useEffect(() => { refetch(); }, [id]);
  useEffect(() => onEvent((e) => { if (e.type === "agent" && e.id === id) setA((p: any) => (p ? { ...p, status: e.status ?? p.status, activity: e.activity ?? p.activity } : p)); }), [id]);
  const onPickAvatar = async (e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setAvBusy(true); setAvErr(""); try { const url = await uploadAgentAvatar(id, f); setSignedAvatar(url); await refetch(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  if (!a) return <div className="scroll"><div className="empty">{t("members.loading")}</div></div>;
  const ctl = async (action: string) => { await api("POST", `/api/agents/${id}/${action}`); setTimeout(refetch, 400); };
  // Three restart modes: restart=keep session+workspace; reset=clear session, keep workspace; full=clear session+delete workspace. All modes end with a restart.
  const doRestart = async (mode: "restart" | "reset" | "full") => {
    setShowRestart(false);
    if (mode === "restart") await api("POST", `/api/agents/${id}/restart`);
    else if (mode === "reset") await api("POST", `/api/agents/${id}/reset`, { restart: true });
    else await api("POST", `/api/agents/${id}/reset`, { wipeWorkspace: true, restart: true });
    setTimeout(refetch, 500);
  };
  const del = async () => { if (!(await confirm({ title: t("members.deleteAgentTitle", { name: a.name }), message: t("members.deleteAgentMessage"), confirmLabel: t("members.delete"), danger: true }))) return; await api("DELETE", "/api/agents/" + id); await reload(); onDeleted(); };
  const startEdit = () => { setDn(a.displayName || a.name); setDs(a.description || ""); setEdit(true); };
  const saveProfile = async () => { await api("PATCH", "/api/agents/" + id, { displayName: dn.trim() || a.name, description: ds.trim() }); setEdit(false); await refetch(); await reload(); }; // profile tab: editable displayName/description
  const live = statusOf(a);
  const msgAgent = async () => { const cid = await openDM("agent", id); if (cid) nav(`/s/${slug}/channel/${cid}`); };
  // Header action bar: Message available to everyone; start/stop/restart/delete gated by manageAgents capability
  const acts = (
    <div className="agent-acts">
      <button className="joinbtn" onClick={onMessage ?? msgAgent}><MessageCircle size={13} style={{ verticalAlign: "-2px" }} /> {t("members.dm")}</button>
      {capabilities.manageAgents && <>
        <button className="joinbtn" onClick={() => ctl(a.status === "active" ? "stop" : "start")}>{a.status === "active" ? t("members.stop") : t("members.start")}</button>
        <button className="joinbtn" onClick={() => setShowRestart(true)}>{t("members.restart")}</button>
        <button className="joinbtn" style={{ color: "var(--error)" }} onClick={del}>{t("members.delete")}</button>
      </>}
    </div>
  );
  return (
    <>
      {onClose ? ( // panel mode (embedded in chat right sidebar: click avatar → profile panel)
        <div className="profile-panel-head">
          <Avatar seed={a.name} url={signedAvatar} size={28} />
          <div className="pph-id"><span className="pph-name">{a.displayName || a.name} <span className={"dot " + live} /></span><span className="pph-handle">@{a.name}</span></div>
          <button className="joinbtn pph-close" title={t("members.close")} onClick={onClose}><X size={14} /></button>
          {acts}
        </div>
      ) : <div className="head head-agent"><Avatar seed={a.name} url={signedAvatar} size={48} /><div><h1>{a.displayName || a.name}</h1><small>@{a.name} <span className={"dot " + live} /></small></div>{acts}</div>}
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
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setSp({ agentTab: k })}>{label}</button>
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
                  <input type="file" ref={avFileRef} accept="image/*" style={{ display: "none" }} onChange={onPickAvatar} />
                  <div className="avatar-edit">
                    {signedAvatar ? <img className="avatar-edit-img" src={signedAvatar} alt="" /> : <Avatar seed={a.name} size={56} />}
                    <div><button type="button" disabled={avBusy} onClick={() => avFileRef.current?.click()}>{avBusy ? t("misc.serverAvatarUploading") : signedAvatar ? t("misc.serverAvatarChange") : t("misc.serverAvatarUpload")}</button>
                    {avErr && <div className="form-err" style={{ marginTop: 6 }}>{avErr}</div>}</div>
                  </div>
                  <label>{t("members.displayName")}</label><input value={dn} onChange={(e) => setDn(e.target.value)} placeholder={a.name} />
                  <label>{t("members.agentDescriptionLabel")}</label><textarea value={ds} maxLength={3000} onChange={(e) => setDs(e.target.value)} placeholder={t("members.agentDescriptionPlaceholder")} />
                  <div className="ta-count">{ds.trim().length}/3000</div>
                  <div className="setrow"><button className="ok" onClick={saveProfile}>{t("members.save")}</button><button className="cancel" onClick={() => setEdit(false)}>{t("members.cancel")}</button></div>
                </div>
              ) : (<>
                <div className="meta">{a.description || t("members.generalAgent")}</div>
                <div className="kv"><b>{t("common.runtime")}</b> {a.runtime}</div>
                <div className="kv"><b>{t("common.model")}</b> {a.model || ""}</div>
                {a.runtimeConfig?.reasoningEffort && <div className="kv"><b>{t("common.reasoning")}</b> {a.runtimeConfig.reasoningEffort}</div>}
                <div className="kv"><b>{t("common.status")}</b> <span className="kv-v"><span className={"dot " + live} /> {live}</span></div>
                <div className="kv"><b>{t("common.session")}</b> {a.sessionId || "(none)"}</div>
                <div className="kv"><b>{t("common.workspace")}</b> ~/.open-tag/agents/{a.id}</div>
                {capabilities.manageAgents && <div className="task-acts" style={{ marginTop: 14 }}>
                  <button className="joinbtn" onClick={startEdit}>{t("members.editProfile")}</button>
                </div>}
              </>)}
            </div>
            <SkillsSection id={id} />
          </div>
        )}
      {showRestart && <RestartModal name={a.displayName || a.name} onClose={() => setShowRestart(false)} onPick={doRestart} />}
    </>
  );
}

// Profile tab SKILLS section (GET /api/agents/:id/skills — daemon reads skills from the host machine)
function SkillsSection({ id }: { id: string }) {
  const { t } = useTranslation();
  const { api } = useStore();
  const [d, setD] = useState<{ global: any[]; workspace: any[] } | null>(null);
  useEffect(() => { (async () => { try { setD(await api("GET", `/api/agents/${id}/skills`)); } catch { setD({ global: [], workspace: [] }); } })(); }, [id]);
  if (!d) return null;
  const all = [...(d.workspace || []).map((s) => ({ ...s, scope: t("members.scopeWorkspace") })), ...(d.global || []).map((s) => ({ ...s, scope: t("members.scopeGlobal") }))];
  return (
    <>
      <div className="sec">{t("common.skills")} <span className="cnt">{all.length}</span></div>
      {all.length === 0 ? <div className="empty">{t("members.skillsEmpty")}</div>
        : all.map((s, i) => (
          <div className="card skill-row" key={i} title={`${s.displayName || s.name}${s.description ? "\n\n" + s.description : ""}`}>
            <div className="who">{s.displayName || s.name} <span className="meta">· {s.scope}{s.userInvocable ? ` · ${t("members.skillInvocable")}` : ""}</span></div>
            {s.description ? <div className="meta skill-desc">{s.description}</div> : <div className="meta" style={{ opacity: .6 }}>{t("members.noDescription")}</div>}
          </div>
        ))}
    </>
  );
}

// Permissions tab (GET/PUT /api/agents/:id/scopes — grouped scope checkboxes with enforcement)
function PermissionsTab({ id }: { id: string }) {
  const { t } = useTranslation();
  const { api } = useStore();
  const [data, setData] = useState<any>(null);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  useEffect(() => { (async () => { const d = await api("GET", `/api/agents/${id}/scopes`); setData(d); setGranted(new Set(d.granted || [])); })(); }, [id]);
  if (!data) return <div className="scroll"><div className="empty">{t("members.loading")}</div></div>;
  const toggle = (k: string) => setGranted((g) => { const n = new Set(g); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const save = async (scopes: string[]) => { const d = await api("PUT", `/api/agents/${id}/scopes`, { scopes }); setData({ ...data, ...d }); setGranted(new Set(d.granted || [])); setSaved(true); setTimeout(() => setSaved(false), 1500); };
  const groups: Record<string, any[]> = {};
  for (const s of data.catalog || []) (groups[s.group] ||= []).push(s);
  return (
    <div className="scroll">
      <div className="perm-head">
        <span className="meta">{data.mode === "custom" ? t("members.permCustom") : t("members.permDefault")} · rev {data.revision}</span>
        <button className="joinbtn" onClick={() => save((data.catalog || []).map((s: any) => s.key))}>{t("members.grantAll")}</button>
        <button className="ok" style={{ marginLeft: "auto" }} onClick={() => save([...granted])}>{t("members.save")}</button>
        {saved && <span className="saved">{t("members.savedConfirm")}</span>}
      </div>
      {Object.entries(groups).map(([g, list]) => (
        <div key={g} className="perm-group">
          <div className="sec sec-sub">{g}</div>
          {list.map((s: any) => (
            <label key={s.key} className="perm-row">
              <input type="checkbox" checked={granted.has(s.key)} onChange={() => toggle(s.key)} />
              <span className="grow"><span className="who">{s.label}</span> <code className="perm-key">{s.key}</code><div className="meta">{s.description}</div></span>
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
  scheduled: i18n.t("members.remScheduled"),
  fired: i18n.t("members.remFired"),
  cancelled: i18n.t("members.remCancelled"),
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
          <div className="meta"><span className={"rem-badge " + (r.status || "scheduled")}>{REM_STATUS[r.status] || r.status}</span> · {fmtTime(r.remindAt)}</div>
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
  const time = (ts: number) => { try { return new Date(ts).toLocaleTimeString(undefined, { hour12: false }); } catch { return ""; } };
  const entryOf = (e: any) => ({ ...e, kind: e.kind === "tool" ? "tool_start" : e.kind });
  const visible = (e: any) => !(e.kind === "status" && !e.activity && !e.detail) && !(e.kind === "tool_start" && e.toolName === "agentMessage" && !e.text);
  return (
    <div className="scroll" ref={scrollRef}>
      {items.length === 0 ? <div className="empty">{t("members.activityEmpty", { name })}</div>
        : <div className="actlog">{items.filter((it) => visible(entryOf(it.entry))).map((it, i) => {
          const e = entryOf(it.entry); const t2 = time(it.timestamp);
          if (e.kind === "tool_start") return <div className="act" key={i}><span className="act-t">{t2}</span><span className="act-tool"><Wrench size={11} /> {e.toolName}</span><span className="act-x mono">{e.toolInput}</span></div>;
          if (e.kind === "text") return <div className="act" key={i}><span className="act-t">{t2}</span><span className="act-x">{e.text}</span></div>;
          return <div className="act" key={i}><span className="act-t">{t2}</span><span className={"dot " + (e.activity || "")} /><span className="act-x muted">{e.activity}{e.detail ? " · " + e.detail : ""}</span></div>;
        })}</div>}
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
  const root = `~/.open-tag/agents/${id}/`; // workspace root path template, matches daemon DATA_DIR
  useEffect(() => { setSel(null); setExpanded(new Set()); (async () => { const d = await api("GET", `/api/agents/${id}/workspace-files`); if (d.error) { setErr(d.error); setFiles([]); } else { setErr(""); setFiles(d.files || []); } })(); }, [id]);
  const open = async (f: any) => { setMode("preview"); const d = await api("GET", `/api/agents/${id}/workspace-files/read?path=${encodeURIComponent(f.path)}`); setSel({ path: f.path, content: d.content, error: d.error }); };
  const toggleDir = (path: string) => setExpanded((s) => { const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n; });
  const copyRoot = () => navigator.clipboard?.writeText(root).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
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
                    <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>Preview</button>
                    <button className={mode === "raw" ? "on" : ""} onClick={() => setMode("raw")}>Raw</button>
                  </span>}
                </div>
                {isMd && mode === "preview"
                  ? <div className="ws-md"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeSanitize]}>{sel.content || ""}</ReactMarkdown></div>
                  : <pre className="ws-content">{sel.content}</pre>}
              </>}
      </div>
    </div>
  );
}

export function CreateAgentModal({ onClose, prefill, onCreated }: { onClose: () => void; prefill?: { name?: string; description?: string }; onCreated?: (r: { id: string; name: string }) => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const { api, serverId, machines, reload } = useStore();
  const [name, setName] = useState(prefill?.name ?? ""); const [desc, setDesc] = useState(prefill?.description ?? "");
  const [machineId, setMachineId] = useState(machines[0]?.id || "");
  const [runtime, setRuntime] = useState("claude"); const [model, setModel] = useState("");
  const [models, setModels] = useState<{ id: string; label?: string }[]>([]); const [fast, setFast] = useState(false);
  const [reasoning, setReasoning] = useState(""); // codex reasoning effort (""=Default, no override)
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { (async () => { try { const d = await api("GET", `/api/servers/${serverId}/machines/${machineId || "none"}/runtime-models/${runtime}`); const ms = d.models || []; setModels(ms); setModel(ms[0]?.id || ""); } catch { setModels([]); } })(); }, [runtime, machineId]);
  const create = async () => {
    const nm = name.trim();
    if (!nm) { setErr(t("members.nameRequired")); return; }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(nm) || nm.length > 64) { setErr(t("members.nameInvalid")); return; } // @mention handle must be machine-safe; keep regex + length 64 in sync with core.ts AGENT_NAME_RE / MAX_AGENT_NAME
    setBusy(true); setErr("");
    try { const r = await api("POST", "/api/agents", { machineId: machineId || null, name: nm, description: desc.trim() || null, runtime, model: model || null, reasoning: runtime === "codex" ? (reasoning || null) : null, fastMode: fast }); await reload(); if (r?.id) onCreated?.({ id: r.id, name: r.name ?? nm }); onClose(); }
    catch (e: any) { setErr(String(e?.message || e)); } finally { setBusy(false); }
  };
  const RUNTIMES = [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }, { value: "gemini", label: "Gemini" }, { value: "opencode", label: "OpenCode" }];
  const machineOpts = machines.length ? machines.map((m) => ({ value: m.id, label: m.name || m.hostname || m.id, hint: m.status === "online" ? t("members.machineOnline") : t("members.machineOffline") })) : [];
  const modelOpts = (models.length ? models : [{ id: "default", label: "Default" }]).map((m) => ({ value: m.id, label: m.label || m.id }));
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("members.createAgentTitle")}</h3>
        <label>{t("members.computerLabel")}</label>
        <Select ariaLabel={t("members.computerAriaLabel")} value={machineId} options={machineOpts} onChange={setMachineId} placeholder={t("members.noMachineOnline")} />
        <label>{t("members.nameLabel")}</label><input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t("members.namePlaceholder")} />
        <label>{t("members.descriptionLabel")}</label><textarea value={desc} maxLength={3000} onChange={(e) => setDesc(e.target.value)} placeholder={t("members.descriptionPlaceholder")} />
        <label>Runtime</label>
        <Select ariaLabel="Runtime" value={runtime} options={RUNTIMES} onChange={setRuntime} />
        <label>{t("common.model")}</label>
        <Select ariaLabel="Model" value={model} options={modelOpts} onChange={setModel} />
        {runtime === "codex" && <>
          <label>{t("members.reasoningLabel")}</label>
          <Select ariaLabel="Reasoning" value={reasoning} onChange={setReasoning}
            options={[{ value: "", label: t("members.reasoningDefault") }, { value: "minimal", label: "Minimal" }, { value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }, { value: "xhigh", label: "XHigh" }]} />
        </>}
        <label className="ck-row"><input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} /><span>{t("members.fastMode")}</span></label>
        {err && <div className="form-err">{err}</div>}
        <div className="acts"><button className="cancel" onClick={onClose}>{t("members.cancel")}</button><button className="ok" onClick={create} disabled={busy}>{busy ? t("members.creating") : t("members.create")}</button></div>
      </div>
    </div>
  );
}

// Human member profile (HumanDetailPanel): shows info/role/Created Agents; the member themselves can edit their own description (max 3000 chars).
// Description is visible to other humans and agents in the server; agents fetch it via `open-tag server info` for collaboration context.
function HumanProfile({ uid }: { uid: string }) {
  const { t } = useTranslation();
  const { api, serverId, me, reload, slug, capabilities, uploadUserAvatar, attachmentUrl } = useStore();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [p, setP] = useState<any>(null);
  const [edit, setEdit] = useState(false); const [ds, setDs] = useState("");
  const [avBusy, setAvBusy] = useState(false); const [avErr, setAvErr] = useState(""); const [signedAvatar, setSignedAvatar] = useState<string | null>(null);
  const avFileRef = useRef<HTMLInputElement>(null);
  const refetch = async () => { const data = await api("GET", `/api/servers/${serverId}/members/${uid}/profile`); setP(data); setSignedAvatar(data?.avatarUrl ? attachmentUrl(data.avatarUrl.replace("/api/attachments/", "")) : null); };
  useEffect(() => { setP(null); setSignedAvatar(null); refetch(); }, [uid, serverId]);
  const onPickAvatar = async (e: any) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setAvBusy(true); setAvErr(""); try { const url = await uploadUserAvatar(f); setSignedAvatar(url); await refetch(); await reload(); } catch (err: any) { setAvErr(String(err?.message || err)); } finally { setAvBusy(false); } };
  if (!p) return <div className="scroll"><div className="empty">{t("members.loading")}</div></div>;
  const isMe = me?.id === uid;
  const save = async () => { await api("PATCH", "/api/auth/me", { description: ds.trim() }); setEdit(false); await refetch(); await reload(); };
  return (
    <>
      <div className="head"><h1 style={{ display: "flex", alignItems: "center", gap: 8 }}><Avatar seed={p.name} url={signedAvatar} size={26} />{p.displayName || p.name}</h1><small>@{p.name} · {p.role}</small></div>
      <input type="file" ref={avFileRef} accept="image/*" style={{ display: "none" }} onChange={onPickAvatar} />
      <div className="scroll">
        <div className="card">
          {edit ? (
            <div className="setform">
              {isMe && (
                <div className="avatar-edit">
                  {signedAvatar ? <img className="avatar-edit-img" src={signedAvatar} alt="" /> : <Avatar seed={p.name} size={56} />}
                  <div><button type="button" disabled={avBusy} onClick={() => avFileRef.current?.click()}>{avBusy ? t("misc.serverAvatarUploading") : signedAvatar ? t("misc.serverAvatarChange") : t("misc.serverAvatarUpload")}</button>
                  {avErr && <div className="form-err" style={{ marginTop: 6 }}>{avErr}</div>}</div>
                </div>
              )}
              <label>{t("members.humanDescriptionLabel")}</label>
              <textarea value={ds} maxLength={3000} onChange={(e) => setDs(e.target.value)} placeholder="Describe yourself for other humans and agents in this server" />
              <div className="ta-count">{ds.trim().length}/3000</div>
              <div className="setrow"><button className="ok" onClick={save}>{t("members.save")}</button><button className="cancel" onClick={() => setEdit(false)}>{t("members.cancel")}</button></div>
            </div>
          ) : (<>
            <div className="meta">{p.description || "No description"}</div>
            <div className="kv"><b>{t("members.role")}</b> {p.role}</div>
            {p.joinedAt && <div className="kv"><b>{t("members.joined")}</b> {fmtTime(p.joinedAt)}</div>}
            {isMe && p.email && <div className="kv"><b>{t("members.email")}</b> {p.email}</div>}
            {isMe && <div className="task-acts" style={{ marginTop: 14 }}><button className="joinbtn" onClick={() => { setDs(p.description || ""); setEdit(true); }}>{t("members.editProfile")}</button></div>}
          </>)}
        </div>
        {!isMe && (capabilities.changeMemberRoles || capabilities.manageMembers) && (
          <div className="card">
            <h3>{t("members.memberManagement")}</h3>
            {capabilities.changeMemberRoles && (
              <div className="kv"><b>{t("members.role")}</b> <select className="role-sel" value={p.role} onChange={async (e) => { const role = e.target.value; const r = await api("PATCH", `/api/servers/${serverId}/members/${uid}`, { role }); if (r?.error) { alert(r.error); return; } await refetch(); await reload(); }}>
                <option value="owner">owner</option><option value="admin">admin</option><option value="member">member</option>
              </select></div>
            )}
            {capabilities.manageMembers && <button className="joinbtn" style={{ color: "var(--error)", marginTop: 12 }} onClick={async () => { if (!(await confirm({ title: t("members.removeMemberTitle", { name: p.name }), message: t("members.removeMemberMessage"), confirmLabel: t("members.remove"), danger: true }))) return; const r = await api("DELETE", `/api/servers/${serverId}/members/${uid}`); if (r?.error) { alert(r.error); return; } await reload(); nav(`/s/${slug}/agent`); }}>{t("members.removeMember")}</button>}
          </div>
        )}
        {p.createdAgents?.length > 0 && (
          <div className="card">
            <h3>Created Agents <small className="meta">· {p.createdAgents.length}</small></h3>
            {p.createdAgents.map((a: any) => (
              <button key={a.id} className="item" onClick={() => nav(`/s/${slug}/agent/${a.id}`)}>
                <Avatar seed={a.name} size={20} /><span className="grow">{a.displayName || a.name}</span><span className={"dot " + a.status} role="img" aria-label={t("members.statusLabel", { status: a.status })} title={a.status} />
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
  useEscClose(onClose);
  const [mode, setMode] = useState<"restart" | "reset" | "full">("restart");
  const opts: { k: "restart" | "reset" | "full"; title: string; desc: string }[] = [
    { k: "restart", title: "Restart", desc: t("members.restartDesc") },
    { k: "reset", title: "Reset Session & Restart", desc: t("members.resetDesc") },
    { k: "full", title: "Full Reset & Restart", desc: t("members.fullResetDesc") },
  ];
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("members.restartTitle", { name })}</h3>
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
