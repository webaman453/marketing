import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "./crypto";
import { loadEnv, requireEnv } from "./env";
import { hashPassword, verifyPassword } from "./passwords";

const KEY = process.env.TOKEN_ENCRYPTION_KEY;
afterEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips text, including unicode and long values", () => {
    for (const plain of ["token-123", "₹ नमस्ते 🔐", "x".repeat(5000)]) {
      expect(decryptSecret(encryptSecret(plain))).toBe(plain);
    }
  });

  it("decryptSecret can read back encryptSecret(\"\") (an empty data part is valid)", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("uses a fresh IV each time and the v1.<iv>.<tag>.<data> format", () => {
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    const parts = a.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(a).not.toContain("same");
  });

  it("detects a tampered ciphertext, tag or IV", () => {
    const enc = encryptSecret("secret value");
    const [v, iv, tag, data] = enc.split(".") as [string, string, string, string];
    const flip = (s: string) => {
      const buf = Buffer.from(s, "base64url");
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString("base64url");
    };
    expect(() => decryptSecret([v, iv, tag, flip(data)].join("."))).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), data].join("."))).toThrow();
    expect(() => decryptSecret([v, flip(iv), tag, data].join("."))).toThrow();
  });

  it("rejects unknown versions and malformed payloads", () => {
    const [, iv, tag, data] = encryptSecret("x").split(".");
    expect(() => decryptSecret(["v2", iv, tag, data].join("."))).toThrow(/Unrecognized/);
    expect(() => decryptSecret("not-encrypted")).toThrow(/Unrecognized/);
    expect(() => decryptSecret("v1..")).toThrow(/Unrecognized/);
  });

  it("cannot be read with another key", () => {
    const enc = encryptSecret("secret");
    process.env.TOKEN_ENCRYPTION_KEY = "f".repeat(64);
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("requires a 32-byte key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "abcd";
    expect(() => encryptSecret("x")).toThrow(/32 bytes/);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe("sha256 / randomToken", () => {
  it("hashes deterministically", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("makes URL-safe random tokens of the requested size", () => {
    const t = randomToken(48);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(48);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("env helpers", () => {
  it("requireEnv returns set values and throws for missing ones", () => {
    process.env.CORE_TEST_VAR = "yes";
    expect(requireEnv("CORE_TEST_VAR")).toBe("yes");
    delete process.env.CORE_TEST_VAR;
    expect(() => requireEnv("CORE_TEST_VAR")).toThrow(/CORE_TEST_VAR/);
  });

  it("loadEnv never overrides variables already set", () => {
    const before = process.env.DATABASE_URL;
    loadEnv();
    expect(process.env.DATABASE_URL).toBe(before);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const stored = await hashPassword("Password123");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword("Password123", stored)).toBe(true);
    expect(await verifyPassword("password123", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("rejects malformed or foreign hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$2b$10$abc")).toBe(false);
    expect(await verifyPassword("x", "scrypt$32768$8$1$salt")).toBe(false);
  });
});
