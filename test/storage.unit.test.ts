// Unit tests for S3 config validation (fail-loud). Pure logic, no network/disk.
// Run: npx tsx --test --test-force-exit test/storage.unit.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { s3Config } from "../src/server/storage.ts";

const S3_VARS = ["OPEN_TAG_S3_ENDPOINT", "OPEN_TAG_S3_BUCKET", "OPEN_TAG_S3_KEY", "OPEN_TAG_S3_SECRET", "OPEN_TAG_S3_REGION"];
function setAll() {
  process.env.OPEN_TAG_S3_ENDPOINT = "http://localhost:9000";
  process.env.OPEN_TAG_S3_BUCKET = "open-tag";
  process.env.OPEN_TAG_S3_KEY = "ak";
  process.env.OPEN_TAG_S3_SECRET = "sk";
  delete process.env.OPEN_TAG_S3_REGION;
}
function clearAll() { for (const v of S3_VARS) delete process.env[v]; }

test("all required set → returns config, region defaults to us-east-1", () => {
  setAll();
  assert.deepEqual(s3Config(), {
    endpoint: "http://localhost:9000", region: "us-east-1",
    bucket: "open-tag", key: "ak", secret: "sk",
  });
});

test("explicit region is honored", () => {
  setAll();
  process.env.OPEN_TAG_S3_REGION = "cn-hangzhou";
  assert.equal(s3Config().region, "cn-hangzhou");
});

test("missing endpoint throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_ENDPOINT;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_ENDPOINT/);
});

test("missing bucket throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_BUCKET;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_BUCKET/);
});

test("missing key throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_KEY;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_KEY/);
});

test("missing secret throws and names the var", () => {
  setAll();
  delete process.env.OPEN_TAG_S3_SECRET;
  assert.throws(() => s3Config(), /OPEN_TAG_S3_SECRET/);
});

test("multiple missing → message lists all of them", () => {
  clearAll();
  assert.throws(() => s3Config(), (e: Error) =>
    /OPEN_TAG_S3_ENDPOINT/.test(e.message) && /OPEN_TAG_S3_BUCKET/.test(e.message) &&
    /OPEN_TAG_S3_KEY/.test(e.message) && /OPEN_TAG_S3_SECRET/.test(e.message));
});
