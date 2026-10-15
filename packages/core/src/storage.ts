/**
 * File storage for creatives and logos. Uses S3-compatible object storage
 * (AWS S3, Cloudflare R2, DigitalOcean Spaces…) when S3_BUCKET is set, and a
 * local directory otherwise (development).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomToken } from "./crypto";

export interface StoredFile {
  key: string;
  url: string;
}

let s3: S3Client | undefined;
function client() {
  s3 ??= new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(process.env.S3_ENDPOINT),
    credentials:
      process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
        : undefined,
  });
  return s3;
}

const useS3 = () => Boolean(process.env.S3_BUCKET);
const localDir = () =>
  path.resolve(process.env.REPO_ROOT || process.cwd(), process.env.UPLOAD_DIR || ".data/uploads");
const publicBase = () => (process.env.FILES_PUBLIC_URL || "/api/files").replace(/\/$/, "");

/** Builds an unguessable key such as `creatives/<org>/<random>.png`. */
export function makeKey(prefix: string, filename: string) {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 8);
  return `${prefix}/${randomToken(18)}${ext}`;
}

export async function putFile(key: string, data: Buffer, contentType: string): Promise<StoredFile> {
  if (useS3()) {
    await client().send(
      new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: data, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }),
    );
  } else {
    const file = path.join(localDir(), key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    await writeFile(`${file}.type`, contentType);
  }
  return { key, url: `${publicBase()}/${key}` };
}

export async function getFile(key: string): Promise<{ data: Buffer; contentType: string } | null> {
  if (key.includes("..")) return null;
  try {
    if (useS3()) {
      const res = await client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? { data: Buffer.from(bytes), contentType: res.ContentType ?? "application/octet-stream" } : null;
    }
    const file = path.join(localDir(), key);
    const [data, contentType] = await Promise.all([readFile(file), readFile(`${file}.type`, "utf8").catch(() => "application/octet-stream")]);
    return { data, contentType };
  } catch {
    return null;
  }
}

/**
 * The storage key behind a URL that putFile returned, for rows saved before
 * the key was stored. Null for anything not served from our storage.
 */
export function keyFromUrl(url: string | null | undefined) {
  if (!url) return null;
  const base = `${publicBase()}/`;
  if (url.startsWith(base)) return url.slice(base.length);
  // Local storage URLs may have been saved relative or against another host.
  const i = url.indexOf("/api/files/");
  return i >= 0 ? url.slice(i + "/api/files/".length) : null;
}

export async function deleteFile(key: string) {
  if (useS3()) {
    await client().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key })).catch(() => undefined);
  } else {
    const file = path.join(localDir(), key);
    await Promise.all([rm(file, { force: true }), rm(`${file}.type`, { force: true })]);
  }
}
