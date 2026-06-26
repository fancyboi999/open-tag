// Static, read-only Showcase page — four real-looking collaboration sessions rendered entirely
// client-side from web/src/showcaseData.ts. Zero API, zero live agents, zero DB channel: the demo
// is built into the frontend so every visitor sees it identically. Reuses the Chat message-bubble
// styles (.msg / .msg-col / .mbody / .msg-atts / .task-pill / Avatar / MessageContent) so it still
// reads like a genuine conversation — but agent avatars/names are intentionally NON-clickable and
// trigger no profile/API (the old DB-channel showcase leaked host-machine skills on avatar click).
import { useTranslation } from "react-i18next";
import { Eye, CheckCircle2 } from "lucide-react";
import { Avatar } from "../Avatar.tsx";
import { MessageContent } from "../messageRender.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { IconFile, IconDownload } from "../icons.tsx";
import { ST_LABEL } from "../TaskBoard.tsx";
import { AGENTS, CASES, type ShowcaseAttachment, type ShowcaseLine, type ShowcaseTask } from "../showcaseData.ts";

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

// One attachment under a case anchor: image → thumbnail + download card; csv (any file) → download card.
function ShowcaseAtt({ att }: { att: ShowcaseAttachment }) {
  return (
    <div className="msg-atts">
      {att.kind === "image" && (
        <a className="msg-att-img" href={att.href} target="_blank" rel="noreferrer">
          <img src={att.href} alt={att.filename} loading="lazy" />
        </a>
      )}
      <a className="msg-att" href={att.href} download={att.filename}>
        <IconFile size={14} />
        <span className="grow">{att.filename}</span>
        <IconDownload size={14} />
      </a>
    </div>
  );
}

// One message row — anchor (you) or a thread line (agent | you). Mirrors the Chat .msg layout but with
// a non-clickable avatar/name and no live status/toolbar.
function ShowcaseMsg({ line, task, attachment }: { line: ShowcaseLine; task?: ShowcaseTask | null; attachment?: ShowcaseAttachment }) {
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
        {task && (
          <div className="msg-meta">
            <span className="task-pill st-done" style={{ cursor: "default" }}>
              <CheckCircle2 size={11} /> #{task.number} {t(ST_LABEL[task.status] ?? task.status)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function Showcase() {
  const { t } = useTranslation();
  return (
    <>
      <ChatSidebar />
      <main className="content-col">
        <div className="head chat-head">
          <h1><Eye size={16} style={{ verticalAlign: "-3px", opacity: 0.7 }} /> {t("showcase.title")}</h1>
          <small>{t("showcase.subtitle")}</small>
        </div>
        <div className="scroll ch-view-enter">
          {CASES.map((c, i) => (
            // A case = its human anchor message (carrying the task badge + attachment) followed by the
            // thread replies inline. Cases after the first get a hairline top border as a visual divider.
            <section key={i} className="showcase-case" style={i > 0 ? { marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--hair)" } : undefined}>
              <ShowcaseMsg line={{ agent: null, content: c.anchor }} task={c.task} attachment={c.attachment} />
              {c.lines.map((line, j) => <ShowcaseMsg key={j} line={line} />)}
            </section>
          ))}
        </div>
        <div className="showcase-readonly"><Eye size={14} />{t("chat.showcaseReadOnly")}</div>
      </main>
    </>
  );
}
