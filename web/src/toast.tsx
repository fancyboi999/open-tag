// Lightweight global toast notifications. Mirrors ConfirmModal's context-provider shape (no third-party lib).
// Usage: `const toast = useToast(); toast.error(t("..."))` / `toast.info(...)`. Callers pass already-translated
// strings (the toast layer stays i18n-agnostic). Used for one-shot operation feedback (e.g. start/create an
// agent while its machine is offline) where an inline banner would not fit.
import { createContext, useContext, useState, useCallback, useMemo, useRef, type ReactNode } from "react";

type ToastKind = "error" | "info";
interface ToastItem { id: number; kind: ToastKind; msg: string }
interface ToastApi { error: (msg: string) => void; info: (msg: string) => void }

const Ctx = createContext<ToastApi>({ error: () => {}, info: () => {} });
export const useToast = () => useContext(Ctx);

const TTL_MS = 5000; // auto-dismiss; also dismissable by click

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = ++idRef.current;
    setItems((xs) => [...xs, { id, kind, msg }]);
    setTimeout(() => remove(id), TTL_MS);
  }, [remove]);
  // Stable api object (push is stable) so consumers don't re-render on every toast change.
  const api = useMemo<ToastApi>(() => ({ error: (m) => push("error", m), info: (m) => push("info", m) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      {items.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite">
          {items.map((it) => (
            <div key={it.id} className={"toast toast-" + it.kind} onClick={() => remove(it.id)}>
              <span className="toast-msg">{it.msg}</span>
              <button className="toast-x" aria-label="dismiss" onClick={(e) => { e.stopPropagation(); remove(it.id); }}>×</button>
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
