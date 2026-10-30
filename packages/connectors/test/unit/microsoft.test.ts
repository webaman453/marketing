/**
 * Microsoft Advertising connector (packages/connectors/src/microsoft), REST/JSON v13.
 * Handlers: test/msw/handlers/microsoft.ts (doc links there).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrosoftAdsConnector, mapMicrosoftStatus } from "../../src/microsoft";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { account, auth, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { MS_CAMPAIGN, MS_CUSTOMER, MS_REPORTING, msAdApiFault, msApiFault, msGeo, msPost, msReporting, msToken, msTokenUrl, REPORT_URL } from "../msw/handlers/microsoft";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";

useMswServer();

const config = { clientId: "ms-client", clientSecret: "ms-secret", developerToken: "dev-tok", tenant: "common" };
const ms = () => new MicrosoftAdsConnector(config);
const ACCT = "149123456";
const acct = account(ACCT, { currency: "INR", timezone: "Asia/Kolkata", meta: { customerId: 251000 } });

/** Report polling waits 2s between polls; run those waits immediately. */
function fastPolling() {
  const real = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, _ms?: number, ...args: unknown[]) => real(fn, 0, ...args)) as typeof setTimeout);
}
afterEach(() => vi.unstubAllGlobals());

describe("Microsoft OAuth", () => {
  it("needs client id, secret and developer token", () => {
    expect(ms().isConfigured()).toBe(true);
    expect(new MicrosoftAdsConnector({ ...config, developerToken: undefined }).isConfigured()).toBe(false);
    expect(() => new MicrosoftAdsConnector({ tenant: "common" }).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl uses the tenant authorize endpoint with msads.manage + offline_access, redirect and state", () => {
    const url = ms().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")).toBe(true);
    expect(queryOf(url)).toEqual({
      client_id: "ms-client",
      response_type: "code",
      redirect_uri: REDIRECT,
      response_mode: "query",
      scope: "https://ads.microsoft.com/msads.manage offline_access",
      state: STATE,
    });
  });

  it("exchangeCode posts the documented form to the tenant token endpoint and computes expiresAt", async () => {
    const c = new MicrosoftAdsConnector({ ...config, tenant: "contoso.onmicrosoft.com" });
    server.use(msToken({}, "contoso.onmicrosoft.com"));
    const before = Date.now();
    const t = await c.exchangeCode({ code: "M.C123", redirectUri: REDIRECT });
    const after = Date.now();
    const h = await onlyHit({ host: "login.microsoftonline.com" });
    expect(Object.fromEntries(h.form!)).toEqual({
      client_id: "ms-client",
      client_secret: "ms-secret",
      scope: "https://ads.microsoft.com/msads.manage offline_access",
      grant_type: "authorization_code",
      code: "M.C123",
      redirect_uri: REDIRECT,
    });
    expect(t).toMatchObject({ accessToken: "ms-access", refreshToken: "ms-refresh", scopes: ["https://ads.microsoft.com/msads.manage"] });
    expect(t.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3599_000);
    expect(t.expiresAt!.getTime()).toBeLessThanOrEqual(after + 3599_000);
  });

  it("refreshTokens sends grant_type=refresh_token and leaves refreshToken undefined when none comes back", async () => {
    server.use(msToken({ refresh_token: undefined, access_token: "ms-access-2", scope: undefined }));
    const t = await ms().refreshTokens("old-rt");
    const h = await onlyHit({ host: "login.microsoftonline.com" });
    expect(h.form!.get("grant_type")).toBe("refresh_token");
    expect(h.form!.get("refresh_token")).toBe("old-rt");
    expect(h.text).not.toContain("undefined");
    expect(t!.accessToken).toBe("ms-access-2");
    expect(t!.refreshToken).toBeUndefined();
    expect(t!.scopes).toEqual(["https://ads.microsoft.com/msads.manage", "offline_access"]);
  });

  it.each(STATUS_CODES)("token endpoint HTTP %i maps to %s with the AADSTS error_description", async (status, code) => {
    server.use(http.post(msTokenUrl(), () => fail(status, { error: "invalid_client", error_description: `AADSTS7000215: ${status}` })));
    const err = await ms().exchangeCode({ code: "c", redirectUri: REDIRECT }).catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`AADSTS7000215: ${status}`);
  });

  // handle-service-errors doc, "Invalid grant": an expired or revoked refresh token is invalid_grant (HTTP 400).
  it("BUG: an expired refresh token (400 invalid_grant) should be AUTH_EXPIRED so the connection asks to reconnect", async () => {
    server.use(http.post(msTokenUrl(), () => fail(400, { error: "invalid_grant", error_description: "The user could not be authenticated or the grant is expired." })));
    await expect(ms().refreshTokens("expired")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("getUser calls User/Query with the bearer and developer token headers", async () => {
    server.use(msPost(MS_CUSTOMER, "/User/Query", { User: { Id: 9001, UserName: "asha@contoso.com", Name: { FirstName: "Asha", LastName: "Rao" } }, CustomerRoles: [] }));
    expect(await ms().getUser(auth("tok"))).toEqual({ id: "9001", name: "Asha Rao" });
    const h = await onlyHit({ path: "/User/Query" });
    expect(h.method).toBe("POST");
    expect(h.headers.get("authorization")).toBe("Bearer tok");
    expect(h.headers.get("developertoken")).toBe("dev-tok");
    expect(h.headers.get("customeraccountid")).toBeNull();
    expect(h.json).toEqual({ UserId: null });
    server.use(msPost(MS_CUSTOMER, "/User/Query", { User: { Id: 1, UserName: "only-login" } }));
    expect((await ms().getUser(auth())).name).toBe("only-login");
  });

  // Code 0 (InternalError) carries no meaning of its own, so the HTTP status decides. (A known code such
  // as 105 InvalidCredentials decides by itself; see the fault-code test below.)
  it.each([[401, "AUTH_EXPIRED"], [403, "PERMISSION_DENIED"], [429, "RATE_LIMITED"], [500, "PLATFORM_ERROR"]])("HTTP %i maps to %s and reads AdApiFaultDetail.Errors[0].Message", async (status, code) => {
    server.use(http.post(`${MS_CUSTOMER}/User/Query`, () => msAdApiFault(status, 0, "InternalError", "An internal error has occurred.")));
    const err = await ms().getUser(auth()).catch((e) => e);
    expect(err.code).toBe(code);
    expect(err.message).toBe("An internal error has occurred.");
  });

  // The fault doc says Bing Ads API faults come back as HTTP 500 and the fault's error Code says
  // what happened (105 = bad/expired token, 117 = CallRateExceeded). REST body shape // unverified.
  it("BUG: classifies faults by their error code (105 → AUTH_EXPIRED, 117 → RATE_LIMITED), not only by HTTP status", async () => {
    server.use(http.post(`${MS_CUSTOMER}/User/Query`, () => msApiFault(500, 105, "InvalidCredentials", "Authentication failed. Either supplied credentials are invalid or the account is inactive")));
    await expect(ms().getUser(auth())).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: expect.stringContaining("Authentication failed") });
    server.use(http.post(`${MS_CUSTOMER}/User/Query`, () => msApiFault(500, 117, "CallRateExceeded", "You have exceeded the number of calls that you are allowed to make in a minute.")));
    await expect(ms().getUser(auth())).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("Microsoft ad accounts", () => {
  const info = { AccountsInfo: [{ Id: 149123456, Name: "Ashniva India", Number: "F149ABCD", AccountLifeCycleStatus: "Active", PauseReason: null }, { Id: 149000002, Name: null, Number: "F1490002", AccountLifeCycleStatus: "Pause" }] };
  const details: Record<string, unknown> = {
    "149123456": { Account: { Id: 149123456, Name: "Ashniva India", CurrencyCode: "INR", TimeZone: "ChennaiKolkataMumbaiNewDelhi", ParentCustomerId: 251000 } },
    "149000002": { Account: { Id: 149000002, Name: "Second", CurrencyCode: "USD", TimeZone: "EasternTimeUSCanada", ParentCustomerId: 251001 } },
  };
  const handlers = () => [
    msPost(MS_CUSTOMER, "/AccountsInfo/Query", info),
    http.post(`${MS_CUSTOMER}/Account/Query`, async ({ request }) => HttpResponse.json(details[String(((await request.json()) as { AccountId: number }).AccountId)] as never)),
  ];

  it("lists accounts with currency, customer id and number from Account/Query", async () => {
    server.use(...handlers());
    const list = await ms().listAdAccounts(auth());
    expect(list).toEqual([
      { externalId: "149123456", name: "Ashniva India", currency: "INR", timezone: expect.any(String), status: "Active", meta: { customerId: 251000, number: "F149ABCD" } },
      { externalId: "149000002", name: "Second", currency: "USD", timezone: expect.any(String), status: "Pause", meta: { customerId: 251001, number: "F1490002" } },
    ]);
    expect((await onlyHit({ path: "/AccountsInfo/Query" })).json).toEqual({ CustomerId: null, OnlyParentAccounts: false });
    expect((await hits({ path: "/Account/Query" })).map((h) => h.json)).toEqual([{ AccountId: 149123456 }, { AccountId: 149000002 }]);
  });

  it.each([[401, "AUTH_EXPIRED"], [429, "RATE_LIMITED"], [500, "PLATFORM_ERROR"]])("an AccountsInfo %i propagates as %s (no empty list)", async (status, code) => {
    server.use(http.post(`${MS_CUSTOMER}/AccountsInfo/Query`, () => msAdApiFault(status, 0, "x", "fault")));
    await expect(ms().listAdAccounts(auth())).rejects.toMatchObject({ code });
  });

  it("BUG: an expired login on Account/Query propagates instead of listing the account in USD (src/microsoft/index.ts:162)", async () => {
    server.use(...handlers());
    server.use(http.post(`${MS_CUSTOMER}/Account/Query`, () => msAdApiFault(401, 105, "InvalidCredentials", "Authentication failed.")));
    await expect(ms().listAdAccounts(auth())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  // AccountRef.timezone is documented as IANA (types.ts) and createCampaign maps IANA → Microsoft names,
  // but listAdAccounts stores Microsoft's own TimeZone enum, so the account's zone is lost on create.
  it("BUG: an account listed in ChennaiKolkataMumbaiNewDelhi creates campaigns in that zone, not EasternTimeUSCanada (index.ts:168 / builder.ts:155)", async () => {
    server.use(...handlers());
    const [listed] = await ms().listAdAccounts(auth());
    server.use(msPost(MS_CAMPAIGN, "/Campaigns", { CampaignIds: [111], PartialErrors: [] }), msPost(MS_CAMPAIGN, "/CampaignCriterions", { CampaignCriterionIds: [1], NestedPartialErrors: [] }));
    const d = makeDraft("MICROSOFT", { campaignType: "PERFORMANCE_MAX" }, { campaign: { budget: 10, locations: [{ id: "191", name: "Delhi", type: "city" }] } });
    d.adGroups = [];
    await ms().createCampaign(auth(), { externalId: listed!.externalId, currency: listed!.currency, timezone: listed!.timezone, meta: listed!.meta }, d, new Map());
    const body = (await onlyHit({ path: "/CampaignManagement/v13/Campaigns" })).json;
    expect(body.Campaigns[0].TimeZone).toBe("ChennaiKolkataMumbaiNewDelhi");
  });
});

describe("Microsoft structure", () => {
  const campaigns = {
    Campaigns: [
      { Id: "804001", Name: "Brand – Search", Status: "Active", CampaignType: "Search", BudgetType: "DailyBudgetStandard", DailyBudget: 1500.5, BudgetId: null },
      { Id: "804002", Name: "Shared", Status: "Paused", CampaignType: "Search", BudgetType: "DailyBudgetAccelerated", DailyBudget: 300, BudgetId: "77" },
      { Id: "804003", Name: "Old", Status: "Deleted", CampaignType: "Audience", BudgetType: "MonthlyBudgetSpendUntilDepleted", DailyBudget: 9000 },
    ],
  };
  const groups: Record<string, unknown> = {
    "804001": { AdGroups: [{ Id: "1300001", Name: "Sarees", Status: "Active", BiddingScheme: { Type: "InheritFromParentBiddingScheme" } }] },
    "804002": { AdGroups: [{ Id: "1300002", Name: "Paused group", Status: "Paused" }] },
    "804003": { AdGroups: [] },
  };
  const ads: Record<string, unknown> = {
    "1300001": { Ads: [{ Id: "8100001", Type: "ResponsiveSearch", Status: "Active", FinalUrls: ["https://shop.example.com"], Headlines: [{ Asset: { Type: "TextAsset", Text: "Silk sarees" } }], Descriptions: [{ Asset: { Type: "TextAsset", Text: "Free shipping" } }] }] },
    "1300002": { Ads: [{ Id: "8100002", Type: "ResponsiveAd", Status: "Paused" }] },
  };
  const handlers = () => [
    msPost(MS_CAMPAIGN, "/Campaigns/QueryByAccountId", campaigns),
    http.post(`${MS_CAMPAIGN}/AdGroups/QueryByCampaignId`, async ({ request }) => HttpResponse.json(groups[String(((await request.json()) as { CampaignId: string }).CampaignId)] as never)),
    http.post(`${MS_CAMPAIGN}/Ads/QueryByAdGroupId`, async ({ request }) => HttpResponse.json(ads[String(((await request.json()) as { AdGroupId: string }).AdGroupId)] as never)),
  ];

  it("maps campaigns, ad groups and ads with daily budgets in currency units and account headers", async () => {
    server.use(...handlers());
    const s = await ms().fetchStructure(auth(), acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.objective, c.dailyBudget, c.raw])).toEqual([
      ["804001", "ACTIVE", "Search", 1500.5, { budgetType: "DailyBudgetStandard", budgetId: null }],
      ["804002", "PAUSED", "Search", 300, { budgetType: "DailyBudgetAccelerated", budgetId: "77" }],
      ["804003", "REMOVED", "Audience", null, { budgetType: "MonthlyBudgetSpendUntilDepleted", budgetId: null }],
    ]);
    expect(s.adGroups.map((g) => [g.externalId, g.campaignExternalId, g.status, g.bidStrategy])).toEqual([
      ["1300001", "804001", "ACTIVE", "InheritFromParentBiddingScheme"],
      ["1300002", "804002", "PAUSED", null],
    ]);
    expect(s.ads[0]).toMatchObject({ externalId: "1300001~8100001", adGroupExternalId: "1300001", campaignExternalId: "804001", name: "Silk sarees", headline: "Silk sarees", body: "Free shipping", finalUrl: "https://shop.example.com", status: "ACTIVE" });
    expect(s.ads[1]).toMatchObject({ externalId: "1300002~8100002", name: "ResponsiveAd #8100002", status: "PAUSED" });

    const q = await onlyHit({ path: "/Campaigns/QueryByAccountId" });
    expect(q.json).toEqual({ AccountId: 149123456, CampaignType: "Search Shopping Audience PerformanceMax" });
    expect(q.headers.get("customeraccountid")).toBe(ACCT);
    expect(q.headers.get("customerid")).toBe("251000");
    expect(q.headers.get("developertoken")).toBe("dev-tok");
    expect((await hits({ path: "/Ads/QueryByAdGroupId" }))[0]!.json).toEqual({ AdGroupId: "1300001", AdTypes: ["ResponsiveSearch", "ExpandedText", "ResponsiveAd"] });
  });

  it("maps statuses", () => {
    expect(mapMicrosoftStatus("Active")).toBe("ACTIVE");
    expect(mapMicrosoftStatus("Paused")).toBe("PAUSED");
    expect(mapMicrosoftStatus("BudgetPaused")).toBe("PAUSED");
    expect(mapMicrosoftStatus("Suspended")).toBe("PAUSED");
    expect(mapMicrosoftStatus("Deleted")).toBe("REMOVED");
    expect(mapMicrosoftStatus(undefined)).toBe("PAUSED");
  });

  it("propagates campaign and ad-group list errors", async () => {
    server.use(http.post(`${MS_CAMPAIGN}/Campaigns/QueryByAccountId`, () => msAdApiFault(401, 105, "InvalidCredentials", "expired")));
    await expect(ms().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    server.resetHandlers();
    server.use(...handlers());
    server.use(http.post(`${MS_CAMPAIGN}/AdGroups/QueryByCampaignId`, () => msAdApiFault(503, 0, "InternalError", "An internal error has occurred.")));
    await expect(ms().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("BUG: propagates an expired login on the ads list instead of returning ad groups with no ads (src/microsoft/index.ts:221)", async () => {
    server.use(...handlers());
    server.use(http.post(`${MS_CAMPAIGN}/Ads/QueryByAdGroupId`, () => msAdApiFault(401, 105, "InvalidCredentials", "expired")));
    await expect(ms().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Microsoft metrics", () => {
  const csv = {
    CampaignPerformanceReportRequest: `﻿"CampaignId","TimePeriod","Impressions","Clicks","Spend","Conversions","Revenue"\r\n"804001","2026-10-01","1,234","56","1,099.50","3","4,500.25"\r\n"804001","2026-10-02","10","0","0.00","0","0"\r\n`,
    AdGroupPerformanceReportRequest: `"AdGroupId","TimePeriod","Impressions","Clicks","Spend","Conversions","Revenue"\r\n"1300001","2026-10-01","1234","56","1099.5","3","4500.25"\r\n`,
    AdPerformanceReportRequest: `"AdGroupId","AdId","TimePeriod","Impressions","Clicks","Spend","Conversions","Revenue"\r\n"1300001","8100001","2026-10-01","1234","56","1099.5","3.5","--"\r\n`,
  };

  it("submits one daily CSV report per level for the exact calendar range and parses the zipped rows", async () => {
    server.use(...msReporting(csv));
    const rows = await ms().fetchMetrics(auth(), acct, { from: "2026-09-30", to: "2026-10-02" });
    const submits = (await hits({ path: "/GenerateReport/Submit" })).map((h) => h.json.ReportRequest);
    expect(submits.map((r) => r.Type)).toEqual(["CampaignPerformanceReportRequest", "AdGroupPerformanceReportRequest", "AdPerformanceReportRequest"]);
    for (const r of submits) {
      expect(r).toMatchObject({ Format: "Csv", Aggregation: "Daily", ExcludeReportHeader: true, ExcludeReportFooter: true, Scope: { AccountIds: [149123456] } });
      expect(r.Time).toEqual({ CustomDateRangeStart: { Year: 2026, Month: 9, Day: 30 }, CustomDateRangeEnd: { Year: 2026, Month: 10, Day: 2 } });
      expect(r.Columns).toEqual(expect.arrayContaining(["TimePeriod", "Impressions", "Clicks", "Spend", "Conversions", "Revenue"]));
    }
    expect((await hits({ path: "/GenerateReport/Submit" }))[0]!.headers.get("customeraccountid")).toBe(ACCT);

    expect(rows.filter((r) => r.level === "CAMPAIGN")).toEqual([
      { date: "2026-10-01", level: "CAMPAIGN", externalId: "804001", impressions: 1234, clicks: 56, spend: 1099.5, conversions: 3, conversionValue: 4500.25, videoViews: 0 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "804001", impressions: 10, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
    ]);
    expect(rows.find((r) => r.level === "AD_GROUP")).toMatchObject({ externalId: "1300001", spend: 1099.5 });
    // Ad ids match fetchStructure's "<adGroupId>~<adId>"; a "--" cell parses as 0.
    expect(rows.find((r) => r.level === "AD")).toMatchObject({ externalId: "1300001~8100001", conversions: 3.5, conversionValue: 0 });
  });

  it("keeps polling while the report is Pending and returns no rows when Success has no download URL", async () => {
    fastPolling();
    server.use(...msReporting({}, ["Pending", "Pending", "Success"]));
    expect(await ms().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
    expect(await hits({ path: "/GenerateReport/Poll" })).toHaveLength(9);
  });

  it("fails with PLATFORM_ERROR when the report errors or never finishes", async () => {
    server.use(...msReporting(csv, ["Error"]));
    await expect(ms().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "PLATFORM_ERROR", message: expect.stringContaining("failed") });
    fastPolling();
    server.resetHandlers();
    server.use(...msReporting(csv, ["Pending"]));
    await expect(ms().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "PLATFORM_ERROR", message: expect.stringContaining("timed out") });
    // One poll from the Error run above, then 30 attempts before giving up.
    expect(await hits({ path: "/GenerateReport/Poll" })).toHaveLength(31);
  });

  it("propagates an expired login on Submit", async () => {
    server.use(http.post(`${MS_REPORTING}/GenerateReport/Submit`, () => msAdApiFault(401, 105, "InvalidCredentials", "expired")));
    await expect(ms().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("BUG: a failed report download (expired blob URL) is a ConnectorError, not an unzip crash (src/microsoft/index.ts:277 ignores res.ok)", async () => {
    server.use(...msReporting(csv));
    server.use(http.get(REPORT_URL, () => new HttpResponse("<Error><Code>AuthenticationFailed</Code></Error>", { status: 403, headers: { "Content-Type": "application/xml" } })));
    await expect(ms().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ name: "ConnectorError" });
  });
});

describe("Microsoft actions", () => {
  it("setCampaignStatus PUTs Campaigns with the account id and Microsoft's status names", async () => {
    server.use(http.put(`${MS_CAMPAIGN}/Campaigns`, () => HttpResponse.json({ PartialErrors: [] })));
    await ms().setCampaignStatus(auth(), acct, { externalId: "804001" }, "PAUSED");
    await ms().setCampaignStatus(auth(), acct, { externalId: "804001" }, "ACTIVE");
    const [pause, resume] = await hits({ method: "PUT" });
    expect(pause!.json).toEqual({ AccountId: 149123456, Campaigns: [{ Id: 804001, Status: "Paused" }] });
    expect(resume!.json.Campaigns[0].Status).toBe("Active");
    expect(pause!.headers.get("customeraccountid")).toBe(ACCT);
  });

  it("setCampaignDailyBudget PUTs DailyBudget in currency units", async () => {
    server.use(http.put(`${MS_CAMPAIGN}/Campaigns`, () => HttpResponse.json({ PartialErrors: [] })));
    await ms().setCampaignDailyBudget(auth(), acct, { externalId: "804001", raw: { budgetId: null } }, 2500.75);
    expect((await onlyHit({ method: "PUT" })).json).toEqual({ AccountId: 149123456, Campaigns: [{ Id: 804001, DailyBudget: 2500.75 }] });
  });

  it("refuses to edit a shared budget and sends nothing", async () => {
    await expect(ms().setCampaignDailyBudget(auth(), acct, { externalId: "804002", raw: { budgetId: "77" } }, 10)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(await hits()).toHaveLength(0);
  });

  it("maps an update fault", async () => {
    server.use(http.put(`${MS_CAMPAIGN}/Campaigns`, () => msAdApiFault(400, 1100, "CampaignServiceInvalidCampaignId", "Invalid campaign id")));
    await expect(ms().setCampaignStatus(auth(), acct, { externalId: "1" }, "PAUSED")).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Invalid campaign id" });
  });
});

describe("Microsoft builder options and targeting", () => {
  it("lists conversion goals, and falls back to none on error", async () => {
    server.use(msPost(MS_CAMPAIGN, "/ConversionGoals/QueryByIds", { ConversionGoals: [{ Id: "4400", Name: "Purchase", Type: "Event" }] }));
    expect(await ms().getBuilderOptions(auth(), acct)).toEqual({ conversionActions: [{ id: "4400", name: "Purchase", detail: "Event" }] });
    expect((await onlyHit({ path: "/ConversionGoals/QueryByIds" })).json).toMatchObject({ AccountId: 149123456 });
  });

  it("searches the locations file, countries first, and only for locations", async () => {
    server.use(...msGeo());
    const res = await ms().searchTargeting(auth(), acct, "location", "india");
    expect(res[0]).toEqual({ id: "190", name: "India", type: "country", detail: "Country" });
    expect(res.map((r) => r.id)).toEqual(["190", "191", "9999"]);
    expect(res.find((r) => r.id === "9999")!.name).toBe('India Gate, "Delhi"');
    expect(await ms().searchTargeting(auth(), acct, "interest", "india")).toEqual([]);
  });
});

describe("Microsoft createCampaign", () => {
  const searchDraft = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("MICROSOFT", { campaignType: "SEARCH" }, {
      ...over,
      campaign: { budget: 40, locations: [{ id: "191", name: "Delhi", type: "city" }], languages: ["en", "hi"], ...over.campaign },
      adGroup: { keywords: [{ text: "silk saree", matchType: "EXACT" }, { text: "banarasi saree", matchType: "PHRASE" }], ...over.adGroup },
      ad: {
        finalUrl: "https://shop.example.com/sarees",
        path1: "sale",
        headlines: [{ text: "Ashniva Silk Sarees", pin: "H1" }, "Free Shipping Today", "Shop the Festive Edit"],
        descriptions: ["Handwoven silk sarees, delivered free.", { text: "Order by Friday for Diwali.", pin: "D2" }],
        ...over.ad,
      },
    });
  const created = () => [
    msPost(MS_CAMPAIGN, "/Campaigns", { CampaignIds: ["804100"], PartialErrors: [] }),
    msPost(MS_CAMPAIGN, "/CampaignCriterions", { CampaignCriterionIds: ["1", "2"], NestedPartialErrors: [] }),
    msPost(MS_CAMPAIGN, "/AdGroups", { AdGroupIds: ["1300100"], PartialErrors: [] }),
    msPost(MS_CAMPAIGN, "/Keywords", { KeywordIds: ["1", "2"], PartialErrors: [] }),
    msPost(MS_CAMPAIGN, "/Ads", { AdIds: ["8100100"], PartialErrors: [] }),
    http.delete(`${MS_CAMPAIGN}/Campaigns`, () => HttpResponse.json({ PartialErrors: [] })),
  ];

  it("creates a paused Search campaign → criteria → ad group → keywords → RSA", async () => {
    server.use(...created());
    const d = searchDraft();
    expect(d.campaign.launchStatus).toBe("PAUSED");
    const s = await ms().createCampaign(auth(), acct, d, new Map());

    const camp = (await onlyHit({ path: "/v13/Campaigns", method: "POST" })).json;
    expect(camp.AccountId).toBe(149123456);
    expect(camp.Campaigns[0]).toMatchObject({
      Name: "Festive Sale",
      CampaignType: "Search",
      BudgetType: "DailyBudgetStandard",
      DailyBudget: 40,
      Status: "Paused",
      TimeZone: "ChennaiKolkataMumbaiNewDelhi",
      Languages: ["English", "Hindi"],
      BiddingScheme: { Type: "MaxConversionsBiddingScheme" },
    });

    const crit = (await onlyHit({ path: "/CampaignCriterions" })).json;
    expect(crit.CriterionType).toBe("Targets");
    expect(crit.CampaignCriterions).toContainEqual({ Type: "BiddableCampaignCriterion", CampaignId: 804100, Criterion: { Type: "LocationCriterion", LocationId: 191 } });
    expect(crit.CampaignCriterions).toContainEqual({ Type: "BiddableCampaignCriterion", CampaignId: 804100, Criterion: { Type: "LocationIntentCriterion", IntentOption: "PeopleInOrSearchingForOrViewingPages" } });
    // All three devices are selected by default, so no device is bid down.
    expect(crit.CampaignCriterions.some((c: { Criterion: { Type: string } }) => c.Criterion.Type === "DeviceCriterion")).toBe(false);

    expect((await onlyHit({ path: "/AdGroups" })).json).toMatchObject({ CampaignId: 804100, AdGroups: [{ Name: "Ad group 1", Status: "Active", Network: "OwnedAndOperatedAndSyndicatedSearch", AdRotation: { Type: "OptimizeForClicks" } }] });
    expect((await onlyHit({ path: "/Keywords" })).json).toEqual({
      AdGroupId: 1300100,
      Keywords: [
        { Text: "silk saree", MatchType: "Exact", Status: "Active" },
        { Text: "banarasi saree", MatchType: "Phrase", Status: "Active" },
      ],
    });
    const ad = (await onlyHit({ path: "/v13/Ads" })).json;
    expect(ad.AdGroupId).toBe(1300100);
    expect(ad.Ads[0]).toMatchObject({ Type: "ResponsiveSearch", FinalUrls: ["https://shop.example.com/sarees"], Path1: "sale", Status: "Active" });
    expect(ad.Ads[0].Headlines[0]).toEqual({ Asset: { Type: "TextAsset", Text: "Ashniva Silk Sarees" }, PinnedField: "Headline1" });
    expect(ad.Ads[0].Headlines[1]).toEqual({ Asset: { Type: "TextAsset", Text: "Free Shipping Today" } });
    expect(ad.Ads[0].Descriptions[1].PinnedField).toBe("Description2");

    expect(s.campaigns[0]).toMatchObject({ externalId: "804100", status: "PAUSED", dailyBudget: 40, objective: "Search" });
    expect(s.adGroups[0]).toMatchObject({ externalId: "1300100", campaignExternalId: "804100", sourceKey: d.adGroups[0]!.key });
    expect(s.ads[0]).toMatchObject({ adGroupExternalId: "1300100", headline: "Ashniva Silk Sarees", sourceKey: d.adGroups[0]!.ads[0]!.key });
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
  });

  // fetchStructure and fetchMetrics key Microsoft ads as "<adGroupId>~<adId>" (index.ts:224, :293).
  it("BUG: created ads use the same '<adGroupId>~<adId>' id as structure sync (src/microsoft/builder.ts:279 returns the bare ad id)", async () => {
    server.use(...created());
    const s = await ms().createCampaign(auth(), acct, searchDraft(), new Map());
    expect(s.ads[0]!.externalId).toBe("1300100~8100100");
  });

  it("sends Active only when the draft launches ACTIVE, and excludes unselected devices", async () => {
    server.use(...created());
    await ms().createCampaign(auth(), acct, searchDraft({ campaign: { launchStatus: "ACTIVE", devices: ["Computers"], bidStrategy: "MaxClicks", maxCpc: 1.25 } }), new Map());
    const camp = (await onlyHit({ path: "/v13/Campaigns", method: "POST" })).json.Campaigns[0];
    expect(camp.Status).toBe("Active");
    expect(camp.BiddingScheme).toEqual({ Type: "MaxClicksBiddingScheme", MaxCpc: { Amount: 1.25 } });
    const devices = (await onlyHit({ path: "/CampaignCriterions" })).json.CampaignCriterions.filter((c: { Criterion: { Type: string } }) => c.Criterion.Type === "DeviceCriterion");
    expect(devices.map((c: { Criterion: { DeviceName: string }; CriterionBid: unknown }) => [c.Criterion.DeviceName, c.CriterionBid])).toEqual([
      ["Smartphones", { Type: "BidMultiplier", Multiplier: -100 }],
      ["Tablets", { Type: "BidMultiplier", Multiplier: -100 }],
    ]);
  });

  it("resolves country codes through the locations file", async () => {
    server.use(...created(), ...msGeo());
    await ms().createCampaign(auth(), acct, searchDraft({ campaign: { locations: [{ id: "IN", name: "India", type: "country" }, { id: "US", name: "United States", type: "country", exclude: true }] } }), new Map());
    const crit = (await onlyHit({ path: "/CampaignCriterions" })).json.CampaignCriterions;
    expect(crit).toContainEqual({ Type: "BiddableCampaignCriterion", CampaignId: 804100, Criterion: { Type: "LocationCriterion", LocationId: 190 } });
    expect(crit).toContainEqual({ Type: "NegativeCampaignCriterion", CampaignId: 804100, Criterion: { Type: "LocationCriterion", LocationId: 244 } });
  });

  it("requires a budget before any call", async () => {
    const d = searchDraft();
    d.campaign.budget = 0;
    await expect(ms().createCampaign(auth(), acct, d, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("throws on campaign PartialErrors without rolling back (nothing was created)", async () => {
    server.use(msPost(MS_CAMPAIGN, "/Campaigns", { CampaignIds: [null], PartialErrors: [{ Code: 1115, ErrorCode: "CampaignServiceInvalidTimeZone", Index: 0, Message: "The time zone is not valid." }] }));
    await expect(ms().createCampaign(auth(), acct, searchDraft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("The time zone is not valid.") });
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
  });

  it("deletes the campaign when an ad group fails after the campaign was created", async () => {
    server.use(...created());
    server.use(msPost(MS_CAMPAIGN, "/AdGroups", { AdGroupIds: [null], PartialErrors: [{ Code: 1201, ErrorCode: "CampaignServiceInvalidAdGroupName", Index: 0, Message: "Bad name" }] }));
    await expect(ms().createCampaign(auth(), acct, searchDraft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Bad name") });
    const del = await onlyHit({ method: "DELETE" });
    expect(del.url.pathname).toBe("/CampaignManagement/v13/Campaigns");
    expect(del.json).toEqual({ AccountId: 149123456, CampaignIds: [804100] });
  });

  it("deletes the campaign when the ad call faults with HTTP 500", async () => {
    server.use(...created());
    server.use(http.post(`${MS_CAMPAIGN}/Ads`, () => msAdApiFault(500, 0, "InternalError", "An internal error has occurred.")));
    await expect(ms().createCampaign(auth(), acct, searchDraft(), new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits({ method: "DELETE" })).toHaveLength(1);
  });

  it("keeps the campaign and warns when only negative keywords or extensions fail", async () => {
    server.use(...created());
    server.use(
      msPost(MS_CAMPAIGN, "/EntityNegativeKeywords", { NestedPartialErrors: [{ Code: 4000, Message: "Negative conflicts" }] }),
      http.post(`${MS_CAMPAIGN}/AdExtensions`, () => msAdApiFault(400, 3000, "AdExtensionsInvalid", "Bad callout")),
    );
    const d = searchDraft({ adGroup: { negativeKeywords: [{ text: "free", matchType: "BROAD" }] }, ad: { callouts: ["Free returns"] } });
    const s = await ms().createCampaign(auth(), acct, d, new Map());
    expect(s.warnings).toHaveLength(2);
    expect((await onlyHit({ path: "/EntityNegativeKeywords" })).json.EntityNegativeKeywords[0].NegativeKeywords).toEqual([{ Text: "free", MatchType: "Phrase" }]);
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
  });

  it("creates a Performance Max asset group with uploaded images", async () => {
    server.use(
      msPost(MS_CAMPAIGN, "/Campaigns", { CampaignIds: ["804200"], PartialErrors: [] }),
      msPost(MS_CAMPAIGN, "/CampaignCriterions", { NestedPartialErrors: [] }),
      http.post(`${MS_CAMPAIGN}/Media`, () => HttpResponse.json({ MediaIds: [Math.floor(Math.random() * 1e6) + 1], PartialErrors: [] })),
      msPost(MS_CAMPAIGN, "/AssetGroups", { AssetGroupIds: ["5500"], PartialErrors: [] }),
    );
    const uploaded: string[] = [];
    const img = (id: string) => imageAsset(id, { onUploaded: async (ref) => void uploaded.push(ref) });
    const d = makeDraft("MICROSOFT", { campaignType: "PERFORMANCE_MAX" }, {
      campaign: { budget: 75, locations: [{ id: "191", name: "Delhi", type: "city" }] },
      adGroup: {
        finalUrl: "https://shop.example.com",
        businessName: "Ashniva",
        headlines: ["One", "Two", "Three"],
        longHeadlines: ["A long headline"],
        descriptions: ["Desc one", "Desc two"],
        landscapeImages: ["l1"],
        squareImages: ["s1"],
        logos: ["logo"],
        cta: "SHOP_NOW",
      },
    });
    const s = await ms().createCampaign(auth(), acct, d, assetsOf(img("l1"), img("s1"), img("logo")));
    const camp = (await onlyHit({ path: "/v13/Campaigns", method: "POST" })).json.Campaigns[0];
    expect(camp).toMatchObject({ CampaignType: "PerformanceMax", Status: "Paused", Settings: [{ Type: "PerformanceMaxSetting", FinalUrlExpansionOptOut: false }] });
    const media = await hits({ path: "/v13/Media" });
    expect(media).toHaveLength(3);
    expect(media[0]!.json.Media[0]).toMatchObject({ Type: "Image", MediaType: "Image", Data: Buffer.from("fake-jpeg-bytes").toString("base64") });
    const ag = (await onlyHit({ path: "/AssetGroups" })).json.AssetGroups[0];
    expect(ag.Images.map((i: { Asset: { SubType: string } }) => i.Asset.SubType)).toEqual(["LandscapeImageMedia", "SquareImageMedia", "SquareLogoMedia"]);
    expect(ag.CallToAction).toBe("ShopNow");
    expect(uploaded).toHaveLength(3);
    expect(uploaded.every((r) => r.startsWith("media:"))).toBe(true);
    expect(s.adGroups[0]).toMatchObject({ externalId: "5500", raw: { kind: "assetGroup" } });
  });
});
