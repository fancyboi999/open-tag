export type UnreadValues = Record<string, number>;

export interface UnreadToken { owner: number; order: number }
export interface UnreadState {
  owner: number;
  values: UnreadValues;
  snapshotFloor: number;
  byKey: Record<string, number>;
  readByKey: Record<string, number>;
}

export const createUnreadState = (owner: number): UnreadState => ({ owner, values: {}, snapshotFloor: 0, byKey: {}, readByKey: {} });

export function applyUnreadValue(state: UnreadState, request: UnreadToken, applied: UnreadToken, key: string, value: number): UnreadState {
  if (request.owner !== state.owner || applied.owner !== state.owner
    || applied.order <= Math.max(state.snapshotFloor, state.byKey[key] ?? 0)
    || request.order <= (state.readByKey[key] ?? 0)) return state;
  const values = { ...state.values };
  if (value > 0) values[key] = value;
  else delete values[key];
  return {
    ...state,
    values,
    byKey: { ...state.byKey, [key]: applied.order },
    readByKey: { ...state.readByKey, [key]: request.order },
  };
}

export function applyUnreadDelta(state: UnreadState, token: UnreadToken, key: string, delta: number): UnreadState {
  if (token.owner !== state.owner || token.order <= Math.max(state.snapshotFloor, state.byKey[key] ?? 0)) return state;
  const values = { ...state.values, [key]: (state.values[key] ?? 0) + delta };
  return { ...state, values, byKey: { ...state.byKey, [key]: token.order } };
}

export function applyUnreadSnapshot(state: UnreadState, token: UnreadToken, snapshot: UnreadValues): UnreadState {
  if (token.owner !== state.owner || token.order <= state.snapshotFloor) return state;
  const values = { ...snapshot };
  const byKey: Record<string, number> = {};
  for (const [key, order] of Object.entries(state.byKey)) {
    if (order <= token.order) continue;
    if (Object.prototype.hasOwnProperty.call(state.values, key)) values[key] = state.values[key]!;
    else delete values[key];
    byKey[key] = order;
  }
  return { owner: state.owner, values, snapshotFloor: token.order, byKey, readByKey: state.readByKey };
}
