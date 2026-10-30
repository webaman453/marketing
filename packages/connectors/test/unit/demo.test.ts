import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays } from "@ashniva/shared";
import { DEMO_ACCOUNTS, DEMO_PLATFORMS, DemoConnector, generateDemoMetrics, generateDemoStructure } from "../../src/demo";
import { createConnectorRegistry } from "../../src/index";
import { hits, useMswServer } from "../msw/server";
import { auth } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import type { ExternalMetricRow } from "../../src/types";

// Demo never touches the network: any request would fail on the MSW server (onUnhandledFrame: error)
// and every test also asserts that nothing was recorded.
useMswServer();

const TODAY = "2026-10-15";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
});
afterEach(async () => {
  expect(await hits()).toEqual([]);
  vi.useRealTimers();
});

const META = DEMO_ACCOUNTS.META!;
const meta = new DemoConnector("META");
const ref = { externalId: META.externalId, currency: "INR", timezone: META.timezone };

describe("Demo connector basics", () => {
  it("has no OAuth and never refreshes", async () => {
    expect(() => meta.getAuthUrl()).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    await expect(meta.exchangeCode()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await meta.refreshTokens()).toBeNull();
    expect(await meta.getUser()).toEqual({ id: "sample-meta", name: "Sample data" });
  });

  it("lists the one sample account per platform, and none for platforms without samples", async () => {
    expect(meta.isConfigured()).toBe(true);
    expect(await meta.listAdAccounts()).toEqual([{ externalId: "demo-meta-1001", name: META.name, currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE", meta: { sample: true } }]);
    const shopify = new DemoConnector("SHOPIFY");
    expect(shopify.isConfigured()).toBe(false);
    expect(await shopify.listAdAccounts()).toEqual([]);
    expect(DEMO_PLATFORMS).toEqual(expect.arrayContaining(["META", "GOOGLE", "SPOTIFY", "YAHOO", "TRADEDESK"]));
  });

  it("the registry hands out DEMO connectors for any platform", () => {
    const r = createConnectorRegistry(new Proxy({}, { get: () => ({}) }) as never);
    expect(r.get("YAHOO", "DEMO")).toBeInstanceOf(DemoConnector);
  });

  it("status and budget changes are local no-ops", async () => {
    await expect(meta.setCampaignStatus()).resolves.toBeUndefined();
    await expect(meta.setCampaignDailyBudget()).resolves.toBeUndefined();
  });

  it("rejects an unknown sample account", async () => {
    await expect(meta.fetchStructure(auth(), { externalId: "nope" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(() => generateDemoMetrics("nope", { from: TODAY, to: TODAY })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("Demo structure", () => {
  it("is deterministic and fully linked", async () => {
    const a = await meta.fetchStructure(auth(), ref);
    expect(generateDemoStructure(META.externalId)).toEqual(a);
    expect(a.campaigns).toHaveLength(META.campaigns.length);
    const campaignIds = new Set(a.campaigns.map((c) => c.externalId));
    const groupIds = new Set(a.adGroups.map((g) => g.externalId));
    for (const g of a.adGroups) expect(campaignIds.has(g.campaignExternalId)).toBe(true);
    for (const ad of a.ads) {
      expect(groupIds.has(ad.adGroupExternalId)).toBe(true);
      expect(campaignIds.has(ad.campaignExternalId)).toBe(true);
    }
  });

  it("dates campaigns from today and maps status/budget from the catalogue", async () => {
    const s = generateDemoStructure(META.externalId);
    META.campaigns.forEach((spec, i) => {
      expect(s.campaigns[i]).toMatchObject({
        externalId: `${META.externalId}-${spec.key}`,
        status: spec.status,
        deliveryStatus: spec.status === "ACTIVE" ? "ACTIVE" : "CAMPAIGN_PAUSED",
        dailyBudget: spec.dailyBudget,
        startDate: addDays(TODAY, -spec.startedDaysAgo),
        endDate: null,
      });
    });
  });
});

describe("Demo metrics", () => {
  const range = { from: addDays(TODAY, -200), to: addDays(TODAY, 5) };
  const rows = () => generateDemoMetrics(META.externalId, range);

  it("is deterministic for the same range", async () => {
    expect(await meta.fetchMetrics(auth(), ref, range)).toEqual(rows());
  });

  it("only has days between each campaign's start and today, inclusive", () => {
    const all = rows();
    for (const spec of META.campaigns) {
      const id = `${META.externalId}-${spec.key}`;
      const days = all.filter((r) => r.level === "CAMPAIGN" && r.externalId === id).map((r) => r.date);
      expect(days[0]).toBe(addDays(TODAY, -spec.startedDaysAgo));
      expect(days.every((d) => d <= TODAY)).toBe(true);
      if (spec.status === "ACTIVE") expect(days.at(-1)).toBe(TODAY);
      else expect(days.at(-1)).toBe(addDays(TODAY, -12));
    }
  });

  it("returns one row per day for a single-day range and nothing for a future range", () => {
    const one = generateDemoMetrics(META.externalId, { from: TODAY, to: TODAY });
    expect(new Set(one.map((r) => r.date))).toEqual(new Set([TODAY]));
    expect(generateDemoMetrics(META.externalId, { from: addDays(TODAY, 1), to: addDays(TODAY, 10) })).toEqual([]);
    expect(generateDemoMetrics(META.externalId, { from: TODAY, to: addDays(TODAY, -1) })).toEqual([]);
  });

  it("has whole-number counts, non-negative values and children that add up to the parent", () => {
    const all = rows();
    const key = (r: ExternalMetricRow) => `${r.date}|${r.externalId}`;
    const byId = new Map(all.map((r) => [key(r), r]));
    for (const r of all) {
      for (const k of ["impressions", "clicks", "videoViews"] as const) expect(Number.isInteger(r[k])).toBe(true);
      for (const k of ["impressions", "clicks", "spend", "conversions", "conversionValue", "videoViews"] as const) expect(r[k]).toBeGreaterThanOrEqual(0);
      expect(Math.round(r.spend * 100)).toBeCloseTo(r.spend * 100, 6);
    }
    const groups = all.filter((r) => r.level === "AD_GROUP");
    for (const c of all.filter((r) => r.level === "CAMPAIGN")) {
      const children = groups.filter((g) => g.date === c.date && g.externalId.startsWith(`${c.externalId}-g`));
      expect(children.length).toBeGreaterThan(0);
      expect(children.reduce((s, g) => s + g.impressions, 0)).toBe(c.impressions);
      expect(children.reduce((s, g) => s + g.clicks, 0)).toBe(c.clicks);
      expect(children.reduce((s, g) => s + g.spend, 0)).toBeCloseTo(c.spend, 2);
    }
    for (const g of groups) {
      const ads = all.filter((r) => r.level === "AD" && r.date === g.date && r.externalId.startsWith(`${g.externalId}-a`));
      expect(ads.reduce((s, a) => s + a.impressions, 0)).toBe(g.impressions);
      expect(byId.get(key(g))).toBe(g);
    }
  });

  it("'today' is the ad account's calendar day (types.ts:80 says dates are in the account timezone; demo/index.ts:172 uses UTC)", () => {
    // 20:00 UTC on Oct 15 is already Oct 16 in Asia/Kolkata (+05:30).
    vi.setSystemTime(new Date(`${TODAY}T20:00:00Z`));
    const next = addDays(TODAY, 1);
    expect(generateDemoMetrics(META.externalId, { from: next, to: next }).length).toBeGreaterThan(0);
  });
});

describe("Demo builder", () => {
  it("creates a paused campaign locally from a Meta draft, keeping node keys and budget", async () => {
    const d = makeDraft("META", { objective: "OUTCOME_TRAFFIC" }, { groups: 2, campaign: { budget: 1500, budgetType: "DAILY", startDate: "2026-11-01T09:30" } });
    const made = await meta.createCampaign(auth(), ref, d);
    expect(made.campaigns[0]).toMatchObject({ name: "Festive Sale", status: "PAUSED", deliveryStatus: "CAMPAIGN_PAUSED", objective: "OUTCOME_TRAFFIC", dailyBudget: 1500, lifetimeBudget: null, startDate: "2026-11-01" });
    expect(made.campaigns[0]!.externalId).toMatch(/^demo-meta-1001-new-[0-9a-f]{8}$/);
    expect(made.adGroups.map((g) => g.sourceKey)).toEqual(d.adGroups.map((g) => g.key));
    expect(made.ads.map((a) => a.sourceKey)).toEqual(d.adGroups.flatMap((g) => g.ads.map((a) => a.key)));
    for (const a of made.ads) expect(a.adGroupExternalId.startsWith(made.campaigns[0]!.externalId)).toBe(true);
  });

  it("ACTIVE launches show LEARNING; lifetime budgets go to lifetimeBudget; no start date means today", async () => {
    const d = makeDraft("META", { objective: "OUTCOME_TRAFFIC" }, { campaign: { launchStatus: "ACTIVE", budget: 9000, budgetType: "LIFETIME" } });
    delete d.campaign.startDate;
    delete d.adGroups[0]!.values.startDate;
    const made = await meta.createCampaign(auth(), ref, d);
    expect(made.campaigns[0]).toMatchObject({ status: "ACTIVE", deliveryStatus: "LEARNING", dailyBudget: null, lifetimeBudget: 9000, startDate: TODAY });
  });

  it("an asset-group campaign (Google Performance Max) uses the group itself as the ad", async () => {
    const google = new DemoConnector("GOOGLE");
    const d = makeDraft("GOOGLE", { goal: "SALES", campaignType: "PERFORMANCE_MAX" });
    const made = await google.createCampaign(auth(), { externalId: "demo-google-7781" }, d);
    expect(made.campaigns[0]?.objective).toBe("PERFORMANCE_MAX");
    expect(made.ads).toHaveLength(1);
    expect(made.ads[0]?.sourceKey).toBe(d.adGroups[0]!.key);
  });

  it("offers sample builder options and filtered targeting search", async () => {
    const opts = await meta.getBuilderOptions();
    expect(opts.pages?.[0]?.name).toMatch(/sample page/);
    const cities = await meta.searchTargeting(auth(), ref, "location", "mum");
    expect(cities.map((c) => c.name)).toContain("Mumbai");
    expect((await meta.searchTargeting(auth(), ref, "location", "")).length).toBeLessThanOrEqual(25);
    expect(await meta.searchTargeting(auth(), ref, "language", "en")).toEqual([]);
    const titles = await meta.searchTargeting(auth(), ref, "jobTitle", "manager");
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => /manager/i.test(t.name))).toBe(true);
  });
});

afterAll(() => vi.useRealTimers());
