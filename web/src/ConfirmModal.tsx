// Confirmation dialog for destructive actions. Promise-based: useConfirm() returns confirm(opts)=>Promise<boolean>.
// Usage: `if (!(await confirm({...}))) return;` — drop-in replacement for window.confirm with modal styling, danger variant, and Esc-to-cancel support.
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

// Shared hook for all modals: closes on Escape (accessibility). Call useEscClose(onClose) inside any modal component.
export function useEscClose(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

// Dialog focus contract shared by feature modals: focus enters the dialog, Tab stays inside,
// Escape closes, and focus returns to the exact trigger after every close path.
export function useDialogFocus(onClose: () => void, active = true) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') ?? [])]
      .filter((el) => !el.hidden && el.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => (dialogRef.current?.querySelector<HTMLElement>("[autofocus]") ?? focusable()[0] ?? dialogRef.current)?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      requestAnimationFrame(() => previous?.isConnected && previous.focus());
    };
  }, [active]);
  return dialogRef;
}

interface ConfirmOpts { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
type ConfirmFn = (opts: ConfirmOpts) => Promise<boolean>;
const Ctx = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [st, setSt] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => setSt({ ...opts, resolve })), []);
  const close = (v: boolean) => setSt((s) => { s?.resolve(v); return null; });
  const dialogRef = useDialogFocus(() => close(false), !!st);
  useEffect(() => {
    if (!st) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter" && !st.danger) close(true); // Enter confirms only for non-destructive actions; destructive actions require an explicit click
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [st]);
  return (
    <Ctx.Provider value={confirm}>
      {children}
      {st && (
        <div className="modal-bg" onClick={() => close(false)}>
          <div ref={dialogRef} className="modal confirm-modal" role="dialog" aria-modal="true" aria-label={st.title} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <h3>{st.title}</h3>
            {st.message && <p className="modal-note">{st.message}</p>}
            <div className="acts">
              <button className="cancel" onClick={() => close(false)}>{st.cancelLabel ?? t("confirm.cancel")}</button>
              <button className={st.danger ? "danger" : "ok"} autoFocus onClick={() => close(true)}>{st.confirmLabel ?? t("confirm.confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
