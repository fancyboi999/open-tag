// Control-plane WebSocket client with exponential-backoff reconnection.
import WebSocket from "ws";
import { createLogger } from "../log.js";
import { MACHINE_REJECTED_CODE } from "../daemonProtocol.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// Minimal surface of the `ws` client that Connection depends on, so tests can inject a fake socket.
export interface WsLike {
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export class Connection {
  private ws: WsLike | null = null;
  private delay = INITIAL_BACKOFF_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private should = true;
  private accepted = false; // per-attempt: flips true once the server sends any frame (proof it accepted us, not rejected)
  private log = createLogger("daemon:conn");

  constructor(
    private url: string,
    private key: string,
    private onMsg: (m: any) => void,
    private onOpen: () => void,
    private mkWs: (url: string) => WsLike = (u) => new WebSocket(u),
  ) {}

  connect(): void { this.should = true; this.doConnect(); }
  send(m: unknown): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  close(): void { this.should = false; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }

  private doConnect(): void {
    if (!this.should) return;
    const wsUrl = this.url.replace(/^http/, "ws") + `/daemon/connect?key=${encodeURIComponent(this.key)}`;
    this.log.info("connecting", { url: this.url });
    this.accepted = false;
    this.ws = this.mkWs(wsUrl);
    // NB: do NOT reset the backoff on `open`. A rejected key also briefly opens before the server closes it;
    // resetting here would pin the backoff at 1s and turn a permanent rejection into a once-a-second storm.
    this.ws.on("open", () => { this.log.info("connected"); this.onOpen(); });
    this.ws.on("message", (d: any) => {
      // The first frame from the server proves it accepted this connection (a rejected key is closed with no
      // frame), so it's now safe to reset the backoff — a later drop is a genuine fresh failure worth a fast retry.
      if (!this.accepted) { this.accepted = true; this.delay = INITIAL_BACKOFF_MS; }
      let m: any; try { m = JSON.parse(d.toString()); } catch { return; }
      this.onMsg(m);
    });
    this.ws.on("close", (code: number, reason: any) => {
      if (code === MACHINE_REJECTED_CODE) {
        // Permanent: this key will never be accepted again. Jump to the max backoff and tell the operator
        // exactly what to do, instead of looping silently every second.
        this.delay = MAX_BACKOFF_MS;
        this.log.error(
          "server rejected this machine: its connection key is unknown or was removed. Re-issue the connect command (workspace → Computers → this machine → Reconnect), then restart the daemon with the new key.",
          { code, reason: reason?.toString?.() ?? String(reason ?? "") },
        );
      } else {
        this.log.warn("disconnected", { code });
      }
      this.scheduleReconnect();
    });
    this.ws.on("error", (e: any) => this.log.error("ws error", { detail: String(e?.message ?? e) }));
  }
  private scheduleReconnect(): void {
    if (!this.should || this.timer) return;
    this.log.info("reconnecting", { ms: this.delay });
    this.timer = setTimeout(() => { this.timer = null; this.doConnect(); }, this.delay);
    this.delay = Math.min(this.delay * 2, MAX_BACKOFF_MS);
  }
}
