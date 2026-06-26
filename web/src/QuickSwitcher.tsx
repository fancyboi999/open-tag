// Cmd/Ctrl+K global quick switcher: aggregates channels/DMs/agents/members with text filter, arrow-key navigation, and Enter to jump.
import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "./store.tsx";
import { Avatar } from "./Avatar.tsx";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

interface QSItem { kind: "channel" | "dm" | "agent" | "human"; id: string; label: string; sub: string; go: () => void }

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { channels, dms, visibleAgents: agents, humans, slug } = useStore(); // visibleAgents: keep showcase demo props out of the quick switcher
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const ql = q.toLowerCase().trim();
  const all: QSItem[] = [
    ...channels.filter((c) => c.type !== "dm").map((c): QSItem => ({ kind: "channel", id: c.id, label: c.name, sub: t("qs.subChannel"), go: () => nav(`/s/${slug}/channel/${c.id}`) })),
    ...dms.map((d): QSItem => ({ kind: "dm", id: d.id, label: d.peerDisplayName || d.peerName || t("qs.unknownUser"), sub: t("qs.subDm"), go: () => nav(`/s/${slug}/channel/${d.id}`) })),
    ...agents.map((a): QSItem => ({ kind: "agent", id: a.id, label: a.displayName || a.name, sub: t("qs.subAgent"), go: () => nav(`/s/${slug}/agent/${a.id}`) })),
    ...humans.map((h): QSItem => ({ kind: "human", id: h.userId, label: h.displayName || h.name, sub: t("qs.subMember"), go: () => nav(`/s/${slug}/human/${h.userId}`) })),
  ];
  const items = (ql ? all.filter((it) => it.label.toLowerCase().includes(ql)) : all).slice(0, 40);

  const pick = (it?: QSItem) => { if (!it) return; it.go(); onClose(); };
  const move = (d: number) => setHi((h) => {
    const n = Math.max(0, Math.min(h + d, items.length - 1));
    listRef.current?.children[n]?.scrollIntoView({ block: "nearest" });
    return n;
  });
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(items[hi]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <div className="modal-bg qs-bg" onClick={onClose}>
      <div className="qs" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t("qs.ariaLabel")}>
        <div className="qs-search">
          <Search size={16} />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKey} placeholder={t("qs.placeholder")} aria-label={t("qs.inputAriaLabel")} />
        </div>
        <div className="qs-list" ref={listRef}>
          {items.length === 0 ? <div className="qs-empty">{t("qs.noMatch")}</div> :
            items.map((it, i) => (
              <button key={it.kind + it.id} className={"qs-item" + (i === hi ? " on" : "")} onMouseEnter={() => setHi(i)} onClick={() => pick(it)}>
                {it.kind === "channel" ? <span className="qs-hash">#</span> : <Avatar seed={it.label} size={20} />}
                <span className="qs-label">{it.label}</span>
                <span className="qs-kind">{it.sub}</span>
              </button>
            ))}
        </div>
        <div className="qs-foot"><kbd>↑↓</kbd> {t("qs.footSelect")} · <kbd>↵</kbd> {t("qs.footGo")} · <kbd>esc</kbd> {t("qs.footClose")}</div>
      </div>
    </div>
  );
}
