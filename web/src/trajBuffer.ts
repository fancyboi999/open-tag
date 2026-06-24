// Bounded ring buffer for the global Agent Live Trace feed. Agents stream trajectory entries
// continuously; the panel keeps only the newest TRAJ_CAP entries in memory so the in-session
// trace survives channel/DM switches (state lives in the store, not the Chat view) without
// growing unbounded. Drop-oldest: when over cap, the front (oldest) entries are discarded.
export interface TrajItem { name?: string; text: string; tool?: boolean }

export const TRAJ_CAP = 300;

export function appendCapped(prev: TrajItem[], items: TrajItem[], cap: number = TRAJ_CAP): TrajItem[] {
  if (!items.length) return prev;
  const merged = [...prev, ...items];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
