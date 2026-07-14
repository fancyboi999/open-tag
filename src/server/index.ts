// Control plane entry point: HTTP (/api/* human, /agent-api/* agent) + WS (/daemon/connect) + SSE
import "../env.js"; // must be first: loads .env before any module reads process.env (e.g. db)
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { handleApi } from "./routes-api/index.js";
import { handleAgentApi } from "./routes-agent.js";
import { attachWs } from "./ws.js";
import { attachSocketIO } from "./socketio.js";
import { initRealtime } from "./realtime.js";
import { startReminderScheduler } from "./reminders.js";
import { reconcileCounters } from "../redis.js";
import { reconcileMachinesOnBoot, startMachineSweeper } from "./machineLiveness.js";
import { sendJson, sendErr } from "./util.js";
import { createLogger } from "../log.js";
import { shouldServeAppShell } from "./staticRoutes.js";

// ── Security headers (helmet) ────────────────────────────────────────────────
// CSP, COEP, and CORP are disabled here: the Vite-built frontend uses inline
// scripts/styles and may load cross-origin assets. Add proper CSP directives
// once the frontend's nonce/hash strategy is established.
const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
});
const applyHelmet = (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> =>
  new Promise((resolve, reject) =>
    helmetMiddleware(req, res, (err?: unknown) => (err ? reject(err as Error) : resolve()))
  );

const redirect = (res: import("node:http").ServerResponse, location: string): void => {
  res.writeHead(308, { location });
  res.end();
};

// ── CORS origin whitelist ─────────────────────────────────────────────────────
// Reads ALLOWED_ORIGIN (comma-separated list of allowed origins, e.g. "https://app.example.com").
// Dev fallback (ALLOWED_ORIGIN unset): any localhost / 127.0.0.1 origin is permitted so Vite HMR
// and direct curl still work. Production deployments must set ALLOWED_ORIGIN explicitly.
const _allowedOrigins: Set<string> | null = (() => {
  const v = process.env.ALLOWED_ORIGIN?.trim();
  if (!v) return null; // null = dev mode, use localhost fallback
  return new Set(v.split(",").map(s => s.trim()).filter(Boolean));
})();

/** Returns the ACAO value to echo back, or null if the origin is not allowed. */
function corsOriginHeader(reqOrigin: string | undefined): string | null {
  if (!reqOrigin) return null; // no Origin header → same-origin or non-browser → no ACAO needed
  if (!_allowedOrigins) {
    // Dev mode: allow any localhost / 127.0.0.1 origin (any port)
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin) ? reqOrigin : null;
  }
  return _allowedOrigins.has(reqOrigin) ? reqOrigin : null;
}

const PORT = Number(process.env.PORT ?? 7777);
const WEBDIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const DOCSDIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs-site/dist");
const log = createLogger("server");
initRealtime();

const CTYPE: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".webmanifest": "application/manifest+json" };
async function serveStatic(res: import("node:http").ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  let file = path.join(WEBDIST, rel);
  if (!file.startsWith(WEBDIST)) file = path.join(WEBDIST, "index.html");
  let data: Buffer; let ext = path.extname(file);
  try { data = await readFile(file); }
  catch {
    if (!shouldServeAppShell(pathname)) return false;
    try { data = await readFile(path.join(WEBDIST, "index.html")); ext = ".html"; } catch { return false; }
  }
  res.writeHead(200, { "content-type": CTYPE[ext] || "application/octet-stream" });
  res.end(data); return true;
}

async function serveDocs(res: import("node:http").ServerResponse, pathname: string, sendBody = true): Promise<boolean> {
  const withoutPrefix = pathname === "/docs" ? "/" : pathname.slice("/docs".length);
  const rel = withoutPrefix === "/" ? "/index.html" : withoutPrefix;
  let file = path.join(DOCSDIST, rel);
  if (!file.startsWith(DOCSDIST)) file = path.join(DOCSDIST, "index.html");
  let data: Buffer; let ext = path.extname(file);
  try { data = await readFile(file); }
  catch { try { data = await readFile(path.join(DOCSDIST, "index.html")); ext = ".html"; } catch { return false; } }
  res.writeHead(200, { "content-type": CTYPE[ext] || "application/octet-stream" });
  res.end(sendBody ? data : undefined); return true;
}

