// Unified avatar: DiceBear notionists style, seed → deterministic unique avatar with a circular light background.
import { useMemo } from "react";
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";

const cache = new Map<string, string>();
function uriFor(seed: string): string {
  const key = seed || "?";
  let u = cache.get(key);
  if (!u) { u = createAvatar(notionists, { seed: key, size: 64, radius: 50, backgroundColor: ["eeeeee"] }).toDataUri(); cache.set(key, u); }
  return u;
}

export function Avatar({ seed, size = 24, url }: { seed: string; size?: number; url?: string | null }) {
  const uri = useMemo(() => uriFor(seed), [seed]);
  return <img className="av-img" src={url || uri} width={size} height={size} alt={seed} title={seed} />;
}
