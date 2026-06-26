// Static, read-only Showcase page — four real-looking collaboration sessions rendered entirely
// client-side from web/src/showcaseData.ts. Zero API, zero live agents, zero DB channel: the demo
// is built into the frontend so every visitor sees it identically.
//
// Form mirrors the real product (Chat.tsx): the channel shows one human "task" anchor per case with a
// task badge + attachment + a "💬 N replies" thread-pill; clicking the pill opens the case's thread in a
// right-side panel (the agents' collaboration = how that task got done). Nothing is flattened.
//
// Reuses the Chat message/thread styles (.msg / .msg-col / .mbody / .msg-meta / .task-pill / .thread-pill /
// .thread-panel / .thread-head / .thread-sep / Avatar / MessageContent). Agent avatars/names are
// intentionally NON-clickable and trigger no profile/API: the old DB-channel showcase leaked host-machine
// skills on avatar click, so this static page never makes an avatar interactive. Thread open/close is pure
// useState over static data — never openThread/startThread (those hit the server).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, CheckCircle2, MessageCircle, X } from "lucide-react";
import { Avatar } from "../Avatar.tsx";
import { Lightbox } from "../Lightbox.tsx";
import { MessageContent } from "../messageRender.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { IconFile, IconDownload } from "../icons.tsx";
import { ST_LABEL } from "../TaskBoard.tsx";
import { AGENTS, CASES, type ShowcaseAttachment, type ShowcaseCase, type ShowcaseLine, type ShowcaseTask } from "../showcaseData.ts";

// Internal token links (@mention / #channel / task #N) are inert on this static page: with empty
// mentions/channels the markdown renderer leaves them as plain text, and nav() is a no-op.
const noNav = () => {};

// Short role label from the demo displayName ("Pat (PM)" → "PM"); full description goes in the tooltip.
function roleOf(name: string): { role: string; title: string } {
  const a = AGENTS[name];
  if (!a) return { role: "", title: "" };
  const m = a.displayName.match(/\(([^)]+)\)/);
  return { role: m ? m[1]! : "", title: a.description };
}

// One attachment under a case anchor: image → clickable thumbnail (opens the in-app Lightbox, like Chat —
// never a new-tab navigation to the raw asset) + download card; csv (any file) → download card.
function ShowcaseAtt({ att }: { att: ShowcaseAttachment }) {
  const [lb, setLb] = useState(false);
  return (
    <div className="msg-atts">
      {att.kind === "image" && (
        <>
          <button className="msg-att-img" title={att.filename} onClick={() => setLb(true)}>
            <img src={att.href} alt={att.filename} loading="lazy" />
          </button>
          {lb && <Lightbox src={att.href} alt={att.filename} onClose={() => setLb(false)} />}
        </>
      )}
      <a className="msg-att" href={att.href} download={att.filename}>
        <IconFile size={14} />
        <span className="grow">{att.filename}</span>
        <IconDownload size={14} />
      </a>
    </div>
  );
}

// One message row — anchor (you) or a thread line (agent | you). Mirrors the Chat .msg layout but with a
// non-clickable avatar/name and no live status/toolbar. The meta row (task badge + thread-pill) only renders
// on the channel anchor (where task / onOpenThread are passed), matching Chat's .msg-meta.
function ShowcaseMsg({ line, task, attachment, replyCount, onOpenThread }: {
  line: ShowcaseLine;
  task?: ShowcaseTask | null;
  attachment?: ShowcaseAttachment;
  replyCount?: number;
  onOpenThread?: () => void;
}) {
  const { t } = useTranslation();
  const isYou = line.agent === null;
  const senderName = isYou ? "you" : line.agent!;
  const { role, title } = isYou ? { role: "", title: "" } : roleOf(senderName);
  return (
    <div className="msg">
      <Avatar seed={senderName} size={36} />
      <div className="msg-col">
        <div className="msg-head">
          <span className="who" title={title || undefined}>{senderName}</span>
          {role ? <span className="msg-role" title={title}>{role}</span> : <span className="member-badge">{t("chat.memberKind")}</span>}
        </div>
        {!!line.content && <div className="mbody"><MessageContent content={line.content} mentions={[]} channels={[]} nav={noNav} /></div>}
        {attachment && <ShowcaseAtt att={attachment} />}
        {(task || onOpenThread) && (
          <div className="msg-meta">
            {task && (
              <span className="task-pill st-done" style={{ cursor: "default" }}>
                <CheckCircle2 size={11} /> #{task.number} {t(ST_LABEL[task.status] ?? task.status)}
              </span>
            )}
            {onOpenThread && (
              <button className="thread-pill" onClick={onOpenThread}>
                <MessageCircle size={12} /> {t("chat.replyCount", { count: replyCount ?? 0 })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Read-only thread panel — mirrors Chat's ThreadPanel structure (thread-head + thread-parent + thread-sep +
// replies) but with NO composer (a static page can't reply): the footer is the read-only notice instead.
function ShowcaseThread({ c, onClose }: { c: ShowcaseCase; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <aside className="thread-panel showcase-thread">
      <div className="thread-head">
        <span className="grow">{t("chat.thread")}</span>
        <button className="tp-close" onClick={onClose} title={t("chat.close")}><X size={15} /></button>
      </div>
      <div className="scroll">
        <div className="thread-parent">
          <ShowcaseMsg line={{ agent: null, content: c.anchor }} attachment={c.attachment} />
        </div>
        <div className="thread-sep">{t("chat.replyCount", { count: c.lines.length })}</div>
        {c.lines.map((line, j) => <ShowcaseMsg key={j} line={line} />)}
      </div>
      <div className="showcase-readonly"><Eye size={14} />{t("chat.showcaseReadOnly")}</div>
    </aside>
  );
}

export function Showcase() {
  const { t } = useTranslation();
  // Index of the case whose thread panel is open (null = closed). Pure local state over static data — no API.
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const openCase = openIdx != null ? CASES[openIdx] : null;
  return (
    <>
      <ChatSidebar />
      {/* Flex row: the channel column + (when a pill is clicked) the thread panel. The showcase route is not
          a /channel path, so the app shell never gets has-traj's 4th grid column — this wrapper IS the single
          grid cell and lays its own "main + thread" columns out, so a closed thread leaves no empty strip. */}
      <div className="showcase-shell">
        <main className="content-col">
          <div className="head chat-head">
            <h1><Eye size={16} style={{ verticalAlign: "-3px", opacity: 0.7 }} /> {t("showcase.title")}</h1>
            <small>{t("showcase.subtitle")}</small>
          </div>
          <div className="scroll ch-view-enter">
            {CASES.map((c, i) => (
              // A case = its human "task" anchor (carrying the task badge, attachment, and the thread-pill).
              // The collaboration transcript lives behind the pill — not flattened here. Cases after the first
              // get a hairline top divider.
              <section key={i} className={"showcase-case" + (openIdx === i ? " open" : "")} style={i > 0 ? { marginTop: 4, paddingTop: 18, borderTop: "1px solid var(--hair)" } : undefined}>
                <ShowcaseMsg
                  line={{ agent: null, content: c.anchor }}
                  task={c.task}
                  attachment={c.attachment}
                  replyCount={c.lines.length}
                  onOpenThread={() => setOpenIdx(i)}
                />
              </section>
            ))}
          </div>
          <div className="showcase-readonly"><Eye size={14} />{t("chat.showcaseReadOnly")}</div>
        </main>
        {openCase && <ShowcaseThread c={openCase} onClose={() => setOpenIdx(null)} />}
      </div>
    </>
  );
}
