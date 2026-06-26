// Top-left brand button = workspace switcher. Click to list all joined workspaces, switch between them, or create a new one.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Check } from "lucide-react";
import { useStore } from "./store.tsx";
import { useTranslation } from "react-i18next";

export function ServerSwitcher() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { servers, slug, serverAvatar, createServer } = useStore();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const cur = servers.find((s) => s.slug === slug);
  // Client-side navigation (no full-page reload): the URL change drives the workspace switch via the /s/:server route guard.
  const go = (s: { slug: string }) => { setOpen(false); if (s.slug !== slug) nav(`/s/${s.slug}/channel`); };
  const submit = async () => { if (!name.trim() || busy) return; setBusy(true); try { const newSlug = await createServer(name.trim()); if (newSlug) { close(); nav(`/s/${newSlug}/channel`); } } finally { setBusy(false); } };
  const close = () => { setOpen(false); setCreating(false); setName(""); };
  return (
    <div className="sw-wrap">
      <button className="brand" title={cur?.name || "open-tag"} aria-label={t("server.switchAriaLabel")} onClick={() => setOpen((o) => !o)}>
        {serverAvatar ? <img className="brand-img" src={serverAvatar} alt="" /> : (cur?.name?.[0]?.toUpperCase() || "f")}
        <span className="dot" />
      </button>
      {open && (<>
        <div className="sw-backdrop" onClick={close} />
        <div className="sw-pop" role="menu">
          <div className="sw-title">{t("server.menuTitle")}</div>
          {servers.map((s) => (
            <button key={s.id} className={"sw-item" + (s.slug === slug ? " on" : "")} onClick={() => go(s)}>
              <span className="sw-ava">{(s.name?.[0] || "?").toUpperCase()}</span>
              <span className="sw-name">{s.name}</span>
              {s.slug === slug && <Check size={14} className="sw-check" />}
            </button>
          ))}
          {creating ? (
            <div className="sw-create">
              <input autoFocus value={name} placeholder={t("server.namePlaceholder")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") close(); }} />
              <button className="sw-go" disabled={busy} onClick={submit}>{busy ? "…" : t("server.createBtn")}</button>
            </div>
          ) : (
            <button className="sw-add" onClick={() => setCreating(true)}><Plus size={14} /> {t("server.createWorkspace")}</button>
          )}
        </div>
      </>)}
    </div>
  );
}
