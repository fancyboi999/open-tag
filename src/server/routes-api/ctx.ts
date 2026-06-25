// Request context threaded through the per-domain route handlers. Each gate in
// handleApi (index.ts) widens the context: public → +userId → +serverId. Handlers
// destructure exactly the fields they use. `member` is intentionally NOT carried —
// the membership check lives in the orchestrator's gate, not in the handlers.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface BaseCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  p: string;
}
export interface UserCtx extends BaseCtx {
  userId: string;
}
export interface ServerCtx extends UserCtx {
  serverId: string;
}
