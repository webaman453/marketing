/**
 * Owner-managed settings stored in platform_settings: integration credentials
 * (one row per env var, secrets encrypted) and the price list. Loaded into
 * process.env / the shared price objects so existing readers pick them up.
 */
import { prisma, type Prisma } from "@ashniva/db";
import {
  CREDENTIAL_GROUPS,
  MANAGED_ENV_KEYS,
  applyCatalog,
  catalogSchema,
  credentialFieldApplies,
  emailProvider,
  defaultCatalog,
  type Catalog,
  type CredentialGroupStatus,
} from "@ashniva/shared";
import { resetConnectors } from "./connectors";
import { decryptSecret, encryptSecret } from "./crypto";

const ENV_PREFIX = "env:";
const CATALOG_KEY = "catalog";
const RELOAD_MS = 15_000;

/** .env values as the process started, so clearing a console value falls back to them. */
const original: Record<string, string | undefined> = {};
let snapshotTaken = false;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let consoleKeys = new Set<string>();
const updatedAtByKey = new Map<string, Date>();

function snapshotEnv() {
  if (snapshotTaken) return;
  for (const k of MANAGED_ENV_KEYS) original[k] = process.env[k];
  snapshotTaken = true;
}

type StoredValue = { v: string };

async function load() {
  snapshotEnv();
  const rows = await prisma.platformSetting.findMany();
  const fromConsole = new Map<string, string>();
  updatedAtByKey.clear();
  let catalog: Catalog | null = null;
  for (const row of rows) {
    if (row.key === CATALOG_KEY) {
      const parsed = catalogSchema.safeParse(row.value);
      if (parsed.success) catalog = parsed.data;
      continue;
    }
    if (!row.key.startsWith(ENV_PREFIX)) continue;
    const name = row.key.slice(ENV_PREFIX.length);
    if (!MANAGED_ENV_KEYS.includes(name)) continue;
    const stored = (row.value as StoredValue | null)?.v ?? "";
    try {
      fromConsole.set(name, row.secret ? decryptSecret(stored) : stored);
      updatedAtByKey.set(name, row.updatedAt);
    } catch {
      // A value encrypted with an older TOKEN_ENCRYPTION_KEY can't be read; fall back to .env.
    }
  }
  const before = MANAGED_ENV_KEYS.map((k) => process.env[k] ?? "").join("\u0000");
  for (const k of MANAGED_ENV_KEYS) {
    const v = fromConsole.get(k) ?? original[k];
    if (v) process.env[k] = v;
    else delete process.env[k];
  }
  consoleKeys = new Set(fromConsole.keys());
  // Connectors read their credentials once, so rebuild them when anything changed.
  if (MANAGED_ENV_KEYS.map((k) => process.env[k] ?? "").join("\u0000") !== before) resetConnectors();
  applyCatalog(catalog ?? envDefaultCatalog());
  loadedAt = Date.now();
}

/** The shipped price list, with AI_FREE_TOKENS from .env when it's set. */
export function envDefaultCatalog(): Catalog {
  const base = defaultCatalog();
  // A blank `AI_FREE_TOKENS=` line means "not set" (Number("") would be 0 free tokens).
  const raw = process.env.AI_FREE_TOKENS?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? { ...base, aiFreeTokens: Math.floor(n) } : base;
}

/** Loads owner settings, at most every 15 seconds unless forced. Safe to call on every request. */
export async function loadPlatformSettings(force = false): Promise<void> {
  if (!force && Date.now() - loadedAt < RELOAD_MS) return;
  if (inflight) {
    // A forced load (right after a save) must not reuse a read that started before the save.
    await inflight;
    if (!force) return;
    return loadPlatformSettings(true);
  }
  inflight = load().finally(() => {
    inflight = null;
  });
  return inflight;
}

const mask = (v: string) => (v.length <= 4 ? "••••" : `••••${v.slice(-4)}`);

/** Current value of a key; an unset EMAIL_PROVIDER shows the service actually in use. */
const effectiveValue = (key: string) =>
  key === "EMAIL_PROVIDER" && !process.env.EMAIL_PROVIDER ? (emailProvider(process.env) ?? "") : (process.env[key] ?? "");

export function credentialStatus(): CredentialGroupStatus[] {
  snapshotEnv();
  return CREDENTIAL_GROUPS.map((g) => {
    const fields = g.fields.map((f) => {
      const value = effectiveValue(f.key);
      const source = consoleKeys.has(f.key) ? ("console" as const) : value ? ("env" as const) : null;
      return { key: f.key, set: Boolean(value), source, display: value ? (f.secret ? mask(value) : value) : null };
    });
    const times = g.fields.map((f) => updatedAtByKey.get(f.key)).filter((d): d is Date => Boolean(d));
    return {
      id: g.id,
      // Fields for another choice (e.g. Resend while sending with SMTP) don't count.
      configured: g.fields.every((f, i) => f.optional || f.options || !credentialFieldApplies(g, f, effectiveValue) || fields[i]!.set),
      fields,
      updatedAt: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))).toISOString() : null,
    };
  });
}

/** Saves console values (`null` or "" removes one, falling back to .env) and reloads. */
export async function saveCredentials(values: Record<string, string | null>, userId: string | null) {
  const secretKeys = new Set(CREDENTIAL_GROUPS.flatMap((g) => g.fields.filter((f) => f.secret).map((f) => f.key)));
  const ops: Prisma.PrismaPromise<unknown>[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!MANAGED_ENV_KEYS.includes(key)) continue;
    const value = raw?.trim() ?? "";
    const id = ENV_PREFIX + key;
    if (!value) {
      ops.push(prisma.platformSetting.deleteMany({ where: { key: id } }));
      continue;
    }
    const secret = secretKeys.has(key);
    const stored = { v: secret ? encryptSecret(value) : value };
    ops.push(
      prisma.platformSetting.upsert({
        where: { key: id },
        create: { key: id, value: stored, secret, updatedById: userId },
        update: { value: stored, secret, updatedById: userId },
      }),
    );
  }
  await prisma.$transaction(ops);
  await loadPlatformSettings(true);
}

export async function saveCatalog(catalog: Catalog, userId: string | null) {
  const value = catalogSchema.parse(catalog);
  await prisma.platformSetting.upsert({
    where: { key: CATALOG_KEY },
    create: { key: CATALOG_KEY, value, updatedById: userId },
    update: { value, updatedById: userId },
  });
  await loadPlatformSettings(true);
}

export async function resetCatalog() {
  await prisma.platformSetting.deleteMany({ where: { key: CATALOG_KEY } });
  await loadPlatformSettings(true);
}

/** Small JSON values the server keeps for itself (e.g. Razorpay plan ids). */
export async function getInternalSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.platformSetting.findUnique({ where: { key: `internal:${key}` } });
  return (row?.value as T | undefined) ?? null;
}

export async function setInternalSetting(key: string, value: Prisma.InputJsonValue) {
  await prisma.platformSetting.upsert({
    where: { key: `internal:${key}` },
    create: { key: `internal:${key}`, value },
    update: { value },
  });
}

export async function deleteInternalSetting(key: string) {
  await prisma.platformSetting.deleteMany({ where: { key: `internal:${key}` } });
}
