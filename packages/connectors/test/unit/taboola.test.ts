import { afterEach, describe, expect, it, vi } from "vitest";
import { TaboolaConnector } from "../../src/taboola";
import { fail, hits, http, HttpResponse, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { TB, TB_TOKEN, tbAccount, tbCampaign, tbCreate, tbItem, tbToken } from "../msw/handlers/taboola";

useMswServer();
afterEach(() => vi.useRealTimers());

const operator = () => new TaboolaConnector({ clientId: "op-id", clientSecret: "op-secret" });
const keys = { clientId: "cust-id", clientSecret: "cust-secret" };
const customer = auth("tb-access", keys);
const acct = account("ashniva-sc");

describe("Taboola tokens", () => {
  it("getAuthUrl returns to our callback with code=client_credentials; unconfigured throws", () => {
    expect(queryOf(operator().getAuthUrl({ state: STATE, redirectUri: REDIRECT }))).toEqual({ code: "client_credentials", state: STATE });
    expect(() => new TaboolaConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
  });

  it("exchangeCode runs the client-credentials grant with the operator's keys and computes expiresAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(tbToken());
    const t = await operator().exchangeCode({ code: "client_credentials", redirectUri: REDIRECT });
    expect(t.accessToken).toBe("tb-access");
    expect(t.refreshToken).toBe("client_credentials");
    expect(t.expiresAt!.toISOString()).toBe(new Date(NOW.getTime() + 43200_000).toISOString());
    const h = (await hits({ path: "/backstage/oauth/token" }))[0]!;
    expect(Object.fromEntries(h.form!)).toEqual({ client_id: "op-id", client_secret: "op-secret", grant_type: "client_credentials" });
  });

  it("connectWithCredentials and refreshTokens use the connection's own keys", async () => {
    server.use(tbToken());
    await new TaboolaConnector({}).connectWithCredentials({ clientId: " cust-id ", clientSecret: "cust-secret" });
    await operator().refreshTokens("client_credentials", keys);
    const forms = (await hits({ path: "/backstage/oauth/token" })).map((h) => h.form!.get("client_id"));
    expect(forms).toEqual(["cust-id", "cust-id"]);
  });

  it("refreshTokens without credentials falls back to the operator's keys, and needs them", async () => {
    server.use(tbToken());
    await operator().refreshTokens("client_credentials", null);
    expect((await hits())[0]!.form!.get("client_secret")).toBe("op-secret");
    await expect(new TaboolaConnector({}).refreshTokens("x", null)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("keeps a refresh token Taboola does return", async () => {
    server.use(tbToken({ access_token: "a", refresh_token: "real-refresh", expires_in: 60 }));
    expect((await operator().refreshTokens("x", keys))!.refreshToken).toBe("real-refresh");
  });

  it("missing keys fail before any request; wrong keys surface Taboola's message", async () => {
    await expect(operator().connectWithCredentials({ clientId: "id" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Client secret") });
    expect(await hits()).toHaveLength(0);
    server.use(http.post(TB_TOKEN, () => fail(401, { error: "invalid_client", error_description: "Bad client credentials" })));
    await expect(operator().connectWithCredentials(keys)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "Bad client credentials" });
  });
});

describe("Taboola accounts", () => {
  it("getUser reads the current account with the bearer token", async () => {
    server.use(http.get(`${TB}/users/current/account`, () => HttpResponse.json(tbAccount("ashniva-sc", { name: "Ashniva" }))));
    expect(await operator().getUser(customer)).toEqual({ id: "ashniva-sc", name: "Ashniva" });
    expect((await hits())[0]!.headers.get("authorization")).toBe("Bearer tb-access");
  });

  it("lists allowed accounts with currency and timezone", async () => {
    server.use(http.get(`${TB}/users/current/allowed-accounts`, () => HttpResponse.json({ results: [tbAccount("a1", { currency: "INR", time_zone_name: "Asia/Kolkata" }), tbAccount("a2", { currency: undefined, time_zone_name: undefined })] })));
    expect(await operator().listAdAccounts(customer)).toEqual([
      { externalId: "a1", name: "Account a1", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" },
      { externalId: "a2", name: "Account a2", currency: "USD", timezone: null, status: "ACTIVE" },
    ]);
  });

  it.each(STATUS_CODES)("maps HTTP %i on the account list to %s", async (status, code) => {
    server.use(http.get(`${TB}/users/current/allowed-accounts`, () => fail(status)));
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code });
  });
});

describe("Taboola structure", () => {
  it("maps campaigns (budgets in currency units, status, dates) and their items", async () => {
    server.use(
      http.get(`${TB}/ashniva-sc/campaigns/`, () =>
        HttpResponse.json({
          results: [
            tbCampaign("c1"),
            tbCampaign("c2", { is_active: false, status: "RUNNING", daily_cap: null, spending_limit: null, start_date: null, end_date: null }),
            tbCampaign("c3", { status: "PENDING_APPROVAL" }),
          ],
        }),
      ),
      http.get(`${TB}/ashniva-sc/campaigns/:cid/items/`, ({ params }) => HttpResponse.json({ results: params.cid === "c1" ? [tbItem("i1"), tbItem("i2", { is_active: false })] : [] })),
    );
    const s = await operator().fetchStructure(customer, acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.deliveryStatus, c.dailyBudget, c.lifetimeBudget, c.startDate, c.endDate])).toEqual([
      ["c1", "ACTIVE", "RUNNING", 50, 1500, "2026-10-01", "2026-11-30"],
      ["c2", "PAUSED", "RUNNING", null, null, null, null],
      ["c3", "PAUSED", "PENDING_APPROVAL", 50, 1500, "2026-10-01", "2026-11-30"],
    ]);
    expect(s.adGroups[0]).toMatchObject({ externalId: "c1:items", campaignExternalId: "c1", bidStrategy: "SMART" });
    expect(s.ads.map((a) => [a.externalId, a.adGroupExternalId, a.status, a.thumbnailUrl])).toEqual([
      ["i1", "c1:items", "ACTIVE", "https://images.taboola.test/i1.jpg"],
      ["i2", "c1:items", "PAUSED", "https://images.taboola.test/i2.jpg"],
    ]);
  });

  it("URL-encodes the account id", async () => {
    server.use(http.get(`${TB}/:acct/campaigns/`, () => HttpResponse.json({ results: [] })));
    await operator().fetchStructure(customer, account("a b/c"));
    expect((await hits())[0]!.url.pathname).toBe("/backstage/api/1.0/a%20b%2Fc/campaigns/");
  });

  it("propagates a campaign list error", async () => {
    server.use(http.get(`${TB}/ashniva-sc/campaigns/`, () => fail(403)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("an expired token on the items list fails the sync instead of returning no ads", async () => {
    server.use(http.get(`${TB}/ashniva-sc/campaigns/`, () => HttpResponse.json({ results: [tbCampaign("c1")] })), http.get(`${TB}/ashniva-sc/campaigns/c1/items/`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Taboola metrics", () => {
  it("asks for the day breakdown of the range and parses each row", async () => {
    server.use(
      http.get(`${TB}/ashniva-sc/reports/campaign-summary/dimensions/campaign_day_breakdown`, () =>
        HttpResponse.json({
          results: [
            { date: "2026-10-01 00:00:00.0", campaign: 111, impressions: 2000, clicks: 31, spent: "4.25", cpa_actions_num: "3", conversions_value: 120.5 },
            { date: "2026-10-02 00:00:00.0", campaign: "111", visible_impressions: 900, clicks: 0, spent: 0 },
          ],
        }),
      ),
    );
    const rows = await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-02" });
    expect(rows).toEqual([
      { date: "2026-10-01", level: "CAMPAIGN", externalId: "111", impressions: 2000, clicks: 31, spend: 4.25, conversions: 3, conversionValue: 120.5, videoViews: 0 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "111", impressions: 900, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
    ]);
    expect(Object.fromEntries((await hits())[0]!.url.searchParams)).toEqual({ start_date: "2026-10-01", end_date: "2026-10-02" });
  });

  it("a 4xx report error gives no rows; auth, rate limit and outages throw", async () => {
    const path = `${TB}/ashniva-sc/reports/campaign-summary/dimensions/campaign_day_breakdown`;
    server.use(http.get(path, () => fail(400)));
    expect(await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
    for (const [status, code] of [[401, "AUTH_EXPIRED"], [429, "RATE_LIMITED"], [502, "PLATFORM_ERROR"]] as const) {
      server.use(http.get(path, () => fail(status)));
      await expect(operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code });
    }
  });
});

describe("Taboola actions", () => {
  it("status and daily cap are partial POST updates on the campaign", async () => {
    server.use(...tbCreate());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED");
    await operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "ACTIVE");
    await operator().setCampaignDailyBudget(customer, { ...acct, currency: "USD" }, { externalId: "c1" }, 80);
    const posts = await hits({ method: "POST", path: "/campaigns/c1/" });
    expect(posts.map((h) => h.json)).toEqual([{ is_active: false }, { is_active: true }, { daily_cap: 80 }]);
  });
});

describe("Taboola createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("TABOOLA", { objective: "TRAFFIC" }, {
      ...over,
      campaign: { brand: "Ashniva", budget: 40, locations: [{ id: "in", name: "India", type: "country" }], devices: ["DESK", "PHON"], startDate: "2026-11-01", endDate: "2026-11-30", ...over.campaign },
      ad: { title: "The festive edit", description: "Handloom", imageUrl: "https://cdn.example.com/t.jpg", ...over.ad },
    });

  it("creates an inactive campaign with a daily cap and its items", async () => {
    server.use(...tbCreate());
    const d = draft();
    const made = await operator().createCampaign(customer, { ...acct, currency: "USD" }, d, new Map());
    const camp = (await hits({ method: "POST", path: /\/ashniva-sc\/campaigns\/$/ }))[0]!.json;
    expect(camp).toEqual({
      name: "Festive Sale",
      branding_text: "Ashniva",
      marketing_objective: "DRIVE_WEBSITE_TRAFFIC",
      is_active: false,
      daily_cap: 40,
      spending_limit_model: "NONE",
      country_targeting: { type: "INCLUDE", value: ["IN"] },
      platform_targeting: { type: "INCLUDE", value: ["DESK", "PHON"] },
      start_date: "2026-11-01",
      end_date: "2026-11-30",
    });
    const item = (await hits({ method: "POST", path: /items\/$/ }))[0]!;
    expect(item.url.pathname).toBe(`/backstage/api/1.0/ashniva-sc/campaigns/${made.campaigns[0]!.externalId}/items/`);
    expect(item.json).toEqual({ url: "https://shop.example.com/festive", title: "The festive edit", description: "Handloom", thumbnail_url: "https://cdn.example.com/t.jpg" });
    expect(made.campaigns[0]).toMatchObject({ status: "PAUSED", dailyBudget: 40, lifetimeBudget: null, startDate: "2026-11-01", endDate: "2026-11-30" });
    expect(made.ads[0]).toMatchObject({ sourceKey: d.adGroups[0]!.ads[0]!.key, status: "PAUSED" });
  });

  it("a lifetime budget is a spending limit over the whole flight", async () => {
    server.use(...tbCreate());
    const made = await operator().createCampaign(customer, { ...acct, currency: "USD" }, draft({ campaign: { budget: 900, budgetType: "LIFETIME" } }), new Map());
    const camp = (await hits({ method: "POST", path: /\/ashniva-sc\/campaigns\/$/ }))[0]!.json;
    expect(camp).toMatchObject({ spending_limit: 900, spending_limit_model: "ENTIRE" });
    expect(camp).not.toHaveProperty("daily_cap");
    expect(made.campaigns[0]).toMatchObject({ dailyBudget: null, lifetimeBudget: 900 });
  });

  it("maps the other objectives", async () => {
    server.use(...tbCreate());
    await operator().createCampaign(customer, { ...acct, currency: "USD" }, makeDraft("TABOOLA", { objective: "LEADS" }, { campaign: { budget: 10 }, ad: { imageUrl: "https://x/y.jpg" } }), new Map());
    expect((await hits({ method: "POST", path: /\/ashniva-sc\/campaigns\/$/ }))[0]!.json.marketing_objective).toBe("LEADS_GENERATION");
  });

  it("uploads a library image when there is no thumbnail URL and caches the hosted URL", async () => {
    server.use(...tbCreate());
    const d = draft({ ad: { image: ["img-1"] } });
    for (const a of d.adGroups[0]!.ads) a.values.imageUrl = "";
    const onUploaded = vi.fn(async () => undefined);
    await operator().createCampaign(customer, { ...acct, currency: "USD" }, d, assetsOf(imageAsset("img-1", { onUploaded })));
    const upload = (await hits({ path: "/images/" }))[0]!;
    expect(upload.headers.get("content-type")).toMatch(/^multipart\/form-data/);
    expect(upload.headers.get("authorization")).toBe("Bearer tb-access");
    expect(onUploaded).toHaveBeenCalledWith("https://cdn.taboola.test/uploaded.jpg");
    expect((await hits({ method: "POST", path: /items\/$/ }))[0]!.json.thumbnail_url).toBe("https://cdn.taboola.test/uploaded.jpg");
  });

  it("switches the campaign off again when an item fails, then rethrows", async () => {
    server.use(http.post(`${TB}/:acct/campaigns/:cid/items/`, () => fail(400, { message: "Invalid URL" })), ...tbCreate());
    const err = await operator().createCampaign(customer, { ...acct, currency: "USD" }, draft({ campaign: { launchStatus: "ACTIVE" } }), new Map()).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", message: "Invalid URL" });
    expect((await hits({ method: "POST", path: /\/campaigns\/tbc1\/$/ })).map((h) => h.json)).toEqual([{ is_active: false }]);
  });

  it("rolls back when an item has no image at all", async () => {
    server.use(...tbCreate());
    const d = draft();
    for (const a of d.adGroups[0]!.ads) a.values.imageUrl = "";
    await expect(operator().createCampaign(customer, { ...acct, currency: "USD" }, d, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await hits({ method: "POST", path: /\/campaigns\/tbc1\/$/ })).map((h) => h.json)).toEqual([{ is_active: false }]);
  });
});
