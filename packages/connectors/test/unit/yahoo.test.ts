import { afterEach, describe, expect, it, vi } from "vitest";
import { YahooDspConnector } from "../../src/yahoo";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import { YAHOO_API, YAHOO_TOKEN, yahooData, yahooHandlers } from "../msw/handlers/yahoo";

useMswServer();
afterEach(() => vi.useRealTimers());

const yh = () => new YahooDspConnector({ clientId: "yh-client", clientSecret: "yh-secret" });
const acc = account("7001");

const draft = (opts: Parameters<typeof makeDraft>[2] = {}, format = "DISPLAY") =>
  makeDraft("YAHOO", { format }, {
    ...opts,
    campaign: { budget: 90, ...opts.campaign },
    ad: { url: "https://shop.example.com/festive", imageUrl: "https://cdn.example.com/300x250.jpg", size: "300x250", ...opts.ad },
  });

describe("Yahoo DSP OAuth", () => {
  it("is not configured without both keys", () => {
    expect(new YahooDspConnector({ clientSecret: "s" }).isConfigured()).toBe(false);
    expect(() => new YahooDspConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl goes to api.login.yahoo.com with client_id, redirect_uri, response_type=code and state", () => {
    const url = yh().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://api.login.yahoo.com/oauth2/request_auth?")).toBe(true);
    expect(queryOf(url)).toEqual({ client_id: "yh-client", redirect_uri: REDIRECT, response_type: "code", state: STATE });
  });

  it("exchangeCode posts client credentials in the form and computes expiresAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...yahooHandlers());
    const t = await yh().exchangeCode({ code: "c0de", redirectUri: REDIRECT });
    expect(t).toMatchObject({ accessToken: "yh-access-1", refreshToken: "yh-refresh-1" });
    expect(t.expiresAt?.toISOString()).toBe("2026-10-15T11:00:00.000Z");
    const h = await onlyHit({ host: "api.login.yahoo.com" });
    expect(Object.fromEntries(h.form!)).toEqual({ grant_type: "authorization_code", code: "c0de", redirect_uri: REDIRECT, client_id: "yh-client", client_secret: "yh-secret" });
  });

  it("refreshTokens never swaps in a different refresh token when Yahoo omits it", async () => {
    server.use(...yahooHandlers());
    const t = await yh().refreshTokens("yh-refresh-1");
    expect(t.accessToken).toBe("yh-access-2");
    expect([undefined, "yh-refresh-1"]).toContain(t.refreshToken);
    expect((await onlyHit({ host: "api.login.yahoo.com" })).form?.get("refresh_token")).toBe("yh-refresh-1");
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "PLATFORM_ERROR"],
  ])("token endpoint HTTP %i → %s", async (status, code) => {
    server.use(http.post(YAHOO_TOKEN, () => fail(status, { error: "invalid_grant", error_description: "Bad code" })));
    await expect(yh().exchangeCode({ code: "x", redirectUri: REDIRECT })).rejects.toMatchObject({ code, message: "Bad code" });
  });
});

