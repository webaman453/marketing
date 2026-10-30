/**
 * LinkedIn Marketing API connector (packages/connectors/src/linkedin).
 * Handlers: test/msw/handlers/linkedin.ts (doc links there).
 */
import { describe, expect, it } from "vitest";
import { LinkedInConnector, mapLinkedInStatus } from "../../src/linkedin";
import { MAX_PAGES } from "../../src/http";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { account, auth, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { LI_REST, LI_TOKEN_URL, LI_USERINFO, liAnalytics, liCreate, liFinder, liImageUpload, liPartialUpdate, liStat, liToken, liTypeahead, liUserinfo } from "../msw/handlers/linkedin";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";

useMswServer();

const config = { clientId: "li-client", clientSecret: "li-secret", apiVersion: "202610" };
const li = () => new LinkedInConnector(config);
const ACCT = "507404993";
const acct = account(ACCT, { currency: "INR", timezone: "Asia/Kolkata" });

describe("LinkedIn OAuth", () => {
  it("is configured only with client id and secret", () => {
    expect(li().isConfigured()).toBe(true);
    expect(new LinkedInConnector({ apiVersion: "202610" }).isConfigured()).toBe(false);
    expect(() => new LinkedInConnector({ apiVersion: "202610", clientId: "x" }).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl asks for the ads scopes with redirect and state (no PKCE)", () => {
    const url = li().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://www.linkedin.com/oauth/v2/authorization?")).toBe(true);
    const q = queryOf(url);
    expect(q).toMatchObject({ response_type: "code", client_id: "li-client", redirect_uri: REDIRECT, state: STATE });
    expect(q.scope!.split(" ")).toEqual(expect.arrayContaining(["r_ads", "rw_ads", "r_ads_reporting"]));
    expect(q.code_challenge).toBeUndefined();
  });

  it("exchangeCode posts the documented form and computes expiresAt from expires_in", async () => {
    server.use(liToken());
    const before = Date.now();
    const t = await li().exchangeCode({ code: "auth-code", redirectUri: REDIRECT });
    const after = Date.now();
    const h = await onlyHit({ path: "/oauth/v2/accessToken" });
    expect(h.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(h.form!)).toEqual({ client_id: "li-client", client_secret: "li-secret", grant_type: "authorization_code", code: "auth-code", redirect_uri: REDIRECT });
    expect(t.accessToken).toBe("li-access");
    expect(t.refreshToken).toBe("li-refresh");
    expect(t.scopes).toEqual(["r_ads", "rw_ads", "r_ads_reporting"]);
    expect(t.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 5184000 * 1000);
    expect(t.expiresAt!.getTime()).toBeLessThanOrEqual(after + 5184000 * 1000);
  });

  it("falls back to the requested scopes when the token response has none", async () => {
    server.use(liToken({ scope: undefined }));
    const t = await li().exchangeCode({ code: "c", redirectUri: REDIRECT });
    expect(t.scopes).toEqual(expect.arrayContaining(["r_ads", "rw_ads"]));
  });

  it("refreshTokens sends grant_type=refresh_token and leaves refreshToken undefined when LinkedIn returns none (core keeps the old one)", async () => {
    server.use(liToken({ refresh_token: undefined, access_token: "li-access-2" }));
    const t = await li().refreshTokens("old-refresh");
    const h = await onlyHit({ path: "/oauth/v2/accessToken" });
    expect(h.form!.get("grant_type")).toBe("refresh_token");
    expect(h.form!.get("refresh_token")).toBe("old-refresh");
    expect(h.text).not.toContain("undefined");
    expect(t!.accessToken).toBe("li-access-2");
    expect(t!.refreshToken).toBeUndefined();
  });

  it.each(STATUS_CODES)("token endpoint HTTP %i maps to %s with LinkedIn's error_description", async (status, code) => {
    server.use(http.post(LI_TOKEN_URL, () => fail(status, { error: "x", error_description: `desc ${status}` })));
    const err = await li().exchangeCode({ code: "c", redirectUri: REDIRECT }).catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`desc ${status}`);
  });

  // RFC 6749 §5.2: an expired/revoked refresh token is HTTP 400 invalid_grant.
  // https://learn.microsoft.com/linkedin/shared/authentication/programmatic-refresh-tokens
  it("BUG: a revoked refresh token (400 invalid_grant) should be AUTH_EXPIRED so the connection asks to reconnect", async () => {
    server.use(http.post(LI_TOKEN_URL, () => fail(400, { error: "invalid_grant", error_description: "The provided authorization grant or refresh token is invalid, expired or revoked." })));
    const err = await li().refreshTokens("revoked").catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
  });

  it("getUser reads OpenID userinfo with the bearer token", async () => {
    server.use(liUserinfo());
    expect(await li().getUser(auth("tok-1"))).toEqual({ id: "782bbtaQ", name: "Asha Rao" });
    expect((await onlyHit({ host: "api.linkedin.com" })).headers.get("authorization")).toBe("Bearer tok-1");
    server.use(liUserinfo({ sub: "s2", email: "only@example.com" }));
    expect((await li().getUser(auth())).name).toBe("only@example.com");
  });

  it.each([[401, "AUTH_EXPIRED"], [403, "PERMISSION_DENIED"], [429, "RATE_LIMITED"], [500, "PLATFORM_ERROR"]])("getUser HTTP %i → %s", async (status, code) => {
    server.use(http.get(LI_USERINFO, () => fail(status, { serviceErrorCode: 65600, message: "Invalid access token", status })));
    const err = await li().getUser(auth()).catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toBe("Invalid access token");
  });
});

describe("LinkedIn ad accounts", () => {
  const accounts = (n: number, extra: Record<string, unknown>[] = []) => [
    ...Array.from({ length: n }, (_, i) => ({ id: 1000 + i, name: `Acct ${i}`, currency: "USD", status: "ACTIVE", type: "BUSINESS" })),
    ...extra,
  ];

  it("sends the versioned REST headers and maps accounts, skipping removed and canceled ones", async () => {
    server.use(
      liFinder("/adAccounts", [
        { id: 507404993, name: "Dunder Mifflin", currency: "INR", status: "ACTIVE" },
        { id: 2, name: "Gone", status: "REMOVED" },
        { id: 3, name: "Closed", status: "CANCELED" },
        { id: 4, status: "DRAFT" },
      ]),
    );
    const list = await li().listAdAccounts(auth("tok"));
    expect(list).toEqual([
      { externalId: "507404993", name: "Dunder Mifflin", currency: "INR", timezone: null, status: "ACTIVE" },
      { externalId: "4", name: "LinkedIn 4", currency: "USD", timezone: null, status: "DRAFT" },
    ]);
    const h = await onlyHit({ path: "/rest/adAccounts" });
    expect(h.headers.get("linkedin-version")).toBe("202610");
    expect(h.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(h.headers.get("authorization")).toBe("Bearer tok");
    expect(h.url.searchParams.get("q")).toBe("search");
  });

  it("follows offset pages to the last one", async () => {
    server.use(liFinder("/adAccounts", accounts(1200)));
    const list = await li().listAdAccounts(auth());
    expect(list).toHaveLength(1200);
    expect(new Set(list.map((a) => a.externalId)).size).toBe(1200);
    expect((await hits({ path: "/rest/adAccounts" })).length).toBe(3);
  });

  // Since 202401 the search finders page with pageSize/pageToken and return metadata.nextPageToken
  // (create-and-manage-accounts doc, "Cursor based Pagination for search APIs").
  it("BUG: follows documented cursor paging (metadata.nextPageToken) instead of start/count", async () => {
    server.use(liFinder("/adAccounts", accounts(250), { cursorOnly: true }));
    expect(await li().listAdAccounts(auth())).toHaveLength(250);
  });

  it(`BUG: stops after MAX_PAGES (${MAX_PAGES}) full pages with an error instead of looping forever`, async () => {
    let calls = 0;
    const full = accounts(500);
    server.use(
      http.get(`${LI_REST}/adAccounts`, () => {
        calls++;
        if (calls > MAX_PAGES + 20) return fail(500, { message: "test guard" });
        return HttpResponse.json({ elements: full, metadata: { nextPageToken: `tok-${calls}` } });
      }),
    );
    const err = await li().listAdAccounts(auth()).catch((e) => e);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(calls).toBeLessThanOrEqual(MAX_PAGES);
  });

  it.each([[401, "AUTH_EXPIRED"], [403, "PERMISSION_DENIED"], [429, "RATE_LIMITED"], [503, "PLATFORM_ERROR"]])("a %i on any page propagates as %s (no partial or empty list)", async (status, code) => {
    let n = 0;
    // The first page links to a second (metadata.nextPageToken, cursor paging since 202401); that one fails.
    server.use(http.get(`${LI_REST}/adAccounts`, () => (n++ === 0 ? HttpResponse.json({ elements: accounts(500), metadata: { nextPageToken: "tok-500" } }) : fail(status, { message: "boom", status }))));
    const err = await li().listAdAccounts(auth()).catch((e) => e);
    expect(err.code).toBe(code);
  });
});

describe("LinkedIn structure", () => {
  const groups = [
    { id: 600001, name: "Q4 Pipeline", status: "ACTIVE", objective: "WEBSITE_VISIT", totalBudget: { amount: "5000.00", currencyCode: "INR" }, runSchedule: { start: Date.UTC(2026, 9, 1), end: Date.UTC(2026, 11, 31, 23, 59) } },
    { id: 600002, name: "Old", status: "ARCHIVED" },
  ];
  const campaigns = [
    { id: 700001, name: "IT DMs", status: "PAUSED", campaignGroup: "urn:li:sponsoredCampaignGroup:600001", dailyBudget: { amount: "25.50", currencyCode: "INR" }, costType: "CPM", objectiveType: "WEBSITE_VISIT", type: "SPONSORED_UPDATES" },
    { id: 700002, name: "Draft one", status: "DRAFT", campaignGroup: "urn:li:sponsoredCampaignGroup:600002" },
  ];
  const creatives = [
    { id: "urn:li:sponsoredCreative:800001", campaign: "urn:li:sponsoredCampaign:700001", intendedStatus: "ACTIVE", name: "Image ad" },
    { id: "urn:li:sponsoredCreative:800002", campaign: "urn:li:sponsoredCampaign:700002", intendedStatus: "DRAFT" },
    { id: "urn:li:sponsoredCreative:800003", campaign: "urn:li:sponsoredCampaign:999", intendedStatus: "ACTIVE" },
  ];
  const all = () => [
    liFinder(`/adAccounts/${ACCT}/adCampaignGroups`, groups),
    liFinder(`/adAccounts/${ACCT}/adCampaigns`, campaigns),
    liFinder(`/adAccounts/${ACCT}/creatives`, creatives, { maxPageSize: 100 }),
  ];

  it("maps groups → campaigns, campaigns → ad groups and creatives → ads with budgets in currency units", async () => {
    server.use(...all());
    const s = await li().fetchStructure(auth(), acct);
    expect(s.campaigns).toEqual([
      expect.objectContaining({ externalId: "600001", name: "Q4 Pipeline", status: "ACTIVE", objective: "WEBSITE_VISIT", dailyBudget: null, lifetimeBudget: 5000, startDate: "2026-10-01", endDate: "2026-12-31" }),
      expect.objectContaining({ externalId: "600002", status: "ARCHIVED", lifetimeBudget: null, startDate: null, endDate: null }),
    ]);
    expect(s.adGroups).toEqual([
      expect.objectContaining({ externalId: "700001", campaignExternalId: "600001", status: "PAUSED", dailyBudget: 25.5, bidStrategy: "CPM" }),
      expect.objectContaining({ externalId: "700002", campaignExternalId: "600002", status: "PAUSED", dailyBudget: null }),
    ]);
    // The creative of an unknown campaign is dropped.
    expect(s.ads.map((a) => [a.externalId, a.adGroupExternalId, a.campaignExternalId, a.status, a.name])).toEqual([
      ["800001", "700001", "600001", "ACTIVE", "Image ad"],
      ["800002", "700002", "600002", "PAUSED", "Creative 800002"],
    ]);
    const crHit = await onlyHit({ path: "/creatives" });
    expect(crHit.url.searchParams.get("q")).toBe("criteria");
  });

  it("maps every documented status", () => {
    expect(mapLinkedInStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapLinkedInStatus("PAUSED")).toBe("PAUSED");
    expect(mapLinkedInStatus("DRAFT")).toBe("PAUSED");
    expect(mapLinkedInStatus("ARCHIVED")).toBe("ARCHIVED");
    expect(mapLinkedInStatus("COMPLETED")).toBe("ARCHIVED");
    expect(mapLinkedInStatus("CANCELED")).toBe("REMOVED");
    expect(mapLinkedInStatus("REMOVED")).toBe("REMOVED");
    expect(mapLinkedInStatus(undefined)).toBe("PAUSED");
  });

  it("propagates a campaign-group list error instead of returning an empty structure", async () => {
    server.use(...all()); server.use(http.get(`${LI_REST}/adAccounts/${ACCT}/adCampaignGroups`, () => fail(401, { message: "expired" })));
    await expect(li().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("BUG: propagates an expired login on the creatives list (src/linkedin/index.ts:173 swallows it into no ads)", async () => {
    server.use(...all()); server.use(http.get(`${LI_REST}/adAccounts/${ACCT}/creatives`, () => fail(401, { message: "expired" })));
    await expect(li().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  // Creatives page at most 100 per request (create-and-manage-creatives doc, "pageSize ... max 100").
  it("BUG: reads every creative when an account has more than one page (100) of creatives", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: `urn:li:sponsoredCreative:${9000 + i}`, campaign: "urn:li:sponsoredCampaign:700001", intendedStatus: "ACTIVE" }));
    server.use(...all()); server.use(liFinder(`/adAccounts/${ACCT}/creatives`, many, { maxPageSize: 100 }));
    const s = await li().fetchStructure(auth(), acct);
    expect(s.ads).toHaveLength(150);
  });
});

describe("LinkedIn metrics", () => {
  const camps = [
    { id: 700001, campaignGroup: "urn:li:sponsoredCampaignGroup:600001" },
    { id: 700002, campaignGroup: "urn:li:sponsoredCampaignGroup:600001" },
  ];

  it("asks adAnalytics for DAILY rows in the exact range with Rest.li syntax", async () => {
    server.use(liFinder(`/adAccounts/${ACCT}/adCampaigns`, camps), liAnalytics({}));
    await li().fetchMetrics(auth(), acct, { from: "2026-02-27", to: "2026-03-02" });
    const [byCampaign, byCreative] = await hits({ path: "/adAnalytics" });
    for (const h of [byCampaign!, byCreative!]) {
      const raw = h.url.search;
      expect(raw).toContain("q=analytics");
      expect(raw).toContain("timeGranularity=DAILY");
      expect(raw).toContain("dateRange=(start:(year:2026,month:2,day:27),end:(year:2026,month:3,day:2))");
      expect(raw).toContain(`accounts=List(urn%3Ali%3AsponsoredAccount%3A${ACCT})`);
      expect(raw).toMatch(/fields=[^&]*costInLocalCurrency/);
    }
    expect([byCampaign!.url.searchParams.get("pivot"), byCreative!.url.searchParams.get("pivot")].sort()).toEqual(["CAMPAIGN", "CREATIVE"]);
  });

  it("returns daily ad-group rows, rolls them up per campaign group and day, and parses string money", async () => {
    server.use(
      liFinder(`/adAccounts/${ACCT}/adCampaigns`, camps),
      liAnalytics({
        CAMPAIGN: [
          liStat("urn:li:sponsoredCampaign:700001", "2026-10-01", { impressions: 1000, clicks: 10, cost: "12.34", conv: 2, value: "100.5", video: 3 }),
          liStat("urn:li:sponsoredCampaign:700002", "2026-10-01", { impressions: 500, clicks: 5, cost: "7.66", conv: 1, value: "0" }),
          liStat("urn:li:sponsoredCampaign:700001", "2026-10-02", { impressions: 10, cost: "0.5" }),
          liStat("urn:li:sponsoredCampaign:555", "2026-10-02", { impressions: 1, cost: "1" }),
        ],
        CREATIVE: [liStat("urn:li:sponsoredCreative:800001", "2026-10-01", { impressions: 900, clicks: 9, cost: "11" })],
      }),
    );
    const rows = await li().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" });
    const byKey = Object.fromEntries(rows.map((r) => [`${r.level}|${r.externalId}|${r.date}`, r]));
    expect(byKey["AD_GROUP|700001|2026-10-01"]).toMatchObject({ impressions: 1000, clicks: 10, spend: 12.34, conversions: 2, conversionValue: 100.5, videoViews: 3 });
    expect(byKey["CAMPAIGN|600001|2026-10-01"]).toMatchObject({ impressions: 1500, clicks: 15, spend: 20, conversions: 3, conversionValue: 100.5 });
    expect(byKey["CAMPAIGN|600001|2026-10-02"]).toMatchObject({ impressions: 10, spend: 0.5 });
    expect(byKey["AD|800001|2026-10-01"]).toMatchObject({ impressions: 900, spend: 11 });
    // A campaign not in the account's campaign list still gets its own row but no group roll-up.
    expect(byKey["AD_GROUP|555|2026-10-02"]).toBeDefined();
    expect(rows.filter((r) => r.level === "CAMPAIGN")).toHaveLength(2);
    expect(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))).toBe(true);
  });

  it("propagates an expired login on the campaign report", async () => {
    server.use(liFinder(`/adAccounts/${ACCT}/adCampaigns`, camps), http.get(`${LI_REST}/adAnalytics`, () => fail(401, { message: "expired" })));
    await expect(li().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("BUG: propagates an expired login on the creative report (src/linkedin/index.ts:232 turns it into no ad rows)", async () => {
    server.use(
      liFinder(`/adAccounts/${ACCT}/adCampaigns`, camps),
      http.get(`${LI_REST}/adAnalytics`, ({ request }) => (new URL(request.url).searchParams.get("pivot") === "CREATIVE" ? fail(401, { message: "expired" }) : HttpResponse.json({ elements: [] }))),
    );
    await expect(li().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("LinkedIn actions", () => {
  it("setCampaignStatus is a Rest.li PARTIAL_UPDATE of the campaign group", async () => {
    server.use(liPartialUpdate(/\/rest\/adAccounts\/\d+\/adCampaignGroups\/\d+$/));
    await li().setCampaignStatus(auth(), acct, { externalId: "600001" }, "PAUSED");
    const h = await onlyHit({ method: "POST" });
    expect(h.url.pathname).toBe(`/rest/adAccounts/${ACCT}/adCampaignGroups/600001`);
    expect(h.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE");
    expect(h.headers.get("linkedin-version")).toBe("202610");
    expect(h.json).toEqual({ patch: { $set: { status: "PAUSED" } } });
  });

  it("setCampaignStatus maps an API error", async () => {
    server.use(http.post(/adCampaignGroups/, () => fail(403, { message: "Not allowed" })));
    await expect(li().setCampaignStatus(auth(), acct, { externalId: "1" }, "ACTIVE")).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: "Not allowed" });
  });

  it("setCampaignDailyBudget is UNSUPPORTED (budgets live on LinkedIn campaigns) and calls nothing", async () => {
    await expect(li().setCampaignDailyBudget()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await hits()).toHaveLength(0);
  });
});

describe("LinkedIn builder options and targeting", () => {
  const options = () => [
    http.get(`${LI_REST}/organizationAcls`, () => HttpResponse.json({ elements: [{ organization: "urn:li:organization:42", role: "ADMINISTRATOR", state: "APPROVED" }] })),
    http.get(`${LI_REST}/organizations/42`, () => HttpResponse.json({ id: 42, localizedName: "Ashniva Labs" })),
    http.get(`${LI_REST}/conversions`, () => HttpResponse.json({ elements: [{ id: 70203, name: "Purchase", type: "PURCHASE" }] })),
    http.get(`${LI_REST}/leadForms`, () => HttpResponse.json({ elements: [{ id: 9001, name: "Demo form" }] })),
    http.get(`${LI_REST}/userinfo`, () => fail(404, { message: "Not found" })),
    liUserinfo(),
  ];

  it("lists pages, conversions and lead forms", async () => {
    server.use(...options());
    const o = await li().getBuilderOptions(auth(), acct);
    expect(o.organizations).toEqual([{ id: "urn:li:organization:42", name: "Ashniva Labs" }]);
    expect(o.conversionActions).toEqual([{ id: "70203", name: "Purchase", detail: "PURCHASE" }]);
    expect(o.leadForms).toEqual([{ id: "urn:li:adForm:9001", name: "Demo form" }]);
  });

  // OpenID userinfo lives at /v2/userinfo (the connector's own getUser uses it); /rest/userinfo does not exist.
  it("BUG: offers the signed-in member as a message-ad sender (src/linkedin/builder.ts:31 calls /rest/userinfo)", async () => {
    server.use(...options());
    const o = await li().getBuilderOptions(auth(), acct);
    expect(o.profiles).toEqual([{ id: "urn:li:person:782bbtaQ", name: "Asha Rao" }]);
  });

  it("searchTargeting uses the typeahead finder for supported facets only", async () => {
    server.use(liTypeahead([{ urn: "urn:li:title:9", name: "Chief Technology Officer" }]));
    const res = await li().searchTargeting(auth(), acct, "jobTitle", " cto ");
    expect(res).toEqual([{ id: "urn:li:title:9", name: "Chief Technology Officer", type: undefined }]);
    const h = await onlyHit({ path: "/adTargetingEntities" });
    expect(h.url.searchParams.get("q")).toBe("typeahead");
    expect(h.url.searchParams.get("facet")).toBe("urn:li:adTargetingFacet:titles");
    expect(h.url.searchParams.get("query")).toBe("cto");
    expect(await li().searchTargeting(auth(), acct, "interest", "x")).toEqual([]);
    expect(await li().searchTargeting(auth(), acct, "location", "  ")).toEqual([]);
    expect(await hits()).toHaveLength(1);
  });
});

describe("LinkedIn createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}, setup: Record<string, unknown> = { objective: "WEBSITE_VISIT", format: "SINGLE_IMAGE" }) =>
    makeDraft("LINKEDIN", setup, {
      ...over,
      adGroup: { locations: [{ id: "IN", name: "India", type: "country" }], budget: 50, ...over.adGroup },
      ad: { organizationId: "urn:li:organization:42", image: ["img-1"], url: "https://shop.example.com/festive", introText: "The festive edit is live", headline: "Festive edit", ...over.ad },
    });
  const assets = assetsOf(imageAsset("img-1"));
  const happy = () => [
    liCreate(`/adAccounts/${ACCT}/adCampaignGroups`, "600100"),
    liCreate(`/adAccounts/${ACCT}/adCampaigns`, "700100"),
    liCreate(`/adAccounts/${ACCT}/creatives`, "urn%3Ali%3AsponsoredCreative%3A800100"),
    liTypeahead(),
    ...liImageUpload(),
    liPartialUpdate(/\/adCampaignGroups\/600100$/),
  ];

  it("creates a paused group → campaign → inline image creative from a realistic draft", async () => {
    server.use(...happy());
    const d = draft();
    expect(d.campaign.launchStatus).toBe("PAUSED");
    const s = await li().createCampaign(auth(), acct, d, assets);

    const group = (await onlyHit({ path: "/adCampaignGroups", method: "POST" })).json;
    expect(group).toMatchObject({ account: `urn:li:sponsoredAccount:${ACCT}`, name: "Festive Sale", status: "PAUSED" });
    expect(typeof group.runSchedule.start).toBe("number");
    expect(group.totalBudget).toBeUndefined();

    const camp = (await onlyHit({ path: "/adCampaigns", method: "POST" })).json;
    expect(camp).toMatchObject({
      account: `urn:li:sponsoredAccount:${ACCT}`,
      campaignGroup: "urn:li:sponsoredCampaignGroup:600100",
      type: "SPONSORED_UPDATES",
      format: "STANDARD_UPDATE",
      objectiveType: "WEBSITE_VISIT",
      locale: { country: "US", language: "en" },
      dailyBudget: { amount: "50.00", currencyCode: "INR" },
      status: "PAUSED",
      optimizationTargetType: "MAX_CLICK",
      creativeSelection: "OPTIMIZED",
      politicalIntent: "NOT_POLITICAL",
    });
    expect(camp.totalBudget).toBeUndefined();
    expect(camp.targetingCriteria.include.and).toContainEqual({ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:102713980"] } });
    expect(camp.targetingCriteria.include.and).toContainEqual({ or: { "urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:en_US"] } });

    const init = (await onlyHit({ path: "/rest/images" })).json;
    expect(init).toEqual({ initializeUploadRequest: { owner: "urn:li:organization:42" } });
    const put = await onlyHit({ method: "PUT" });
    expect(put.headers.get("content-type")).toBe("image/jpeg");

    const cr = await onlyHit({ path: "/creatives" });
    expect(cr.url.searchParams.get("action")).toBe("createInline");
    expect(cr.json.creative).toMatchObject({
      campaign: "urn:li:sponsoredCampaign:700100",
      intendedStatus: "PAUSED",
      inlineContent: {
        post: {
          author: "urn:li:organization:42",
          commentary: "The festive edit is live",
          adContext: { dscAdAccount: `urn:li:sponsoredAccount:${ACCT}`, dscStatus: "ACTIVE" },
          content: { media: { id: "urn:li:image:C4E10AQ", title: "Festive edit" } },
          contentLandingPage: "https://shop.example.com/festive",
          contentCallToActionLabel: "LEARN_MORE",
        },
      },
    });

    expect(s.campaigns[0]).toMatchObject({ externalId: "600100", status: "PAUSED", objective: "WEBSITE_VISIT" });
    expect(s.adGroups[0]).toMatchObject({ externalId: "700100", campaignExternalId: "600100", dailyBudget: 50, sourceKey: d.adGroups[0]!.key });
    expect(s.ads[0]).toMatchObject({ externalId: "800100", adGroupExternalId: "700100", campaignExternalId: "600100", status: "PAUSED", sourceKey: d.adGroups[0]!.ads[0]!.key, finalUrl: "https://shop.example.com/festive" });
    // Nothing was rolled back.
    expect(await hits({ path: "/adCampaignGroups/600100" })).toHaveLength(0);
  });

  it("uses a lifetime totalBudget on the campaign and the optional group budget, both in currency units", async () => {
    server.use(...happy());
    const d = draft({ campaign: { groupBudget: true, groupBudgetAmount: 1000 }, adGroup: { budget: 300, budgetType: "LIFETIME", endDate: "2026-12-31" } });
    const s = await li().createCampaign(auth(), acct, d, assets);
    expect((await onlyHit({ path: "/adCampaignGroups", method: "POST" })).json.totalBudget).toEqual({ amount: "1000.00", currencyCode: "INR" });
    const camp = (await onlyHit({ path: "/adCampaigns", method: "POST" })).json;
    expect(camp.totalBudget).toEqual({ amount: "300.00", currencyCode: "INR" });
    expect(camp.dailyBudget).toBeUndefined();
    expect(typeof camp.runSchedule.end).toBe("number");
    expect(s.adGroups[0]!.dailyBudget).toBeNull();
  });

  it("starts everything only when the draft says ACTIVE", async () => {
    server.use(...happy());
    await li().createCampaign(auth(), acct, draft({ campaign: { launchStatus: "ACTIVE" } }), assets);
    expect((await onlyHit({ path: "/adCampaignGroups", method: "POST" })).json.status).toBe("ACTIVE");
    expect((await onlyHit({ path: "/adCampaigns", method: "POST" })).json.status).toBe("ACTIVE");
    expect((await onlyHit({ path: "/creatives" })).json.creative.intendedStatus).toBe("ACTIVE");
  });

  it("archives the campaign group when a creative fails after the group was created", async () => {
    server.use(...happy()); server.use(http.post(`${LI_REST}/adAccounts/${ACCT}/creatives`, () => fail(422, { message: "Invalid landing page", status: 422 })));
    const err = await li().createCampaign(auth(), acct, draft(), assets).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", message: "Invalid landing page" });
    const rb = await onlyHit({ path: "/adCampaignGroups/600100" });
    expect(rb.headers.get("x-restli-method")).toBe("PARTIAL_UPDATE");
    expect(rb.json).toEqual({ patch: { $set: { status: "ARCHIVED" } } });
  });

  it("archives the group when the draft is missing the company page, and rethrows", async () => {
    server.use(...happy());
    const d = draft();
    d.adGroups[0]!.ads[0]!.values.organizationId = "";
    const err = await li().createCampaign(auth(), acct, d, assets).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(await hits({ path: "/adCampaignGroups/600100" })).toHaveLength(1);
    expect(await hits({ path: "/creatives" })).toHaveLength(0);
  });

  it("does not roll back when the group itself fails, and refuses unsupported formats before any call", async () => {
    server.use(http.post(`${LI_REST}/adAccounts/${ACCT}/adCampaignGroups`, () => fail(500, { message: "down" })));
    await expect(li().createCampaign(auth(), acct, draft(), assets)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits()).toHaveLength(1);

    const msg = makeDraft("LINKEDIN", { objective: "WEBSITE_VISIT", format: "MESSAGE" });
    await expect(li().createCampaign(auth(), acct, msg, assets)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await hits()).toHaveLength(1);
  });

  it("fails the create (and archives) when LinkedIn returns no id", async () => {
    server.use(...happy()); server.use(http.post(`${LI_REST}/adAccounts/${ACCT}/adCampaigns`, () => new HttpResponse(null, { status: 201 })));
    await expect(li().createCampaign(auth(), acct, draft(), assets)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits({ path: "/adCampaignGroups/600100" })).toHaveLength(1);
  });

  // conversion-tracking doc: "PUT https://api.linkedin.com/rest/campaignConversions/(campaign:…,conversion:…)".
  it("BUG: links conversions with the documented PUT (src/linkedin/builder.ts:207 sends POST)", async () => {
    server.use(...happy()); server.use(http.put(/\/rest\/campaignConversions\//, () => new HttpResponse(null, { status: 204 })));
    const d = draft({ adGroup: { conversions: ["70203"], optimizationGoal: "MAX_CONVERSION" } }, { objective: "WEBSITE_CONVERSION", format: "SINGLE_IMAGE" });
    const s = await li().createCampaign(auth(), acct, d, assets);
    expect(s.warnings ?? []).toEqual([]);
    const h = await onlyHit({ path: "/campaignConversions" });
    expect(h.method).toBe("PUT");
    expect(decodeURIComponent(h.url.pathname)).toContain("(campaign:urn:li:sponsoredCampaign:700100,conversion:urn:lla:llaPartnerConversion:70203)");
  });

  it("keeps going with a warning when a conversion can't be linked", async () => {
    server.use(...happy()); server.use(http.all(/\/rest\/campaignConversions\//, () => fail(400, { message: "bad conversion" })));
    const d = draft({ adGroup: { conversions: ["70203"], optimizationGoal: "MAX_CONVERSION" } }, { objective: "WEBSITE_CONVERSION", format: "SINGLE_IMAGE" });
    const s = await li().createCampaign(auth(), acct, d, assets);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings![0]).toContain("70203");
    expect(s.ads).toHaveLength(1);
  });
});
