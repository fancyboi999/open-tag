// Task board shared between the channel chatTab=tasks view and the global Tasks page.
// Five-status columns + Board/List toggle + Board layout toggle (horizontal columns ↔ vertical stack, persisted) (pure frontend) + Creator/Assignee filters (pure frontend, applied over the loaded array) + New Task (POST /api/tasks/channel/:id).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Trash2, ChevronDown, ChevronRight, Pencil, Columns3, Rows3, ListChecks } from "lucide-react";
import { createPortal } from "react-dom";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
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
  const [activeId, setActiveId] = useState<string | null>(null); // id of the card being dragged → turns every column into a generous drop target
  // Status-change menu, hoisted to the board (NOT inside StatusPill): the inner card/pill components are redefined
  // every TaskBoard render, so React remounts them — a menu-open flag living inside one would be lost on the next
  // render. Keeping it here (+ portaling the menu to <body>) makes click-to-open reliable.
  const [menu, setMenu] = useState<{ task: Msg; status: string; opts: string[]; right: number; top: number } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const prevRects = useRef<Map<string, DOMRect>>(new Map()); // last-known card positions, for the FLIP move animation

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
  // Close the status menu on outside click / scroll / Escape (the menu is body-portaled with fixed coords).
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".st-menu, .st-pill-btn")) setMenu(null); };
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("scroll", close, true); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  const act = async (task: Msg, action: string, body?: unknown) => { await api("PATCH", `/api/tasks/${task.id}/${action}`, body); load(); };
  // Move a task to another column optimistically: update local state first so the FLIP animation fires instantly,
  // then persist in the background; a failed PATCH reloads to revert. Realtime task:updated reconciles the rest.
  const moveTask = (task: Msg, status: string) => {
    const live = tasks.find((x) => x.id === task.id) || task; // current status, not a drag-start / menu-open snapshot
    if (status === (live.taskStatus || "todo")) return;
    setTasks((cur) => cur.map((x) => (x.id === task.id ? { ...x, taskStatus: status } : x)));
    const didExpand = collapsed.has(status);
    if (didExpand) toggleCol(status); // a card moved into a collapsed column → expand it so you can see it land
    api("PATCH", `/api/tasks/${task.id}/status`, { status }).catch(() => { load(); if (didExpand) toggleCol(status); }); // PATCH failed → revert the optimistic move and the auto-expand
  };
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

  // FLIP move animation: when a card lands in a different column (click-move, realtime, or a non-drag reflow),
  // slide it from its previous position to its new one. Layout/collapse/view toggles reflow everything at once —
  // those are not "a card moved", so we refresh positions without animating. Honors prefers-reduced-motion.
  const layoutSig = boardLayout + "|" + view + "|" + [...collapsed].sort().join(",");
  const lastSig = useRef(layoutSig);
  useLayoutEffect(() => {
    const root = boardRef.current;
    if (!root) return;
    const reduce = typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Animate only once we have prior positions: the first populate (empty map) just records, so the board
    // doesn't flutter every card in on load (product UIs don't choreograph page loads); a card that appears
    // later (realtime/create) still has no prior rect → it fades in; a moved card has one → it slides.
    const animate = !reduce && lastSig.current === layoutSig && prevRects.current.size > 0;
    const next = new Map<string, DOMRect>();
    const moves: { el: HTMLElement; dx: number; dy: number; fresh: boolean }[] = [];
    root.querySelectorAll<HTMLElement>("[data-task-id]").forEach((el) => {
      const id = el.dataset.taskId!;
      const rect = el.getBoundingClientRect();
      next.set(id, rect);
      if (!animate) return;
      const prev = prevRects.current.get(id);
      if (prev) { const dx = prev.left - rect.left, dy = prev.top - rect.top; if (dx || dy) moves.push({ el, dx, dy, fresh: false }); }
      else moves.push({ el, dx: 0, dy: 6, fresh: true });
    });
    // Invert (write), one reflow, then play (write) — batched so N cards don't thrash layout.
    moves.forEach(({ el, dx, dy, fresh }) => { el.style.transition = "none"; el.style.transform = `translate(${dx}px,${dy}px)`; if (fresh) el.style.opacity = "0"; });
    if (moves.length) void root.offsetWidth;
    moves.forEach(({ el, fresh }) => { el.style.transition = ""; el.style.transform = ""; if (fresh) el.style.opacity = ""; });
    prevRects.current = next;
    lastSig.current = layoutSig;
  }, [tasks, creatorKey, assigneeKey, boardLayout, view, collapsed]);

  const submit = async (titles: string[]) => { if (channelId && titles.length) { await createTasks(channelId, titles); setMkOpen(false); load(); } };

  // Status pill: a claim button for unclaimed todos, a read-only pill for non-editable statuses, otherwise a
  // button that opens the status menu. The menu itself lives at board level (`menu` state + portal below) so it
  // survives this component being remounted on every render and escapes the draggable card's pointer/stacking.
  const StatusPill = ({ t: task }: { t: Msg }) => {
    const status = task.taskStatus || "todo";
    const claimedByMe = task.taskAssigneeType === "human" && task.taskAssigneeId === me?.id;
    // Unclaimed todo task → show claim pill (atomic claim, automatically sets status to in_progress)
    if (!task.taskAssigneeId && status === "todo") return <button className="claim-pill" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); act(task, "claim"); }}>{t("tasks.claim")}</button>;
    const opts = ynOptions(status, manageServer, claimedByMe);
    const canEdit = opts.length > 0;
    const pill = <span className={"st-pill st-" + status}>{t(ST_LABEL[status])}{canEdit && <Pencil size={10} />}</span>;
    if (!canEdit) return pill; // read-only pill (no pencil icon)
    return (
      <button className="st-pill-btn" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu((m) => (m?.task.id === task.id ? null : { task, status, opts, right: window.innerWidth - r.right, top: r.bottom + 4 })); // toggle this card's menu
      }}>{pill}</button>
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
        <button className="tk-del" title={t("tasks.deleteTask")} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); delTask(task); }}><Trash2 size={12} /></button>
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
    setActiveId(null);
    const task = e.active?.data?.current?.task as Msg | undefined;
    const col = e.over?.id as string | undefined;
    if (task && col && col !== (task.taskStatus || "todo")) moveTask(task, col); // the real card stays put during drag (DragOverlay shows the moving copy), then FLIPs into its new column
  };
  // The original card stays in place and just dims; the moving copy is rendered by <DragOverlay> in a top-level
  // portal, so it's never clipped by a column's overflow or painted behind a later column.
  const DraggableCard = ({ t: task }: { t: Msg }) => {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id, data: { task } });
    return <div ref={setNodeRef} {...attributes} {...listeners} style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}><Card t={task} /></div>;
  };
  const DroppableCol = ({ k, labelKey }: { k: string; labelKey: string }) => {
    const { setNodeRef, isOver } = useDroppable({ id: k });
    const label = t(labelKey);
    const isCollapsed = collapsed.has(k);
    const dragging = activeId != null;
    const showBody = !isCollapsed || dragging; // while a drag is in flight, even collapsed columns reveal a drop area so every status is reachable
    return (
      <div ref={setNodeRef} className={"task-col" + (isCollapsed ? " collapsed" : "") + (isOver ? " drop-over" : "")}>
        <div className="sec" onClick={() => toggleCol(k)} style={{ cursor: "pointer" }}>{isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{label} <span className="cnt">{groups[k]?.length || 0}</span></div>
        {showBody && (
          <div className="task-col-body">
            {!isCollapsed && (groups[k] || []).map((task) => <div key={task.id} data-task-id={task.id} className="tk-slot"><DraggableCard t={task} /></div>)}
            {/* drop indicator appended after the cards (never overlaps them); fills an empty column on its own */}
            {isOver && <div className="drop-slot">{t("tasks.dropToSet", { label })}</div>}
          </div>
        )}
      </div>
    );
  };

  const activeTask = activeId ? tasks.find((x) => x.id === activeId) : null; // the card currently being dragged, rendered in the DragOverlay

  return (
    <div className="scroll board-scroll">
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
          <DndContext sensors={sensors} onDragStart={(e) => setActiveId(String(e.active.id))} onDragCancel={() => setActiveId(null)} onDragEnd={onDragEnd}>
            <div ref={boardRef} className={"task-board " + boardLayout + (activeId ? " dragging" : "")}>
              {TCOLS.map(([k, labelKey]) => <DroppableCol key={k} k={k} labelKey={labelKey} />)}
            </div>
            {/* Body-portal the overlay so dnd-kit's fixed-position wrapper is not re-based by .board-scroll's enter-animation transform. */}
            {createPortal(
              <DragOverlay dropAnimation={null}>
                {activeTask ? <div className="card-overlay"><Card t={activeTask} /></div> : null}
              </DragOverlay>,
              document.body,
            )}
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
      {/* Status menu, portaled to <body>: outside the draggable card subtree (no pointer/stacking conflict) and stable across card remounts. */}
      {menu && createPortal(
        <div className="st-menu" style={{ position: "fixed", right: menu.right, top: menu.top }}>
          {menu.opts.map((s) => <button key={s} className={s === menu.status ? "on" : ""} onClick={() => { moveTask(menu.task, s); setMenu(null); }}><span className={"st-dot st-" + s} />{t(ST_LABEL[s])}</button>)}
        </div>,
        document.body,
      )}
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
