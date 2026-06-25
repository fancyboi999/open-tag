// Shared daemon ↔ server WebSocket control-plane protocol constants. Imported by BOTH src/server/ws.ts and
// src/daemon/connection.ts so the two planes can never drift on the wire contract. See ARCHITECTURE.md
// "Control plane is always the backbone".

// WS close code (RFC 6455 §7.4.2 private range 4000–4999) the server sends when it cannot authenticate or
// identify a machine: an unknown key, or a key whose machine row was deleted or rotated via …/reconnect.
// This is a permanent rejection, not a transient drop — retrying the same key can never succeed — so the
// daemon backs off to its cap and surfaces an actionable error instead of reconnecting once a second forever.
export const MACHINE_REJECTED_CODE = 4001;
