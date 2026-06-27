// System alert center: derives live, actionable system warnings from store state and renders them in a
// rail-anchored notification popover. Intentionally NOT a generic toast/queue — these are *standing conditions*
// (recomputed from state) the operator should act on, not one-shot feedback. Two signals today:
//   - outdated daemon  → an online machine whose reported daemonVersion differs from the latest published one
//                        (latestDaemonVersion comes from packages/daemon/package.json via the machines endpoint)
//   - machine offline  → an offline machine that still hosts agents (those agents can't run until it reconnects)
// Benign states (idle/no-agent, an offline machine with no agents) deliberately raise NO alert, so the rail
// button only appears when there is something to act on. New signals slot into useSystemAlerts() as more cases.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { useStore } from "./store.tsx";

export interface SystemAlert {
  id: string;            // stable signature, used as the dismiss key (e.g. "machine-offline:<id>")
  title: string;         // already-translated
  body: string;          // already-translated
  machineId?: string;    // when set, the "View" action navigates to this computer
}

export function isDaemonOutdated(current: string | undefined, latest: string | undefined): boolean {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i]! < next[i]!) return true;
    if (cur[i]! > next[i]!) return false;
  }
  return false;
}

function parseSemver(v: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function useSystemAlerts(): SystemAlert[] {
  const { machines, agents, latestDaemonVersion } = useStore();
  const { t } = useTranslation();
  return useMemo(() => {
    const out: SystemAlert[] = [];
    // Outdated daemon: only flag *online* machines (an offline one isn't running anything to be outdated) whose
    // reported semver is lower than the latest published one. A newer daemon can briefly connect to an older
    // server during release rollout; that is not outdated and should not page the operator.
    const outdated = machines.filter((m) => m.status === "online" && isDaemonOutdated(m.daemonVersion, latestDaemonVersion));
    if (outdated.length) {
      const names = outdated.map((m) => m.name || m.hostname || m.id).join(", ");
      out.push({
        id: "daemon-outdated:" + outdated.map((m) => m.id).sort().join(","),
        title: t("alerts.daemonOutdatedTitle"),
        body: t("alerts.daemonOutdatedBody", { names }),
        machineId: outdated[0]!.id,
      });
    }
    // Offline machine that still hosts agents: those agents can't run. An offline machine with no agents is benign
    // and raises nothing (avoids permanent noise from intentionally-offline computers).
    for (const m of machines) {
      if (m.status === "online") continue;
      const onIt = agents.filter((a) => a.machineId === m.id).length;
      if (!onIt) continue;
      out.push({
        id: "machine-offline:" + m.id,
        title: t("alerts.machineOfflineTitle", { name: m.name || m.hostname || m.id }),
        body: t("alerts.machineOfflineBody", { count: onIt }),
        machineId: m.id,
      });
    }
    return out;
  }, [machines, agents, latestDaemonVersion, t]);
}

// Rail-anchored notification popover. Presentational: the owner (Layout) holds open/dismiss state and supplies the
// already-filtered alert list + handlers. `anchor` is a fixed-position point (left + distance-from-bottom) so the
// panel sits just outside the rail and grows upward from near the trigger button.
export function NotificationCenter({ alerts, anchor, onView, onDismiss, onClose }: {
  alerts: SystemAlert[];
  anchor: { left: number; bottom: number };
  onView: (a: SystemAlert) => void;
  onDismiss: (a: SystemAlert) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="alert-backdrop" onClick={onClose} />
      <div className="alert-pop" role="dialog" aria-label={t("alerts.title")} style={{ left: anchor.left, bottom: anchor.bottom }}>
        <div className="alert-pop-head">
          <span className="alert-pop-title">{t("alerts.title")}</span>
          <span className="alert-pop-count">{t("alerts.count", { count: alerts.length })}</span>
        </div>
        <ul className="alert-list" aria-label={t("alerts.title")}>
          {alerts.map((a) => (
            <li key={a.id} className="alert-item">
              <span className="alert-ic" aria-hidden="true"><AlertTriangle size={15} /></span>
              <div className="alert-body">
                <div className="alert-item-title">{a.title}</div>
                <div className="alert-item-desc">{a.body}</div>
                <div className="alert-acts">
                  {a.machineId && <button className="joinbtn" onClick={() => onView(a)}>{t("alerts.view")}</button>}
                  <button className="alert-dismiss" onClick={() => onDismiss(a)}>{t("alerts.dismiss")}</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
