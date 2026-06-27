// Loading skeletons that mirror the app-shell layout (rail · sidebar · chat · trace), shown while the workspace
// bootstraps or switches — so navigation feels instant (skeleton-first) instead of blanking to a null screen.
// Editorial-calm skin: hairline placeholder blocks with a soft left-to-right shimmer; the shimmer is removed
// under prefers-reduced-motion (see .skel-box in styles.css).
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

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

// Full workspace shell skeleton: same grid as <Layout/> (.app.has-traj) so the swap to the real UI is shift-free.
// `chat` forces the 4-column chat variant when the caller knows the destination is a channel even though the
// current URL isn't one yet (e.g. the "/" guard redirects an authed user to /s/:slug/channel) — without it the
// skeleton would render 3-col then shift to 4-col on arrival, the exact jump this skeleton exists to avoid.
export function WorkspaceSkeleton({ chat }: { chat?: boolean }) {
  const { t } = useTranslation();
  const loc = useLocation();
  const isChat = chat ?? loc.pathname.includes("/channel"); // mirror <Layout/>'s has-traj rule: only chat shows the 4th (trace) column → swap is shift-free
  return (
    <div className={"app skel-app" + (isChat ? " has-traj" : "")} role="status" aria-busy="true" aria-label={t("common.loadingWorkspace")}>
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
      {isChat && (
        <div className="skel-traj">
          <div className="skel-box skel-traj-title" />
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skel-box skel-traj-line" style={{ width: `${80 - i * 9}%` }} />)}
        </div>
      )}
    </div>
  );
}
