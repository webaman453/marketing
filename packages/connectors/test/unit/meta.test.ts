/**
 * Meta connector: OAuth, error mapping, account/structure sync, insights,
 * campaign actions, ad media and Instant Form leads (src/meta/index.ts, media.ts, leads.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaConnector, mapMetaStatus } from "../../src/meta";
import { ConnectorError } from "../../src/errors";
import { hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE } from "../msw/fixtures";
import { GRAPH, META_VERSION, insightRow, metaAccount, metaConfig, metaEdge, metaError, metaTokenHandlers } from "../msw/handlers/meta";

useMswServer();

const meta = () => new MetaConnector(metaConfig);
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as ConnectorError);

afterEach(() => {
  vi.useRealTimers();
});

describe("Meta OAuth", () => {
  it("builds the Facebook login dialog URL with app id, redirect, state and the ads scopes", () => {
    const url = new URL(meta().getAuthUrl({ state: STATE, redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe(`https://www.facebook.com/${META_VERSION}/dialog/oauth`);
    const q = queryOf(url.toString());
    expect(q.client_id).toBe("app-123");
    expect(q.redirect_uri).toBe(REDIRECT);
    expect(q.state).toBe(STATE);
    expect(q.response_type).toBe("code");
    expect(q.scope!.split(",")).toEqual(expect.arrayContaining(["ads_management", "ads_read", "business_management"]));
    // Meta's manual login flow has no PKCE; the app secret stays server side.
    expect(q.code_challenge).toBeUndefined();
    expect(url.toString()).not.toContain("app-secret");
  });

  it("is not configured without app id and secret", async () => {
    const c = new MetaConnector({ apiVersion: META_VERSION, appId: "x" });
    expect(c.isConfigured()).toBe(false);
    expect(meta().isConfigured()).toBe(true);
    expect(() => c.getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect((await errorOf(c.exchangeCode({ code: "c", redirectUri: REDIRECT })))?.code).toBe("NOT_CONFIGURED");
  });

  it("exchanges the code, then swaps the short-lived token for a long-lived one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...metaTokenHandlers());
    const tokens = await meta().exchangeCode({ code: "the-code", redirectUri: REDIRECT });

    const calls = await hits({ path: "/oauth/access_token" });
    expect(calls).toHaveLength(2);
    const first = Object.fromEntries(calls[0]!.url.searchParams);
    expect(first).toEqual({ client_id: "app-123", client_secret: "app-secret", redirect_uri: REDIRECT, code: "the-code" });
    const second = Object.fromEntries(calls[1]!.url.searchParams);
    expect(second).toEqual({ grant_type: "fb_exchange_token", client_id: "app-123", client_secret: "app-secret", fb_exchange_token: "short-1" });

    expect(tokens.accessToken).toBe("long-short-1");
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 5_183_944_000).toISOString());
    expect(tokens.scopes).toContain("ads_management");
  });

  it("leaves expiresAt empty when the long-lived token has no expires_in", async () => {
    server.use(...metaTokenHandlers({ longExpiresIn: null }));
    const tokens = await meta().exchangeCode({ code: "c", redirectUri: REDIRECT });
    expect(tokens.expiresAt).toBeUndefined();
  });

  it("maps a rejected code to INVALID_REQUEST with Meta's message", async () => {
    server.use(...metaTokenHandlers());
    const err = await errorOf(meta().exchangeCode({ code: "bad-code", redirectUri: REDIRECT }));
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(err?.message).toBe("Invalid verification code format.");
    expect(await hits({ path: "/oauth/access_token" })).toHaveLength(1);
  });

  it("cannot refresh: Meta user tokens need the user to reconnect", async () => {
    expect(await meta().refreshTokens()).toBeNull();
    expect(await hits()).toHaveLength(0);
  });

  it("revokes the grant with DELETE /me/permissions", async () => {
    server.use(http.delete(`${GRAPH}/me/permissions`, () => HttpResponse.json({ success: true })));
    await meta().revokeAccess("tok-9");
    const h = await onlyHit({ method: "DELETE", path: "/me/permissions" });
    expect(h.url.searchParams.get("access_token")).toBe("tok-9");
  });

  it("reads the user with GET /me?fields=id,name", async () => {
    server.use(http.get(`${GRAPH}/me`, () => HttpResponse.json({ id: "10157", name: "Asha Rao" })));
    expect(await meta().getUser(auth("tok"))).toEqual({ id: "10157", name: "Asha Rao" });
    const h = await onlyHit({ path: "/me" });
    expect(h.url.searchParams.get("fields")).toBe("id,name");
    expect(h.url.searchParams.get("access_token")).toBe("tok");
  });
});

describe("Meta error mapping", () => {
  // https://developers.facebook.com/docs/graph-api/guides/error-handling/#errorcodes
  const cases: [string, number, number | null, string][] = [
    ["expired token (190) on a 400", 400, 190, "AUTH_EXPIRED"],
    ["expired token (190) on a 401", 401, 190, "AUTH_EXPIRED"],
    ["plain 401", 401, null, "AUTH_EXPIRED"],
    ["app rate limit (4)", 400, 4, "RATE_LIMITED"],
    ["user rate limit (17)", 400, 17, "RATE_LIMITED"],
    ["page rate limit (32)", 400, 32, "RATE_LIMITED"],
    ["custom rate limit (613)", 400, 613, "RATE_LIMITED"],
    ["ads insights throttling (80004)", 400, 80004, "RATE_LIMITED"],
    ["HTTP 429", 429, null, "RATE_LIMITED"],
    ["permission (10)", 403, 10, "PERMISSION_DENIED"],
    ["permission (200) on a 400", 400, 200, "PERMISSION_DENIED"],
    ["permission (294)", 400, 294, "PERMISSION_DENIED"],
    ["invalid parameter (100)", 400, 100, "INVALID_REQUEST"],
    ["unknown error (1) on a 500", 500, 1, "PLATFORM_ERROR"],
    ["service unavailable (2) on a 503", 503, 2, "PLATFORM_ERROR"],
  ];

  it.each(cases)("%s → %s", async (_label, status, code, expected) => {
    server.use(http.get(`${GRAPH}/me`, () => (code === null ? HttpResponse.json({}, { status }) : metaError(status, code, `msg ${code}`))));
    const err = await errorOf(meta().getUser(auth()));
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err?.code).toBe(expected);
    expect(err?.message).toBe(code === null ? `Meta API error (${status})` : `msg ${code}`);
  });

  it("keeps the Graph error body as details", async () => {
    server.use(http.get(`${GRAPH}/me`, () => metaError(400, 190, "Session has expired", 463)));
    const err = await errorOf(meta().getUser(auth()));
    expect((err?.details as { error: { error_subcode: number } }).error.error_subcode).toBe(463);
  });
});

describe("Meta listAdAccounts", () => {
  it("follows paging.next to the last page and maps account status, timezone and business", async () => {
    server.use(
      metaEdge("get", "/me/adaccounts", [
        [metaAccount("111", { business: { id: "biz-1", name: "Zari Studio" } }), metaAccount("112", { account_status: 2 })],
        [metaAccount("113", { account_status: 9, currency: "INR", timezone_name: "Asia/Kolkata" })],
        [metaAccount("114", { account_status: 999, timezone_name: undefined })],
      ]),
    );
    const list = await meta().listAdAccounts(auth("tok"));
    expect(list.map((a) => a.externalId)).toEqual(["111", "112", "113", "114"]);
    expect(list[0]).toEqual({ externalId: "111", name: "Account 111", currency: "USD", timezone: "America/Los_Angeles", status: "ACTIVE", meta: { businessId: "biz-1", businessName: "Zari Studio" } });
    expect(list[1]!.status).toBe("DISABLED");
    expect(list[1]!.meta).toBeUndefined();
    expect(list[2]).toMatchObject({ currency: "INR", timezone: "Asia/Kolkata", status: "IN_GRACE_PERIOD" });
    expect(list[3]).toMatchObject({ status: "999", timezone: null });

    const calls = await hits({ path: "/me/adaccounts" });
    expect(calls).toHaveLength(3);
    const first = calls[0]!.url.searchParams;
    expect(first.get("access_token")).toBe("tok");
    expect(first.get("limit")).toBe("200");
    expect(first.get("fields")).toContain("account_status");
    // Later pages use Meta's own `next` URL verbatim (it carries the token and cursor).
    expect(calls[1]!.url.searchParams.get("after")).toBe("cursor-1");
    expect(calls[2]!.url.searchParams.get("after")).toBe("cursor-2");
  });

  it("propagates an error on a later page instead of returning a partial list", async () => {
    server.use(metaEdge("get", "/me/adaccounts", [[metaAccount("1")], [metaAccount("2")]], (i) => (i === 1 ? metaError(400, 190, "expired") : undefined)));
    const err = await errorOf(meta().listAdAccounts(auth()));
    expect(err?.code).toBe("AUTH_EXPIRED");
  });

  it("propagates a first-page error (no silent empty list)", async () => {
    server.use(http.get(`${GRAPH}/me/adaccounts`, () => metaError(500, 2, "Service temporarily unavailable")));
    const err = await errorOf(meta().listAdAccounts(auth()));
    expect(err?.code).toBe("PLATFORM_ERROR");
    expect(err?.retryable).toBe(true);
  });

  it("BUG: paging is not capped — a cursor that never ends must fail like allPages (MAX_PAGES) instead of reading forever", async () => {
    // 150 pages, each linking to the next: http.ts allPages stops at 100 pages and throws.
    server.use(metaEdge("get", "/me/adaccounts", Array.from({ length: 150 }, (_, i) => [metaAccount(String(i))])));
    const err = await errorOf(meta().listAdAccounts(auth()));
    expect(err?.code).toBe("PLATFORM_ERROR");
  });
});

describe("Meta fetchStructure", () => {
  const campaigns = [
    [
      { id: "c1", name: "Diwali", status: "ACTIVE", effective_status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "2500", start_time: "2026-10-01T00:00:00+0530", stop_time: "2026-11-01T23:59:59+0530", updated_time: "2026-10-10T08:00:00+0000" },
      { id: "c2", name: "Brand", status: "PAUSED", effective_status: "CAMPAIGN_PAUSED", objective: "OUTCOME_AWARENESS", lifetime_budget: "100000" },
    ],
    [
      { id: "c3", status: "ARCHIVED" },
      { id: "c4", name: "Old", status: "DELETED" },
      { id: "c5", name: "Weird", status: "IN_PROCESS" },
    ],
  ];
  const adsets = [[{ id: "s1", name: "Women 25-44", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "1999", bid_strategy: "COST_CAP", optimization_goal: "OFFSITE_CONVERSIONS", targeting: { geo_locations: { countries: ["IN"] } } }], [{ id: "s2", campaign_id: "c2", status: "PAUSED" }]];
  const ads = [[{ id: "a1", name: "Saree carousel", adset_id: "s1", campaign_id: "c1", status: "ACTIVE", effective_status: "ACTIVE", creative: { title: "Silk sarees", body: "New drop", thumbnail_url: "https://scontent.example/t.jpg", object_url: "https://shop.example.com/o", link_url: "https://shop.example.com/l" } }], [{ id: "a2", adset_id: "s2", campaign_id: "c2", status: "PAUSED", creative: { object_url: "https://shop.example.com/o2" } }]];

  const serve = (over: { adsetsError?: Response } = {}) =>
    server.use(
      metaEdge("get", "/act_42/campaigns", campaigns),
      metaEdge("get", "/act_42/adsets", adsets, (i) => (i === 1 ? over.adsetsError : undefined)),
      metaEdge("get", "/act_42/ads", ads),
    );

  it("reads every page of campaigns, ad sets and ads and maps status, dates and links", async () => {
    serve();
    const s = await meta().fetchStructure(auth("tok"), account("42", { currency: "USD" }));
    expect(s.campaigns.map((c) => c.externalId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(s.campaigns.map((c) => c.status)).toEqual(["ACTIVE", "PAUSED", "ARCHIVED", "REMOVED", "PAUSED"]);
    expect(s.campaigns[0]).toMatchObject({ name: "Diwali", deliveryStatus: "ACTIVE", objective: "OUTCOME_SALES", startDate: "2026-10-01", endDate: "2026-11-01" });
    expect(s.campaigns[0]!.updatedAt?.toISOString()).toBe("2026-10-10T08:00:00.000Z");
    expect(s.campaigns[2]).toMatchObject({ name: "Untitled campaign", objective: null, dailyBudget: null, lifetimeBudget: null, startDate: null, updatedAt: null });

    expect(s.adGroups).toHaveLength(2);
    expect(s.adGroups[0]).toMatchObject({ externalId: "s1", campaignExternalId: "c1", status: "ACTIVE", bidStrategy: "COST_CAP", targeting: { geo_locations: { countries: ["IN"] } } });
    expect(s.adGroups[0]!.raw).toEqual({ optimization_goal: "OFFSITE_CONVERSIONS", effective_status: "ACTIVE" });
    expect(s.adGroups[1]).toMatchObject({ name: "Untitled ad set", dailyBudget: null, bidStrategy: null, targeting: null });

    expect(s.ads[0]).toMatchObject({ externalId: "a1", adGroupExternalId: "s1", campaignExternalId: "c1", headline: "Silk sarees", body: "New drop", thumbnailUrl: "https://scontent.example/t.jpg", finalUrl: "https://shop.example.com/l" });
    expect(s.ads[1]).toMatchObject({ name: "Untitled ad", headline: null, finalUrl: "https://shop.example.com/o2" });

    for (const edge of ["campaigns", "adsets", "ads"]) {
      const calls = await hits({ path: new RegExp(`/act_42/${edge}$`) });
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url.searchParams.get("limit")).toBe("500");
      expect(calls[0]!.url.searchParams.get("access_token")).toBe("tok");
    }
  });

  it("converts budgets from the currency's minor unit (cents) to currency units", async () => {
    serve();
    const s = await meta().fetchStructure(auth(), account("42", { currency: "USD" }));
    expect(s.campaigns[0]!.dailyBudget).toBe(25);
    expect(s.campaigns[1]!.lifetimeBudget).toBe(1000);
    expect(s.adGroups[0]!.dailyBudget).toBe(19.99);
  });

  it("does not divide zero-decimal currencies (JPY) by 100", async () => {
    serve();
    const s = await meta().fetchStructure(auth(), account("42", { currency: "JPY" }));
    expect(s.campaigns[0]!.dailyBudget).toBe(2500);
    expect(s.campaigns[1]!.lifetimeBudget).toBe(100000);
    expect(s.adGroups[0]!.dailyBudget).toBe(1999);
  });

  it("fails the whole sync when one edge fails on a later page", async () => {
    serve({ adsetsError: metaError(400, 17, "User request limit reached") });
    const err = await errorOf(meta().fetchStructure(auth(), account("42")));
    expect(err?.code).toBe("RATE_LIMITED");
  });

  it("mapMetaStatus treats unknown statuses as paused", () => {
    expect(mapMetaStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapMetaStatus("DELETED")).toBe("REMOVED");
    expect(mapMetaStatus(undefined)).toBe("PAUSED");
    expect(mapMetaStatus("WITH_ISSUES")).toBe("PAUSED");
  });
});

describe("Meta fetchMetrics", () => {
  const range = { from: "2026-10-01", to: "2026-10-02" };

  function serveInsights(rows: Record<string, unknown[][]>, error?: Response) {
    server.use(
      http.get(`${GRAPH}/act_42/insights`, ({ request }) => {
        if (error) return error.clone();
        const q = new URL(request.url).searchParams;
        const pages = rows[q.get("level")!] ?? [[]];
        const i = Number(q.get("after") ?? 0);
        const next = new URL(request.url);
        next.searchParams.set("after", String(i + 1));
        return HttpResponse.json({ data: pages[i] ?? [], paging: { cursors: {}, ...(i + 1 < pages.length ? { next: next.toString() } : {}) } });
      }),
    );
  }

  it("asks for daily rows at campaign, ad set and ad level for the exact date range", async () => {
    serveInsights({});
    await meta().fetchMetrics(auth("tok"), account("42", { timezone: "Asia/Kolkata" }), range);
    const calls = await hits({ path: "/act_42/insights" });
    expect(calls.map((c) => c.url.searchParams.get("level"))).toEqual(["campaign", "adset", "ad"]);
    for (const c of calls) {
      const q = c.url.searchParams;
      expect(q.get("time_increment")).toBe("1");
      // Meta reports in the ad account's own timezone, so the dates go through unchanged.
      expect(JSON.parse(q.get("time_range")!)).toEqual({ since: "2026-10-01", until: "2026-10-02" });
      expect(q.get("access_token")).toBe("tok");
    }
    expect(calls[0]!.url.searchParams.get("fields")).toMatch(/^campaign_id,date_start,/);
    expect(calls[1]!.url.searchParams.get("fields")).toMatch(/^adset_id,/);
    expect(calls[2]!.url.searchParams.get("fields")).toMatch(/^ad_id,/);
  });

  it("parses string numbers, keeps one row per day and follows paging", async () => {
    serveInsights({
      campaign: [
        [insightRow("campaign_id", "c1", "2026-10-01", { spend: "10.50", impressions: "1200", clicks: "30" })],
        [insightRow("campaign_id", "c1", "2026-10-02", { spend: "0", impressions: "0", clicks: "0" })],
      ],
      adset: [[insightRow("adset_id", "s1", "2026-10-01")]],
      ad: [[insightRow("ad_id", "a1", "2026-10-02", { impressions: undefined, clicks: undefined, spend: undefined })]],
    });
    const rows = await meta().fetchMetrics(auth(), account("42"), range);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ date: "2026-10-01", level: "CAMPAIGN", externalId: "c1", impressions: 1200, clicks: 30, spend: 10.5, conversions: 0, conversionValue: 0, videoViews: 0 });
    expect(rows[1]).toMatchObject({ date: "2026-10-02", level: "CAMPAIGN", spend: 0 });
    expect(rows[2]).toMatchObject({ level: "AD_GROUP", externalId: "s1", spend: 12.34 });
    expect(rows[3]).toMatchObject({ level: "AD", externalId: "a1", impressions: 0, clicks: 0, spend: 0 });
  });

  it("counts a purchase once across its duplicate action types, adds leads, and reads value and video views", async () => {
    serveInsights({
      campaign: [
        [
          insightRow("campaign_id", "c1", "2026-10-01", {
            actions: [
              { action_type: "purchase", value: "4" },
              { action_type: "omni_purchase", value: "5" },
              { action_type: "offsite_conversion.fb_pixel_purchase", value: "4" },
              { action_type: "lead", value: "2" },
              { action_type: "onsite_conversion.lead_grouped", value: "2" },
              { action_type: "video_view", value: "300" },
              { action_type: "link_click", value: "25" },
            ],
            action_values: [
              { action_type: "purchase", value: "400.00" },
              { action_type: "omni_purchase", value: "512.75" },
            ],
          }),
        ],
      ],
    });
    const [row] = await meta().fetchMetrics(auth(), account("42"), range);
    expect(row).toMatchObject({ conversions: 7, conversionValue: 512.75, videoViews: 300 });
  });

  it("treats a non-numeric action value as 0", async () => {
    serveInsights({ campaign: [[insightRow("campaign_id", "c1", "2026-10-01", { actions: [{ action_type: "omni_purchase", value: "n/a" }] })]] });
    const [row] = await meta().fetchMetrics(auth(), account("42"), range);
    expect(row!.conversions).toBe(0);
  });

  it("propagates an expired token instead of returning no rows", async () => {
    serveInsights({}, metaError(400, 190, "Error validating access token: Session has expired"));
    const err = await errorOf(meta().fetchMetrics(auth(), account("42"), range));
    expect(err?.code).toBe("AUTH_EXPIRED");
  });

  it("propagates insights throttling (80004) as RATE_LIMITED", async () => {
    serveInsights({}, metaError(400, 80004, "There have been too many calls to this ad-account."));
    expect((await errorOf(meta().fetchMetrics(auth(), account("42"), range)))?.code).toBe("RATE_LIMITED");
  });
});

describe("Meta campaign actions", () => {
  const postCampaign = () => server.use(http.post(`${GRAPH}/:id`, () => HttpResponse.json({ success: true })));

  it("pauses a campaign with POST /{id} status=PAUSED (form encoded)", async () => {
    postCampaign();
    await meta().setCampaignStatus(auth("tok"), account("42"), { externalId: "c1" }, "PAUSED");
    const h = await onlyHit({ method: "POST", path: "/c1" });
    expect(h.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(h.form!)).toEqual({ status: "PAUSED", access_token: "tok" });
  });

  it("activates a campaign", async () => {
    postCampaign();
    await meta().setCampaignStatus(auth("tok"), account("42"), { externalId: "c1" }, "ACTIVE");
    expect((await onlyHit({ method: "POST" })).form!.get("status")).toBe("ACTIVE");
  });

  it.each([
    ["USD", 12.34, "1234"],
    ["USD", 19.99, "1999"],
    ["INR", 500, "50000"],
    ["JPY", 1500, "1500"],
    ["JPY", 1500.4, "1500"],
  ])("sets the daily budget in %s minor units: %d → %s", async (currency, amount, minor) => {
    postCampaign();
    await meta().setCampaignDailyBudget(auth("tok"), account("42", { currency }), { externalId: "c1", raw: { daily_budget: "100" } }, amount);
    const h = await onlyHit({ method: "POST", path: "/c1" });
    expect(Object.fromEntries(h.form!)).toEqual({ daily_budget: minor, access_token: "tok" });
  });

  it("refuses a campaign-level budget change when the budget lives on the ad sets", async () => {
    const err = await errorOf(meta().setCampaignDailyBudget(auth(), account("42"), { externalId: "c1", raw: { lifetime_budget: "100" } }, 10));
    expect(err?.code).toBe("UNSUPPORTED");
    expect(await hits()).toHaveLength(0);
  });

  it("propagates a permission error from the budget update", async () => {
    server.use(http.post(`${GRAPH}/c1`, () => metaError(403, 200, "Requires ads_management permission")));
    const err = await errorOf(meta().setCampaignDailyBudget(auth(), account("42"), { externalId: "c1", raw: null }, 10));
    expect(err?.code).toBe("PERMISSION_DENIED");
  });
});

describe("Meta fetchAdMedia", () => {
  // Ad creative fields: https://developers.facebook.com/docs/marketing-api/reference/ad-creative/
  const serveAd = (creative: Record<string, unknown>) => server.use(http.get(`${GRAPH}/ad-1`, () => HttpResponse.json({ id: "ad-1", creative: { id: "cr-1", ...creative } })));

  it("resolves a single image to the full-size library URL by hash", async () => {
    serveAd({ title: "Silk sarees", body: "New drop", call_to_action_type: "SHOP_NOW", object_story_spec: { page_id: "p1", link_data: { link: "https://shop.example.com", image_hash: "h1", picture: "https://scontent.example/thumb.jpg", name: "Card name" } } });
    // https://developers.facebook.com/docs/marketing-api/reference/ad-account/adimages/ (GET with hashes)
    server.use(http.get(`${GRAPH}/act_42/adimages`, () => HttpResponse.json({ data: [{ hash: "h1", url: "https://scontent.example/full.jpg" }] })));
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m).toMatchObject({ format: "IMAGE", headline: "Silk sarees", body: "New drop", callToAction: "SHOP_NOW", link: "https://shop.example.com" });
    expect(m.items).toEqual([{ type: "IMAGE", url: "https://scontent.example/full.jpg", posterUrl: "https://scontent.example/thumb.jpg", title: "Card name", description: null, link: "https://shop.example.com", durationSec: null, permalink: null }]);
    expect(JSON.parse((await onlyHit({ path: "/adimages" })).url.searchParams.get("hashes")!)).toEqual(["h1"]);
  });

  it("falls back to the creative picture when the image library call fails", async () => {
    serveAd({ object_story_spec: { link_data: { image_hash: "h1", picture: "https://scontent.example/thumb.jpg" } } });
    server.use(http.get(`${GRAPH}/act_42/adimages`, () => metaError(403, 10)));
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m.items[0]!.url).toBe("https://scontent.example/thumb.jpg");
  });

  it("resolves a video to its source, poster, rounded length and permalink", async () => {
    serveAd({ object_story_spec: { video_data: { video_id: "v1", image_url: "https://scontent.example/poster.jpg", title: "Watch", message: "Body", call_to_action: { type: "LEARN_MORE", value: { link: "https://shop.example.com/v" } } } } });
    // https://developers.facebook.com/docs/graph-api/reference/video/
    server.use(http.get(`${GRAPH}/v1`, () => HttpResponse.json({ id: "v1", source: "https://video.example/v1.mp4", picture: "https://scontent.example/pic.jpg", length: 14.6, permalink_url: "/zari/videos/v1/" })));
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m).toMatchObject({ format: "VIDEO", headline: "Watch", body: "Body", callToAction: "LEARN_MORE", link: "https://shop.example.com/v" });
    expect(m.items[0]).toEqual({ type: "VIDEO", url: "https://video.example/v1.mp4", posterUrl: "https://scontent.example/pic.jpg", title: "Watch", description: null, link: "https://shop.example.com/v", durationSec: 15, permalink: "https://www.facebook.com/zari/videos/v1/" });
  });

  it("keeps the poster when the video cannot be read", async () => {
    serveAd({ object_story_spec: { video_data: { video_id: "v1", image_url: "https://scontent.example/poster.jpg" } } });
    server.use(http.get(`${GRAPH}/v1`, () => metaError(400, 10)));
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m.items[0]).toMatchObject({ type: "VIDEO", url: null, posterUrl: "https://scontent.example/poster.jpg", permalink: null });
  });

  it("returns every carousel card", async () => {
    serveAd({ object_story_spec: { link_data: { link: "https://shop.example.com", child_attachments: [{ picture: "https://x/1.jpg", name: "One", link: "https://shop.example.com/1" }, { picture: "https://x/2.jpg", name: "Two", description: "d", link: "https://shop.example.com/2" }] } } });
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m.format).toBe("CAROUSEL");
    expect(m.items.map((i) => [i.title, i.url, i.link])).toEqual([["One", "https://x/1.jpg", "https://shop.example.com/1"], ["Two", "https://x/2.jpg", "https://shop.example.com/2"]]);
  });

  it("reports UNKNOWN for a creative without media", async () => {
    serveAd({});
    const m = await meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" });
    expect(m).toMatchObject({ format: "UNKNOWN", items: [], headline: null });
  });

  it("propagates an expired token on the ad read", async () => {
    server.use(http.get(`${GRAPH}/ad-1`, () => metaError(400, 190)));
    expect((await errorOf(meta().fetchAdMedia(auth(), account("42"), { externalId: "ad-1" })))?.code).toBe("AUTH_EXPIRED");
  });
});

describe("Meta fetchLeads", () => {
  // Permissions: https://developers.facebook.com/docs/graph-api/reference/user/permissions/
  const perms = (list: [string, string][]) => http.get(`${GRAPH}/me/permissions`, () => HttpResponse.json({ data: list.map(([permission, status]) => ({ permission, status })) }));
  // Pages + page tokens: https://developers.facebook.com/docs/graph-api/reference/user/accounts/
  const pages = (rows: Record<string, unknown>[]) => metaEdge("get", "/me/accounts", [rows]);
  // Lead retrieval: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/
  const lead = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    created_time: "2026-10-12T09:30:00+0000",
    ad_id: "a1",
    ad_name: "Ad 1",
    adset_id: "s1",
    adset_name: "Set 1",
    campaign_id: "c1",
    campaign_name: "Camp 1",
    form_id: "f1",
    platform: "ig",
    is_organic: false,
    field_data: [
      { name: "full_name", values: ["Asha Rao"] },
      { name: "email", values: ["asha@example.com"] },
    ],
    ...over,
  });

  it("throws PERMISSION_DENIED when leads_retrieval was not granted", async () => {
    server.use(perms([["ads_read", "granted"], ["leads_retrieval", "declined"]]));
    const err = await errorOf(meta().fetchLeads(auth("tok"), { since: null }));
    expect(err?.code).toBe("PERMISSION_DENIED");
    expect(await hits({ path: "/me/accounts" })).toHaveLength(0);
  });

  it("reads every form's leads with each Page's own token, filtered by time_created", async () => {
    server.use(
      perms([["leads_retrieval", "granted"]]),
      pages([
        { id: "p1", name: "Zari", access_token: "page-tok-1" },
        { id: "p2", name: "No token" },
      ]),
      metaEdge("get", "/p1/leadgen_forms", [[{ id: "f1", name: "Festive form", status: "ACTIVE" }]]),
      metaEdge("get", "/f1/leads", [[lead("L1")], [lead("L2", { is_organic: true, platform: "fb", ad_id: undefined, form_id: undefined })]]),
    );
    const since = new Date("2026-10-10T00:00:00Z");
    const leads = await meta().fetchLeads(auth("tok"), { since });
    expect(leads.map((l) => l.externalId)).toEqual(["L1", "L2"]);
    expect(leads[0]).toEqual({
      externalId: "L1",
      createdTime: new Date("2026-10-12T09:30:00Z"),
      source: "ig",
      isOrganic: false,
      pageId: "p1",
      formId: "f1",
      formName: "Festive form",
      externalAdId: "a1",
      externalAdGroupId: "s1",
      externalCampaignId: "c1",
      adName: "Ad 1",
      adGroupName: "Set 1",
      campaignName: "Camp 1",
      fields: { full_name: ["Asha Rao"], email: ["asha@example.com"] },
    });
    expect(leads[1]).toMatchObject({ isOrganic: true, source: "fb", externalAdId: null, formId: "f1" });

    const formCall = await onlyHit({ path: "/p1/leadgen_forms" });
    expect(formCall.url.searchParams.get("access_token")).toBe("page-tok-1");
    const leadCalls = await hits({ path: "/f1/leads" });
    expect(leadCalls).toHaveLength(2);
    expect(leadCalls[0]!.url.searchParams.get("access_token")).toBe("page-tok-1");
    expect(JSON.parse(leadCalls[0]!.url.searchParams.get("filtering")!)).toEqual([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(since.getTime() / 1000) }]);
    expect(await hits({ path: "/p2/" })).toHaveLength(0);
  });

  it("reads all leads without a filter when since is null", async () => {
    server.use(perms([["leads_retrieval", "granted"]]), pages([{ id: "p1", access_token: "pt" }]), metaEdge("get", "/p1/leadgen_forms", [[{ id: "f1" }]]), metaEdge("get", "/f1/leads", [[lead("L1")]]));
    await meta().fetchLeads(auth(), { since: null });
    expect((await onlyHit({ path: "/f1/leads" })).url.searchParams.has("filtering")).toBe(false);
  });

  it("skips a Page whose forms cannot be read and keeps the others", async () => {
    server.use(
      perms([["leads_retrieval", "granted"]]),
      pages([{ id: "p1", access_token: "pt1" }, { id: "p2", access_token: "pt2" }]),
      http.get(`${GRAPH}/p1/leadgen_forms`, () => metaError(403, 200, "Page admin required")),
      metaEdge("get", "/p2/leadgen_forms", [[{ id: "f2" }]]),
      metaEdge("get", "/f2/leads", [[lead("L9", { form_id: "f2" })]]),
    );
    const leads = await meta().fetchLeads(auth(), { since: null });
    expect(leads.map((l) => [l.externalId, l.pageId])).toEqual([["L9", "p2"]]);
  });

  it("propagates an expired login from the permissions check", async () => {
    server.use(http.get(`${GRAPH}/me/permissions`, () => metaError(400, 190)));
    expect((await errorOf(meta().fetchLeads(auth(), { since: null })))?.code).toBe("AUTH_EXPIRED");
  });

  it("BUG: a rate limit while reading a form's leads is swallowed, so those leads are silently skipped", async () => {
    server.use(
      perms([["leads_retrieval", "granted"]]),
      pages([{ id: "p1", access_token: "pt" }]),
      metaEdge("get", "/p1/leadgen_forms", [[{ id: "f1" }]]),
      http.get(`${GRAPH}/f1/leads`, () => metaError(400, 17, "User request limit reached")),
    );
    // errors.ts noRowsUnlessFatal: rate limits and outages must throw so the sync records them.
    const err = await errorOf(meta().fetchLeads(auth(), { since: null }));
    expect(err?.code).toBe("RATE_LIMITED");
  });
});
