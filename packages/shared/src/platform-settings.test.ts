import { afterEach, describe, expect, it } from "vitest";
import { AI_TOKEN_PACKS } from "./ai";
import {
  CREDENTIAL_GROUPS,
  MANAGED_ENV_KEYS,
  PRICING,
  applyCatalog,
  catalogSchema,
  credentialFieldApplies,
  credentialGroupFor,
  credentialValue,
  currentCatalog,
  defaultCatalog,
  emailProvider,
  saveCredentialsSchema,
  withGst,
  type Catalog,
  type CredentialField,
} from "./platform-settings";
import { PLANS, minimumPlanFor, planHasFeature } from "./plans";
import { PLATFORMS, isPlatformShown } from "./platforms";

const group = (id: string) => CREDENTIAL_GROUPS.find((g) => g.id === id)!;
const field = (groupId: string, key: string) => group(groupId).fields.find((f) => f.key === key)!;

// applyCatalog mutates shared objects: always restore the shipped price list.
afterEach(() => applyCatalog(defaultCatalog()));

describe("credential groups", () => {
  it("have unique ids and unique env keys", () => {
    const ids = CREDENTIAL_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(MANAGED_ENV_KEYS).size).toBe(MANAGED_ENV_KEYS.length);
    expect(MANAGED_ENV_KEYS).toContain("META_APP_SECRET");
    expect(MANAGED_ENV_KEYS).toContain("RESEND_API_KEY");
  });
  it("cover every visible platform and no hidden one except TikTok", () => {
    for (const p of PLATFORMS) {
      const g = credentialGroupFor(p);
      if (isPlatformShown(p)) expect(g?.platform, p).toBe(p);
    }
    expect(credentialGroupFor("SWIGGY")).toBeUndefined();
    expect(credentialGroupFor("NAUKRI")).toBeUndefined();
    expect(credentialGroupFor("META")!.id).toBe("META");
  });
  it("every showWhen points at a field in the same group, and its values are that field's options", () => {
    for (const g of CREDENTIAL_GROUPS) {
      for (const f of g.fields) {
        if (!f.showWhen) continue;
        const dep = g.fields.find((x) => x.key === f.showWhen!.key);
        expect(dep, `${g.id}.${f.key}`).toBeDefined();
        if (dep!.options) for (const v of f.showWhen.values) expect(dep!.options.map((o) => o.value), `${g.id}.${f.key}`).toContain(v);
      }
    }
  });
  it("env keys are SCREAMING_SNAKE_CASE and console URLs are https", () => {
    for (const g of CREDENTIAL_GROUPS) {
      expect(g.consoleUrl).toMatch(/^https:\/\//);
      expect(g.steps.length).toBeGreaterThan(0);
      for (const f of g.fields) expect(f.key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("credentialValue", () => {
  it("uses the raw value, else a dropdown's first option, else empty", () => {
    const provider = field("EMAIL", "EMAIL_PROVIDER");
    expect(credentialValue(provider, "RESEND")).toBe("RESEND");
    expect(credentialValue(provider, null)).toBe("SMTP");
    expect(credentialValue(provider, "")).toBe("SMTP");
    expect(credentialValue(field("META", "META_APP_ID"), undefined)).toBe("");
    expect(credentialValue(field("META", "META_APP_ID"), "123")).toBe("123");
  });
});

describe("credentialFieldApplies", () => {
  const env = (values: Record<string, string | null>) => (key: string) => values[key];
  it("fields without showWhen always apply", () => {
    expect(credentialFieldApplies(group("META"), field("META", "META_APP_ID"), env({}))).toBe(true);
  });
  it("SMTP fields apply when the provider is SMTP or unset (first option)", () => {
    const g = group("EMAIL");
    expect(credentialFieldApplies(g, field("EMAIL", "SMTP_HOST"), env({}))).toBe(true);
    expect(credentialFieldApplies(g, field("EMAIL", "SMTP_HOST"), env({ EMAIL_PROVIDER: "SMTP" }))).toBe(true);
    expect(credentialFieldApplies(g, field("EMAIL", "SMTP_HOST"), env({ EMAIL_PROVIDER: "RESEND" }))).toBe(false);
    expect(credentialFieldApplies(g, field("EMAIL", "RESEND_API_KEY"), env({ EMAIL_PROVIDER: "RESEND" }))).toBe(true);
    expect(credentialFieldApplies(g, field("EMAIL", "RESEND_API_KEY"), env({}))).toBe(false);
  });
  it("AI base URL applies only for OpenAI-compatible providers", () => {
    const g = group("AI");
    const base = field("AI", "AI_BASE_URL");
    expect(credentialFieldApplies(g, base, env({}))).toBe(false);
    expect(credentialFieldApplies(g, base, env({ AI_PROVIDER: "OPENAI" }))).toBe(false);
    expect(credentialFieldApplies(g, base, env({ AI_PROVIDER: "OPENAI_COMPATIBLE" }))).toBe(true);
  });
  it("falls back to the raw value when the dependency isn't in the group", () => {
    const orphan: CredentialField = { key: "X", label: "X", showWhen: { key: "ELSEWHERE", values: ["on"] } };
    expect(credentialFieldApplies(group("META"), orphan, env({ ELSEWHERE: "on" }))).toBe(true);
    expect(credentialFieldApplies(group("META"), orphan, env({}))).toBe(false);
  });
});

describe("emailProvider", () => {
  const smtp = { SMTP_HOST: "smtp.x.com", SMTP_USER: "u", SMTP_PASSWORD: "p" };
  it("uses the chosen provider only when it has its keys (case-insensitive)", () => {
    expect(emailProvider({ EMAIL_PROVIDER: "smtp", ...smtp })).toBe("SMTP");
    expect(emailProvider({ EMAIL_PROVIDER: "SMTP", RESEND_API_KEY: "re_x" })).toBeNull();
    expect(emailProvider({ EMAIL_PROVIDER: "Resend", RESEND_API_KEY: "re_x", ...smtp })).toBe("RESEND");
    expect(emailProvider({ EMAIL_PROVIDER: "RESEND", ...smtp })).toBeNull();
  });
  it("without a choice prefers complete SMTP, then Resend", () => {
    expect(emailProvider({ ...smtp, RESEND_API_KEY: "re_x" })).toBe("SMTP");
    expect(emailProvider({ SMTP_HOST: "h", SMTP_USER: "u", RESEND_API_KEY: "re_x" })).toBe("RESEND");
    expect(emailProvider({})).toBeNull();
    expect(emailProvider({ EMAIL_PROVIDER: "POSTMARK", ...smtp })).toBe("SMTP");
  });
});

describe("saveCredentialsSchema", () => {
  it("trims values, allows null to clear, caps length", () => {
    expect(saveCredentialsSchema.parse({ values: { A: "  x  ", B: null } })).toEqual({ values: { A: "x", B: null } });
    expect(saveCredentialsSchema.safeParse({ values: { A: "x".repeat(4001) } }).success).toBe(false);
    expect(saveCredentialsSchema.safeParse({ values: { A: 1 } }).success).toBe(false);
  });
});

describe("price catalog", () => {
  it("the default catalog passes its own schema", () => {
    const parsed = catalogSchema.parse(defaultCatalog());
    expect(parsed.plans.AGENCY.limits).toEqual({ workspaces: null, adAccounts: null, members: null });
    expect(parsed.plans.GROWTH.popular).toBe(true);
    expect(parsed.trialDays).toBe(14);
    expect(parsed.gstPercent).toBe(18);
  });

  it("currentCatalog equals defaultCatalog until something is applied", () => {
    expect(currentCatalog()).toEqual(defaultCatalog());
  });

  it("applyCatalog → currentCatalog round-trips", () => {
    const c: Catalog = structuredClone(defaultCatalog());
    c.trialDays = 30;
    c.gstPercent = 12;
    c.aiFreeTokens = 5000;
    c.aiMinBalance = 10;
    c.plans.STARTER.priceMonthly = 1999;
    c.plans.STARTER.features = ["campaign_builder"];
    c.plans.GROWTH.limits.members = null;
    c.plans.AGENCY.limits.workspaces = 100;
    c.plans.STARTER.popular = true;
    c.plans.GROWTH.popular = false;
    c.tokenPacks = [{ id: "only", name: "Only pack", tokens: 1000, price: 1 }];
    applyCatalog(c);
    expect(currentCatalog()).toEqual(c);
    // the shared objects every reader uses were updated in place
    expect(PLANS.STARTER.priceMonthly).toBe(1999);
    expect(PLANS.GROWTH.limits.members).toBe(Number.POSITIVE_INFINITY);
    expect(PLANS.AGENCY.limits.workspaces).toBe(100);
    expect(AI_TOKEN_PACKS).toEqual([{ id: "only", name: "Only pack", tokens: 1000, price: 1 }]);
    expect(PRICING).toMatchObject({ trialDays: 30, gstPercent: 12, aiFreeTokens: 5000, aiMinBalance: 10 });
    expect(planHasFeature("STARTER", "ai_assistant")).toBe(false);
    expect(minimumPlanFor("ai_assistant")).toBe("GROWTH");
  });

  it("the trial is always free, whatever price is saved", () => {
    const c = structuredClone(defaultCatalog());
    c.plans.TRIAL.priceMonthly = 999;
    applyCatalog(c);
    expect(PLANS.TRIAL.priceMonthly).toBe(0);
  });

  it("applying copies arrays, so later edits to the input don't leak in", () => {
    const c = structuredClone(defaultCatalog());
    applyCatalog(c);
    c.plans.STARTER.features.push("white_label");
    c.tokenPacks[0]!.price = 1;
    expect(PLANS.STARTER.features).not.toContain("white_label");
    expect(AI_TOKEN_PACKS[0]!.price).not.toBe(1);
  });

  it("defaultCatalog is unaffected by applyCatalog", () => {
    const before = defaultCatalog();
    const c = structuredClone(before);
    c.plans.GROWTH.name = "Changed";
    c.tokenPacks[0]!.tokens = 2000;
    applyCatalog(c);
    expect(defaultCatalog()).toEqual(before);
  });

  describe("catalogSchema rejects", () => {
    const bad = (mutate: (c: Catalog) => void) => {
      const c = structuredClone(defaultCatalog());
      mutate(c);
      return catalogSchema.safeParse(c).success;
    };
    it.each([
      ["negative trial days", (c: Catalog) => void (c.trialDays = -1)],
      ["trial over a year", (c: Catalog) => void (c.trialDays = 366)],
      ["fractional trial days", (c: Catalog) => void (c.trialDays = 1.5)],
      ["GST over 50%", (c: Catalog) => void (c.gstPercent = 51)],
      ["fractional price", (c: Catalog) => void (c.plans.STARTER.priceMonthly = 9.99)],
      ["one-letter plan name", (c: Catalog) => void (c.plans.STARTER.name = "S")],
      ["unknown feature", (c: Catalog) => void (c.plans.STARTER.features = ["teleport" as never])],
      ["negative limit", (c: Catalog) => void (c.plans.STARTER.limits.members = -1)],
      ["13 highlights", (c: Catalog) => void (c.plans.STARTER.highlights = Array.from({ length: 13 }, (_, i) => `h${i}`))],
      ["empty highlight", (c: Catalog) => void (c.plans.STARTER.highlights = [" "])],
      ["no token packs", (c: Catalog) => void (c.tokenPacks = [])],
      ["9 token packs", (c: Catalog) => void (c.tokenPacks = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `Pack ${i}`, tokens: 1000, price: 1 })))],
      ["uppercase pack id", (c: Catalog) => void (c.tokenPacks[0]!.id = "Pack_1")],
      ["pack under 1,000 tokens", (c: Catalog) => void (c.tokenPacks[0]!.tokens = 999)],
      ["free pack", (c: Catalog) => void (c.tokenPacks[0]!.price = 0)],
      ["missing plan", (c: Catalog) => void delete (c.plans as Partial<Catalog["plans"]>).AGENCY],
    ])("%s", (_name, mutate) => {
      expect(bad(mutate)).toBe(false);
    });
    it("defaults `popular` to false", () => {
      const c = structuredClone(defaultCatalog()) as unknown as { plans: Record<string, { popular?: boolean }> };
      delete c.plans.STARTER!.popular;
      expect(catalogSchema.parse(c).plans.STARTER.popular).toBe(false);
    });
  });
});

describe("withGst", () => {
  it("adds the current GST percent and rounds to whole rupees", () => {
    expect(withGst(2999)).toBe(3539);
    expect(withGst(0)).toBe(0);
    expect(withGst(100)).toBe(118);
  });
  it("follows an applied GST rate", () => {
    const c = structuredClone(defaultCatalog());
    c.gstPercent = 0;
    applyCatalog(c);
    expect(withGst(2999)).toBe(2999);
    c.gstPercent = 5;
    applyCatalog(c);
    expect(withGst(999)).toBe(1049);
  });
});
