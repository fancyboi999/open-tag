import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useStore, type Agent } from "../store.tsx";
import { Avatar, resolveAvatar } from "../Avatar.tsx";

// Live agent activity bar pinned to the bottom of the sidebar: an at-a-glance, workspace-wide
// pulse of which agents are doing something right now (working / thinking). Complements — does
// not replace — the per-DM status dots. Clicking an agent opens its profile panel on the Activity
// tab in the chat right column (no page nav, no DM). Data comes from store agents[].activity /
// activityDetail, pushed live over the Socket.IO "agent:activity" channel (see store.tsx).
const LIVE = new Set(["working", "thinking"]); // states that count as "actively doing something"
const rank = (a: Agent) => (a.activity === "working" ? 0 : 1); // working surfaces before thinking (only working/thinking reach here)

export function LiveAgentBar() {
  const { t } = useTranslation();
  const { agents, channels, slug, attachmentUrl, openAgentPanel } = useStore();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const avFor = (u?: string | null) => resolveAvatar(u, attachmentUrl);

  // "live" = alive AND doing something. The status check guards against stale activity: an agent
  // that died without a clean offline event keeps activity="working" in the DB, which would
  // otherwise pin a phantom "running" agent here forever.
  const live = agents.filter((a) => a.status === "active" && !!a.activity && LIVE.has(a.activity)).sort((x, y) => rank(x) - rank(y));

  // Open the agent profile panel (Activity tab) in the chat right column — no page nav, no DM.
  // The panel only exists inside the channel view, so if we're elsewhere (Saved/Tasks) route to a
  // channel first; otherwise the request would sit unconsumed and surprise-open on a later nav.
  const goActivity = (id: string) => {
    setOpen(false);
    openAgentPanel(id);
    if (!pathname.includes("/channel/")) {
      const ch = channels.find((c) => c.joined) ?? channels[0];
      if (ch && slug) nav(`/s/${slug}/channel/${ch.id}`);
    }
  };
  const labelOf = (a: Agent) => a.activityDetail?.trim() || t(a.activity === "thinking" ? "liveBar.thinking" : "liveBar.working");

  if (live.length === 0) {
    return (
      <div className="live-bar live-bar--idle" data-testid="live-agent-bar">
        <span className="dot" aria-hidden="true" />
        <span className="live-bar__idle">{t("liveBar.idle")}</span>
      </div>
    );
  }

  const primary = live[0];
  const extra = live.length - 1;

  return (
    <div className="live-bar" data-testid="live-agent-bar">
      <button
        type="button"
        className="live-bar__main"
        onClick={() => goActivity(primary.id)}
        title={t("liveBar.viewActivity", { name: primary.displayName || primary.name })}
      >
        <span className="live-bar__ava">
          <Avatar seed={primary.name} url={avFor(primary.avatarUrl)} size={22} />
          <span className={"live-bar__pip dot " + primary.activity} aria-hidden="true" />
        </span>
        <span className="live-bar__text">
          <span className="live-bar__name">{primary.displayName || primary.name}</span>
          <span className="live-bar__detail">{labelOf(primary)}</span>
        </span>
      </button>
      {extra > 0 && (
        <button
          type="button"
          className="live-bar__more"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={open}
          title={t("liveBar.moreActive", { count: extra })}
        >
          +{extra}
        </button>
      )}
      {open && extra > 0 && (
        <>
          <div className="live-bar__backdrop" onClick={() => setOpen(false)} />
          <div className="live-bar__pop">
            <div className="live-bar__pop-title">{t("liveBar.activeTitle")}</div>
            {live.map((a) => (
              <button key={a.id} type="button" className="live-bar__pop-item" onClick={() => goActivity(a.id)}>
                <Avatar seed={a.name} url={avFor(a.avatarUrl)} size={20} />
                <span className="live-bar__pop-text">
                  <span className="live-bar__pop-name">{a.displayName || a.name}</span>
                  <span className="live-bar__pop-detail">{labelOf(a)}</span>
                </span>
                <span className={"dot " + a.activity} aria-hidden="true" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
