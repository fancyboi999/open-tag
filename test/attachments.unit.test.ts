// Regression test: an upload whose saveObject fails BEFORE the file stream is consumed
// (e.g. s3Config() validation throws) must make parseUpload REJECT — not hang (busboy never
// emits "close") and not crash the process (unhandledRejection). Pre-fix this hangs/crashes.
// Run: npx tsx --test --test-force-exit test/attachments.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

test("parseUpload rejects (not hangs/crashes) when saveObject fails before consuming the stream", { timeout: 8000 }, async () => {
  // Force the S3 driver to throw inside saveS3 → s3Config(), which happens BEFORE the stream is read.
  process.env.OPEN_TAG_STORAGE = "s3";
  process.env.OPEN_TAG_S3_ENDPOINT = "http://127.0.0.1:9000";
  process.env.OPEN_TAG_S3_KEY = "k";
  process.env.OPEN_TAG_S3_SECRET = "s";
  delete process.env.OPEN_TAG_S3_BUCKET; // missing → s3Config() throws "requires OPEN_TAG_S3_BUCKET"
  // Dynamic import so storage.ts's top-level DRIVER const is evaluated after env is set.
  const { parseUpload } = await import("../src/server/attachments.ts");

  const B = "----otTestBoundary";
  const body = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="files"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\nhello-bytes\r\n--${B}--\r\n`);
  const req: any = Readable.from([body]);
  req.headers = { "content-type": `multipart/form-data; boundary=${B}` };

  await assert.rejects(parseUpload(req), /OPEN_TAG_S3_BUCKET/);
});
