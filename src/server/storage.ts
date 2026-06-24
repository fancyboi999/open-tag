// Pluggable object storage: defaults to local disk (zero-config, data stays on-prem), switchable to any S3-compatible backend (MinIO/Garage/SeaweedFS/OSS).
// env OPEN_TAG_STORAGE=local|s3; s3 uses @aws-sdk/client-s3 to connect to any S3-compatible endpoint (OPEN_TAG_S3_*).
// storageKey is driver-agnostic (local = relative filename, s3 = object key); switching storage backends requires no changes to business logic.
import { createWriteStream } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { uploadsDir } from "../paths.js";

const DRIVER = process.env.OPEN_TAG_STORAGE ?? "local";
const LOCAL_DIR = uploadsDir();

export interface Saved { key: string; size: number }

/** Stream-save an object and return the driver-agnostic storageKey plus byte count. */
export async function saveObject(filename: string, stream: Readable): Promise<Saved> {
  const safe = (filename || "file").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  const key = `${randomUUID()}__${safe}`;
  if (DRIVER === "s3") return saveS3(key, stream);
  await mkdir(LOCAL_DIR, { recursive: true });
  let size = 0;
  await new Promise<void>((res, rej) => {
    stream.on("data", (d: Buffer) => { size += d.length; });
    const ws = createWriteStream(path.join(LOCAL_DIR, key));
    ws.on("close", () => res()); ws.on("error", rej);
    stream.pipe(ws);
  });
  return { key, size };
}

export async function readObject(key: string): Promise<Buffer> {
  if (DRIVER === "s3") return readS3(key);
  return readFile(path.join(LOCAL_DIR, key));
}

// ── S3-compatible driver (disabled by default; enable by running `npm i @aws-sdk/client-s3` and setting OPEN_TAG_S3_ENDPOINT/BUCKET/KEY/SECRET, optional OPEN_TAG_S3_REGION) ──
export interface S3Config { endpoint: string; region: string; bucket: string; key: string; secret: string }

/** Validate + read S3 env on each call (mirrors paths.ts: honors lazily-loaded env, stays testable). Fail loud on missing config. */
export function s3Config(): S3Config {
  const endpoint = process.env.OPEN_TAG_S3_ENDPOINT;
  const bucket = process.env.OPEN_TAG_S3_BUCKET;
  const key = process.env.OPEN_TAG_S3_KEY;
  const secret = process.env.OPEN_TAG_S3_SECRET;
  const missing = ([
    ["OPEN_TAG_S3_ENDPOINT", endpoint], ["OPEN_TAG_S3_BUCKET", bucket],
    ["OPEN_TAG_S3_KEY", key], ["OPEN_TAG_S3_SECRET", secret],
  ] as const).filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new Error(
    `OPEN_TAG_STORAGE=s3 requires ${missing.join(", ")} to be set (see README → Object storage).`);
  return { endpoint: endpoint!, region: process.env.OPEN_TAG_S3_REGION ?? "us-east-1", bucket: bucket!, key: key!, secret: secret! };
}

async function s3client(cfg: S3Config): Promise<any> {
  const mod = await import("@aws-sdk/client-s3" as string).catch(() => { throw new Error("S3 driver requires @aws-sdk/client-s3: npm i @aws-sdk/client-s3"); });
  return new mod.S3Client({
    endpoint: cfg.endpoint, region: cfg.region,
    forcePathStyle: true, // required for MinIO/Garage
    credentials: { accessKeyId: cfg.key, secretAccessKey: cfg.secret },
  });
}
async function saveS3(key: string, stream: Readable): Promise<Saved> {
  const cfg = s3Config();
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of stream) { chunks.push(c as Buffer); size += (c as Buffer).length; }
  const mod = await import("@aws-sdk/client-s3" as string);
  await (await s3client(cfg)).send(new mod.PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: Buffer.concat(chunks) }));
  return { key, size };
}
async function readS3(key: string): Promise<Buffer> {
  const cfg = s3Config();
  const mod = await import("@aws-sdk/client-s3" as string);
  const r = await (await s3client(cfg)).send(new mod.GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const chunks: Buffer[] = []; for await (const c of r.Body as Readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
