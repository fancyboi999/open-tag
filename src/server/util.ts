import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
export function sendErr(res: ServerResponse, code: number, error: string, extra: Record<string, unknown> = {}): void {
  sendJson(res, code, { error, ...extra });
}
export async function readJson<T = any>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve((d ? JSON.parse(d) : {}) as T); } catch { resolve({} as T); } });
  });
}
/** Canonical UUID shape check. A client-supplied id destined for a uuid column must pass this before
 *  reaching a query — Postgres throws on casting a non-uuid string (22P02), which surfaces as a 500.
 *  Malformed ids (e.g. the web client's synthetic `agent-reply:*` streaming-preview id) must be
 *  rejected as not-found at the route boundary instead. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string): boolean => UUID_RE.test(s);
function header(req: IncomingMessage, name: string): string | null {
  const h = req.headers[name];
  return Array.isArray(h) ? (h[0] ?? null) : (h ?? null);
}
export const serverIdHeader = (req: IncomingMessage) => header(req, "x-server-id");
export const agentIdHeader = (req: IncomingMessage) => header(req, "x-agent-id");
export function bearer(req: IncomingMessage): string | null {
  const v = header(req, "authorization");
  if (!v) return null;
  const m = /^Bearer\s+(.+)$/i.exec(v);
  return m ? m[1]!.trim() : null;
}
