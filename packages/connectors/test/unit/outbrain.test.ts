import { describe, expect, it } from "vitest";
import { OutbrainConnector } from "../../src/outbrain";
import { fail, hits, http, HttpResponse, server, useMswServer } from "../msw/server";
import { account, auth, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { marketer, OB, obCampaign, obCampaigns, obCreate, obLinks, obMarketers, promotedLink } from "../msw/handlers/outbrain";

useMswServer();

const operator = () => new OutbrainConnector({ apiToken: "operator-token" });
const customer = auth("customer-token", { apiToken: "customer-token" });
const acct = account("m1");

describe("Outbrain connect", () => {
  it("getAuthUrl redirects straight back with code=saved-token; unconfigured throws", () => {
    expect(queryOf(operator().getAuthUrl({ state: STATE, redirectUri: REDIRECT }))).toEqual({ code: "saved-token", state: STATE });
    expect(() => new OutbrainConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
    expect(new OutbrainConnector({}).isConfigured()).toBe(false);
  });

  it("exchangeCode returns the operator token; refresh is not supported", async () => {
    expect((await operator().exchangeCode({ code: "saved-token", redirectUri: REDIRECT })).accessToken).toBe("operator-token");
    await expect(new OutbrainConnector({}).exchangeCode({ code: "x", redirectUri: REDIRECT })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(await operator().refreshTokens("r")).toBeNull();
  });

  it("connectWithCredentials takes the customer's trimmed token and requires it", async () => {
    expect(await operator().connectWithCredentials({ apiToken: " tok-1 " })).toEqual({ accessToken: "tok-1", scopes: [] });
    await expect(operator().connectWithCredentials({ apiToken: "  " })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Amplify API token") });
  });

  it("getUser is the first marketer, sent with the customer's own token", async () => {
    server.use(obMarketers([marketer("m1", { name: "Ashniva" }), marketer("m2")]));
    expect(await operator().getUser(customer)).toEqual({ id: "m1", name: "Ashniva" });
    expect((await hits())[0]!.headers.get("ob-token-v1")).toBe("customer-token");
  });

  it("the operator's own connection uses the current config token", async () => {
    server.use(obMarketers([]));
    expect(await operator().getUser(auth("stale"))).toEqual({ id: "outbrain", name: "Outbrain" });
    expect((await hits())[0]!.headers.get("ob-token-v1")).toBe("operator-token");
  });
});

describe("Outbrain accounts and structure", () => {
  it("lists marketers with currency and enabled status", async () => {
    server.use(obMarketers([marketer("m1", { currency: "INR" }), marketer("m2", { enabled: false, currency: undefined })]));
    expect(await operator().listAdAccounts(customer)).toEqual([
      { externalId: "m1", name: "Marketer m1", currency: "INR", timezone: null, status: "ACTIVE" },
      { externalId: "m2", name: "Marketer m2", currency: "USD", timezone: null, status: "PAUSED" },
    ]);
  });

  it.each(STATUS_CODES)("maps HTTP %i on the marketer list to %s", async (status, code) => {
    server.use(http.get(`${OB}/marketers`, () => fail(status, { message: "denied" })));
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code });
  });

  it("maps campaigns (daily budget in currency units), one link group per campaign and its promoted links", async () => {
    server.use(
      obCampaigns("m1", [obCampaign("c1"), obCampaign("c2", { enabled: false, cpc: undefined, budget: { dailyTarget: 30 } })]),
      obLinks({ c1: [promotedLink("l1"), promotedLink("l2", { enabled: false, imageMetadata: undefined, cachedImageUrl: "https://cache/l2.jpg" })] }),
    );
    const s = await operator().fetchStructure(customer, acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.dailyBudget, c.objective])).toEqual([
      ["c1", "ACTIVE", 120, "Traffic"],
      ["c2", "PAUSED", 30, "Traffic"],
    ]);
    expect(s.adGroups.map((g) => [g.externalId, g.campaignExternalId, g.bidStrategy])).toEqual([
      ["c1:links", "c1", "CPC"],
      ["c2:links", "c2", null],
    ]);
    expect(s.ads.map((a) => [a.externalId, a.adGroupExternalId, a.status, a.thumbnailUrl])).toEqual([
      ["l1", "c1:links", "ACTIVE", "https://images.outbrain.test/l1.jpg"],
      ["l2", "c1:links", "PAUSED", "https://cache/l2.jpg"],
    ]);
  });

  it("propagates a campaign list error", async () => {
    server.use(http.get(`${OB}/marketers/m1/campaigns`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("an expired token on the promoted links list fails the sync instead of returning no ads", async () => {
    server.use(obCampaigns("m1", [obCampaign("c1")]), http.get(`${OB}/campaigns/c1/promotedLinks`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  // Paging shape (limit/offset with totalCount) is `// unverified` against a live account.
  it("follows promoted link pages past the first 100", async () => {
    server.use(obCampaigns("m1", [obCampaign("c1")]), obLinks({ c1: Array.from({ length: 150 }, (_, i) => promotedLink(`l${i}`)) }));
    const s = await operator().fetchStructure(customer, acct);
    expect(s.ads).toHaveLength(150);
  });
});

describe("Outbrain metrics", () => {
  const report = {
    campaignResults: [
      {
        campaignId: "c1",
        results: [
          { metadata: { id: "2026-10-01", fromDate: "2026-10-01", toDate: "2026-10-01" }, metrics: { impressions: 1000, clicks: "12", spend: "3.75", conversions: 2, sumValue: "49.5" } },
          { metadata: { id: "2026-10-02" }, metrics: { impressions: 0 } },
          { metadata: {}, metrics: { impressions: 5 } },
        ],
      },
      { metadata: { id: "c2" }, results: [{ metadata: { fromDate: "2026-10-02T00:00:00" }, metrics: { clicks: 1 } }] },
      { results: [{ metadata: { id: "2026-10-01" }, metrics: { clicks: 99 } }] },
    ],
  };

  it("asks for a daily breakdown of the range and parses each day's numbers", async () => {
    server.use(http.get(`${OB}/reports/marketers/m1/campaigns/periodic`, () => HttpResponse.json(report)));
    const rows = await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-02" });
    expect(rows).toEqual([
      { date: "2026-10-01", level: "CAMPAIGN", externalId: "c1", impressions: 1000, clicks: 12, spend: 3.75, conversions: 2, conversionValue: 49.5, videoViews: 0 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "c1", impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "c2", impressions: 0, clicks: 1, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
    ]);
    const q = (await hits())[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({ from: "2026-10-01", to: "2026-10-02", breakdown: "daily", limit: "500" });
  });

  it("a report the account cannot run (4xx) gives no rows", async () => {
    server.use(http.get(`${OB}/reports/marketers/m1/campaigns/periodic`, () => fail(400)));
    expect(await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
  });

  it.each([[401, "AUTH_EXPIRED"], [403, "PERMISSION_DENIED"], [429, "RATE_LIMITED"], [500, "PLATFORM_ERROR"]])("HTTP %i on the report throws %s", async (status, code) => {
    server.use(http.get(`${OB}/reports/marketers/m1/campaigns/periodic`, () => fail(status)));
    await expect(operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code });
  });
});

describe("Outbrain actions", () => {
  it("status and daily budget are PUTs on the campaign", async () => {
    server.use(...obCreate());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED");
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "ACTIVE");
    await operator().setCampaignDailyBudget(customer, acct, { externalId: "c1" }, 42);
    const puts = await hits({ method: "PUT", path: "/campaigns/c1" });
    expect(puts.map((h) => h.json)).toEqual([{ enabled: false }, { enabled: true }, { budget: { amount: 42, type: "DAILY" } }]);
  });

  it("propagates a rejected status change", async () => {
    server.use(http.put(`${OB}/campaigns/c1`, () => fail(429)));
    await expect(operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("Outbrain createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("OUTBRAIN", { objective: "Traffic" }, { ...over, campaign: { budget: 60, cpc: 0.4, locations: [{ id: "in", name: "India", type: "country" }], ...over.campaign }, ad: { title: "5 festive looks", imageUrl: "https://cdn.example.com/a.jpg", ...over.ad } });

  /** The spec requires imageUrl, so makeDraft fills it; clear it to exercise the uploaded-image path. */
  const noImageUrl = (d: ReturnType<typeof draft>) => {
    for (const g of d.adGroups) for (const a of g.ads) a.values.imageUrl = "";
    return d;
  };

  it("creates a disabled campaign and disabled promoted links by default", async () => {
    server.use(...obCreate());
    const d = draft();
    const made = await operator().createCampaign(customer, acct, d, new Map());
    const camp = (await hits({ method: "POST", path: "/marketers/m1/campaigns" }))[0]!.json;
    expect(camp).toEqual({ name: "Festive Sale", enabled: false, budget: { amount: 60, type: "DAILY" }, cpc: 0.4, objective: "Traffic", targeting: { country: ["IN"] } });
    const link = (await hits({ method: "POST", path: /promotedLinks/ }))[0]!;
    expect(link.url.pathname).toBe(`/amplify/v0.1/campaigns/${made.campaigns[0]!.externalId}/promotedLinks`);
    expect(link.json).toEqual({ text: "5 festive looks", url: "https://shop.example.com/festive", enabled: false, imageMetadata: { url: "https://cdn.example.com/a.jpg" } });
    expect(made.campaigns[0]).toMatchObject({ status: "PAUSED", dailyBudget: 60, lifetimeBudget: null });
    expect(made.ads[0]).toMatchObject({ status: "PAUSED", sourceKey: d.adGroups[0]!.ads[0]!.key, headline: "5 festive looks" });
    expect(made.adGroups[0]!.sourceKey).toBe(d.adGroups[0]!.key);
    expect(await hits({ method: "PUT" })).toHaveLength(0);
  });

  it("a CPM bid is sent as cpm with bidType CPM", async () => {
    server.use(...obCreate());
    await operator().createCampaign(customer, acct, draft({ campaign: { bidType: "CPM", cpc: 5 } }), new Map());
    const camp = (await hits({ method: "POST", path: "/marketers/m1/campaigns" }))[0]!.json;
    expect(camp).toMatchObject({ bidType: "CPM", cpm: 5 });
    expect(camp).not.toHaveProperty("cpc");
  });

  it("uses an uploaded image only when it already has a public link", async () => {
    server.use(...obCreate());
    const d = noImageUrl(draft({ ad: { image: ["img-1"] } }));
    await operator().createCampaign(customer, acct, d, assetsOf(imageAsset("img-1", { cachedRef: "https://public.example.com/i.jpg" })));
    expect((await hits({ method: "POST", path: /promotedLinks/ }))[0]!.json.imageMetadata).toEqual({ url: "https://public.example.com/i.jpg" });
  });

  it("disables the campaign again when a promoted link fails, then rethrows", async () => {
    server.use(http.post(`${OB}/campaigns/:id/promotedLinks`, () => fail(400, { message: "Bad image" })), ...obCreate());
    const err = await operator().createCampaign(customer, acct, draft({ campaign: { launchStatus: "ACTIVE" } }), new Map()).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", message: "Bad image" });
    const puts = await hits({ method: "PUT" });
    expect(puts.map((h) => [h.url.pathname, h.json])).toEqual([["/amplify/v0.1/campaigns/obc1", { enabled: false }]]);
  });

  it("rolls back when the image has no public URL", async () => {
    server.use(...obCreate());
    const err = await operator().createCampaign(customer, acct, noImageUrl(draft({ ad: { image: ["img-1"] } })), assetsOf(imageAsset("img-1"))).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(await hits({ method: "PUT" })).toHaveLength(1);
  });

  it("a failed campaign create propagates and nothing else is sent", async () => {
    server.use(http.post(`${OB}/marketers/m1/campaigns`, () => fail(500)));
    await expect(operator().createCampaign(customer, acct, draft(), new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits()).toHaveLength(1);
  });
});
