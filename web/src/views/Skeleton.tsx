// Loading skeletons that mirror the default app-shell layout (rail · sidebar · content), shown while the workspace
// bootstraps or switches — so navigation feels instant (skeleton-first) instead of blanking to a null screen.
// Editorial-calm skin: hairline placeholder blocks with a soft left-to-right shimmer; the shimmer is removed
// under prefers-reduced-motion (see .skel-box in styles.css).
import { useTranslation } from "react-i18next";

// One placeholder message row: avatar block + a name line and a body line of the given width (mimics a real chat line).
function SkelMsg({ w }: { w: string }) {
  return (
    <div className="skel-msg" aria-hidden="true">
      <div className="skel-box skel-ava" />
      <div className="skel-msg-body">
        <div className="skel-box skel-line skel-line-name" />
        <div className="skel-box skel-line" style={{ width: w }} />
      </div>
    </div>
  );
}

const MSG_WIDTHS = ["72%", "54%", "83%", "61%", "44%", "77%"]; // varied widths so the rows don't read as a uniform grid

// Message-area skeleton: reused by the full shell skeleton and by Chat while a channel's messages load.
export function ChatSkeleton() {
  return (
    <div className="skel-msgs" aria-hidden="true">
      {MSG_WIDTHS.map((w, i) => <SkelMsg key={i} w={w} />)}
    </div>
  );
}

// Full workspace shell skeleton: the right panel is contextual (thread/profile) and closed during bootstrap,
// so every route shares the same three-column loading grid.
export function WorkspaceSkeleton({ chat }: { chat?: boolean }) {
  const { t } = useTranslation();
  void chat;
  return (
    <div className="app skel-app" role="status" aria-busy="true" aria-label={t("common.loadingWorkspace")}>
      <div className="rail skel-rail">
        <div className="skel-box skel-brand" />
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skel-box skel-railicon" />)}
      </div>
      <div className="skel-sb">
        <div className="skel-box skel-sb-title" />
        {Array.from({ length: 7 }).map((_, i) => <div key={i} className="skel-box skel-sb-line" style={{ width: `${64 - (i % 3) * 12}%` }} />)}
      </div>
      <div className="skel-main">
        <div className="skel-main-head"><div className="skel-box skel-main-title" /></div>
        <div className="skel-main-scroll"><ChatSkeleton /></div>
      </div>
    </div>
  );
}

export function BootstrapFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <main className="bootstrap-failure" role="alert">
      <div className="bootstrap-failure-card">
        <strong className="auth-brand">open-tag</strong>
        <h1>{t("common.bootstrapFailedTitle")}</h1>
        <p>{t("common.bootstrapFailedBody")}</p>
        <button type="button" className="ok" onClick={onRetry}>{t("common.retryBootstrap")}</button>
      </div>
    </main>
  );
}
