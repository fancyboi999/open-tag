// Bounded ring buffer for the global Agent Live Trace feed. Agents stream trajectory entries
// continuously; the panel keeps only the newest TRAJ_CAP entries in memory so the in-session
// trace survives channel/DM switches (state lives in the store, not the Chat view) without
// growing unbounded. Drop-oldest: when over cap, the front (oldest) entries are discarded.
// `boundary` is a structural marker (no visible content) pushed when an agent's activity leaves
// working/thinking — it forces the next fragment for that same agent to start a fresh group
// instead of being appended to a turn that already ended (see store.tsx agent:activity handler).
export interface TrajItem { name?: string; text: string; tool?: boolean; boundary?: boolean }

export const TRAJ_CAP = 300;

export function appendCapped(prev: TrajItem[], items: TrajItem[], cap: number = TRAJ_CAP): TrajItem[] {
  if (!items.length) return prev;
  const merged = [...prev, ...items];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export interface TrajGroupItem { kind: "text" | "tool"; text: string }
export interface TrajGroup { name?: string; items: TrajGroupItem[] }

// Turns the flat, one-fragment-per-line buffer into message-bar-like groups: consecutive text
// fragments from the same agent/turn merge into one running block (so the panel reads as
// continuous prose, not a scrolling log); tool calls stay as their own discrete step; a different
// agent, or a boundary marker for the same agent, always starts a new group.
export function groupTraj(items: TrajItem[]): TrajGroup[] {
  const groups: TrajGroup[] = [];
  const boundaryPending = new Set<string>();
  for (const it of items) {
    const key = it.name ?? "";
    if (it.boundary) { boundaryPending.add(key); continue; }
    const last = groups[groups.length - 1];
    if (!last || last.name !== it.name || boundaryPending.has(key)) {
      groups.push({ name: it.name, items: [] });
      boundaryPending.delete(key);
    }
    const gi = groups[groups.length - 1]!.items;
    if (it.tool) { gi.push({ kind: "tool", text: it.text }); continue; }
    const lastItem = gi[gi.length - 1];
    if (lastItem && lastItem.kind === "text") lastItem.text += it.text;
    else gi.push({ kind: "text", text: it.text });
  }
  return groups;
}