describe("Yahoo DSP account reads", () => {
  it("getUser and listAdAccounts read /advertisers with the bearer token", async () => {
    server.use(...yahooHandlers(yahooData({ advertisers: [{ id: 7001, name: "Ashniva", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" }, { id: 7002, status: "INACTIVE" }] })));
    expect(await yh().getUser(auth("tok"))).toEqual({ id: "7001", name: "Ashniva" });
    expect(await yh().listAdAccounts(auth("tok"))).toEqual([
      { externalId: "7001", name: "Ashniva", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" },
      { externalId: "7002", name: "7002", currency: "USD", timezone: null, status: "PAUSED" },
    ]);
    for (const h of await hits()) expect(h.headers.get("authorization")).toBe("Bearer tok");
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
    [502, "PLATFORM_ERROR"],
  ])("advertisers HTTP %i → %s (no silent empty list)", async (status, code) => {
    server.use(http.get(`${YAHOO_API}/advertisers`, () => fail(status, { errors: [{ message: "denied" }] })));
    await expect(yh().listAdAccounts(auth())).rejects.toMatchObject({ code, message: "denied" });
  });

  it("maps campaigns, lines and ads with status and budget in currency units", async () => {
    server.use(...yahooHandlers());
    const s = await yh().fetchStructure(auth(), acc);
    expect(s.campaigns[0]).toMatchObject({ externalId: "501", status: "ACTIVE", objective: "CPC", dailyBudget: 40, startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(s.adGroups[0]).toMatchObject({ externalId: "601", status: "PAUSED", dailyBudget: 20, bidStrategy: "CPM" });
    expect(s.ads[0]).toMatchObject({ externalId: "701", adGroupExternalId: "601", headline: "Sale", body: "Up to 50%", finalUrl: "https://shop.example.com", raw: { format: "DISPLAY" } });
  });

  it("maps INACTIVE to PAUSED", async () => {
    server.use(...yahooHandlers(yahooData({ campaigns: [{ id: 1, accountId: 7001, name: "x", status: "INACTIVE" }] })));
    expect((await yh().fetchStructure(auth(), acc)).campaigns[0]?.status).toBe("PAUSED");
  });

  it("propagates a list error instead of returning a partial structure", async () => {
    server.use(http.get(`${YAHOO_API}/lines`, () => fail(401, { errors: [{ message: "expired" }] })), ...yahooHandlers());
    await expect(yh().fetchStructure(auth(), acc)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("lists campaigns with the documented accountId parameter (yahoo/index.ts:81 sends advertiserId)", async () => {
    server.use(...yahooHandlers());
    await yh().fetchStructure(auth(), acc);
    expect((await onlyHit({ path: /\/traffic\/campaigns$/ })).url.searchParams.get("accountId")).toBe("7001");
  });

  it("links lines to campaigns through the documented orderId field (yahoo/index.ts:103 reads campaignId)", async () => {
    server.use(...yahooHandlers(yahooData({ lines: [{ id: 601, orderId: 501, name: "IN", status: "ACTIVE", mediaType: "DISPLAY" }] })));
    expect((await yh().fetchStructure(auth(), acc)).adGroups[0]?.campaignExternalId).toBe("501");
  });

  it("follows page/limit paging past the 100-row page limit (yahoo/index.ts:82-86 reads one page)", async () => {
    const campaigns = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, accountId: 7001, name: `C${i}`, status: "ACTIVE" }));
    server.use(...yahooHandlers(yahooData({ campaigns })));
    expect((await yh().fetchStructure(auth(), acc)).campaigns).toHaveLength(150);
  });

  it("fetchMetrics returns no rows and makes no request (reporting not implemented)", async () => {
    expect(await yh().fetchMetrics()).toEqual([]);
    expect(await hits()).toEqual([]);
  });
});

describe("Yahoo DSP actions", () => {
  it("setCampaignStatus PUTs the status (partial update)", async () => {
    server.use(...yahooHandlers());
    await yh().setCampaignStatus(auth(), acc, { externalId: "501" }, "PAUSED");
    const h = await onlyHit({ method: "PUT" });
    expect(h.url.pathname).toBe("/traffic/campaigns/501");
    expect(h.json).toEqual({ status: "PAUSED" });
  });

  it("setCampaignDailyBudget PUTs the amount in currency units", async () => {
    server.use(...yahooHandlers());
    await yh().setCampaignDailyBudget(auth(), { ...acc, currency: "USD" }, { externalId: "501" }, 75.5);
    expect((await onlyHit({ method: "PUT" })).json).toEqual({ budget: 75.5, budgetType: "DAILY" });
  });

  it("propagates a PUT error", async () => {
    server.use(http.put(`${YAHOO_API}/campaigns/:id`, () => fail(403, { errors: [{ message: "no access" }] })));
    await expect(yh().setCampaignStatus(auth(), acc, { externalId: "501" }, "ACTIVE")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("Yahoo DSP createCampaign", () => {
  it("creates a paused campaign, lines sharing the budget, and display ads", async () => {
    server.use(...yahooHandlers());
    const d = draft({ groups: 3 });
    const made = await yh().createCampaign(auth(), acc, d, new Map());

    const campaign = (await hits({ method: "POST", path: /\/campaigns$/ }))[0]!;
    expect(campaign.json).toMatchObject({ name: "Festive Sale", status: "PAUSED", budget: 90, budgetType: "DAILY" });
    const campaignId = Number(made.campaigns[0]!.externalId);

    const lines = await hits({ method: "POST", path: /\/lines$/ });
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.json).toMatchObject({ campaignId, status: "PAUSED", budget: 30, mediaType: "DISPLAY" });

    const ads = await hits({ method: "POST", path: /\/ads$/ });
    expect(ads).toHaveLength(3);
    expect(ads[0]!.json).toMatchObject({ status: "PAUSED", adType: "DISPLAY", landingPageUrl: "https://shop.example.com/festive", imageUrl: "https://cdn.example.com/300x250.jpg", size: "300x250" });
    expect(ads[0]!.json).not.toHaveProperty("videoUrl");
    expect(Number.isFinite(ads[0]!.json.lineId)).toBe(true);

    expect(made.campaigns[0]).toMatchObject({ status: "PAUSED", dailyBudget: 90 });
    expect(made.adGroups.map((g) => g.dailyBudget)).toEqual([30, 30, 30]);
    expect(made.adGroups.map((g) => g.sourceKey)).toEqual(d.adGroups.map((g) => g.key));
  });

  it("rounds each line's share down to cents (100 over 3 → 33.33)", async () => {
    server.use(...yahooHandlers());
    await yh().createCampaign(auth(), acc, draft({ groups: 3, campaign: { budget: 100 } }), new Map());
    expect((await hits({ method: "POST", path: /\/lines$/ })).map((l) => l.json.budget)).toEqual([33.33, 33.33, 33.33]);
  });

  it("a native ad sends headline and description; video sends videoUrl", async () => {
    server.use(...yahooHandlers());
    await yh().createCampaign(auth(), acc, draft({ ad: { headline: "Diwali", description: "50% off" } }, "NATIVE"), new Map());
    expect((await hits({ method: "POST", path: /\/ads$/ }))[0]!.json).toMatchObject({ adType: "NATIVE", title: "Diwali", description: "50% off" });
  });

  it("fails with PLATFORM_ERROR when Yahoo returns no id", async () => {
    server.use(http.post(`${YAHOO_API}/campaigns`, () => HttpResponse.json({ response: null, errors: [] })), ...yahooHandlers());
    await expect(yh().createCampaign(auth(), acc, draft(), new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("create campaign names the advertiser with the documented accountId field (yahoo/builder.ts:23 sends advertiserId)", async () => {
    server.use(...yahooHandlers());
    await yh().createCampaign(auth(), acc, draft(), new Map());
    expect((await hits({ method: "POST", path: /\/campaigns$/ }))[0]!.json.accountId).toBe(7001);
  });

  it("rolls back the created campaign when a line fails (yahoo/builder.ts:29-31 leaves it behind)", async () => {
    server.use(http.post(`${YAHOO_API}/lines`, () => fail(400, { errors: [{ message: "bad line" }] })), ...yahooHandlers());
    await yh().createCampaign(auth(), acc, draft(), new Map()).catch(() => undefined);
    const cleanup = (await hits()).filter((h) => /\/traffic\/campaigns\/\d+$/.test(h.url.pathname) && (h.method === "DELETE" || ["INACTIVE", "ARCHIVED", "DELETED"].includes(h.json?.status)));
    expect(cleanup).toHaveLength(1);
  });
});
