/**
 * Workspace totals convert each ad account's currency into the workspace currency
 * (USD workspace with an INR account and a USD account). Rates are seeded straight into
 * exchange_rates; the network is never used (fetch throws if anything tries).
 */
import { resetFxMemo } from "@ashniva/core";
import type { Prisma } from "@ashniva/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as } from "../helpers/api";
import { prisma } from "../helpers/db";
import { createConnection, createOrg, createUser } from "../helpers/factories";

const RANGE = "from=2026-10-19&to=2026-10-25"; // Mon..Sun; the previous period is 12..18 Oct
const day = (d: string) => new Date(`${d}T00:00:00Z`);
/** Faster than resetDb() (truncating every table is slow here): tenant rows cascade from orgs and users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.exchangeRate.deleteMany()]);

async function seedRates() {
  // 1 EUR = 1 USD keeps the arithmetic obvious: INR→USD is 1/100 until the 23rd, then 1/80.
  const rows: Prisma.ExchangeRateCreateManyInput[] = [];
  for (const [date, inr] of [["2026-10-09", 100], ["2026-10-16", 100], ["2026-10-23", 80]] as const) {
    rows.push({ date: day(date), base: "EUR", quote: "USD", rate: 1 }, { date: day(date), base: "EUR", quote: "INR", rate: inr });
  }
  await prisma.exchangeRate.createMany({ data: rows });
}

async function seed() {
  const user = await createUser();
  const { org, workspace } = await createOrg(user);
  await prisma.workspace.update({ where: { id: workspace.id }, data: { currency: "USD" } });
  const { adAccount: inr } = await createConnection(org.id, { workspaceId: workspace.id, currency: "INR" });
  const { adAccount: usd } = await createConnection(org.id, { workspaceId: workspace.id, currency: "USD", platform: "GOOGLE" });

  const campaign = (a: typeof inr, name: string) =>
    prisma.campaign.create({ data: { adAccountId: a.id, platform: a.platform, externalId: `ext-${name}`, name, status: "ACTIVE" } });
  const inrCampaign = await campaign(inr, "India launch");
  const usdCampaign = await campaign(usd, "US search");

  const metric = (c: { id: string; adAccountId: string; platform: typeof inr.platform }, date: string, m: { spend: number; conversionValue?: number; impressions?: number; conversions?: number }) =>
    prisma.metricDaily.create({
      data: {
        date: day(date),
        level: "CAMPAIGN",
        entityId: c.id,
        campaignId: c.id,
        adAccountId: c.adAccountId,
        platform: c.platform,
        impressions: m.impressions ?? 1000,
        clicks: 10,
        spend: m.spend,
        conversions: m.conversions ?? 1,
        conversionValue: m.conversionValue ?? 0,
      },
    });
  // INR: ₹10,000 on Tue 20th (→ $100) and ₹8,000 on Sat 24th (Friday's 1/80 rate → $100).
  await metric(inrCampaign, "2026-10-20", { spend: 10_000, conversionValue: 20_000 });
  await metric(inrCampaign, "2026-10-24", { spend: 8_000, impressions: 2_000_000 });
  // USD: $500 on the 21st. Raw digits would rank the INR campaign first; converted it's $200 vs $500.
  await metric(usdCampaign, "2026-10-21", { spend: 500, conversionValue: 100 });
  // Previous period: ₹5,000 on the 13th (→ $50).
  await metric(inrCampaign, "2026-10-13", { spend: 5_000 });

  return { user, workspace, inrCampaign, usdCampaign };
}

describe("currency conversion in workspace totals", () => {
  beforeEach(async () => {
    await reset();
    resetFxMemo();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("no network in tests"))));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("overview converts each account and day into the workspace currency", async () => {
    await seedRates();
    const { user, workspace, usdCampaign, inrCampaign } = await seed();
    const res = await (await as(user)).get(`/api/workspaces/${workspace.id}/overview?${RANGE}`);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body.currency).toBe("USD");
    expect(body.fx).toEqual({ conversion: "converted", currency: "USD", from: ["INR"], source: "ECB" });
    expect(body.totals.spend).toBe(700);
    expect(body.totals.conversionValue).toBe(300);
    expect(body.totals.roas).toBeCloseTo(300 / 700, 6);
    expect(body.totals.impressions).toBe(2_002_000);
    expect(body.previous.spend).toBe(50);

    const series = Object.fromEntries(body.timeseries.map((p: { date: string; spend: number }) => [p.date, p.spend]));
    expect(series).toMatchObject({ "2026-10-20": 100, "2026-10-21": 500, "2026-10-24": 100, "2026-10-25": 0 });

    const platforms = Object.fromEntries(body.byPlatform.map((p: { platform: string; metrics: { spend: number } }) => [p.platform, p.metrics.spend]));
    expect(platforms).toEqual({ GOOGLE: 500, META: 200 });

    expect(body.topCampaigns.map((c: { id: string }) => c.id)).toEqual([usdCampaign.id, inrCampaign.id]);
    expect(body.topCampaigns[1]).toMatchObject({ currency: "USD", metrics: { spend: 200 } });
  });

  it("campaign rows keep the account currency, with a converted copy, and the totals are in USD", async () => {
    await seedRates();
    const { user, workspace, usdCampaign, inrCampaign } = await seed();
    const res = await (await as(user)).get(`/api/workspaces/${workspace.id}/campaigns?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(res.body.fx.conversion).toBe("converted");
    expect(res.body.totals.spend).toBe(700);
    expect(res.body.totals.cpa).toBeCloseTo(700 / 3, 6);

    const [first, second] = res.body.campaigns;
    expect(first.id).toBe(usdCampaign.id);
    expect(first.converted).toBeUndefined();
    expect(second).toMatchObject({ id: inrCampaign.id, currency: "INR", metrics: { spend: 18_000 }, converted: { spend: 200, conversionValue: 200 } });

    const detail = await (await as(user)).get(`/api/workspaces/${workspace.id}/campaigns/${inrCampaign.id}?${RANGE}`);
    expect(detail.status).toBe(200);
    expect(detail.body.campaign).toMatchObject({ currency: "INR", metrics: { spend: 18_000 }, converted: { spend: 200 } });
  });

  it("report totals are converted too", async () => {
    await seedRates();
    const { user, workspace } = await seed();
    const res = await (await as(user))
      .post(`/api/workspaces/${workspace.id}/reports/preview`)
      .send({ config: { metrics: ["spend", "conversionValue", "roas"], dimension: "platform", chartMetric: "spend", compare: true }, from: "2026-10-19", to: "2026-10-25" });
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    expect(res.body.fx.conversion).toBe("converted");
    expect(res.body.totals.spend).toBe(700);
    expect(res.body.previousTotals.spend).toBe(50);
    expect(Object.fromEntries(res.body.rows.map((r: { key: string; values: { spend: number } }) => [r.key, r.values.spend]))).toEqual({ GOOGLE: 500, META: 200 });
  });

  it("flags 'unavailable' and leaves amounts unconverted when no rate is known", async () => {
    const { user, workspace } = await seed();
    const res = await (await as(user)).get(`/api/workspaces/${workspace.id}/overview?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.fx).toEqual({ conversion: "unavailable", currency: "USD", from: ["INR"], source: "ECB" });
    expect(res.body.totals.spend).toBe(18_500);
    const campaigns = await (await as(user)).get(`/api/workspaces/${workspace.id}/campaigns?${RANGE}`);
    expect(campaigns.body.fx.conversion).toBe("unavailable");
    expect(campaigns.body.campaigns.every((c: { converted?: unknown }) => c.converted === undefined)).toBe(true);
  });

  it("a workspace whose accounts share its currency needs no rates", async () => {
    const user = await createUser();
    const { org, workspace } = await createOrg(user);
    await createConnection(org.id, { workspaceId: workspace.id, currency: "INR" });
    const res = await (await as(user)).get(`/api/workspaces/${workspace.id}/overview?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.fx).toEqual({ conversion: "none", currency: "INR", from: [], source: "ECB" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
