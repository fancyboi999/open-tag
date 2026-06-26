// Custom dropdown (replaces native <select>: the native expanded list is OS-rendered, unstyled by CSS, and visually inconsistent inside modals).
// The menu is portaled to <body> (createPortal) with fixed positioning + getBoundingClientRect. This escapes BOTH overflow clipping AND an
// ancestor transform's containing block: a CSS enter-animation with fill-mode:both leaves .modal holding an identity matrix() transform
// (its computed value is a matrix, NOT "none"), and ANY non-none transform makes that ancestor the containing block of a fixed descendant —
// which would re-anchor the menu to .modal instead of the viewport and drift it off its trigger. Portaling to <body> sidesteps it entirely.
// Supports: click to open/close, option selection, click-outside to close, Escape to close, arrow-key highlight + Enter to confirm.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface Opt { value: string; label: string; hint?: string }

export function Select({ value, options, onChange, placeholder, ariaLabel }: { value: string; options: Opt[]; onChange: (v: string) => void; placeholder?: string; ariaLabel?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0); // keyboard-highlighted option index
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  const place = () => { const r = btnRef.current?.getBoundingClientRect(); if (r) setPos({ left: r.left, top: r.bottom + 6, width: r.width }); };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false); };
    const close = () => setOpen(false);
    // Close on scroll EXCEPT when the scroll happens inside the menu itself. The menu is a fixed,
    // viewport-positioned overlay, so an outer/page scroll drifts it off its trigger → close it. But a
    // long option list scrolling within its own max-height must NOT dismiss the menu (capture-phase
    // listener sees that inner scroll too, so we have to exclude it explicitly).
    const onScroll = (e: Event) => { if (menuRef.current?.contains(e.target as Node)) return; setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("resize", close); window.removeEventListener("scroll", onScroll, true); };
  }, [open, options, value]);

  const pick = (v: string) => { onChange(v); setOpen(false); btnRef.current?.focus(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) { if (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ") { e.preventDefault(); setOpen(true); } return; }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(options.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); options[hi] && pick(options[hi]!.value); }
  };

  return (
    <div className="sel">
      <button ref={btnRef} type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        className={"sel-trigger" + (open ? " open" : "")} onClick={() => setOpen((o) => !o)} onKeyDown={onKey}>
        <span className="grow">{cur?.label ?? <span className="sel-ph">{placeholder ?? t("select.placeholder")}</span>}</span>
        <svg className="sel-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="sel-menu" role="listbox" style={{ left: pos.left, top: pos.top, minWidth: pos.width }} onKeyDown={onKey} tabIndex={-1}>
          {options.length === 0 ? <div className="sel-empty">{t("select.empty")}</div> : options.map((o, i) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value}
              className={"sel-opt" + (o.value === value ? " on" : "") + (i === hi ? " hi" : "")}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}>
              <span className="grow">{o.label}{o.hint && <span className="sel-hint">{o.hint}</span>}</span>
              {o.value === value && <Check size={14} className="sel-check" />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
