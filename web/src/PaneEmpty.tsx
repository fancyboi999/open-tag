import type { ReactNode } from "react";

// Centered, editorial empty state for a PRIMARY full content pane — Inbox, Saved, the Tasks board, an
// empty channel, the no-machine onboarding hint, an empty activity log. A serif headline + an optional
// muted sub-line, vertically centered: the calm alternative to a small grey line pinned top-left.
// Secondary sub-section empties (a "No DMs" under a "DMs" section header inside a profile tab) deliberately
// keep the inline `.empty` instead — a giant serif headline there would over-dramatize a minor state.
export function PaneEmpty({ icon, title, sub, action }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pane-empty">
      {icon}
      <div className="pe-title">{title}</div>
      {sub ? <div className="pe-sub">{sub}</div> : null}
      {action ? <div className="pe-action">{action}</div> : null}
    </div>
  );
}
