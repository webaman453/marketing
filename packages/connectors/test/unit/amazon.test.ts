import { afterEach, describe, expect, it, vi } from "vitest";
import { AmazonAdsConnector } from "../../src/amazon";
import { createdId } from "../../src/amazon/builder";
import { ConnectorError } from "../../src/errors";
import { MAX_PAGES } from "../../src/http";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { AMZ_EU, AMZ_FE, AMZ_NA, amazonProfiles, created207, failed207, lwaToken, LWA_TOKEN, profile, sd207, sdList, tokenList } from "../msw/handlers/amazon";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";

useMswServer();

const amazon = () => new AmazonAdsConnector({ clientId: "amzn1.application-oa2-client.abc", clientSecret: "amzn-secret" });
const acct = (over = {}) => account("3554", { meta: { host: AMZ_EU }, ...over });

afterEach(() => vi.useRealTimers());

/** Empty SB/SD lists so fetchStructure can run with only SP data. */
const emptyOthers = (host = AMZ_NA) => [tokenList(host, "/sb/v4/campaigns/list", "campaigns", [[]]), sdList(host, [])];
const emptySp = (host = AMZ_NA) => [
  tokenList(host, "/sp/campaigns/list", "campaigns", [[]]),
  tokenList(host, "/sp/adGroups/list", "adGroups", [[]]),
  tokenList(host, "/sp/productAds/list", "productAds", [[]]),
];

