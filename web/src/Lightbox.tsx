// Image lightbox: focused media panel with scroll-to-zoom, drag-to-pan, double-click to reset, Esc/backdrop
// to close. Portaled to document.body so position:fixed is viewport-relative (not relative to a message
// row's enter-animation transform). Shared by the real Chat view and the static Showcase demo so an image
// preview opens a floating dialog in place instead of navigating the browser to the raw asset.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import i18n from "./i18n";

export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prevFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        e.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      prevFocus.current?.focus();
    };
  }, [onClose]);
  return createPortal(
    <div className="lightbox-bg" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose} onWheel={(e) => { setScale((s) => Math.min(8, Math.max(1, s - e.deltaY * 0.0016 * s))); }}>
      <button ref={closeRef} className="lightbox-x" onClick={onClose} aria-label={i18n.t("chat.close")}><X size={20} /></button>
      <div className="lightbox-panel" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="lightbox-img" draggable={false}
          style={{ transform: `translate(${pos.x}px,${pos.y}px) scale(${scale})`, cursor: scale > 1 ? (drag.current ? "grabbing" : "grab") : "zoom-in" }}
          onClick={(e) => { e.stopPropagation(); if (scale === 1) setScale(2); }}
          onDoubleClick={(e) => { e.stopPropagation(); setScale(1); setPos({ x: 0, y: 0 }); }}
          onMouseDown={(e) => { if (scale > 1) { e.preventDefault(); drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; } }}
          onMouseMove={(e) => { if (drag.current) setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
          onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }} />
      </div>
    </div>,
    document.body,
  );
}
