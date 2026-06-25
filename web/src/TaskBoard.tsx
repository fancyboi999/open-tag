// Task board shared between the channel chatTab=tasks view and the global Tasks page.
// Five-status columns + Board/List toggle + Board layout toggle (horizontal columns ↔ vertical stack, persisted) (pure frontend) + Creator/Assignee filters (pure frontend, applied over the loaded array) + New Task (POST /api/tasks/channel/:id).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trash2, ChevronDown, ChevronRight, Pencil, Columns3, Rows3, ListChecks } from "lucide-react";
import { DndContext, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore, type Msg } from "./store.tsx";
import { Select } from "./Select.tsx";
import { useEscClose } from "./ConfirmModal.tsx";
import { PaneEmpty } from "./PaneEmpty.tsx";
import i18n from "./i18n";

const TCOLS: [string, string][] = [
  ["todo", "tasks.statusTodo"],
  ["in_progress", "tasks.statusInProgress"],
  ["in_review", "tasks.statusInReview"],
  ["done", "tasks.statusDone"],
  ["closed", "tasks.statusClosed"],
];
export const ST_LABEL: Record<string, string> = {
  todo: "tasks.statusTodo",
  in_progress: "tasks.statusInProgress",
  in_review: "tasks.statusInReview",
  done: "tasks.statusDone",
  closed: "tasks.statusClosed",
};
// Status dropdown permission rules: server admins see all options; assignees see a restricted set based on current status; server does not re-validate — this is UI-only guidance
export const ynOptions = (status: string, manageServer: boolean, claimedByMe: boolean): string[] => {
  if (manageServer) return ["todo", "in_progress", "in_review", "done", "closed"];
  if (claimedByMe && status === "todo") return ["todo", "in_progress", "closed"];
  if (claimedByMe && status === "in_progress") return ["in_progress", "in_review", "done", "closed"];
  if (claimedByMe && status === "in_review") return ["in_review", "done", "in_progress", "closed"];
  if (status === "in_review") return ["in_review", "done"]; // anyone can approve an in-review task
  return [];
};

