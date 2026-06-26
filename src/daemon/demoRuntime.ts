// Demo runtime: a zero-cost, zero-dependency in-process runtime for public demo sites.
// No subprocess, no LLM API, no API key needed — always available.
//
// On each turn it:
//   1. Calls GET /agent-api/message/check (same as the open-tag CLI) to read pending messages.
//   2. For each unique target with pending messages, posts a fixed demo notice via
//      POST /agent-api/message/send — the agent reply the user sees in the channel.
//   3. Emits the text as a trajectory entry so the Activity tab also shows it.
//
// Using fetch (Node 18+ built-in) to call the LOCAL agent-API is not a "paid external API call"
// — it is the programmatic equivalent of running `open-tag message check` + `open-tag message send`
// from a CLI subprocess. Zero LLM spend, zero third-party network hops.
//
// Response varies by turn index (no Math.random — deterministic, mirrors other adapters'
// avoidance of non-determinism in the daemon).
import { randomUUID } from "node:crypto";
import type { Runtime, StartOpts, RuntimeCallbacks, RuntimeSession } from "./runtime.js";

const DEMO_NOTICE =
  "I'm a **demo agent** running on a no-op runtime — I don't call any LLM, so I can't do real work here. " +
  "To get a real AI teammate, self-host open-tag and connect a runtime like Claude Code, Codex, or your own API key. " +
  "See [getopentag.com](https://getopentag.com) to get started.";

// Greeting pool — index driven by turnIndex, not Math.random.
const GREETINGS = ["Hi there! 👋", "Hello again! 👋", "Hey! 👋", "Thanks for your message! 👋", "Received! 👋"];

// Extract the human-readable message body from a formatted agent-api message text.
// Format: "[target=<t> msg=<id> time=<iso> type=<role>] @sender: body text"
function extractBody(text: string): string {
  const m = /\] [^:]+: (.+)$/s.exec(text);
  return m ? m[1]!.trim() : "";
}

// Extract the target token from a formatted agent-api message text.
function extractTarget(text: string): string | null {
  const m = /^\[target=(\S+)/.exec(text);
  return m ? m[1]! : null;
}

// Build a deterministic per-turn reply: greeting (rotated by turnIndex) + fixed notice + echo.
export function buildReply(userBody: string, turnIndex: number): string {
  const greeting = GREETINGS[turnIndex % GREETINGS.length]!;
  const snippet = userBody.slice(0, 120);
  const tail = userBody.length > 120 ? "…" : "";
  const echo = snippet ? `\n\n> You said: "${snippet}${tail}"` : "";
  return `${greeting} ${DEMO_NOTICE}${echo}`;
}

// ── Thin agent-API transport (injectable for unit tests) ──────────────────────────────────────

export interface DemoTransport {
  check(): Promise<{ text: string }[]>;
  send(target: string, content: string): Promise<void>;
}

// Production transport: calls the local open-tag server's agent-API using the per-agent token
// that the daemon injects into opts.env (same credentials the open-tag CLI uses).
export function makeTransport(serverUrl: string, agentToken: string, agentId: string): DemoTransport {
  const base = serverUrl.replace(/\/$/, "");
  const headers = {
    "Authorization": `Bearer ${agentToken}`,
    "x-agent-id": agentId,
    "Content-Type": "application/json",
  };
  return {
    async check() {
      const r = await fetch(`${base}/agent-api/message/check`, { headers });
      const d = await r.json() as { messages?: { text: string }[] };
      return d.messages ?? [];
    },
    async send(target: string, content: string) {
      await fetch(`${base}/agent-api/message/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ target, content }),
      });
    },
  };
}

// ── DemoRun: serial turn queue (mirrors copilot/pi queue/pump pattern) ────────────────────────

class DemoRun {
  private readonly sessionId: string;
  private queue: string[] = [];
  private turnBusy = false;
  private stopped = false;
  private turnIndex = 0;
  private readonly transport: DemoTransport;

  constructor(private readonly opts: StartOpts, private readonly cb: RuntimeCallbacks, transport?: DemoTransport) {
    this.sessionId = opts.sessionId || randomUUID();
    this.transport = transport ?? makeTransport(
      opts.env.OPEN_TAG_SERVER_URL ?? "",
      opts.env.OPEN_TAG_AGENT_TOKEN ?? "",
      opts.env.OPEN_TAG_AGENT_ID ?? "",
    );
    cb.onSession(this.sessionId);
    this.enqueue(opts.initialPrompt);
  }

  enqueue(text: string): void {
    if (this.stopped) return;
    this.queue.push(text);
    this.pump();
  }

  private pump(): void {
    if (this.stopped || this.turnBusy || this.queue.length === 0) return;
    this.runTurn(this.queue.shift()!);
  }

  // Each turn: check messages → for each pending target, build + post a demo reply → mark online.
  // Uses setImmediate to stay non-blocking before the await chain takes over.
  private runTurn(_prompt: string): void {
    this.turnBusy = true;
    this.cb.onActivity("working", "turn");
    setImmediate(() => void this.executeTurn());
  }

  private async executeTurn(): Promise<void> {
    if (this.stopped) { this.turnBusy = false; return; }
    try {
      const messages = await this.transport.check();

      if (!messages.length) {
        // No pending messages (e.g. initial STARTUP_NUDGE with nothing in inbox yet).
        this.cb.onActivity("online", "");
        this.turnBusy = false;
        this.pump();
        return;
      }

      // Collect unique targets and the most-recent message body per target.
      const byTarget = new Map<string, string>(); // target → last body seen
      for (const m of messages) {
        const target = extractTarget(m.text);
        if (!target) continue;
        byTarget.set(target, extractBody(m.text));
      }

      for (const [target, body] of byTarget) {
        const reply = buildReply(body, this.turnIndex++);
        // Emit to Activity log (same as every other runtime's trajectory output).
        this.cb.onTrajectory([{ kind: "text", text: reply }]);
        // Post the reply into the channel — this is what the user actually sees.
        await this.transport.send(target, reply);
      }
    } catch (e) {
      // Don't crash the agent on a transient API failure; log + stay online.
      this.cb.log.warn("demo: turn failed", { detail: String((e as Error)?.message ?? e) });
    }

    if (!this.stopped) {
      this.cb.onActivity("online", "");
      this.turnBusy = false;
      this.pump();
    }
  }

  stop(): void { this.stopped = true; }
}

// ── Public runtime export ─────────────────────────────────────────────────────────────────────

export const demoRuntime: Runtime = {
  name: "demo",
  experimental: true,
  start(opts: StartOpts, cb: RuntimeCallbacks): RuntimeSession {
    const run = new DemoRun(opts, cb);
    return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
  },
};

// Exported for testing: allows tests to inject a mock transport without network calls.
export function startWithTransport(opts: StartOpts, cb: RuntimeCallbacks, transport: DemoTransport): RuntimeSession {
  const run = new DemoRun(opts, cb, transport);
  return { deliver: (text) => run.enqueue(text), stop: () => run.stop() };
}
