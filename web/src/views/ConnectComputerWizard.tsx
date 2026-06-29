import { useEffect, useState, useCallback } from "react";
import { useStore } from "../store.tsx";
import { useTranslation } from "react-i18next";
import { IconMonitor } from "../icons.tsx";
import { CheckCircle2 } from "lucide-react";
import { daemonConnectCommand } from "../machineUi.ts";

// Self-contained onboarding nudge state (reused from the old AddComputerModal): once-per-tab session
// dismiss + a permanent global opt-out checkbox. Only the "onboard" mode reads/writes these.
const COMPUTER_OPTOUT_KEY = "open-tag.onboard.computer.optout";        // localStorage: permanent opt-out
const COMPUTER_DISMISSED_KEY = "open-tag.onboard.computer.dismissed";  // sessionStorage: this tab session

type Mode = "onboard" | "add" | "reconnect";
type Step = "intro" | "connect" | "connected";

// One wizard for all three add-a-computer entry points. It carries the user end-to-end inside the modal:
// intro → generate a ready-to-run daemon command → wait for the daemon to come online (socket-driven) →
// connected (optional friendly rename) → Done. Replaces AddComputerModal + ConnectMachineModal.
//   onboard   → auto-shows when the workspace has no machine; starts at intro; owns its own dismiss.
//   add       → parent-mounted (Computers "+"); starts at connect.
//   reconnect → parent-mounted; rotates the key on an existing offline machine; starts at connect.
export function ConnectComputerWizard({ mode, machine, onClose }: { mode: Mode; machine?: { id: string; name: string }; onClose?: () => void }) {
  const { machines, capabilities, api, serverId, reload } = useStore();
  const { t } = useTranslation();

  const [dontRemind, setDontRemind] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    if (mode !== "onboard") return false;
    try { return sessionStorage.getItem(COMPUTER_DISMISSED_KEY) === "1" || localStorage.getItem(COMPUTER_OPTOUT_KEY) === "1"; } catch { return false; }
  });
  const [step, setStep] = useState<Step>(mode === "onboard" ? "intro" : "connect");
  const [res, setRes] = useState<{ id: string; key: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [savingName, setSavingName] = useState(false);

  // onboard auto-show gate: only the intro step is conditioned on "no machine yet" — once the user advances
  // to connect (which creates a machine row), keep showing so the command/connected steps don't vanish.
  // Other modes are mounted/unmounted by their parent, so they're always shown.
  const shown = mode !== "onboard"
    ? true
    : (!dismissed && !!capabilities.manageMachines && (step === "intro" ? machines.length === 0 : true));

  const close = useCallback(() => {
    if (mode === "onboard") {
      try { sessionStorage.setItem(COMPUTER_DISMISSED_KEY, "1"); if (dontRemind) localStorage.setItem(COMPUTER_OPTOUT_KEY, "1"); } catch { /* storage unavailable — dismiss in memory only */ }
      setDismissed(true);
    }
    onClose?.();
  }, [mode, dontRemind, onClose]);

  // Esc-to-dismiss, only while shown.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, close]);

  // Generate (or rotate) the connection key. add/onboard create a new machine; reconnect rotates the existing key.
  const gen = useCallback(async () => {
    setBusy(true); setGenErr("");
    try {
      const r = mode === "reconnect" && machine
        ? await api("POST", `/api/servers/${serverId}/machines/${machine.id}/reconnect`, {})
        : await api("POST", `/api/servers/${serverId}/machines`, {});
      if (r?.key) { setRes({ id: r.id, key: r.key, name: r.name }); await reload(); }
      else setGenErr(r?.error || t("misc.wizardGenError"));
    } catch { setGenErr(t("misc.wizardGenError")); }
    finally { setBusy(false); }
  }, [mode, machine, api, serverId, reload, t]);

  // Auto-generate once on entering the connect step.
  useEffect(() => { if (shown && step === "connect" && !res && !busy && !genErr) gen(); }, [shown, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // The just-touched machine (created or reconnected) and whether its daemon is online yet.
  const targetId = res?.id ?? machine?.id;
  const liveMachine = targetId ? machines.find((m) => m.id === targetId) : undefined;
  const isOnline = liveMachine?.status === "online";

  // Online transition → connected step. Pre-fill rename with the current name on reconnect.
  useEffect(() => {
    if (step === "connect" && res && isOnline) { setNameInput(mode === "reconnect" ? (machine?.name ?? "") : ""); setStep("connected"); }
  }, [step, res, isOnline, mode, machine]);

  const cmd = res ? daemonConnectCommand(window.location.origin, res.key) : "";
  const copy = (text: string) => { navigator.clipboard?.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  const finish = async () => {
    const newName = nameInput.trim();
    const curName = res?.name ?? machine?.name ?? "";
    if (newName && newName !== curName && targetId) {
      setSavingName(true);
      try { await api("PATCH", `/api/servers/${serverId}/machines/${targetId}`, { name: newName }); await reload(); }
      finally { setSavingName(false); }
    }
    close();
  };

  if (!shown) return null;
  const meta = liveMachine ? [liveMachine.hostname, liveMachine.os, (liveMachine.runtimes || []).join(", ")].filter(Boolean).join(" · ") : "";

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {step === "intro" && (<>
          <h3>{t("chat.addComputerTitle")}</h3>
          <div className="onboard-lead"><span className="onboard-ico"><IconMonitor size={22} /></span><p>{t("chat.addComputerBody")}</p></div>
          <p className="modal-note">{t("chat.addComputerRuntimes")}</p>
          <div className="acts">
            <label className="onboard-optout"><input type="checkbox" checked={dontRemind} onChange={(e) => setDontRemind(e.target.checked)} /> {t("chat.addComputerDontRemind")}</label>
            <button className="cancel" onClick={close}>{t("chat.addComputerSkip")}</button>
            <button className="ok" onClick={() => setStep("connect")}><IconMonitor size={14} /> {t("chat.addComputerConnect")}</button>
          </div>
        </>)}

        {step === "connect" && (<>
          <h3>{mode === "reconnect" && machine ? t("misc.reconnectModalTitle", { name: machine.name }) : t("misc.connectModalTitle")}</h3>
          {mode === "reconnect" ? <p className="modal-note">{t("misc.reconnectModalNote")}</p> : null}
          {genErr ? (<>
            <p className="form-err">{genErr}</p>
            <div className="acts"><button className="cancel" onClick={close}>{t("misc.connectModalCancel")}</button><button className="ok" onClick={gen} disabled={busy}>{busy ? t("misc.connectModalGenerating") : t("misc.wizardRetry")}</button></div>
          </>) : !res ? (
            <div className="wiz-wait"><span className="wiz-pulse" /> {t("misc.connectModalGenerating")}</div>
          ) : (<>
            <label>{t("misc.wizardCmdIntro")}</label>
            <div className="codebox"><code className="grow">{cmd}</code><button className="joinbtn" onClick={() => copy(cmd)}>{copied ? t("misc.connectModalCopied") : t("misc.connectModalCopyBtn")}</button></div>
            <div className="wiz-wait"><span className="wiz-pulse" /> {t("misc.wizardWaiting")}</div>
            <div className="acts"><button className="cancel" onClick={close}>{t("misc.connectModalCancel")}</button></div>
          </>)}
        </>)}

        {step === "connected" && (<>
          <h3>{t("misc.wizardConnectedTitle")}</h3>
          <div className="wiz-ok">
            <CheckCircle2 size={24} className="wiz-ok-ico" />
            <div><div><b>{t("misc.wizardConnectedSuccess")}</b></div>{meta ? <div className="wiz-ok-meta">{meta}</div> : null}</div>
          </div>
          <label>{t("misc.wizardNameLabel")}</label>
          <input autoFocus value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder={liveMachine?.hostname || ""} maxLength={80} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(); }} />
          <p className="wiz-hint">{t("misc.wizardNameHint")}</p>
          <div className="acts"><button className="ok" onClick={finish} disabled={savingName}>{t("misc.connectModalDone")}</button></div>
        </>)}
      </div>
    </div>
  );
}
