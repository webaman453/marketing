/**
 * Owner-managed settings. The module keeps a snapshot of .env taken on its
 * first load, so this file sets the "env" values before anything loads.
 */
import { MANAGED_ENV_KEYS, PLANS, PRICING, defaultCatalog, type Catalog } from "@ashniva/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createUser } from "../../../test/helpers/factories";
import { connectors } from "../src/connectors";
import { decryptSecret, encryptSecret } from "../src/crypto";
import {
  credentialStatus,
  envDefaultCatalog,
  getInternalSetting,
  loadPlatformSettings,
  resetCatalog,
  saveCatalog,
  saveCredentials,
  setInternalSetting,
} from "../src/platform-settings";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const resetDb = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

const saved: Record<string, string | undefined> = {};
const ENV = { META_APP_ID: "env-app-id", META_APP_SECRET: "env-secret-9876", AI_FREE_TOKENS: undefined as string | undefined };

beforeAll(async () => {
  for (const k of [...MANAGED_ENV_KEYS, "AI_FREE_TOKENS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.META_APP_ID = ENV.META_APP_ID;
  process.env.META_APP_SECRET = ENV.META_APP_SECRET;
  await resetDb();
  // First load: takes the .env snapshot.
  await loadPlatformSettings(true);
});

beforeEach(async () => {
  await resetDb();
  await loadPlatformSettings(true);
});

afterAll(async () => {
  await resetDb();
  await loadPlatformSettings(true);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const group = (id: string) => credentialStatus().find((g) => g.id === id)!;
const field = (id: string, key: string) => group(id).fields.find((f) => f.key === key)!;

describe("loadPlatformSettings / saveCredentials", () => {
  it("uses .env values while nothing is saved in the console", () => {
    expect(process.env.META_APP_ID).toBe("env-app-id");
    expect(group("META")).toMatchObject({ id: "META", configured: true, updatedAt: null });
    expect(field("META", "META_APP_ID")).toEqual({ key: "META_APP_ID", set: true, source: "env", display: "env-app-id" });
    expect(field("META", "META_APP_SECRET")).toEqual({ key: "META_APP_SECRET", set: true, source: "env", display: "••••9876" });
    expect(field("META", "META_API_VERSION")).toEqual({ key: "META_API_VERSION", set: false, source: null, display: null });
  });

  it("console values override .env and are applied to process.env", async () => {
    const user = await createUser();
    await saveCredentials({ META_APP_ID: " console-id ", META_APP_SECRET: "console-secret-1234" }, user.id);
    expect(process.env.META_APP_ID).toBe("console-id");
    expect(process.env.META_APP_SECRET).toBe("console-secret-1234");
    expect(field("META", "META_APP_ID")).toMatchObject({ source: "console", display: "console-id" });
    expect(field("META", "META_APP_SECRET")).toMatchObject({ source: "console", display: "••••1234" });
    expect(group("META").updatedAt).toEqual(expect.any(String));
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: "env:META_APP_ID" } });
    expect(row).toMatchObject({ secret: false, value: { v: "console-id" }, updatedById: user.id });
  });

  it("stores secrets encrypted at rest", async () => {
    await saveCredentials({ META_APP_SECRET: "super-secret-value" }, null);
    const row = await prisma.platformSetting.findUniqueOrThrow({ where: { key: "env:META_APP_SECRET" } });
    const stored = (row.value as { v: string }).v;
    expect(row.secret).toBe(true);
    expect(stored).not.toContain("super-secret-value");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(decryptSecret(stored)).toBe("super-secret-value");
  });

  it("removing a console value (null, empty or blank) falls back to .env", async () => {
    await saveCredentials({ META_APP_ID: "console-id", META_APP_SECRET: "console-secret", META_API_VERSION: "v99.0" }, null);
    expect(process.env.META_API_VERSION).toBe("v99.0");
    await saveCredentials({ META_APP_ID: null, META_APP_SECRET: "", META_API_VERSION: "   " }, null);
    expect(process.env.META_APP_ID).toBe("env-app-id");
    expect(process.env.META_APP_SECRET).toBe("env-secret-9876");
    expect(process.env.META_API_VERSION).toBeUndefined();
    expect(field("META", "META_APP_ID").source).toBe("env");
    expect(await prisma.platformSetting.count()).toBe(0);
  });

  it("ignores keys the console doesn't manage", async () => {
    await saveCredentials({ DATABASE_URL: "postgres://evil", JWT_ACCESS_SECRET: "x" }, null);
    expect(await prisma.platformSetting.count()).toBe(0);
    expect(process.env.DATABASE_URL).toContain("_test");
  });

  it("falls back to .env when a stored secret can't be decrypted", async () => {
    await prisma.platformSetting.create({ data: { key: "env:META_APP_SECRET", value: { v: "v1.garbage.garbage.garbage" }, secret: true } });
    await loadPlatformSettings(true);
    expect(process.env.META_APP_SECRET).toBe("env-secret-9876");
    expect(field("META", "META_APP_SECRET").source).toBe("env");
  });

  it("skips rows for unmanaged env keys and unrelated keys", async () => {
    await prisma.platformSetting.createMany({
      data: [
        { key: "env:PATH", value: { v: "/evil" } },
        { key: "internal:foo", value: { a: 1 } },
      ],
    });
    const path = process.env.PATH;
    await loadPlatformSettings(true);
    expect(process.env.PATH).toBe(path);
  });

  it("only re-reads the table every 15 seconds unless forced", async () => {
    await prisma.platformSetting.create({ data: { key: "env:META_APP_ID", value: { v: "direct-write" } } });
    await loadPlatformSettings();
    expect(process.env.META_APP_ID).toBe("env-app-id");
    await loadPlatformSettings(true);
    expect(process.env.META_APP_ID).toBe("direct-write");
  });

  it("a forced reload never reuses a read that started before the save", async () => {
    const first = loadPlatformSettings(true);
    await prisma.platformSetting.create({ data: { key: "env:META_APP_ID", value: { v: "saved-during-load" } } });
    const second = loadPlatformSettings(true);
    await Promise.all([first, second]);
    expect(process.env.META_APP_ID).toBe("saved-during-load");
  });

  it("a non-forced call during a load waits for it instead of starting another", async () => {
    await prisma.platformSetting.create({ data: { key: "env:META_APP_ID", value: { v: "loaded" } } });
    const forced = loadPlatformSettings(true);
    const lazy = loadPlatformSettings();
    await Promise.all([forced, lazy]);
    expect(process.env.META_APP_ID).toBe("loaded");
  });

  it("rebuilds the connector registry only when a credential changed", async () => {
    const before = connectors();
    await loadPlatformSettings(true);
    expect(connectors()).toBe(before);
    await saveCredentials({ PINTEREST_APP_ID: "pin-id" }, null);
    expect(connectors()).not.toBe(before);
  });
});

describe("credentialStatus: configured", () => {
  it("email is not configured with nothing set", () => {
    expect(group("EMAIL").configured).toBe(false);
    // An unset provider counts as the first option (SMTP), whose fields are then required.
    expect(field("EMAIL", "EMAIL_PROVIDER")).toMatchObject({ set: false, display: null });
  });

  it("Resend alone is enough when no provider is chosen, and the provider shows what is in use", async () => {
    await saveCredentials({ RESEND_API_KEY: "re_abcdef" }, null);
    expect(group("EMAIL").configured).toBe(true);
    expect(field("EMAIL", "EMAIL_PROVIDER")).toMatchObject({ set: true, display: "RESEND" });
    expect(field("EMAIL", "RESEND_API_KEY").display).toBe("••••cdef");
  });

  it("choosing SMTP requires the SMTP fields, not Resend's", async () => {
    await saveCredentials({ EMAIL_PROVIDER: "SMTP", RESEND_API_KEY: "re_abcdef" }, null);
    expect(group("EMAIL").configured).toBe(false);
    await saveCredentials({ SMTP_HOST: "smtp.example.test", SMTP_USER: "u", SMTP_PASSWORD: "pw" }, null);
    expect(group("EMAIL").configured).toBe(true);
    // Short secrets are fully masked.
    expect(field("EMAIL", "SMTP_PASSWORD").display).toBe("••••");
    // Port is optional.
    expect(field("EMAIL", "SMTP_PORT").set).toBe(false);
  });

  it("a field shown only for one option is required only for that option", async () => {
    await saveCredentials({ AI_API_KEY: "sk-test-key-0001" }, null);
    expect(group("AI").configured).toBe(true);
    await saveCredentials({ AI_PROVIDER: "OPENAI_COMPATIBLE" }, null);
    expect(group("AI").configured).toBe(false);
    await saveCredentials({ AI_BASE_URL: "https://llm.example.test/v1" }, null);
    expect(group("AI").configured).toBe(true);
  });

  it("platform groups need every required field", async () => {
    expect(group("GOOGLE").configured).toBe(false);
    await saveCredentials({ GOOGLE_CLIENT_ID: "cid" }, null);
    expect(group("GOOGLE").configured).toBe(false);
    await saveCredentials({ GOOGLE_CLIENT_SECRET: "csecret" }, null);
    // Developer token and API version are optional.
    expect(group("GOOGLE").configured).toBe(true);
  });
});

const catalogWith = (patch: (c: Catalog) => void) => {
  const c = defaultCatalog();
  patch(c);
  return c;
};

describe("price list", () => {
  it("saveCatalog applies prices, limits and AI settings everywhere", async () => {
    const user = await createUser();
    await saveCatalog(
      catalogWith((c) => {
        c.plans.STARTER.priceMonthly = 1999;
        c.plans.STARTER.limits.workspaces = 2;
        c.plans.GROWTH.limits.members = null;
        c.plans.TRIAL.priceMonthly = 500;
        c.aiFreeTokens = 7777;
        c.trialDays = 7;
      }),
      user.id,
    );
    expect(PLANS.STARTER.priceMonthly).toBe(1999);
    expect(PLANS.STARTER.limits.workspaces).toBe(2);
    expect(PLANS.GROWTH.limits.members).toBe(Number.POSITIVE_INFINITY);
    expect(PLANS.TRIAL.priceMonthly).toBe(0);
    expect(PRICING.aiFreeTokens).toBe(7777);
    expect(PRICING.trialDays).toBe(7);
    expect((await prisma.platformSetting.findUniqueOrThrow({ where: { key: "catalog" } })).updatedById).toBe(user.id);
  });

  it("rejects an invalid price list without saving it", async () => {
    await expect(saveCatalog(catalogWith((c) => (c.trialDays = -1)), null)).rejects.toThrow();
    await expect(saveCatalog(catalogWith((c) => (c.tokenPacks = [])), null)).rejects.toThrow();
    expect(await prisma.platformSetting.count()).toBe(0);
  });

  it("resetCatalog goes back to the shipped prices (with AI_FREE_TOKENS from .env)", async () => {
    await saveCatalog(catalogWith((c) => (c.plans.AGENCY.priceMonthly = 1)), null);
    expect(PLANS.AGENCY.priceMonthly).toBe(1);
    process.env.AI_FREE_TOKENS = "4242.9";
    try {
      await resetCatalog();
      expect(PLANS.AGENCY.priceMonthly).toBe(defaultCatalog().plans.AGENCY.priceMonthly);
      expect(PRICING.aiFreeTokens).toBe(4242);
    } finally {
      delete process.env.AI_FREE_TOKENS;
      await loadPlatformSettings(true);
    }
    expect(await prisma.platformSetting.count({ where: { key: "catalog" } })).toBe(0);
  });

  it("envDefaultCatalog ignores an invalid AI_FREE_TOKENS", () => {
    for (const v of ["-5", "abc"]) {
      process.env.AI_FREE_TOKENS = v;
      expect(envDefaultCatalog().aiFreeTokens).toBe(defaultCatalog().aiFreeTokens);
    }
    process.env.AI_FREE_TOKENS = "0";
    expect(envDefaultCatalog().aiFreeTokens).toBe(0);
    delete process.env.AI_FREE_TOKENS;
    expect(envDefaultCatalog()).toEqual(defaultCatalog());
  });

  it("a blank AI_FREE_TOKENS keeps the shipped free-token allowance", () => {
    process.env.AI_FREE_TOKENS = "";
    try {
      expect(envDefaultCatalog().aiFreeTokens).toBe(defaultCatalog().aiFreeTokens);
    } finally {
      delete process.env.AI_FREE_TOKENS;
    }
  });

  it("a stored price list that no longer validates falls back to the defaults", async () => {
    await prisma.platformSetting.create({ data: { key: "catalog", value: { trialDays: "soon" } } });
    await loadPlatformSettings(true);
    expect(PLANS.STARTER.priceMonthly).toBe(defaultCatalog().plans.STARTER.priceMonthly);
  });
});

describe("internal settings", () => {
  it("returns null until set, then the latest value", async () => {
    expect(await getInternalSetting("razorpayPlans")).toBeNull();
    await setInternalSetting("razorpayPlans", { STARTER: "plan_1" });
    expect(await getInternalSetting<Record<string, string>>("razorpayPlans")).toEqual({ STARTER: "plan_1" });
    await setInternalSetting("razorpayPlans", { STARTER: "plan_2" });
    expect(await getInternalSetting("razorpayPlans")).toEqual({ STARTER: "plan_2" });
    expect(await prisma.platformSetting.findUnique({ where: { key: "internal:razorpayPlans" } })).not.toBeNull();
  });

  it("internal rows never leak into process.env", async () => {
    await setInternalSetting("META_APP_ID", "x");
    await loadPlatformSettings(true);
    expect(process.env.META_APP_ID).toBe("env-app-id");
    // and an env row encrypted with this key still loads
    await prisma.platformSetting.create({ data: { key: "env:META_APP_SECRET", value: { v: encryptSecret("enc-ok") }, secret: true } });
    await loadPlatformSettings(true);
    expect(process.env.META_APP_SECRET).toBe("enc-ok");
  });
});
