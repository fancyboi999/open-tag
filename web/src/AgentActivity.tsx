import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, Brain, Check, ChevronRight, FilePen, FileText, Globe, ListTodo, MessageSquare, Search, Square, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "./store.tsx";
import { useToast } from "./toast.tsx";
import type { AgentActivityItem } from "./store.tsx";

export type AgentRunPhase = "thinking" | "working" | "error" | null;

export function agentRunPhase(items: AgentActivityItem[] = [], state?: string | null): AgentRunPhase {
  if (state === "error") return "error";
  if (state !== "running") return null;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.activity === "error") return "error";
    if (["online", "sleeping", "offline"].includes(item.activity ?? "")) return null;
    if (item.activity === "thinking" || item.activity === "working") return item.activity;
    if (item.kind === "tool_start") return "working";
    if (item.kind === "thinking" || item.kind === "text") return "thinking";
  }

  return "working";
}

function eventTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

// toolName is runtime-raw (codex `commandExecution`/`patch_apply`, claude `Bash`/`Read`/`WebSearch`, arbitrary
// function names elsewhere), so icons match by keyword, not exact name. Order matters: more specific families
// (todo/web) before broader ones (write/search) so e.g. `TodoWrite` → list, `webSearch` → globe.
const TOOL_ICON_RULES: [RegExp, LucideIcon][] = [
  [/command|exec|bash|shell|terminal|script/i, Terminal],
  [/todo|task|plan/i, ListTodo],
  [/web|fetch|http|browser|url|crawl/i, Globe],
  [/search|grep|find|query/i, Search],
  [/read|cat|view|glob|open/i, FileText],
  [/write|edit|patch|apply|change|create|save|notebook/i, FilePen],
  [/message|say|send|reply|speak/i, MessageSquare],
  [/think|reason/i, Brain],
];
function toolIcon(name?: string | null): LucideIcon {
  if (name) for (const [re, icon] of TOOL_ICON_RULES) if (re.test(name)) return icon;
  return Wrench;
}

/** One timeline event row — the single renderer for run events, shared by the per-message
 *  disclosure below and the Agent Profile activity tab (Members.tsx), so both stay identical. */
export function ActivityEventRow({ item, current = false }: { item: AgentActivityItem; current?: boolean }) {
  const tool = item.kind === "tool_start";
  const text = tool ? item.toolName : item.text || [item.activity, item.detail].filter(Boolean).join(" · ");
  const ToolIcon = toolIcon(item.toolName);
  return <div className={`msg-act-event${tool ? " is-tool" : ""}${current ? " is-current" : ""}`}>
    <time>{eventTime(item.timestamp)}</time>
    <span className="msg-act-mark" />
    <div className="msg-act-event-content">
      {tool ? <><span className="msg-act-kind"><ToolIcon size={12} />{text}</span>{item.toolInput ? <code>{item.toolInput}</code> : null}</>
        : <span>{text}</span>}
    </div>
  </div>;
}

function eventSummary(item?: AgentActivityItem): string {
  if (!item) return "";
  if (item.kind === "tool_start") return item.toolName || "tool";
  if (item.text) return item.text;
  return [item.activity, item.detail].filter(Boolean).join(" · ");
}

export function AgentActivityDisclosure({ items = [], state = "handled", receipt = false, autoOpenWhenLive = false, agentId }: { items?: AgentActivityItem[]; state?: string | null; receipt?: boolean; autoOpenWhenLive?: boolean; agentId?: string | null }) {
  const { t } = useTranslation();
  const { api, capabilities } = useStore();
  const toast = useToast();
  // One-click interrupt where the user watches a runaway run: POST stop kills the daemon's
  // process tree mid-turn. Sibling of the toggle (not nested — buttons can't nest).
  const stopAgent = () => { if (!agentId) return; api("POST", `/api/agents/${agentId}/stop`).catch((e: unknown) => toast.error(String((e as { message?: string })?.message || e))); };
  const phase = useMemo(() => agentRunPhase(items, state), [items, state]);
  const live = phase === "thinking" || phase === "working";
  const failed = phase === "error";
  const [open, setOpen] = useState(autoOpenWhenLive && live);
  const wasLive = useRef(autoOpenWhenLive && live);
  useEffect(() => {
    if (!autoOpenWhenLive) return;
    if (live) { wasLive.current = true; setOpen(true); return; }
    if (!wasLive.current) return;
    wasLive.current = false;
    const timer = window.setTimeout(() => setOpen(false), 900);
    return () => window.clearTimeout(timer);
  }, [autoOpenWhenLive, live]);
  const summary = useMemo(() => eventSummary(items[items.length - 1]), [items]);
  const label = receipt
    ? (failed ? t("chat.agentFailed") : t("chat.agentHandled"))
    : phase === "thinking" ? t("liveBar.thinking")
      : phase === "working" ? t("chat.agentWorking")
        : t("chat.activity");
  if (!items.length && !live) return null;
  return (
    <div className={`msg-act${live ? " is-live" : ""}${failed ? " is-error" : ""}${receipt ? " is-receipt" : ""}`}>
      <div className="msg-act-head">
        <button className="msg-act-toggle" type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="msg-act-state" aria-hidden="true">{failed ? <AlertCircle size={14} /> : live ? <Activity size={14} /> : <Check size={14} />}</span>
          <span className="msg-act-label">{label}</span>
          <span className="msg-act-summary">{summary}</span>
          <span className="msg-act-count">{t("chat.activityCount", { count: items.length })}</span>
          <ChevronRight className="msg-act-chevron" size={14} aria-hidden="true" />
        </button>
        {live && agentId && !!capabilities.manageAgents && (
          <button className="msg-act-stop" type="button" title={t("members.stop")} aria-label={t("members.stop")} onClick={stopAgent}>
            <Square size={13} />
          </button>
        )}
      </div>
      <div className={`msg-act-reveal${open ? " is-open" : ""}`} aria-hidden={!open}><div className="msg-act-body">
        {items.map((item, index) => (
          <ActivityEventRow key={`${item.timestamp}-${index}`} item={item} current={live && index === items.length - 1} />
        ))}
      </div></div>
    </div>
  );
}
