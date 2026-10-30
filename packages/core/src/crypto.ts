import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { requireEnv } from "./env";

const VERSION = "v1";

function key() {
  const hex = requireEnv("TOKEN_ENCRYPTION_KEY");
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  return buf;
}

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  const [version, iv, tag, data] = parts;
  // The data part is legitimately empty for an empty plaintext, so only the IV and tag must be non-empty.
  if (parts.length !== 4 || version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognized encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** URL-safe random token, e.g. for invitations and password resets. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
