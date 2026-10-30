import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteFile, getFile, keyFromUrl, makeKey, putFile } from "./storage";

const saved = { UPLOAD_DIR: process.env.UPLOAD_DIR, FILES_PUBLIC_URL: process.env.FILES_PUBLIC_URL, S3_BUCKET: process.env.S3_BUCKET };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "core-storage-"));
  process.env.UPLOAD_DIR = dir;
  delete process.env.S3_BUCKET;
  delete process.env.FILES_PUBLIC_URL;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.S3_BUCKET;
  delete process.env.FILES_PUBLIC_URL;
  vi.restoreAllMocks();
});

describe("makeKey", () => {
  it("builds an unguessable key that keeps a clean extension", () => {
    const key = makeKey("creatives/org1", "My Photo.JPG");
    expect(key).toMatch(/^creatives\/org1\/[\w-]{24}\.jpg$/);
    expect(makeKey("x", "a.png")).not.toBe(makeKey("x", "a.png"));
    expect(makeKey("x", "noext")).toMatch(/^x\/[\w-]{24}$/);
    expect(makeKey("x", "evil.p$h%p")).toMatch(/\.php$/);
  });
});

describe("local storage", () => {
  it("stores, reads and deletes a file with its content type", async () => {
    const stored = await putFile("creatives/o/a.png", Buffer.from("data"), "image/png");
    expect(stored).toEqual({ key: "creatives/o/a.png", url: "/api/files/creatives/o/a.png" });
    expect(await getFile("creatives/o/a.png")).toEqual({ data: Buffer.from("data"), contentType: "image/png" });
    await deleteFile("creatives/o/a.png");
    expect(existsSync(path.join(dir, "creatives/o/a.png"))).toBe(false);
    expect(await getFile("creatives/o/a.png")).toBeNull();
  });

  it("refuses keys that climb out of the upload directory", async () => {
    expect(await getFile("../etc/passwd")).toBeNull();
  });

  it("uses FILES_PUBLIC_URL for public links", async () => {
    process.env.FILES_PUBLIC_URL = "https://files.example.test/";
    expect((await putFile("k/b.txt", Buffer.from("b"), "text/plain")).url).toBe("https://files.example.test/k/b.txt");
  });
});

describe("keyFromUrl", () => {
  it("extracts the key from our URLs only", () => {
    expect(keyFromUrl("/api/files/creatives/x.png")).toBe("creatives/x.png");
    expect(keyFromUrl("http://localhost:4000/api/files/logos/y.png")).toBe("logos/y.png");
    expect(keyFromUrl("https://other.example.test/image.png")).toBeNull();
    expect(keyFromUrl(null)).toBeNull();
    expect(keyFromUrl(undefined)).toBeNull();
    process.env.FILES_PUBLIC_URL = "https://cdn.example.test/u";
    expect(keyFromUrl("https://cdn.example.test/u/creatives/z.png")).toBe("creatives/z.png");
  });
});

describe("S3 storage", () => {
  it("sends put, get and delete commands to the bucket", async () => {
    process.env.S3_BUCKET = "bucket";
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === "GetObjectCommand") return { Body: { transformToByteArray: async () => new Uint8Array([1, 2]) }, ContentType: "image/png" };
      return {};
    }) as unknown as ReturnType<typeof vi.fn>;
    await putFile("s3/key.png", Buffer.from([1, 2]), "image/png");
    expect(await getFile("s3/key.png")).toEqual({ data: Buffer.from([1, 2]), contentType: "image/png" });
    await deleteFile("s3/key.png");
    const names = send.mock.calls.map((c) => (c[0] as { constructor: { name: string }; input: { Bucket: string; Key: string } }).constructor.name);
    expect(names).toEqual(["PutObjectCommand", "GetObjectCommand", "DeleteObjectCommand"]);
    for (const c of send.mock.calls) expect((c[0] as { input: { Bucket: string } }).input.Bucket).toBe("bucket");
  });

  it("returns null when the object can't be read", async () => {
    process.env.S3_BUCKET = "bucket";
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("NoSuchKey"));
    expect(await getFile("missing.png")).toBeNull();
    await expect(deleteFile("missing.png")).resolves.toBeUndefined();
  });
});
