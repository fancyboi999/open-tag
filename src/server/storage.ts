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

// ── S3-compatible driver (disabled by default; enable by running `npm i @aws-sdk/client-s3` and setting OPEN_TAG_S3_ENDPOINT/BUCKET/REGION/KEY/SECRET) ──
async function s3client(): Promise<any> {
  const mod = await import("@aws-sdk/client-s3" as string).catch(() => { throw new Error("S3 driver requires @aws-sdk/client-s3: npm i @aws-sdk/client-s3"); });
  return new mod.S3Client({
    endpoint: process.env.OPEN_TAG_S3_ENDPOINT, region: process.env.OPEN_TAG_S3_REGION ?? "us-east-1",
    forcePathStyle: true, // required for MinIO/Garage
    credentials: { accessKeyId: process.env.OPEN_TAG_S3_KEY ?? "", secretAccessKey: process.env.OPEN_TAG_S3_SECRET ?? "" },
  });
}
async function saveS3(key: string, stream: Readable): Promise<Saved> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of stream) { chunks.push(c as Buffer); size += (c as Buffer).length; }
  const mod = await import("@aws-sdk/client-s3" as string);
  await (await s3client()).send(new mod.PutObjectCommand({ Bucket: process.env.OPEN_TAG_S3_BUCKET, Key: key, Body: Buffer.concat(chunks) }));
  return { key, size };
}
async function readS3(key: string): Promise<Buffer> {
  const mod = await import("@aws-sdk/client-s3" as string);
  const r = await (await s3client()).send(new mod.GetObjectCommand({ Bucket: process.env.OPEN_TAG_S3_BUCKET, Key: key }));
  const chunks: Buffer[] = []; for await (const c of r.Body as Readable) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
