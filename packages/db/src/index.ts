import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export type * from "./generated/prisma/models";

declare global {
  var __ashnivaPrisma: PrismaClient | undefined;
}

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: Number(process.env.DB_POOL_SIZE ?? 10) }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

function client(): PrismaClient {
  globalThis.__ashnivaPrisma ??= createClient();
  return globalThis.__ashnivaPrisma;
}

/**
 * Shared client, created on first use so apps can load their environment
 * before any connection is opened. Reused across hot reloads in development.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    const c = client();
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
});

/** Prisma Decimal → JS number (safe for money values well below 2^53). */
export const num = (v: { toNumber(): number } | number | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : v.toNumber();
