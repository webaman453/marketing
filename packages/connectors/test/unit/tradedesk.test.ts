import { describe, expect, it } from "vitest";
import { TradeDeskConnector } from "../../src/tradedesk";
import { ConnectorError } from "../../src/errors";
import { fail, hits, http, HttpResponse, server, useMswServer } from "../msw/server";
import { account, auth, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import { adGroup, adGroupsByCampaign, advertiser, campaign, TTD, ttdCreate, ttdQuery, ttdUpdates } from "../msw/handlers/tradedesk";

useMswServer();

const operator = () => new TradeDeskConnector({ apiToken: "operator-token", partnerId: "partner-op" });
const customer = auth("customer-token", { apiToken: "customer-token", partnerId: "partner-1" });
const acct = account("adv1");

describe("TradeDesk connect", () => {
  it("is configured only with both token and partner id", () => {
    expect(operator().isConfigured()).toBe(true);
    expect(new TradeDeskConnector({ apiToken: "t" }).isConfigured()).toBe(false);
    expect(new TradeDeskConnector({ partnerId: "p" }).isConfigured()).toBe(false);
  });

  it("getAuthUrl sends the browser straight back with code=saved-token and the state", () => {
    expect(queryOf(operator().getAuthUrl({ state: STATE, redirectUri: REDIRECT }))).toEqual({ code: "saved-token", state: STATE });
    expect(() => new TradeDeskConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(ConnectorError);
  });

  it("exchangeCode hands back the operator token; refresh is not supported", async () => {
    expect(await operator().exchangeCode({ code: "saved-token", redirectUri: REDIRECT })).toEqual({ accessToken: "operator-token", scopes: [] });
    await expect(new TradeDeskConnector({}).exchangeCode({ code: "x", redirectUri: REDIRECT })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(await operator().refreshTokens("anything")).toBeNull();
  });

  it("connectWithCredentials uses the customer's trimmed token, without any HTTP call", async () => {
    expect(await operator().connectWithCredentials({ apiToken: "  cust-tok ", partnerId: " p9 " })).toEqual({ accessToken: "cust-tok", scopes: [] });
    expect(await hits()).toHaveLength(0);
  });

  it("connectWithCredentials names the missing field", async () => {
    await expect(operator().connectWithCredentials({ apiToken: "t" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Partner ID") });
    await expect(operator().connectWithCredentials({ partnerId: "p" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("API token") });
  });

  it("getUser is the connection's own partner, or the operator's for the operator connection", async () => {
    expect(await operator().getUser(customer)).toEqual({ id: "partner-1", name: "Partner partner-1" });
    expect(await operator().getUser(auth("x"))).toEqual({ id: "partner-op", name: "Partner partner-op" });
    // A customer connection never falls back to the operator's partner.
    await expect(operator().getUser(auth("x", { apiToken: "x" }))).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("TradeDesk listAdAccounts", () => {
  it("pages through every advertiser of the connection's partner with the connection's own token", async () => {
    const all = Array.from({ length: 250 }, (_, i) => advertiser(i, { CurrencyCode: i === 0 ? "INR" : "USD" }));
    server.use(ttdQuery("/advertiser/query/partner", all));
    const list = await operator().listAdAccounts(customer);
    expect(list).toHaveLength(250);
    expect(list[0]).toEqual({ externalId: "adv0", name: "Advertiser 0", currency: "INR", timezone: null, status: "ACTIVE" });
    const calls = await hits({ path: "/advertiser/query/partner" });
    expect(calls.map((h) => h.json.PageStartIndex)).toEqual([0, 100, 200]);
    for (const h of calls) {
      expect(h.json.PartnerId).toBe("partner-1");
      expect(h.json.PageSize).toBe(100);
      expect(h.headers.get("ttd-auth")).toBe("customer-token");
    }
  });

  it("the operator's own connection sends the current config token, not the stored copy", async () => {
    server.use(ttdQuery("/advertiser/query/partner", [advertiser(1)]));
    await operator().listAdAccounts(auth("stale-stored-token"));
    const [h] = await hits({ path: "/advertiser/query/partner" });
    expect(h!.headers.get("ttd-auth")).toBe("operator-token");
    expect(h!.json.PartnerId).toBe("partner-op");
  });

  it("stops at the last page when exactly a full page is the total", async () => {
    server.use(ttdQuery("/advertiser/query/partner", Array.from({ length: 100 }, (_, i) => advertiser(i))));
    expect(await operator().listAdAccounts(customer)).toHaveLength(100);
    expect(await hits({ path: "/advertiser/query/partner" })).toHaveLength(1);
  });

  it("fails instead of saving a partial list when paging never ends", async () => {
    server.use(
      http.post(`${TTD}/advertiser/query/partner`, async ({ request }) => {
        const start = Number(((await request.json()) as { PageStartIndex: number }).PageStartIndex);
        return HttpResponse.json({ Result: Array.from({ length: 100 }, (_, i) => advertiser(start + i)), TotalFilteredCount: 1_000_000 });
      }),
    );
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits({ path: "/advertiser/query/partner" })).toHaveLength(100);
  });

  it.each(STATUS_CODES)("maps HTTP %i to %s (no silent empty list)", async (status, code) => {
    server.use(http.post(`${TTD}/advertiser/query/partner`, () => fail(status, { Message: "nope" })));
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code });
  });
});

describe("TradeDesk fetchStructure", () => {
  it("maps campaigns, budgets in currency units, dates and ad groups", async () => {
    server.use(
      ttdQuery("/campaign/query/advertiser", [
        campaign("c-live"),
        campaign("c-paused", { DailyBudget: null, Budget: { Amount: 900, CurrencyCode: "USD" } }),
        campaign("c-arch", { Availability: "Archived" }),
        campaign("c-empty", { StartDate: null, EndDate: null }),
      ]),
      adGroupsByCampaign([
        adGroup("g1", "c-live"),
        adGroup("g2", "c-live", { IsEnabled: false }),
        adGroup("g3", "c-paused", { IsEnabled: false, RTBAttributes: {} }),
        adGroup("g4", "c-arch"),
      ]),
    );
    const s = await operator().fetchStructure(customer, acct);
    const byId = Object.fromEntries(s.campaigns.map((c) => [c.externalId, c]));
    expect(byId["c-live"]).toMatchObject({ status: "ACTIVE", dailyBudget: 250, lifetimeBudget: 5000, startDate: "2026-10-01", endDate: "2026-12-31" });
    expect(byId["c-paused"]).toMatchObject({ status: "PAUSED", dailyBudget: null, lifetimeBudget: 900 });
    expect(byId["c-arch"]!.status).toBe("ARCHIVED");
    // A campaign without ad groups is not shown as paused.
    expect(byId["c-empty"]).toMatchObject({ status: "ACTIVE", startDate: null, endDate: null });
    expect(s.adGroups.map((g) => [g.externalId, g.campaignExternalId, g.status, g.dailyBudget])).toEqual([
      ["g1", "c-live", "ACTIVE", 40],
      ["g2", "c-live", "PAUSED", 40],
      ["g3", "c-paused", "PAUSED", null],
      ["g4", "c-arch", "ACTIVE", 40],
    ]);
    const campaignQuery = await hits({ path: "/campaign/query/advertiser" });
    expect(campaignQuery[0]!.json.AdvertiserId).toBe("adv1");
  });

  it("follows ad group pages for a big campaign", async () => {
    server.use(ttdQuery("/campaign/query/advertiser", [campaign("c1")]), adGroupsByCampaign(Array.from({ length: 130 }, (_, i) => adGroup(`g${i}`, "c1"))));
    const s = await operator().fetchStructure(customer, acct);
    expect(s.adGroups).toHaveLength(130);
  });

  it("propagates an ad group list error instead of returning a campaign without groups", async () => {
    server.use(ttdQuery("/campaign/query/advertiser", [campaign("c1")]), http.post(`${TTD}/adgroup/query/campaign`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("fetchMetrics reports nothing yet (no reporting call)", async () => {
    expect(await operator().fetchMetrics()).toEqual([]);
    expect(await hits()).toHaveLength(0);
  });
});

describe("TradeDesk actions", () => {
  it("pauses by switching every ad group off and never touches campaign Availability", async () => {
    server.use(adGroupsByCampaign([adGroup("g1", "c1"), adGroup("g2", "c1"), adGroup("gx", "other")]), ...ttdUpdates());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED");
    const puts = await hits({ method: "PUT" });
    expect(puts.map((h) => [h.url.pathname, h.json])).toEqual([
      ["/v3/adgroup", { AdGroupId: "g1", IsEnabled: false }],
      ["/v3/adgroup", { AdGroupId: "g2", IsEnabled: false }],
    ]);
    expect(JSON.stringify(puts.map((h) => h.json))).not.toContain("Archived");
    expect(puts.every((h) => h.headers.get("ttd-auth") === "customer-token")).toBe(true);
  });

  it("resumes by switching the ad groups back on", async () => {
    server.use(adGroupsByCampaign([adGroup("g1", "c1", { IsEnabled: false })]), ...ttdUpdates());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "ACTIVE");
    expect((await hits({ method: "PUT" }))[0]!.json).toEqual({ AdGroupId: "g1", IsEnabled: true });
  });

  it("propagates a failed ad group update", async () => {
    server.use(adGroupsByCampaign([adGroup("g1", "c1")]), http.put(`${TTD}/adgroup`, () => fail(403)));
    await expect(operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("sets the campaign's daily cap in currency units and leaves the total Budget alone", async () => {
    server.use(...ttdUpdates());
    await operator().setCampaignDailyBudget(customer, { ...acct, currency: "EUR" }, { externalId: "c1" }, 75.5);
    const [h] = await hits({ method: "PUT", path: "/campaign" });
    expect(h!.json).toEqual({ CampaignId: "c1", DailyBudget: { Amount: 75.5, CurrencyCode: "EUR" } });
  });

  it("builder options and targeting search are empty", async () => {
    expect(await operator().getBuilderOptions()).toEqual({});
    expect(await operator().searchTargeting(customer, acct, "location", "ind")).toEqual([]);
  });
});

describe("TradeDesk createCampaign", () => {
  it("creates an Available campaign with ad groups switched off and the daily budget split across them", async () => {
    server.use(...ttdCreate());
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { groups: 2, campaign: { budget: 100 } });
    const made = await operator().createCampaign(customer, acct, draft, new Map());

    const camp = (await hits({ method: "POST", path: /\/campaign$/ }))[0]!.json;
    expect(camp).toMatchObject({ AdvertiserId: "adv1", CampaignName: "Festive Sale", Availability: "Available", DailyBudget: { Amount: 100, CurrencyCode: "USD" } });
    expect(camp.Budget).toBeUndefined();
    expect(Number.isNaN(Date.parse(camp.StartDate))).toBe(false);

    const groups = (await hits({ method: "POST", path: /\/adgroup$/ })).map((h) => h.json);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.IsEnabled).toBe(false);
      expect(g.CampaignId).toBe(made.campaigns[0]!.externalId);
      expect(g.RTBAttributes.BudgetSettings).toEqual({ DailyBudget: { Amount: 50, CurrencyCode: "USD" } });
      expect(g.RTBAttributes.CreativeIds).toHaveLength(1);
    }
    const creatives = (await hits({ method: "POST", path: /\/creative$/ })).map((h) => h.json);
    expect(creatives[0]).toMatchObject({ AdvertiserId: "adv1", CreativeType: "DISPLAY", ClickthroughUrl: "https://shop.example.com/festive", ImageUrl: "https://shop.example.com/festive" });
    expect(creatives[0]).not.toHaveProperty("Headline");

    expect(JSON.stringify((await hits()).map((h) => h.json))).not.toContain("Archived");
    expect(made.campaigns[0]).toMatchObject({ status: "PAUSED", dailyBudget: 100, lifetimeBudget: null, objective: "DISPLAY" });
    expect(made.adGroups.map((g) => [g.status, g.dailyBudget, g.sourceKey])).toEqual(draft.adGroups.map((g) => ["PAUSED", 50, g.key]));
    expect(made.ads.map((a) => a.adGroupExternalId)).toEqual(made.adGroups.map((g) => g.externalId));
    expect(made.ads.map((a) => a.sourceKey)).toEqual(draft.adGroups.map((g) => g.ads[0]!.key));
  });

  it("rounds each ad group's share down to cents so the total never exceeds the campaign budget", async () => {
    server.use(...ttdCreate());
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { groups: 3, campaign: { budget: 100 } });
    await operator().createCampaign(customer, acct, draft, new Map());
    const amounts = (await hits({ method: "POST", path: /\/adgroup$/ })).map((h) => h.json.RTBAttributes.BudgetSettings.DailyBudget.Amount);
    expect(amounts).toEqual([33.33, 33.33, 33.33]);
  });

  it("a lifetime budget goes on Budget (campaign total and per-group share), not DailyBudget", async () => {
    server.use(...ttdCreate());
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { groups: 2, campaign: { budget: 1000, budgetType: "LIFETIME" } });
    const made = await operator().createCampaign(customer, acct, draft, new Map());
    const camp = (await hits({ method: "POST", path: /\/campaign$/ }))[0]!.json;
    expect(camp.Budget).toEqual({ Amount: 1000, CurrencyCode: "USD" });
    expect(camp.DailyBudget).toBeUndefined();
    const g = (await hits({ method: "POST", path: /\/adgroup$/ }))[0]!.json;
    expect(g.RTBAttributes.BudgetSettings).toEqual({ Budget: { Amount: 500, CurrencyCode: "USD" } });
    expect(made.campaigns[0]).toMatchObject({ dailyBudget: null, lifetimeBudget: 1000 });
    expect(made.adGroups[0]!.dailyBudget).toBeNull();
  });

  it("an ACTIVE launch enables the ad groups", async () => {
    server.use(...ttdCreate());
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { campaign: { budget: 20, launchStatus: "ACTIVE" } });
    const made = await operator().createCampaign(customer, acct, draft, new Map());
    expect((await hits({ method: "POST", path: /\/adgroup$/ }))[0]!.json.IsEnabled).toBe(true);
    expect(made.campaigns[0]!.status).toBe("ACTIVE");
  });

  it("native creatives send headline and description; video creatives send the VAST tag and no image", async () => {
    server.use(...ttdCreate());
    const native = makeDraft("TRADEDESK", { format: "NATIVE" }, { campaign: { budget: 20 }, ad: { headline: "Diwali edit", description: "Handloom sarees", imageUrl: "https://cdn.example.com/n.jpg" } });
    await operator().createCampaign(customer, acct, native, new Map());
    const n = (await hits({ method: "POST", path: /\/creative$/ }))[0]!.json;
    expect(n).toMatchObject({ CreativeType: "NATIVE", Headline: "Diwali edit", Description: "Handloom sarees", ImageUrl: "https://cdn.example.com/n.jpg" });
    expect(n).not.toHaveProperty("ThirdPartyTag");

    const video = makeDraft("TRADEDESK", { format: "VIDEO" }, { campaign: { budget: 20 }, ad: { tag: "https://vast.example.com/tag.xml" } });
    await operator().createCampaign(customer, acct, video, new Map());
    const v = (await hits({ method: "POST", path: /\/creative$/ }))[1]!.json;
    expect(v).toMatchObject({ CreativeType: "VIDEO", ThirdPartyTag: "https://vast.example.com/tag.xml" });
    expect(v).not.toHaveProperty("ImageUrl");
    expect(v).not.toHaveProperty("Headline");
  });

  it("checks every creative before creating anything", async () => {
    const draft = makeDraft("TRADEDESK", { format: "NATIVE" }, { campaign: { budget: 20 }, ad: { headline: "", description: "", imageUrl: "" } });
    for (const a of draft.adGroups[0]!.ads) Object.assign(a.values, { headline: "", description: "" });
    await expect(operator().createCampaign(customer, acct, draft, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("fails when the campaign comes back without an id", async () => {
    server.use(http.post(`${TTD}/campaign`, () => HttpResponse.json({})));
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { campaign: { budget: 20 } });
    await expect(operator().createCampaign(customer, acct, draft, new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("switches already-created ad groups off when a later step fails after an ACTIVE launch", async () => {
    let creatives = 0;
    server.use(
      http.post(`${TTD}/creative`, () => (++creatives === 2 ? fail(500) : HttpResponse.json({ CreativeId: `cr${creatives}` }))),
      ...ttdCreate(),
      ...ttdUpdates(),
    );
    const draft = makeDraft("TRADEDESK", { format: "DISPLAY" }, { groups: 2, campaign: { budget: 100, launchStatus: "ACTIVE" } });
    await expect(operator().createCampaign(customer, acct, draft, new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    // Ad group 1 was created enabled with its creative; the caller sees a failure, so it must not keep delivering.
    const disabled = (await hits({ method: "PUT", path: "/adgroup" })).filter((h) => h.json.IsEnabled === false);
    expect(disabled.length).toBeGreaterThan(0);
  });
});