describe("Amazon OAuth (Login with Amazon)", () => {
  it("isConfigured needs both client id and secret; unconfigured calls throw NOT_CONFIGURED", () => {
    expect(amazon().isConfigured()).toBe(true);
    const bare = new AmazonAdsConnector({ clientId: "x" });
    expect(bare.isConfigured()).toBe(false);
    expect(() => bare.getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(() => bare.refreshTokens("r")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  // https://advertising.amazon.com/API/docs/en-us/guides/get-started/create-authorization-grant
  it("getAuthUrl sends client_id, the campaign_management scope, code flow, redirect and state", () => {
    const url = amazon().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://www.amazon.com/ap/oa?")).toBe(true);
    expect(queryOf(url)).toEqual({
      client_id: "amzn1.application-oa2-client.abc",
      scope: "advertising::campaign_management",
      response_type: "code",
      redirect_uri: REDIRECT,
      state: STATE,
    });
  });

  it("exchangeCode posts the authorization_code grant as a form and computes expiresAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(lwaToken());
    const t = await amazon().exchangeCode({ code: "ANcode", redirectUri: REDIRECT });
    expect(t).toMatchObject({ accessToken: "Atza|access", refreshToken: "Atzr|refresh" });
    expect(t.expiresAt?.toISOString()).toBe("2026-10-15T11:00:00.000Z");
    const h = await onlyHit({ host: "api.amazon.com" });
    expect(h.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(h.form!)).toEqual({
      grant_type: "authorization_code",
      code: "ANcode",
      redirect_uri: REDIRECT,
      client_id: "amzn1.application-oa2-client.abc",
      client_secret: "amzn-secret",
    });
  });

  it("refreshTokens uses the refresh_token grant and never invents a refresh token", async () => {
    server.use(http.post(LWA_TOKEN, () => HttpResponse.json({ access_token: "Atza|new", token_type: "bearer", expires_in: 3600 })));
    const t = await amazon().refreshTokens("Atzr|old");
    expect(t?.accessToken).toBe("Atza|new");
    // Core keeps the stored refresh token when the platform returns none (core/tokens.ts).
    expect(t?.refreshToken ?? "Atzr|old").toBe("Atzr|old");
    const h = await onlyHit({ host: "api.amazon.com" });
    expect(h.form?.get("grant_type")).toBe("refresh_token");
    expect(h.form?.get("refresh_token")).toBe("Atzr|old");
    expect(h.text).not.toContain("undefined");
  });

  it("maps an invalid_grant from LWA to INVALID_REQUEST with its description", async () => {
    server.use(http.post(LWA_TOKEN, () => fail(400, { error: "invalid_grant", error_description: "The request has an invalid grant parameter : refresh_token" })));
    const err = await amazon().refreshTokens("bad").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.message).toMatch(/invalid grant/);
  });
});

describe("Amazon profiles (getUser / listAdAccounts)", () => {
  it("reads profiles from every region with the client-id header and keeps each profile's host", async () => {
    server.use(...amazonProfiles({ [AMZ_NA]: [profile(1)], [AMZ_EU]: [profile(2, { countryCode: "DE", currencyCode: "EUR", timezone: "Europe/Paris" })], [AMZ_FE]: [] }));
    const list = await amazon().listAdAccounts(auth("tok"));
    expect(list).toEqual([
      { externalId: "1", name: "Ashniva Store · US", currency: "USD", timezone: "America/Los_Angeles", status: "ACTIVE", meta: { host: AMZ_NA, country: "US" } },
      { externalId: "2", name: "Ashniva Store · DE", currency: "EUR", timezone: "Europe/Paris", status: "ACTIVE", meta: { host: AMZ_EU, country: "DE" } },
    ]);
    const all = await hits({ path: "/v2/profiles" });
    expect(all).toHaveLength(3);
    for (const h of all) {
      expect(h.headers.get("authorization")).toBe("Bearer tok");
      expect(h.headers.get("amazon-advertising-api-clientid")).toBe("amzn1.application-oa2-client.abc");
    }
  });

  it("getUser uses the first profile's advertiser account", async () => {
    server.use(...amazonProfiles({ [AMZ_NA]: [profile(7)] }));
    expect(await amazon().getUser(auth())).toEqual({ id: "A7", name: "Ashniva Store" });
  });

  it("a region the login cannot reach fails alone", async () => {
    server.use(...amazonProfiles({ [AMZ_NA]: 403, [AMZ_EU]: [profile(2)], [AMZ_FE]: 500 }));
    expect((await amazon().listAdAccounts(auth())).map((a) => a.externalId)).toEqual(["2"]);
  });

  it.each(STATUS_CODES)("all regions failing with %i throws %s (no silent empty list)", async (status, code) => {
    server.use(...amazonProfiles({ [AMZ_NA]: status, [AMZ_EU]: status, [AMZ_FE]: status }));
    const err = await amazon().listAdAccounts(auth()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
  });
});

describe("Amazon fetchStructure", () => {
  it("lists SP/SB/SD on the profile's region with the scope header and maps status and budgets", async () => {
    server.use(
      tokenList(AMZ_EU, "/sp/campaigns/list", "campaigns", [
        [{ campaignId: "11", name: "SP one", state: "ENABLED", targetingType: "MANUAL", budget: { budgetType: "DAILY", budget: 25.5 }, startDate: "2026-10-01" }],
        [{ campaignId: "12", name: "SP two", state: "PAUSED", budget: { budgetType: "DAILY", budget: 10 }, startDate: "2026-10-02", endDate: "2026-12-31" }],
      ]),
      tokenList(AMZ_EU, "/sp/adGroups/list", "adGroups", [[{ adGroupId: "21", campaignId: "11", name: "G", state: "ENABLED", defaultBid: 0.75 }]]),
      tokenList(AMZ_EU, "/sp/productAds/list", "productAds", [[{ adId: "31", adGroupId: "21", campaignId: "11", state: "ARCHIVED", asin: "B0ASIN" }]]),
      tokenList(AMZ_EU, "/sb/v4/campaigns/list", "campaigns", [[{ campaignId: "41", name: "SB", state: "ENABLED", budget: 50, budgetType: "DAILY" }]]),
      sdList(AMZ_EU, [{ campaignId: 51, name: "SD", state: "paused", budget: 7, budgetType: "daily", tactic: "T00020" }]),
    );
    const s = await amazon().fetchStructure(auth(), acct());
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.objective, c.dailyBudget])).toEqual([
      ["11", "ACTIVE", "SPONSORED_PRODUCTS", 25.5],
      ["12", "PAUSED", "SPONSORED_PRODUCTS", 10],
      ["41", "ACTIVE", "SPONSORED_BRANDS", 50],
      ["51", "PAUSED", "SPONSORED_DISPLAY", 7],
    ]);
    expect(s.campaigns[1]).toMatchObject({ startDate: "2026-10-02", endDate: "2026-12-31", raw: { product: "SPONSORED_PRODUCTS" } });
    expect(s.adGroups[0]).toMatchObject({ externalId: "21", campaignExternalId: "11", status: "ACTIVE" });
    expect(s.ads[0]).toMatchObject({ externalId: "31", adGroupExternalId: "21", campaignExternalId: "11", status: "ARCHIVED", name: "B0ASIN", raw: { asin: "B0ASIN" } });

    const spCalls = await hits({ path: "/sp/campaigns/list" });
    expect(spCalls.map((h) => h.json)).toEqual([{ maxResults: 100 }, { maxResults: 100, nextToken: "tok-1" }]);
    expect(spCalls[0]!.url.host).toBe("advertising-api-eu.amazon.com");
    expect(spCalls[0]!.headers.get("amazon-advertising-api-scope")).toBe("3554");
    expect(spCalls[0]!.headers.get("accept")).toBe("application/vnd.spCampaign.v3+json");
    expect((await onlyHit({ path: "/sb/v4/campaigns/list" })).headers.get("accept")).toBe("application/vnd.sbcampaignresource.v4+json");
  });

  // SP v3 / SB v4 require the versioned media type in BOTH Accept and Content-Type, else 415:
  // https://advertising.amazon.com/API/docs/en-us/sponsored-products/3-0/openapi/prod (each operation's request body media type)
  it("SP v3 list/write calls send the vendor Content-Type (http.ts overwrites it with application/json)", async () => {
    server.use(...emptySp(AMZ_EU), ...emptyOthers(AMZ_EU), http.put(`${AMZ_EU}/sp/campaigns`, () => created207("campaigns", "campaignId", "11")));
    await amazon().fetchStructure(auth(), acct());
    await amazon().setCampaignStatus(auth(), acct(), { externalId: "11" }, "PAUSED");
    expect((await onlyHit({ path: "/sp/campaigns/list" })).headers.get("content-type")).toBe("application/vnd.spCampaign.v3+json");
    expect((await onlyHit({ method: "PUT" })).headers.get("content-type")).toBe("application/vnd.spCampaign.v3+json");
  });

  it("defaults to the North America host when the account has no stored host", async () => {
    server.use(...emptySp(), ...emptyOthers());
    await amazon().fetchStructure(auth(), account("9"));
    expect((await hits()).every((h) => h.url.host === "advertising-api.amazon.com")).toBe(true);
  });

  it("pages Sponsored Display with startIndex/count until a short page", async () => {
    const rows = Array.from({ length: 103 }, (_, i) => ({ campaignId: i + 1, name: `SD ${i}`, state: "enabled", budget: 1 }));
    server.use(...emptySp(AMZ_EU), tokenList(AMZ_EU, "/sb/v4/campaigns/list", "campaigns", [[]]), sdList(AMZ_EU, rows));
    const s = await amazon().fetchStructure(auth(), acct());
    expect(s.campaigns).toHaveLength(103);
    expect((await hits({ path: "/sd/campaigns" })).map((h) => h.url.searchParams.get("startIndex"))).toEqual(["0", "100"]);
  });

  it("stops after MAX_PAGES instead of saving a partial account", async () => {
    server.use(
      tokenList(AMZ_EU, "/sp/campaigns/list", "campaigns", [[{ campaignId: "1", name: "c", state: "ENABLED" }]], { endless: true }),
      tokenList(AMZ_EU, "/sp/adGroups/list", "adGroups", [[]]),
      tokenList(AMZ_EU, "/sp/productAds/list", "productAds", [[]]),
      ...emptyOthers(AMZ_EU),
    );
    const err = await amazon().fetchStructure(auth(), acct()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(await hits({ path: "/sp/campaigns/list" })).toHaveLength(MAX_PAGES);
  });

  it("treats a 403 on Sponsored Brands/Display as 'no such product' but still fails on SP errors", async () => {
    server.use(
      tokenList(AMZ_EU, "/sp/campaigns/list", "campaigns", [[{ campaignId: "1", name: "c", state: "ENABLED" }]]),
      tokenList(AMZ_EU, "/sp/adGroups/list", "adGroups", [[]]),
      tokenList(AMZ_EU, "/sp/productAds/list", "productAds", [[]]),
      tokenList(AMZ_EU, "/sb/v4/campaigns/list", "campaigns", [403]),
      sdList(AMZ_EU, 403),
    );
    expect((await amazon().fetchStructure(auth(), acct())).campaigns).toHaveLength(1);

    server.use(tokenList(AMZ_EU, "/sp/campaigns/list", "campaigns", [403]));
    expect((await amazon().fetchStructure(auth(), acct()).catch((e) => e)).code).toBe("PERMISSION_DENIED");
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [429, "RATE_LIMITED"],
    [500, "PLATFORM_ERROR"],
  ])("a %i from Sponsored Brands on a later page propagates as %s", async (status, code) => {
    server.use(...emptySp(AMZ_EU), sdList(AMZ_EU, []), tokenList(AMZ_EU, "/sb/v4/campaigns/list", "campaigns", [[{ campaignId: "1", name: "sb", state: "ENABLED", budget: 1 }], status]));
    expect((await amazon().fetchStructure(auth(), acct()).catch((e) => e)).code).toBe(code);
  });

  it("an SP ad group's default bid is not its daily budget", async () => {
    server.use(
      tokenList(AMZ_EU, "/sp/campaigns/list", "campaigns", [[]]),
      tokenList(AMZ_EU, "/sp/adGroups/list", "adGroups", [[{ adGroupId: "21", campaignId: "11", name: "G", state: "ENABLED", defaultBid: 0.75 }]]),
      tokenList(AMZ_EU, "/sp/productAds/list", "productAds", [[]]),
      ...emptyOthers(AMZ_EU),
    );
    const s = await amazon().fetchStructure(auth(), acct());
    expect(s.adGroups[0]!.dailyBudget).toBeNull();
  });

  it("a Sponsored Brands LIFETIME budget is not reported as a daily budget", async () => {
    server.use(...emptySp(AMZ_EU), sdList(AMZ_EU, []), tokenList(AMZ_EU, "/sb/v4/campaigns/list", "campaigns", [[{ campaignId: "41", name: "SB", state: "ENABLED", budget: 500, budgetType: "LIFETIME" }]]));
    const c = (await amazon().fetchStructure(auth(), acct())).campaigns[0]!;
    expect(c.dailyBudget).toBeNull();
    expect(c.lifetimeBudget).toBe(500);
  });
});

describe("Amazon fetchMetrics", () => {
  it("returns no rows and makes no request (async reports are not polled yet)", async () => {
    expect(await amazon().fetchMetrics()).toEqual([]);
    expect(await hits()).toEqual([]);
  });
});

describe("Amazon actions", () => {
  it("setCampaignStatus PUTs the SP v3 campaign state by default", async () => {
    server.use(http.put(`${AMZ_EU}/sp/campaigns`, () => created207("campaigns", "campaignId", "11")));
    await amazon().setCampaignStatus(auth(), acct(), { externalId: "11" }, "PAUSED");
    const h = await onlyHit({ method: "PUT" });
    expect(h.json).toEqual({ campaigns: [{ campaignId: "11", state: "PAUSED" }] });
    expect(h.headers.get("amazon-advertising-api-scope")).toBe("3554");
  });

  it("setCampaignStatus uses SB v4 and SD v3 (lower-case state, numeric id) per product", async () => {
    server.use(
      http.put(`${AMZ_EU}/sb/v4/campaigns`, () => created207("campaigns", "campaignId", "41")),
      http.put(`${AMZ_EU}/sd/campaigns`, () => sd207("campaignId", 51)),
    );
    await amazon().setCampaignStatus(auth(), acct(), { externalId: "41", raw: { product: "SPONSORED_BRANDS" } }, "ACTIVE");
    await amazon().setCampaignStatus(auth(), acct(), { externalId: "51", raw: { product: "SPONSORED_DISPLAY" } }, "PAUSED");
    const sb = await onlyHit({ path: "/sb/v4/campaigns" });
    expect(sb.json).toEqual({ campaigns: [{ campaignId: "41", state: "ENABLED" }] });
    expect((await onlyHit({ path: "/sd/campaigns" })).json).toEqual([{ campaignId: 51, state: "paused" }]);
  });

  it("setCampaignDailyBudget sends a DAILY budget in currency units (not cents/micros)", async () => {
    server.use(http.put(`${AMZ_EU}/sp/campaigns`, () => created207("campaigns", "campaignId", "11")));
    await amazon().setCampaignDailyBudget(auth(), acct(), { externalId: "11" }, 42.5);
    expect((await onlyHit({ method: "PUT" })).json).toEqual({ campaigns: [{ campaignId: "11", budget: { budgetType: "DAILY", budget: 42.5 } }] });
  });

  it.each([[401, "AUTH_EXPIRED"], [429, "RATE_LIMITED"], [503, "PLATFORM_ERROR"]])("action errors map %i → %s", async (status, code) => {
    server.use(http.put(`${AMZ_EU}/sp/campaigns`, () => fail(status, { code: String(status), details: "nope" })));
    expect((await amazon().setCampaignStatus(auth(), acct(), { externalId: "11" }, "ACTIVE").catch((e) => e)).code).toBe(code);
  });

  it("setCampaignStatus treats a 207 multi-status item error as success", async () => {
    server.use(http.put(`${AMZ_EU}/sp/campaigns`, () => failed207("campaigns", "Campaign not found")));
    await expect(amazon().setCampaignStatus(auth(), acct(), { externalId: "11" }, "PAUSED")).rejects.toThrow(ConnectorError);
  });

  it("setCampaignDailyBudget on a Sponsored Brands campaign must not PUT the SP endpoint", async () => {
    server.use(
      http.put(`${AMZ_EU}/sp/campaigns`, () => failed207("campaigns", "Campaign not found")),
      http.put(`${AMZ_EU}/sb/v4/campaigns`, () => created207("campaigns", "campaignId", "41")),
    );
    await amazon().setCampaignDailyBudget(auth(), acct(), { externalId: "41", raw: { product: "SPONSORED_BRANDS" } } as never, 30);
    expect(await hits({ path: "/sp/campaigns" })).toHaveLength(0);
  });
});

describe("Amazon createdId (207 multi-status parsing)", () => {
  it("reads the id from success[0] or its nested entity, and throws with the platform message on errors", () => {
    expect(createdId({ campaigns: { success: [{ index: 0, campaignId: "1" }], error: [] } }, "campaigns", "Campaign")).toBe("1");
    expect(createdId({ adGroups: { success: [{ index: 0, adGroup: { adGroupId: "2" } }] } }, "adGroups", "Ad group")).toBe("2");
    expect(() =>
      createdId({ campaigns: { success: [], error: [{ index: 0, errors: [{ errorValue: { duplicateValueError: { message: "Name taken" } } }] }] } }, "campaigns", "Campaign"),
    ).toThrow("Campaign: Name taken");
    expect(() => createdId({}, "campaigns", "Campaign")).toThrow(/Campaign: rejected/);
  });
});

describe("Amazon createCampaign", () => {
  const spHandlers = (opts: { failAt?: "group" | "keyword" | "ad" } = {}) => [
    http.post(`${AMZ_EU}/sp/campaigns`, () => created207("campaigns", "campaignId", "c-1")),
    http.post(`${AMZ_EU}/sp/adGroups`, () => (opts.failAt === "group" ? failed207("adGroups", "Bad bid") : created207("adGroups", "adGroupId", "g-1"))),
    http.post(`${AMZ_EU}/sp/keywords`, () =>
      opts.failAt === "keyword" ? failed207("keywords", "Bad keyword") : HttpResponse.json({ keywords: { success: [{ index: 0, keywordId: "k-1" }], error: [] } }, { status: 207 }),
    ),
    http.post(`${AMZ_EU}/sp/productAds`, () => (opts.failAt === "ad" ? fail(500, { code: "500", details: "boom" }) : created207("productAds", "adId", "ad-1"))),
    http.post(`${AMZ_EU}/sp/campaigns/delete`, () => created207("campaigns", "campaignId", "c-1")),
  ];

  it("Sponsored Products: paused campaign, ad group, keywords and product ad with documented bodies", async () => {
    server.use(...spHandlers());
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" }, { campaign: { budget: 40 }, adGroup: { defaultBid: 0.85, keywords: [{ text: "silk saree", matchType: "EXACT" }] }, ad: { asin: "B0FESTIVE1" } });
    const out = await amazon().createCampaign(auth(), acct(), draft, new Map());
    const campaign = await onlyHit({ path: /\/sp\/campaigns$/ });
    expect(campaign.json.campaigns[0]).toMatchObject({
      name: "Festive Sale",
      targetingType: "MANUAL",
      state: "PAUSED",
      budget: { budgetType: "DAILY", budget: 40 },
      dynamicBidding: { strategy: "LEGACY_FOR_SALES" },
    });
    expect(campaign.json.campaigns[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await onlyHit({ path: "/sp/adGroups" })).json).toEqual({ adGroups: [{ campaignId: "c-1", name: "Ad group 1", state: "PAUSED", defaultBid: 0.85 }] });
    expect((await onlyHit({ path: "/sp/keywords" })).json).toEqual({
      keywords: [{ campaignId: "c-1", adGroupId: "g-1", keywordText: "silk saree", matchType: "EXACT", state: "PAUSED", bid: 0.85 }],
    });
    const ad = await onlyHit({ path: "/sp/productAds" });
    expect(ad.json).toEqual({ productAds: [{ campaignId: "c-1", adGroupId: "g-1", state: "PAUSED", asin: "B0FESTIVE1" }] });
    expect(out.campaigns[0]).toMatchObject({ externalId: "c-1", status: "PAUSED", dailyBudget: 40, objective: "SPONSORED_PRODUCTS", raw: { product: "SPONSORED_PRODUCTS" } });
    expect(out.adGroups[0]).toMatchObject({ externalId: "g-1", sourceKey: draft.adGroups[0]!.key });
    expect(out.ads[0]).toMatchObject({ externalId: "ad-1", sourceKey: draft.adGroups[0]!.ads[0]!.key });
  });

  it("Sponsored Products AUTO targeting sends no keywords; ACTIVE launches ENABLED", async () => {
    server.use(...spHandlers());
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" }, { campaign: { targetingType: "AUTO", launchStatus: "ACTIVE" }, ad: { asin: "B0X" } });
    draft.adGroups[0]!.values.keywords = [{ text: "ignored", matchType: "EXACT" }];
    const out = await amazon().createCampaign(auth(), acct(), draft, new Map());
    expect(await hits({ path: "/sp/keywords" })).toHaveLength(0);
    expect((await onlyHit({ path: /\/sp\/campaigns$/ })).json.campaigns[0]).toMatchObject({ targetingType: "AUTO", state: "ENABLED" });
    expect(out.campaigns[0]!.status).toBe("ACTIVE");
  });

  it("refuses an ad group without ASIN/SKU before creating anything", async () => {
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" }, { ad: { asin: "B0X" } });
    draft.adGroups[0]!.ads[0]!.values.asin = "";
    const err = await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(await hits()).toHaveLength(0);
  });

  it.each(["group", "keyword", "ad"] as const)("archives the SP campaign when the %s step fails after it was created", async (failAt) => {
    server.use(...spHandlers({ failAt }));
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" }, { adGroup: { keywords: [{ text: "saree", matchType: "BROAD" }] }, ad: { asin: "B0X" } });
    const err = await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    const undo = await onlyHit({ path: "/sp/campaigns/delete" });
    expect(undo.json).toEqual({ campaignIdFilter: { include: ["c-1"] } });
  });

  it("a rejected campaign create throws with Amazon's message and needs no rollback", async () => {
    server.use(http.post(`${AMZ_EU}/sp/campaigns`, () => failed207("campaigns", "Budget too low")));
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" }, { ad: { asin: "B0X" } });
    const err = await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e);
    expect(err.message).toContain("Budget too low");
    expect(await hits({ path: "/delete" })).toHaveLength(0);
  });

  it("Sponsored Brands: v4 campaign, ad group and ad; logo only from the asset library", async () => {
    server.use(
      http.post(`${AMZ_EU}/sb/v4/campaigns`, () => created207("campaigns", "campaignId", "sb-1")),
      http.post(`${AMZ_EU}/sb/v4/adGroups`, () => created207("adGroups", "adGroupId", "sbg-1")),
      http.post(`${AMZ_EU}/sb/v4/ads`, () => created207("ads", "adId", "sba-1")),
    );
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_BRANDS" }, { campaign: { budget: 60 }, ad: { asins: "B0A1, B0A2\nB0A3", headline: "Festive picks", brandName: "Ashniva", brandLogo: ["logo"] } });
    const out = await amazon().createCampaign(auth(), acct(), draft, assetsOf(imageAsset("logo")));
    expect((await onlyHit({ path: "/sb/v4/campaigns" })).json.campaigns[0]).toMatchObject({ name: "Festive Sale", state: "PAUSED", budget: 60, budgetType: "DAILY" });
    const ad = await onlyHit({ path: "/sb/v4/ads" });
    expect(ad.json.ads[0]).toMatchObject({ adGroupId: "sbg-1", state: "PAUSED", creative: { asins: ["B0A1", "B0A2", "B0A3"], headline: "Festive picks", brandName: "Ashniva" }, landingPage: { asins: ["B0A1", "B0A2", "B0A3"] } });
    expect(ad.json.ads[0].creative.brandLogoAssetID).toBeUndefined();
    expect(out.warnings?.[0]).toMatch(/asset library/);
    expect(out.campaigns[0]).toMatchObject({ externalId: "sb-1", status: "PAUSED", dailyBudget: 60 });
  });

  it("Sponsored Brands rejects more than 3 ASINs and rolls back when the ad fails", async () => {
    const tooMany = makeDraft("AMAZON", { adProduct: "SPONSORED_BRANDS" }, { ad: { asins: "A1 A2 A3 A4" } });
    expect((await amazon().createCampaign(auth(), acct(), tooMany, new Map()).catch((e) => e)).code).toBe("INVALID_REQUEST");
    expect(await hits()).toHaveLength(0);

    server.use(
      http.post(`${AMZ_EU}/sb/v4/campaigns`, () => created207("campaigns", "campaignId", "sb-1")),
      http.post(`${AMZ_EU}/sb/v4/adGroups`, () => created207("adGroups", "adGroupId", "sbg-1")),
      http.post(`${AMZ_EU}/sb/v4/ads`, () => failed207("ads", "Headline rejected")),
      http.post(`${AMZ_EU}/sb/v4/campaigns/delete`, () => created207("campaigns", "campaignId", "sb-1")),
    );
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_BRANDS" }, { ad: { asins: "B0A1", url: "https://shop.example.com/brand" } });
    const err = await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e);
    expect(err.message).toContain("Headline rejected");
    expect((await onlyHit({ path: "/sb/v4/ads" })).json.ads[0].landingPage).toEqual({ url: "https://shop.example.com/brand" });
    expect((await onlyHit({ path: "/sb/v4/campaigns/delete" })).json).toEqual({ campaignIdFilter: { include: ["sb-1"] } });
  });

  it("Sponsored Display: lower-case state, daily budget, numeric ids; archives on failure", async () => {
    server.use(
      http.post(`${AMZ_EU}/sd/campaigns`, () => sd207("campaignId", 501)),
      http.post(`${AMZ_EU}/sd/adGroups`, () => sd207("adGroupId", 601)),
      http.post(`${AMZ_EU}/sd/productAds`, () => sd207("adId", 701)),
    );
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_DISPLAY" }, { campaign: { budget: 15 }, ad: { asin: "B0SD", headline: "Custom" } });
    const out = await amazon().createCampaign(auth(), acct(), draft, new Map());
    expect((await onlyHit({ path: /\/sd\/campaigns$/ })).json).toEqual([{ name: "Festive Sale", state: "paused", budgetType: "daily", budget: 15, tactic: "T00020" }]);
    expect((await onlyHit({ path: "/sd/adGroups" })).json).toEqual([{ campaignId: 501, name: "Ad group 1", state: "paused", defaultBid: 1 }]);
    expect((await onlyHit({ path: "/sd/productAds" })).json).toEqual([{ campaignId: 501, adGroupId: 601, state: "paused", asin: "B0SD" }]);
    expect(out.campaigns[0]).toMatchObject({ externalId: "501", status: "PAUSED", objective: "SPONSORED_DISPLAY" });
    expect(out.warnings?.[0]).toMatch(/headline was not sent/);

    server.resetHandlers();
    server.use(
      http.post(`${AMZ_EU}/sd/campaigns`, () => sd207("campaignId", 502)),
      http.post(`${AMZ_EU}/sd/adGroups`, () => sd207("adGroupId", 0, "INVALID_ARGUMENT")),
      http.delete(`${AMZ_EU}/sd/campaigns/502`, () => HttpResponse.json({ code: "SUCCESS", campaignId: 502 })),
    );
    const err = await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(await hits({ method: "DELETE", path: "/sd/campaigns/502" })).toHaveLength(1);
  });

  it("Sponsored Display without an ASIN is refused up front", async () => {
    const draft = makeDraft("AMAZON", { adProduct: "SPONSORED_DISPLAY" }, { ad: { asin: "B0SD" } });
    draft.adGroups[0]!.ads[0]!.values.asin = " ";
    expect((await amazon().createCampaign(auth(), acct(), draft, new Map()).catch((e) => e)).code).toBe("INVALID_REQUEST");
  });

  it("builder options and targeting search are empty without HTTP", async () => {
    expect(await amazon().getBuilderOptions()).toEqual({});
    expect(await amazon().searchTargeting()).toEqual([]);
  });
});
