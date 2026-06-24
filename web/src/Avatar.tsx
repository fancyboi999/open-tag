// Unified avatar: DiceBear notionists style, seed → deterministic unique avatar with a circular light background.
// An avatarUrl may be a real image (uploaded attachment) OR a generated-avatar scheme `dicebear:<seed>`
// (also accepts the legacy `pixel:random:<seed>` alias) — the latter renders a notionists avatar from <seed>,
// which is how the "avatar set" picker persists a chosen generated face without uploading a file.
import { useMemo, useRef, useState } from "react";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import { Camera, X, Shuffle, Upload } from "lucide-react";

const cache = new Map<string, string>();
function uriFor(seed: string): string {
  const key = seed || "?";
  let u = cache.get(key);
  if (!u) { u = createAvatar(notionists, { seed: key, size: 64, radius: 50, backgroundColor: ["eeeeee"] }).toDataUri(); cache.set(key, u); }
  return u;
}

const GEN_PREFIXES = ["dicebear:", "pixel:random:"];
/** If avatarUrl is a generated-avatar scheme, return its embedded seed; otherwise null (it's a real image URL or empty). */
function genSeed(url?: string | null): string | null {
  if (!url) return null;
  for (const p of GEN_PREFIXES) if (url.startsWith(p)) return url.slice(p.length);
  return null;
}
/** Resolve a stored avatarUrl into the value to hand <Avatar url=…>: sign attachment URLs, pass generated schemes through. */
export function resolveAvatar(avatarUrl: string | null | undefined, signAttachment: (id: string) => string): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith("/api/attachments/")) return signAttachment(avatarUrl.replace("/api/attachments/", ""));
  return avatarUrl; // dicebear:<seed> / pixel:random:<seed> — Avatar generates from the seed
}

export function Avatar({ seed, size = 24, url }: { seed: string; size?: number; url?: string | null }) {
  const gen = genSeed(url);
  const isImg = !!url && !gen;
  const uri = useMemo(() => uriFor(gen || seed), [gen, seed]);
  return <img className="av-img" src={isImg ? url! : uri} width={size} height={size} alt={seed} title={seed} />;
}

// A fresh batch of generated-avatar candidate seeds for the picker. The display name anchors the first few
// so they feel "yours", the rest are random for variety; "shuffle" just calls this again.
function seedBatch(base: string, n = 18): string[] {
  const out = [base];
  while (out.length < n) out.push(base + "-" + Math.random().toString(36).slice(2, 8));
  return out;
}

// Editable avatar = the change-avatar control. Click opens a picker offering (a) a set of generated avatars to
// switch to and (b) upload-your-own. onPickSeed persists a chosen generated face (avatarUrl=dicebear:<seed>);
// onPickFile uploads a custom image. When editable is false it renders a plain Avatar (view-only).
export function AvatarPicker({ name, size = 48, url, editable, busy, onPickSeed, onPickFile }: {
  name: string; size?: number; url?: string | null; editable?: boolean; busy?: boolean;
  onPickSeed?: (seed: string) => void; onPickFile?: (f: File) => void;
}) {
  const [open, setOpen] = useState(false);
  const [batch, setBatch] = useState<string[]>(() => seedBatch(name));
  const fileRef = useRef<HTMLInputElement>(null);
  if (!editable) return <Avatar seed={name} size={size} url={url} />;
  return (
    <>
      <button type="button" className="av-editable" style={{ width: size, height: size }} title="Change avatar"
        disabled={busy} onClick={() => { setBatch(seedBatch(name)); setOpen(true); }}>
        <Avatar seed={name} size={size} url={url} />
        <span className="av-editable-ovl">{busy ? "…" : <Camera size={Math.round(size * 0.32)} />}</span>
      </button>
      {open && (
        <div className="modal-bg" onClick={() => setOpen(false)}>
          <div className="modal av-picker" onClick={(e) => e.stopPropagation()}>
            <div className="av-picker-head">
              <h3>Choose avatar</h3>
              <button className="joinbtn" title="Close" onClick={() => setOpen(false)}><X size={14} /></button>
            </div>
            <div className="av-picker-grid">
              {batch.map((s) => (
                <button key={s} type="button" className="av-picker-opt" title="Use this avatar"
                  onClick={() => { onPickSeed?.("dicebear:" + s); setOpen(false); }}>
                  <Avatar seed={s} size={56} />
                </button>
              ))}
            </div>
            <div className="av-picker-acts">
              <button className="joinbtn" onClick={() => setBatch(seedBatch(name))}><Shuffle size={13} style={{ verticalAlign: "-2px" }} /> Shuffle</button>
              <button className="joinbtn" onClick={() => fileRef.current?.click()}><Upload size={13} style={{ verticalAlign: "-2px" }} /> Upload image</button>
              <input type="file" ref={fileRef} accept="image/*" style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { onPickFile?.(f); setOpen(false); } }} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