async function serveDocsAsset(res: import("node:http").ServerResponse, pathname: string, sendBody = true): Promise<boolean> {
  let file = path.join(DOCSDIST, pathname);
  if (!file.startsWith(DOCSDIST)) return false;
  let data: Buffer; const ext = path.extname(file);
  try { data = await readFile(file); } catch { return false; }
  res.writeHead(200, { "content-type": CTYPE[ext] || "application/octet-stream" });
  res.end(sendBody ? data : undefined); return true;
}

const server = http.createServer(async (req, res) => {
  await applyHelmet(req, res);
  const allowedOrigin = corsOriginHeader(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader("access-control-allow-origin", allowedOrigin);
    res.setHeader("vary", "Origin");
  }
  res.setHeader("access-control-allow-headers", "authorization,content-type,x-server-id,x-agent-id");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/socket.io/")) return; // pass-through: handled by socket.io's own request listener (polling/handshake)
  const method = req.method ?? "GET";
  const t0 = Date.now();
  res.on("finish", () => log.debug("req", { method, path: url.pathname, status: res.statusCode, ms: Date.now() - t0 }));
  try {
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "open-tag", time: new Date().toISOString() });
    if (await handleAgentApi(req, res, url, method)) return;
    if (await handleApi(req, res, url, method)) return;
    const isRead = method === "GET" || method === "HEAD";
    if (isRead && url.pathname === "/docs") return redirect(res, "/docs/");
    if (isRead && url.pathname.startsWith("/docs/") && await serveDocs(res, url.pathname, method === "GET")) return;
    if (isRead && url.pathname.startsWith("/_astro/") && await serveDocsAsset(res, url.pathname, method === "GET")) return;
    // Static frontend (web/dist) + SPA fallback (client-side routing /s/:server/*)
    if (method === "GET" && await serveStatic(res, url.pathname)) return;
    sendErr(res, 404, "not found");
  } catch (e: any) {
    // Postgres 22P02 (invalid text representation — e.g. a non-uuid client id cast into a uuid column,
    // drizzle wraps the original error as .cause) is a malformed-input class, not a server fault: respond
    // 400 without the raw query text. Route boundaries validate ids explicitly (isUuid); this is the
    // backstop for any entry point that slips through — the 500 fallback below echoes e.message, which
    // for query errors contains the SQL + bind values and must never reach a client for this class.
    if ((e?.cause?.code ?? e?.code) === "22P02") {
      log.warn("request error (malformed id)", { path: url.pathname, method });
      try { sendErr(res, 400, "invalid id"); } catch { /* */ }
      return;
    }
    log.error("request error", { path: url.pathname, method, detail: String(e?.message ?? e), stack: e?.stack });
    try { sendErr(res, 500, "internal", { detail: String(e?.message ?? e) }); } catch { /* */ }
  }
});

attachSocketIO(server); // human-side realtime (socket.io, /socket.io/)
attachWs(server);       // daemon control plane (raw ws, /daemon/connect)
startReminderScheduler(); // reminder scheduler: fires at due time, wakes the author

// Durability guard: before accepting traffic, advance Redis seq/tasknum counters to match the current Postgres maximum.
// Prevents seq collisions and silent message drops in /messages/sync if Redis loses data (flush/instance swap/eviction) and INCR restarts from a lower value.
reconcileCounters()
  .then((r) => log.info("counters reconciled", r))
  .catch((e) => log.error("counter reconcile failed (continuing)", { detail: String(e?.message ?? e) }))
  // Before listening (so no daemon can reconnect first), flip stale "online" machines to offline —
  // a fresh server instance has zero daemons connected; they re-mark online on reconnect.
  .then(() => reconcileMachinesOnBoot().catch((e) => log.error("machine reconcile failed (continuing)", { detail: String(e?.message ?? e) })))
  .finally(() => server.listen(PORT, () => {
    log.info("control plane up", { url: `http://localhost:${PORT}`, logs: "~/.open-tag/logs/" });
    startMachineSweeper(); // backstop: offline machines whose daemon died without a clean WS close
  }));
