// Control plane entry point: HTTP (/api/* human, /agent-api/* agent) + WS (/daemon/connect) + SSE
import "../env.js"; // must be first: loads .env before any module reads process.env (e.g. db)
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./routes-api.js";
import { handleAgentApi } from "./routes-agent.js";
import { attachWs } from "./ws.js";
import { attachSocketIO } from "./socketio.js";
import { initRealtime } from "./realtime.js";
import { startReminderScheduler } from "./reminders.js";
import { reconcileCounters } from "../redis.js";
import { reconcileMachinesOnBoot, startMachineSweeper } from "./machineLiveness.js";
import { sendJson, sendErr } from "./util.js";
import { createLogger } from "../log.js";

const PORT = Number(process.env.PORT ?? 7777);
const WEBDIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const log = createLogger("server");
initRealtime();

const CTYPE: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json", ".webmanifest": "application/manifest+json" };
async function serveStatic(res: import("node:http").ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  let file = path.join(WEBDIST, rel);
  if (!file.startsWith(WEBDIST)) file = path.join(WEBDIST, "index.html");
  let data: Buffer; let ext = path.extname(file);
  try { data = await readFile(file); }
  catch { try { data = await readFile(path.join(WEBDIST, "index.html")); ext = ".html"; } catch { return false; } } // SPA fallback
  res.writeHead(200, { "content-type": CTYPE[ext] || "application/octet-stream" });
  res.end(data); return true;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
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
    // Static frontend (web/dist) + SPA fallback (client-side routing /s/:server/*)
    if (method === "GET" && await serveStatic(res, url.pathname)) return;
    sendErr(res, 404, "not found");
  } catch (e: any) {
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
