import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

const SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
export const BOOTSTRAP_KEY = process.env.DAEMON_BOOTSTRAP_KEY ?? "poc-secret-key";

export const signUser = (userId: string) => jwt.sign({ uid: userId }, SECRET, { expiresIn: "30d" });
export function verifyUser(token: string | null): string | null {
  if (!token) return null;
  try { return (jwt.verify(token, SECRET) as { uid?: string }).uid ?? null; } catch { return null; }
}

/** dev-login gate: a public username→JWT shortcut for local dev. Disabled by default so production never ships it open.
 *  Read at call-time (not module load) so the value is honored even if the env is mutated after import (e.g. tests). */
export const devLoginEnabled = (): boolean => process.env.ALLOW_DEV_LOGIN === "true";

/** First-deploy admin setup token (`POST /api/auth/setup`). When unset, the setup endpoint is disabled entirely (404). */
export const setupToken = (): string | null => {
  const t = process.env.ADMIN_SETUP_TOKEN;
  return t && t.length > 0 ? t : null;
};

/** Constant-time string compare for secrets (token/key) — avoids leaking length-prefix matches via timing.
 *  Length mismatch short-circuits to false but only after a fixed-length compare to keep timing uniform. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

// ── Input validation (shared by register / login / setup) ──
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (email: unknown): email is string =>
  typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);

/** Password policy. Returns null when valid, otherwise a human-readable reason (used as the unified error message). */
export function passwordError(pw: unknown): string | null {
  if (typeof pw !== "string") return "password required";
  if (pw.length < 8) return "password must be at least 8 characters";
  if (pw.length > 200) return "password too long";
  return null;
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  const [salt, h] = stored.split(":");
  if (!salt || !h) return false;
  const c = crypto.scryptSync(pw, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c));
}

export const newKey = (prefix: string) => prefix + crypto.randomBytes(24).toString("hex");
export const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

/** agent-api auth: Bearer = the agent's own per-agent token (`sk_agent_*`, injected by daemon at spawn, see slice10) + x-agent-id header.
 *  Identity is resolved by hashing the token and looking it up: the token must belong to the agent named in x-agent-id, which prevents cross-agent and cross-server impersonation.
 *  No shared bootstrap key; machine keys are not accepted as agent credentials (machine keys are used only for daemon WS connections, see ws.ts). */
export async function resolveAgent(token: string | null, agentId: string | null) {
  if (!token || !agentId) return null;
  const agent = (await db.select().from(schema.agents).where(eq(schema.agents.id, agentId)))[0];
  if (!agent || !agent.agentTokenHash) return null;
  if (hashToken(token) === agent.agentTokenHash) return agent;
  return null;
}
