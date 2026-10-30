import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsConnector, mapGoogleStatus } from "../../src/google";
import { ConnectorError } from "../../src/errors";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE } from "../msw/fixtures";
import {
  ADS,
  customerClient,
  GOOGLE_REVOKE,
  GOOGLE_TOKEN,
  GOOGLE_USERINFO,
  googleAdsError,
  googleConfig,
  googleSearch,
  listAccessible,
  paged,
  tokenOk,
} from "../msw/handlers/google";

useMswServer();

const g = () => new GoogleAdsConnector(googleConfig);
const acct = account("1112223333", { currency: "INR", timezone: "Asia/Kolkata" });

afterEach(() => {
  vi.useRealTimers();
});

describe("Google OAuth", () => {
  it("isConfigured needs both client id and secret; getAuthUrl throws NOT_CONFIGURED otherwise", () => {
    expect(g().isConfigured()).toBe(true);
    const bare = new GoogleAdsConnector({ clientId: "only-id", apiVersion: "v21" });
    expect(bare.isConfigured()).toBe(false);
    expect(() => bare.getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl asks for offline adwords access with consent, redirect and state", () => {
    const url = g().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    const q = queryOf(url);
    expect(q).toMatchObject({
      client_id: "g-client",
      redirect_uri: REDIRECT,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: STATE,
    });
    expect(q.scope!.split(" ")).toEqual(expect.arrayContaining(["https://www.googleapis.com/auth/adwords", "openid", "email"]));
    // Google OAuth doesn't need PKCE for a confidential web client.
    expect(q.code_challenge).toBeUndefined();
  });

  it("exchangeCode posts the authorization_code grant and computes expiresAt from expires_in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(tokenOk());
    const t = await g().exchangeCode({ code: "4/0Acode", redirectUri: REDIRECT });
    expect(t).toEqual({
      accessToken: "ya29.access",
      refreshToken: "1//refresh",
      expiresAt: new Date(NOW.getTime() + 3599_000),
      scopes: ["https://www.googleapis.com/auth/adwords", "openid", "email", "profile"],
    });
    const h = await onlyHit({ path: "/token" });
    expect(h.method).toBe("POST");
    expect(h.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(h.form!)).toEqual({
      client_id: "g-client",
      client_secret: "g-secret",
      code: "4/0Acode",
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
    });
  });

  it("refreshTokens posts the refresh_token grant and returns no refresh token when Google sends none (core keeps the old one)", async () => {
    server.use(http.post(GOOGLE_TOKEN, () => HttpResponse.json({ access_token: "ya29.new", expires_in: 3599, scope: "https://www.googleapis.com/auth/adwords", token_type: "Bearer" })));
    const t = await g().refreshTokens("1//old-refresh");
    expect(t?.accessToken).toBe("ya29.new");
    expect(t?.refreshToken).toBeUndefined();
    expect(t?.scopes).toEqual(["https://www.googleapis.com/auth/adwords"]);
    const h = await onlyHit({ path: "/token" });
    expect(h.form?.get("grant_type")).toBe("refresh_token");
    expect(h.form?.get("refresh_token")).toBe("1//old-refresh");
    expect(h.form?.has("redirect_uri")).toBe(false);
    expect(h.text).not.toContain("undefined");
  });

  it("refreshTokens passes a rotated refresh token through", async () => {
    server.use(tokenOk({ refresh_token: "1//rotated" }));
    expect((await g().refreshTokens("1//old"))?.refreshToken).toBe("1//rotated");
  });

  it("token errors surface Google's error_description", async () => {
    server.use(http.post(GOOGLE_TOKEN, () => fail(401, { error: "invalid_client", error_description: "The OAuth client was not found." })));
    const err = await g().exchangeCode({ code: "c", redirectUri: REDIRECT }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.message).toBe("The OAuth client was not found.");
  });

  // Google answers a revoked/expired refresh token with HTTP 400 invalid_grant
  // (https://developers.google.com/identity/protocols/oauth2#expiration). That is an expired login,
  // so it must surface as AUTH_EXPIRED for core/tokens.ts to stop retrying; today it's INVALID_REQUEST.
  it("BUG: a revoked refresh token (400 invalid_grant) maps to AUTH_EXPIRED", async () => {
    server.use(http.post(GOOGLE_TOKEN, () => fail(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })));
    const err = await g().refreshTokens("1//revoked").catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
  });

  it("revokeAccess posts the token to the revoke endpoint", async () => {
    server.use(http.post(GOOGLE_REVOKE, () => new HttpResponse(null, { status: 200 })));
    await g().revokeAccess("1//refresh");
    const h = await onlyHit({ path: "/revoke" });
    expect(h.form?.get("token")).toBe("1//refresh");
  });

  it("getUser reads OpenID userinfo with the bearer token, falling back to email then a label", async () => {
    server.use(http.get(GOOGLE_USERINFO, () => HttpResponse.json({ sub: "1098", name: "Asha Rao", email: "asha@example.com" })));
    expect(await g().getUser(auth("ya29.tok"))).toEqual({ id: "1098", name: "Asha Rao" });
    expect((await onlyHit({ path: "/userinfo" })).headers.get("authorization")).toBe("Bearer ya29.tok");

    server.use(http.get(GOOGLE_USERINFO, () => HttpResponse.json({ sub: "1", email: "e@example.com" })));
    expect((await g().getUser(auth())).name).toBe("e@example.com");
    server.use(http.get(GOOGLE_USERINFO, () => HttpResponse.json({ sub: "2" })));
    expect((await g().getUser(auth())).name).toBe("Google user");
  });

  it("getUser with an expired token throws AUTH_EXPIRED", async () => {
    server.use(http.get(GOOGLE_USERINFO, () => fail(401, { error: "invalid_token", error_description: "Invalid Credentials" })));
    await expect(g().getUser(auth())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Google Ads API error mapping", () => {
  const cases: [string, Response, string, string][] = [
    ["401 UNAUTHENTICATED", googleAdsError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials.", "Authentication of the request failed.", { authenticationError: "OAUTH_TOKEN_EXPIRED" }), "AUTH_EXPIRED", "Authentication of the request failed."],
    ["403 PERMISSION_DENIED", googleAdsError(403, "PERMISSION_DENIED", "The caller does not have permission", "User doesn't have permission to access customer.", { authorizationError: "USER_PERMISSION_DENIED" }), "PERMISSION_DENIED", "User doesn't have permission to access customer."],
    ["429 RESOURCE_EXHAUSTED", googleAdsError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota).", "Too many requests.", { quotaError: "RESOURCE_EXHAUSTED" }), "RATE_LIMITED", "Too many requests."],
    ["400 INVALID_ARGUMENT", googleAdsError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", "Unrecognized field in the query.", { queryError: "UNRECOGNIZED_FIELD" }), "INVALID_REQUEST", "Unrecognized field in the query."],
    ["500 INTERNAL", googleAdsError(500, "INTERNAL", "Internal error encountered."), "PLATFORM_ERROR", "Internal error encountered."],
    ["503 UNAVAILABLE", googleAdsError(503, "UNAVAILABLE", "The service is currently unavailable."), "PLATFORM_ERROR", "The service is currently unavailable."],
  ];

  it.each(cases)("%s → %s", async (_label, response, code, message) => {
    server.use(http.post(`${ADS}/customers/:cid/campaigns\\:mutate`, () => response.clone()));
    const err = await g().setCampaignStatus(auth(), acct, { externalId: "55" }, "PAUSED").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  });

  it("status field wins over the HTTP code (UNAUTHENTICATED / RESOURCE_EXHAUSTED)", async () => {
    server.use(http.post(`${ADS}/customers/:cid/campaigns\\:mutate`, () => HttpResponse.json({ error: { code: 400, status: "RESOURCE_EXHAUSTED", message: "quota" } }, { status: 400 })));
    expect((await g().setCampaignStatus(auth(), acct, { externalId: "1" }, "PAUSED").catch((e) => e)).code).toBe("RATE_LIMITED");
    server.use(http.post(`${ADS}/customers/:cid/campaigns\\:mutate`, () => HttpResponse.json({ error: { code: 400, status: "UNAUTHENTICATED", message: "nope" } }, { status: 400 })));
    expect((await g().setCampaignStatus(auth(), acct, { externalId: "1" }, "PAUSED").catch((e) => e)).code).toBe("AUTH_EXPIRED");
  });

  it("reads the error from a searchStream-style array body and falls back to a generic message", async () => {
    server.use(http.post(`${ADS}/customers/:cid/campaigns\\:mutate`, () => HttpResponse.json([{ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }], { status: 403 })));
    expect((await g().setCampaignStatus(auth(), acct, { externalId: "1" }, "PAUSED").catch((e) => e)).message).toBe("denied");
    server.use(http.post(`${ADS}/customers/:cid/campaigns\\:mutate`, () => new HttpResponse("<html>Bad gateway</html>", { status: 502 })));
    const err = await g().setCampaignStatus(auth(), acct, { externalId: "1" }, "PAUSED").catch((e) => e);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(err.message).toBe("Google Ads API error (502)");
  });
});

describe("Google listAdAccounts", () => {
  it("expands manager accounts into their client accounts and skips managers", async () => {
    server.use(
      listAccessible(["100", "200"]),
      googleSearch({
        customer_client: ({ cid }) =>
          cid === "100"
            ? { results: [customerClient("100", { manager: true, level: "0" }), customerClient("101", { descriptiveName: "Saree Store" }), customerClient("102", { descriptiveName: "", currencyCode: "USD", timeZone: "America/New_York" })] }
            : { results: [customerClient("200", { level: "0" }), customerClient("101")] },
      }),
    );
    const list = await g().listAdAccounts(auth("ya29.tok"));
    expect(list).toEqual([
      { externalId: "101", name: "Saree Store", currency: "INR", timezone: "Asia/Kolkata", status: "ENABLED", meta: { loginCustomerId: "100" } },
      { externalId: "102", name: "Google Ads 102", currency: "USD", timezone: "America/New_York", status: "ENABLED", meta: { loginCustomerId: "100" } },
      { externalId: "200", name: "Account 200", currency: "INR", timezone: "Asia/Kolkata", status: "ENABLED", meta: {} },
    ]);
    const searches = await hits({ path: "googleAds:search" });
    expect(searches.map((h) => h.url.pathname)).toEqual([`/v21/customers/100/googleAds:search`, `/v21/customers/200/googleAds:search`]);
    expect(searches[0]!.json.query).toMatch(/FROM customer_client/);
    expect(searches[0]!.headers.get("authorization")).toBe("Bearer ya29.tok");
    // Querying a customer from its own id needs no login-customer-id header.
    expect(searches[0]!.headers.get("login-customer-id")).toBeNull();
  });

  it("follows nextPageToken through every page of customer clients", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => customerClient(String(300 + i)));
    server.use(listAccessible(["999"]), googleSearch({ customer_client: paged(rows, 3) }));
    const list = await g().listAdAccounts(auth());
    expect(list.map((a) => a.externalId)).toEqual(["300", "301", "302", "303", "304", "305", "306"]);
    const bodies = (await hits({ path: "googleAds:search" })).map((h) => h.json.pageToken ?? null);
    expect(bodies).toEqual([null, "p2", "p3"]);
  });

  it("skips a customer that rejects queries (e.g. cancelled, 403) but keeps the others", async () => {
    server.use(
      listAccessible(["400", "500"]),
      googleSearch({
        customer_client: ({ cid }) =>
          cid === "400" ? googleAdsError(403, "PERMISSION_DENIED", "denied", "The customer account can't be accessed because it is not yet enabled or has been deactivated.", { authorizationError: "CUSTOMER_NOT_ENABLED" }) : { results: [customerClient("500", { level: "0" })] },
      }),
    );
    expect((await g().listAdAccounts(auth())).map((a) => a.externalId)).toEqual(["500"]);
  });

  it("propagates AUTH_EXPIRED instead of returning an empty list", async () => {
    server.use(listAccessible(["400"]), googleSearch({ customer_client: () => googleAdsError(401, "UNAUTHENTICATED", "expired") }));
    await expect(g().listAdAccounts(auth())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("propagates a listAccessibleCustomers failure", async () => {
    server.use(http.get(`${ADS}/customers\\:listAccessibleCustomers`, () => googleAdsError(500, "INTERNAL", "Internal error encountered.")));
    await expect(g().listAdAccounts(auth())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("sends the developer token header only when one is configured", async () => {
    server.use(listAccessible([]));
    await g().listAdAccounts(auth());
    expect((await onlyHit({ path: "listAccessibleCustomers" })).headers.get("developer-token")).toBeNull();
    await new GoogleAdsConnector({ ...googleConfig, developerToken: "dev-tok" }).listAdAccounts(auth());
    const all = await hits({ path: "listAccessibleCustomers" });
    expect(all[1]!.headers.get("developer-token")).toBe("dev-tok");
  });

  // index.ts listAdAccounts: every ConnectorError except AUTH_EXPIRED is swallowed per customer,
  // so a rate limit or a Google outage silently drops accounts from the list.
  it("BUG: a 429 RESOURCE_EXHAUSTED while listing a customer's accounts propagates instead of dropping them", async () => {
    server.use(listAccessible(["600"]), googleSearch({ customer_client: () => googleAdsError(429, "RESOURCE_EXHAUSTED", "quota", "Too many requests.") }));
    await expect(g().listAdAccounts(auth())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("BUG: a 5xx while listing a customer's accounts propagates instead of returning an empty list", async () => {
    server.use(listAccessible(["600"]), googleSearch({ customer_client: () => googleAdsError(503, "UNAVAILABLE", "The service is currently unavailable.") }));
    await expect(g().listAdAccounts(auth())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });
});

describe("Google fetchStructure", () => {
  const campaignRow = (id: string, over: Record<string, unknown> = {}, budget: Record<string, unknown> | null = {}) => ({
    campaign: { resourceName: `customers/1112223333/campaigns/${id}`, id, name: `Campaign ${id}`, status: "ENABLED", servingStatus: "SERVING", primaryStatus: "ELIGIBLE", advertisingChannelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS", ...over },
    ...(budget ? { campaignBudget: { resourceName: `customers/1112223333/campaignBudgets/9${id}`, amountMicros: "1500000000", explicitlyShared: false, ...budget } } : {}),
  });

  it("maps campaigns, ad groups and ads; budgets from micros; ids as strings", async () => {
    server.use(
      googleSearch({
        campaign: [
          campaignRow("11"),
          campaignRow("12", { status: "PAUSED", primaryStatus: undefined, servingStatus: "SUSPENDED", advertisingChannelType: "PERFORMANCE_MAX" }, { amountMicros: undefined, totalAmountMicros: "250000000", explicitlyShared: true }),
          campaignRow("13", { status: "UNKNOWN" }, null),
        ],
        ad_group: [{ adGroup: { id: "21", name: "Sarees", status: "ENABLED", type: "SEARCH_STANDARD" }, campaign: { id: "11" } }],
        ad_group_ad: [
          {
            adGroupAd: {
              status: "PAUSED",
              ad: { id: "31", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://shop.example.com/a"], responsiveSearchAd: { headlines: [{ text: "Silk sarees" }, { text: "Two" }], descriptions: [{ text: "Free shipping" }] } },
            },
            adGroup: { id: "21" },
            campaign: { id: "11" },
          },
          { adGroupAd: { status: "ENABLED", ad: { id: "32", type: "RESPONSIVE_DISPLAY_AD" } }, adGroup: { id: "21" }, campaign: { id: "11" } },
        ],
      }),
    );
    const s = await g().fetchStructure(auth(), acct);
    expect(s.campaigns).toHaveLength(3);
    expect(s.campaigns[0]).toMatchObject({
      externalId: "11",
      status: "ACTIVE",
      deliveryStatus: "ELIGIBLE",
      objective: "SEARCH",
      dailyBudget: 1500,
      lifetimeBudget: null,
      raw: { channelType: "SEARCH", biddingStrategyType: "MAXIMIZE_CONVERSIONS", budgetResourceName: "customers/1112223333/campaignBudgets/911", budgetShared: false },
    });
    expect(s.campaigns[1]).toMatchObject({ status: "PAUSED", deliveryStatus: "SUSPENDED", dailyBudget: null, lifetimeBudget: 250, raw: { budgetShared: true } });
    expect(s.campaigns[2]).toMatchObject({ status: "PAUSED", dailyBudget: null, lifetimeBudget: null });
    expect(s.adGroups).toEqual([expect.objectContaining({ externalId: "21", campaignExternalId: "11", name: "Sarees", status: "ACTIVE", raw: { type: "SEARCH_STANDARD" } })]);
    expect(s.ads[0]).toMatchObject({ externalId: "21~31", adGroupExternalId: "21", campaignExternalId: "11", status: "PAUSED", headline: "Silk sarees", body: "Free shipping", finalUrl: "https://shop.example.com/a", name: "responsive search ad #31" });
    expect(s.ads[1]).toMatchObject({ externalId: "21~32", headline: null, body: null, finalUrl: null, name: "responsive display ad #32" });

    const queries = (await hits({ path: "googleAds:search" })).map((h) => h.json.query as string);
    expect(queries.find((q) => /FROM campaign\b/.test(q))).toMatch(/campaign\.status != 'REMOVED'/);
    expect(queries.find((q) => /FROM ad_group_ad/.test(q))).toMatch(/ad_group_ad\.status != 'REMOVED'/);
  });

  it("sends login-customer-id for client accounts reached through a manager", async () => {
    server.use(googleSearch({}));
    await g().fetchStructure(auth(), { ...acct, meta: { loginCustomerId: "100" } });
    const all = await hits({ path: "googleAds:search" });
    expect(all).toHaveLength(3);
    for (const h of all) {
      expect(h.headers.get("login-customer-id")).toBe("100");
      expect(h.url.pathname).toBe("/v21/customers/1112223333/googleAds:search");
    }
  });

  it("follows every page of campaigns", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => campaignRow(String(40 + i)));
    server.use(googleSearch({ campaign: paged(rows, 2) }));
    const s = await g().fetchStructure(auth(), acct);
    expect(s.campaigns.map((c) => c.externalId)).toEqual(["40", "41", "42", "43", "44"]);
  });

  it("propagates an auth error on any of the three queries", async () => {
    server.use(googleSearch({ ad_group: () => googleAdsError(401, "UNAUTHENTICATED", "expired") }));
    await expect(g().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  // index.ts search(): follows nextPageToken with no page limit, unlike http.ts allPages (MAX_PAGES = 100).
  // A token that never ends would loop forever; it should stop and throw so a partial list isn't saved.
  it("BUG: GAQL paging is capped at MAX_PAGES and throws instead of looping", async () => {
    let calls = 0;
    server.use(googleSearch({ campaign: () => (calls++, calls < 150 ? { results: [campaignRow(String(calls))], nextPageToken: `t${calls}` } : { results: [] }) }));
    const err = await g().fetchStructure(auth(), acct).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(calls).toBeLessThanOrEqual(100);
  });
});

describe("Google fetchMetrics", () => {
  const metric = (over: Record<string, unknown>, m: Record<string, unknown> = {}) => ({
    segments: { date: "2026-10-01" },
    metrics: { impressions: "1200", clicks: "34", costMicros: "56780000", conversions: 2.5, conversionsValue: 1999.5, videoTrueviewViews: "7", ...m },
    ...over,
  });

  it("queries campaign, ad group and ad levels for the inclusive range and parses int64 strings", async () => {
    server.use(
      googleSearch({
        campaign: [metric({ campaign: { id: "11" } }), metric({ campaign: { id: "11" }, segments: { date: "2026-10-02" } }, { impressions: "0", clicks: "0", costMicros: "0", conversions: 0, conversionsValue: 0, videoTrueviewViews: undefined })],
        ad_group: [metric({ adGroup: { id: "21" } })],
        ad_group_ad: [metric({ adGroup: { id: "21" }, adGroupAd: { ad: { id: "31" } } }, { videoTrueviewViews: undefined, videoViews: "4" })],
      }),
    );
    const rows = await g().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" });
    expect(rows).toEqual([
      { date: "2026-10-01", level: "CAMPAIGN", externalId: "11", impressions: 1200, clicks: 34, spend: 56.78, conversions: 2.5, conversionValue: 1999.5, videoViews: 7 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "11", impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
      { date: "2026-10-01", level: "AD_GROUP", externalId: "21", impressions: 1200, clicks: 34, spend: 56.78, conversions: 2.5, conversionValue: 1999.5, videoViews: 7 },
      { date: "2026-10-01", level: "AD", externalId: "21~31", impressions: 1200, clicks: 34, spend: 56.78, conversions: 2.5, conversionValue: 1999.5, videoViews: 4 },
    ]);
    const queries = (await hits({ path: "googleAds:search" })).map((h) => h.json.query as string);
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-02'");
      expect(q).toContain("segments.date");
      expect(q).toContain("metrics.cost_micros");
      expect(q).toContain("metrics.video_trueview_views");
    }
  });

  it("missing metric fields count as zero", async () => {
    server.use(googleSearch({ campaign: [{ campaign: { id: "11" }, segments: { date: "2026-10-01" } }] }));
    const [row] = await g().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" });
    expect(row).toMatchObject({ impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 });
  });

  it("retries with the older video_views field, then without video metrics, on a 400 for the field", async () => {
    server.use(
      googleSearch({
        campaign: ({ query }) =>
          query.includes("video_trueview_views") || query.includes("video_views")
            ? googleAdsError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", "Unrecognized field in the query: 'metrics.video_trueview_views'.", { queryError: "UNRECOGNIZED_FIELD" })
            : { results: [metric({ campaign: { id: "11" } }, { videoTrueviewViews: undefined })] },
      }),
    );
    const rows = await g().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" });
    expect(rows.filter((r) => r.level === "CAMPAIGN")).toHaveLength(1);
    const campaignQueries = (await hits({ path: "googleAds:search" })).map((h) => h.json.query as string).filter((q) => /FROM campaign\b/.test(q));
    expect(campaignQueries).toHaveLength(3);
    expect(campaignQueries[1]).toContain("metrics.video_views");
    expect(campaignQueries[2]).not.toMatch(/video/);
  });

  it("propagates AUTH_EXPIRED without retrying field variants", async () => {
    server.use(googleSearch({ campaign: () => googleAdsError(401, "UNAUTHENTICATED", "expired") }));
    await expect(g().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await hits({ path: "googleAds:search" })).toHaveLength(1);
  });

  it("a 400 that persists without video fields still throws", async () => {
    server.use(googleSearch({ campaign: () => googleAdsError(400, "INVALID_ARGUMENT", "bad", "Date range too long.") }));
    await expect(g().fetchMetrics(auth(), acct, { from: "2020-01-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Date range too long." });
  });

  it("follows pages of metric rows", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => metric({ campaign: { id: "11" }, segments: { date: `2026-10-0${i + 1}` } }));
    server.use(googleSearch({ campaign: paged(rows, 2) }));
    const out = await g().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-05" });
    expect(out.filter((r) => r.level === "CAMPAIGN").map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
  });
});

describe("Google actions", () => {
  const mutateOk = (path: string) => http.post(`${ADS}/customers/:cid/${path}`, () => HttpResponse.json({ results: [{ resourceName: "customers/1112223333/x/1" }] }));

  it("setCampaignStatus sends a campaigns:mutate update with ENABLED/PAUSED and updateMask", async () => {
    server.use(mutateOk("campaigns\\:mutate"));
    await g().setCampaignStatus(auth(), { ...acct, meta: { loginCustomerId: "100" } }, { externalId: "55" }, "ACTIVE");
    await g().setCampaignStatus(auth(), acct, { externalId: "55" }, "PAUSED");
    const [on, off] = await hits({ path: "campaigns:mutate" });
    expect(on!.url.pathname).toBe("/v21/customers/1112223333/campaigns:mutate");
    expect(on!.json).toEqual({ operations: [{ update: { resourceName: "customers/1112223333/campaigns/55", status: "ENABLED" }, updateMask: "status" }] });
    expect(on!.headers.get("login-customer-id")).toBe("100");
    expect(off!.json.operations[0].update.status).toBe("PAUSED");
    expect(off!.headers.get("login-customer-id")).toBeNull();
  });

  it("setCampaignDailyBudget updates the campaign's budget in micros rounded to the cent", async () => {
    server.use(mutateOk("campaignBudgets\\:mutate"));
    const campaign = { externalId: "55", raw: { budgetResourceName: "customers/1112223333/campaignBudgets/77", budgetShared: false } };
    await g().setCampaignDailyBudget(auth(), acct, campaign, 1234.567);
    const h = await onlyHit({ path: "campaignBudgets:mutate" });
    expect(h.json).toEqual({ operations: [{ update: { resourceName: "customers/1112223333/campaignBudgets/77", amountMicros: "1234570000" }, updateMask: "amount_micros" }] });
  });

  it("setCampaignDailyBudget: whole and small amounts", async () => {
    server.use(mutateOk("campaignBudgets\\:mutate"));
    const campaign = { externalId: "55", raw: { budgetResourceName: "customers/1/campaignBudgets/77" } };
    await g().setCampaignDailyBudget(auth(), acct, campaign, 500);
    await g().setCampaignDailyBudget(auth(), acct, campaign, 0.1);
    const [a, b] = await hits({ path: "campaignBudgets:mutate" });
    expect(a!.json.operations[0].update.amountMicros).toBe("500000000");
    expect(b!.json.operations[0].update.amountMicros).toBe("100000");
  });

  it("refuses shared budgets and campaigns without a budget, without calling Google", async () => {
    await expect(g().setCampaignDailyBudget(auth(), acct, { externalId: "1", raw: { budgetResourceName: "customers/1/campaignBudgets/7", budgetShared: true } }, 10)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(g().setCampaignDailyBudget(auth(), acct, { externalId: "1", raw: {} }, 10)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(g().setCampaignDailyBudget(auth(), acct, { externalId: "1" }, 10)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await hits()).toHaveLength(0);
  });

  it("budget mutate errors propagate with Google's detail message", async () => {
    server.use(http.post(`${ADS}/customers/:cid/campaignBudgets\\:mutate`, () => googleAdsError(400, "INVALID_ARGUMENT", "x", "Budget amount is too small.", { campaignBudgetError: "AMOUNT_TOO_SMALL" })));
    await expect(g().setCampaignDailyBudget(auth(), acct, { externalId: "1", raw: { budgetResourceName: "customers/1/campaignBudgets/7" } }, 0.01)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Budget amount is too small.",
    });
  });
});

describe("mapGoogleStatus", () => {
  it("maps ENABLED/PAUSED/REMOVED and treats anything else as paused", () => {
    expect(mapGoogleStatus("ENABLED")).toBe("ACTIVE");
    expect(mapGoogleStatus("PAUSED")).toBe("PAUSED");
    expect(mapGoogleStatus("REMOVED")).toBe("REMOVED");
    expect(mapGoogleStatus("UNKNOWN")).toBe("PAUSED");
    expect(mapGoogleStatus(undefined)).toBe("PAUSED");
  });
});
