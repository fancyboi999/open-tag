// Attachment multipart upload parser: streams via busboy into storage.saveObject (driver-agnostic: local disk or S3-compatible).
import Busboy from "busboy";
import type { IncomingMessage } from "node:http";
import { saveObject } from "./storage.js";

export interface UploadedFile { filename: string; mimeType: string; size: number; storageKey: string }

/**
 * Normalise a client-declared MIME type before storage.
 *
 * Browsers control the Content-Type of each multipart part, so we never trust
 * it at face value. This function:
 *   - Extracts only the base type (strips "; charset=utf-8" etc. to prevent
 *     header-injection via stored parameters).
 *   - Normalises to lowercase.
 *   - Rejects malformed or injection-looking strings, falling back to
 *     "application/octet-stream".
 *
 * Note: this does NOT filter out dangerous types like text/html — that
 * responsibility belongs to safeDownloadHeaders() in routes-api/attachments.ts,
 * which enforces a safe-inline whitelist at serve time and covers both new
 * uploads and any legacy records already in the database.
 */
export function sanitizeMimeType(declared: string): string {
  // Extract the base type (before the first ";")
  const base = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  // A valid MIME type is "type/subtype" where both parts are non-empty tokens.
  // RFC 2045 tokens: printable ASCII excluding specials. We use a conservative
  // subset that covers all real-world types while rejecting injection attempts.
  if (/^[a-z0-9][a-z0-9!#$&\-^_.+]*\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/.test(base)) {
    return base;
  }
  return "application/octet-stream";
}

export function parseUpload(req: IncomingMessage): Promise<{ fields: Record<string, string>; files: UploadedFile[] }> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 10 } }); }
    catch (e) { return reject(e); }
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];
    const pending: Promise<void>[] = [];
    let firstError: unknown = null;
    bb.on("field", (name, val) => { fields[name] = val; });
    bb.on("file", (_name, stream, info) => {
      // Each per-file task self-catches: a save that fails (especially before the stream is
      // consumed, e.g. s3Config() validation) must still drain the stream so busboy emits
      // "close", and must never surface as an unhandledRejection (which crashes the process
      // on Node ≥15). The error is remembered and surfaced once, after close.
      pending.push((async () => {
        try {
          const { key, size } = await saveObject(info.filename || "file", stream);
          files.push({ filename: info.filename || "file", mimeType: sanitizeMimeType(info.mimeType || "application/octet-stream"), size, storageKey: key });
        } catch (e) {
          stream.resume(); // drain any unconsumed bytes so busboy can finish and emit "close"
          firstError ??= e;
        }
      })());
    });
    bb.on("close", () => { Promise.all(pending).then(() => { firstError ? reject(firstError) : resolve({ fields, files }); }).catch(reject); });
    bb.on("error", reject);
    req.pipe(bb);
  });
}
