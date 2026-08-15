export function acceptLatestReadResponse(applied: Map<string, number>, key: string, order: number): boolean {
  if (order <= (applied.get(key) ?? 0)) return false;
  applied.set(key, order);
  return true;
}