// channelId = null means global scope (all tasks across channels); creating new tasks is disabled in global scope because tasks must belong to a specific channel
export function TaskBoard({ channelId, onOpenThread }: { channelId: string | null; onOpenThread?: (t: Msg) => void }) {
  const { t } = useTranslation();
  const { api, onEvent, agents, humans, me, myRole, channels, dms, createTasks, slug } = useStore();
  const manageServer = myRole === "owner" || myRole === "admin"; // determines the status dropdown permission set
  const nav = useNavigate();
  // Click on a task card/row → navigate to the source message (highlighted); cross-channel tasks use the task's own channelId
  const goSrc = (t: Msg) => nav(`/s/${slug}/channel/${t.channelId}?msg=${t.id}`);
  // Clicking a card opens the task's thread panel (tasks are threads); falls back to source message navigation when no thread context is available (global Tasks page)
  const open = (task: Msg) => (onOpenThread ? onOpenThread(task) : goSrc(task));
  const [tasks, setTasks] = useState<Msg[]>([]);
  const [view, setView] = useState<"board" | "list">("board");
  // DONE and CLOSED columns are collapsed by default, with the state persisted to localStorage
  const [collapsed, setCollapsed] = useState<Set<string>>(() => { try { const s = localStorage.getItem("open-tag.tasks.collapsed"); return new Set<string>(s ? JSON.parse(s) : ["done", "closed"]); } catch { return new Set(["done", "closed"]); } });
  const toggleCol = (k: string) => setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); try { localStorage.setItem("open-tag.tasks.collapsed", JSON.stringify([...n])); } catch { /* */ } return n; });
  // Board layout: horizontal Kanban columns (default) vs the legacy vertical stack; persisted like `collapsed`.
  const [boardLayout, setBoardLayout] = useState<"columns" | "stack">(() => { try { return localStorage.getItem("open-tag.tasks.boardLayout") === "stack" ? "stack" : "columns"; } catch { return "columns"; } });
  const setLayout = (l: "columns" | "stack") => { setBoardLayout(l); try { localStorage.setItem("open-tag.tasks.boardLayout", l); } catch { /* */ } };
  const [creatorKey, setCreatorKey] = useState(""); // "" = all | "me" | "type:id"
  const [assigneeKey, setAssigneeKey] = useState(""); // "" = all | "unclaimed" | "type:id"
  const [mkOpen, setMkOpen] = useState(false);

  const path = channelId ? `/api/tasks/channel/${channelId}` : "/api/tasks/server";
  const load = async () => { const d = await api("GET", path); setTasks(d.tasks || []); };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [channelId]);
  useEffect(() => onEvent((e) => {
    if (e.type !== "task") return;
    if (e.op === "deleted") { setTasks((cur) => cur.filter((x) => x.id !== e.taskId)); return; } // task deleted → remove from board
    const task: Msg = e.task;
    if (channelId && task.channelId !== channelId) return;
    setTasks((cur) => { const rest = cur.filter((x) => x.id !== task.id); return [...rest, task].sort((a, b) => (a.taskNumber || 0) - (b.taskNumber || 0)); });
  }), [channelId]);

  const act = async (task: Msg, action: string, body?: unknown) => { await api("PATCH", `/api/tasks/${task.id}/${action}`, body); load(); };
  const delTask = async (task: Msg) => { await api("DELETE", `/api/tasks/${task.id}`); load(); }; // deleting a task reverts it to a plain message (clears task fields); the source message is preserved
  const nameOf = (type?: string | null, id?: string | null) => {
    if (!type || !id) return "";
    if (type === "agent") { const a = agents.find((x) => x.id === id); return a?.displayName || a?.name || "agent"; }
    if (id === me?.id) return me?.displayName || me?.name || t("tasks.me");
    const h = humans.find((x) => x.userId === id); return h?.displayName || h?.name || t("tasks.me");
  };

  // Filter options: deduplicated creator / assignee lists derived from the loaded tasks (pure frontend filtering)
  const creators = useMemo(() => {
    const m = new Map<string, { key: string; name: string }>();
    for (const task of tasks) { const k = `${task.senderType}:${task.senderId}`; if (!m.has(k)) m.set(k, { key: k, name: task.senderName }); }
    return [...m.values()];
  }, [tasks]);
  const assignees = useMemo(() => {
    const m = new Map<string, { key: string; name: string }>();
    for (const task of tasks) { if (!task.taskAssigneeId) continue; const k = `${task.taskAssigneeType}:${task.taskAssigneeId}`; if (!m.has(k)) m.set(k, { key: k, name: nameOf(task.taskAssigneeType, task.taskAssigneeId) }); }
    return [...m.values()];
  }, [tasks, agents, humans]);

  const filtered = tasks.filter((task) => {
    if (creatorKey === "me" ? task.senderId !== me?.id : creatorKey && `${task.senderType}:${task.senderId}` !== creatorKey) return false;
    if (assigneeKey === "unclaimed" ? !!task.taskAssigneeId : assigneeKey && `${task.taskAssigneeType}:${task.taskAssigneeId}` !== assigneeKey) return false;
    return true;
  });
  const groups: Record<string, Msg[]> = { todo: [], in_progress: [], in_review: [], done: [], closed: [] };
  for (const task of filtered) (groups[task.taskStatus || "todo"] ||= []).push(task);

  const submit = async (titles: string[]) => { if (channelId && titles.length) { await createTasks(channelId, titles); setMkOpen(false); load(); } };

  // Status pill / dropdown: unclaimed tasks show a claim pill; editable statuses show a pill with a pencil icon; read-only statuses show a plain pill
  const StatusPill = ({ t: task }: { t: Msg }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ right: number; top: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const status = task.taskStatus || "todo";
    const claimedByMe = task.taskAssigneeType === "human" && task.taskAssigneeId === me?.id;
    // Fixed positioning from the button rect (same approach as Select.tsx): each card sits in its own
    // transform-induced stacking context, so an `absolute` menu is trapped beneath the next card no
    // matter its z-index. A fixed, body-relative menu escapes that. Right-aligned to the pill.
    useLayoutEffect(() => { if (!open) return; const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ right: window.innerWidth - r.right, top: r.bottom + 4 }); }, [open]);
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => { const n = e.target as Node; if (!btnRef.current?.contains(n) && !menuRef.current?.contains(n)) setOpen(false); };
      const onScroll = () => setOpen(false); // any scroll closes it (the fixed coords would otherwise drift)
      const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
      document.addEventListener("mousedown", onDown);
      window.addEventListener("scroll", onScroll, true);
      document.addEventListener("keydown", onKey);
      return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("scroll", onScroll, true); document.removeEventListener("keydown", onKey); };
    }, [open]);
    // Unclaimed todo task → show claim pill (atomic claim, automatically sets status to in_progress)
    if (!task.taskAssigneeId && status === "todo") return <button className="claim-pill" onClick={(e) => { e.stopPropagation(); act(task, "claim"); }}>{t("tasks.claim")}</button>;
    const opts = ynOptions(status, manageServer, claimedByMe);
    const canEdit = opts.length > 0;
    const pill = <span className={"st-pill st-" + status}>{t(ST_LABEL[status])}{canEdit && <Pencil size={10} />}</span>;
    if (!canEdit) return pill; // read-only pill (no pencil icon)
    return (
      <span className="st-pill-wrap" onClick={(e) => e.stopPropagation()}>
        <button ref={btnRef} className="st-pill-btn" onClick={() => setOpen((v) => !v)}>{pill}</button>
        {open && pos && <div ref={menuRef} className="st-menu" style={{ right: pos.right, top: pos.top }}>
          {opts.map((s) => <button key={s} className={s === status ? "on" : ""} onClick={() => { setOpen(false); if (s !== status) act(task, "status", { status: s }); }}><span className={"st-dot st-" + s} />{t(ST_LABEL[s])}</button>)}
        </div>}
      </span>
    );
  };
  const Card = ({ t: task }: { t: Msg }) => {
    // Source location, only shown in the server-wide (global) view. Channel tasks show `#name`; DM tasks
    // are scoped to a 1:1 conversation (own per-DM numbering) so they show the peer as `@name` — visually
    // distinct so a DM #1 is never mistaken for a channel #1.
    const chan = !channelId ? channels.find((c) => c.id === task.channelId)?.name : null;
    const dm = !channelId && !chan ? dms.find((d) => d.id === task.channelId) : null;
    return (
      <div className="card task" onClick={() => open(task)} title={t("tasks.openThread")}>
        <button className="tk-del" title={t("tasks.deleteTask")} onClick={(e) => { e.stopPropagation(); delTask(task); }}><Trash2 size={12} /></button>
        {chan ? <div className="tk-chan">#{chan}</div> : dm ? <div className="tk-chan tk-chan-dm">@{dm.peerDisplayName || dm.peerName || dm.name}</div> : null}
        <div className="tk-num">#{task.taskNumber ?? "-"}</div>
        <div className="tk-title">{task.content}</div>
        <div className="tk-foot"><StatusPill t={task} /></div>
      </div>
    );
  };

  // Drag-and-drop status change via dnd-kit: dragging a card to a column PATCHes its status; the target column highlights with a "Drop to set X" hint.
  // Activation distance of 6px: plain clicks (open thread / status pill) do not trigger drag; only pointer movement beyond 6px starts a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const task = e.active?.data?.current?.task as Msg | undefined;
    const col = e.over?.id as string | undefined;
    if (task && col && col !== (task.taskStatus || "todo")) act(task, "status", { status: col });
  };
  const DraggableCard = ({ t: task }: { t: Msg }) => {
    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id, data: { task } });
    return <div ref={setNodeRef} {...attributes} {...listeners} style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 100 : undefined, position: "relative" }}><Card t={task} /></div>;
  };
  const DroppableCol = ({ k, labelKey }: { k: string; labelKey: string }) => {
    const { setNodeRef, isOver } = useDroppable({ id: k });
    const label = t(labelKey);
    return (
      <div ref={setNodeRef} className={"task-col" + (collapsed.has(k) ? " collapsed" : "") + (isOver ? " drop-over" : "")}>
        <div className="sec" onClick={() => toggleCol(k)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>{collapsed.has(k) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{label} <span className="cnt">{groups[k]?.length || 0}</span></div>
        {isOver && <div className="drop-hint">{t("tasks.dropToSet", { label })}</div>}
        {!collapsed.has(k) && (groups[k] || []).map((task) => <DraggableCard key={task.id} t={task} />)}
      </div>
    );
  };

  return (
    <div className="scroll">
      <div className="task-toolbar">
        <div className="seg">
          <button className={view === "board" ? "on" : ""} onClick={() => setView("board")}>{t("tasks.viewBoard")}</button>
          <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>{t("tasks.viewList")}</button>
        </div>
        {view === "board" && (
          <div className="seg seg-icon">
            <button className={boardLayout === "columns" ? "on" : ""} title={t("tasks.layoutColumns")} aria-label={t("tasks.layoutColumns")} onClick={() => setLayout("columns")}><Columns3 size={15} /></button>
            <button className={boardLayout === "stack" ? "on" : ""} title={t("tasks.layoutStack")} aria-label={t("tasks.layoutStack")} onClick={() => setLayout("stack")}><Rows3 size={15} /></button>
          </div>
        )}
        <Select ariaLabel={t("tasks.filterByCreator")} value={creatorKey} onChange={setCreatorKey}
          options={[{ value: "", label: t("tasks.allCreators") }, ...(me ? [{ value: "me", label: t("tasks.myTasks") }] : []), ...creators.filter((c) => c.key !== `user:${me?.id}`).map((c) => ({ value: c.key, label: c.name }))]} />
        <Select ariaLabel={t("tasks.filterByAssignee")} value={assigneeKey} onChange={setAssigneeKey}
          options={[{ value: "", label: t("tasks.allAssignees") }, { value: "unclaimed", label: t("tasks.unclaimed") }, ...assignees.map((a) => ({ value: a.key, label: a.name }))]} />
        <span className="grow" />
        {channelId && <button className="ok newtask" onClick={() => setMkOpen(true)}>{t("tasks.newTask")}</button>}
      </div>
      {filtered.length === 0 ? <PaneEmpty icon={<ListChecks size={30} />} title={tasks.length ? t("tasks.emptyFiltered") : channelId ? t("tasks.emptyChannel") : t("tasks.emptyServer")} />
        : view === "board" ? (
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className={"task-board " + boardLayout}>
              {TCOLS.map(([k, labelKey]) => <DroppableCol key={k} k={k} labelKey={labelKey} />)}
            </div>
          </DndContext>
        ) : (
          <div className="task-list">
            {TCOLS.flatMap(([k, labelKey]) => (groups[k] || []).length ? [
              <div key={"h-" + k} className="sec list-sec">{t(labelKey)} <span className="cnt">{groups[k]?.length || 0}</span></div>,
              ...(groups[k] || []).map((task) => (
                <div key={task.id} className="list-row" style={{ cursor: "pointer" }} onClick={() => open(task)} title={t("tasks.openThread")}>
                  <span className="lnum">#{task.taskNumber ?? "-"}</span>
                  <span className="grow">{task.content}</span>
                  <span className="meta">{task.taskAssigneeId ? nameOf(task.taskAssigneeType, task.taskAssigneeId) : task.senderName}</span>
                  <StatusPill t={task} />
                  <button className="tk-del-row" title={t("tasks.deleteTaskRow")} onClick={(e) => { e.stopPropagation(); delTask(task); }}><Trash2 size={13} /></button>
                </div>
              )),
            ] : [])}
          </div>
        )}
      {mkOpen && channelId && <NewTaskModal onSubmit={submit} onClose={() => setMkOpen(false)} />}
    </div>
  );
}

// New Task modal: multiple title inputs with an "Add Another" button for batch creation
function NewTaskModal({ onSubmit, onClose }: { onSubmit: (titles: string[]) => void; onClose: () => void }) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const [titles, setTitles] = useState<string[]>([""]);
  const set = (i: number, v: string) => setTitles((ts) => ts.map((x, j) => (j === i ? v : x)));
  const submit = () => { const ts = titles.map((x) => x.trim()).filter(Boolean); if (ts.length) onSubmit(ts); };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("tasks.modalTitle")}</h3>
        {titles.map((v, i) => (
          <input key={i} autoFocus={i === 0} value={v} onChange={(e) => set(i, e.target.value)} placeholder={t("tasks.taskPlaceholder", { n: i + 1 })}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }} />
        ))}
        <button className="addmore" onClick={() => setTitles((ts) => [...ts, ""])}>{t("tasks.addAnother")}</button>
        <div className="acts"><button className="cancel" onClick={onClose}>{t("tasks.cancel")}</button><button className="ok" onClick={submit}>{t("tasks.create")}</button></div>
      </div>
    </div>
  );
}
