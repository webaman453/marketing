import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapchatConnector, mapSnapStatus } from "../../src/snapchat";
import { ConnectorError } from "../../src/errors";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft, videoAsset } from "../msw/drafts";
import {
  SNAP_API,
  SNAP_CAMPAIGN,
  SNAP_TOKEN_URL,
  snapCreateHandlers,
  snapError,
  snapMe,
  snapOrganizations,
  snapPagedList,
  snapStatsBody,
  snapToken,
  snapWrap,
} from "../msw/handlers/snapchat";

useMswServer();

const snap = () => new SnapchatConnector({ clientId: "snap-client", clientSecret: "snap-secret" });
const acct = account("acc-1", { timezone: "UTC" });

describe("Snapchat OAuth", () => {
  it("getAuthUrl asks for the marketing scope with redirect and state", () => {
    const url = snap().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://accounts.snapchat.com/login/oauth2/authorize?")).toBe(true);
    expect(queryOf(url)).toEqual({ response_type: "code", client_id: "snap-client", redirect_uri: REDIRECT, scope: "snapchat-marketing-api", state: STATE });
  });

  it("getAuthUrl throws NOT_CONFIGURED without app credentials", () => {
    const c = new SnapchatConnector({ clientId: "x" });
    expect(c.isConfigured()).toBe(false);
    expect(() => c.getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  describe("token math", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it("exchangeCode posts the code form and computes expiresAt from expires_in", async () => {
      server.use(snapToken());
      const t = await snap().exchangeCode({ code: "auth-code", redirectUri: REDIRECT });
      expect(t).toEqual({ accessToken: "snap-access", refreshToken: "snap-refresh-2", expiresAt: new Date(NOW.getTime() + 1800_000), scopes: ["snapchat-marketing-api"] });
      const h = await onlyHit({ host: "accounts.snapchat.com" });
      expect(h.url.toString()).toBe(SNAP_TOKEN_URL);
      expect(Object.fromEntries(h.form!)).toEqual({ client_id: "snap-client", client_secret: "snap-secret", grant_type: "authorization_code", code: "auth-code", redirect_uri: REDIRECT });
    });

    it("refreshTokens sends the refresh grant; a missing refresh_token is left undefined for the caller to keep the old one", async () => {
      server.use(snapToken({ refresh_token: undefined, scope: undefined }));
      const t = await snap().refreshTokens("old-refresh");
      expect(t.accessToken).toBe("snap-access");
      // core/tokens.ts keeps the stored refresh token when the connector returns none.
      expect(t.refreshToken).toBeUndefined();
      expect(t.scopes).toEqual(["snapchat-marketing-api"]);
      const h = await onlyHit({ host: "accounts.snapchat.com" });
      expect(h.form?.get("grant_type")).toBe("refresh_token");
      expect(h.form?.get("refresh_token")).toBe("old-refresh");
      expect(h.text).not.toMatch(/undefined/);
    });
  });

  it("maps a token error (invalid_grant) to INVALID_REQUEST with the description", async () => {
    server.use(http.post(SNAP_TOKEN_URL, () => fail(400, { error: "invalid_grant", error_description: "Invalid authorization code" })));
    await expect(snap().exchangeCode({ code: "bad", redirectUri: REDIRECT })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Invalid authorization code" });
  });

  it("getUser reads /me with the bearer token", async () => {
    server.use(snapMe());
    expect(await snap().getUser(auth("tok"))).toEqual({ id: "user-1", name: "Asha Rao" });
    expect((await onlyHit({ path: "/v1/me" })).headers.get("authorization")).toBe("Bearer tok");
  });

  it("getUser falls back to the email when there's no display name", async () => {
    server.use(http.get(`${SNAP_API}/me`, () => HttpResponse.json({ request_status: "SUCCESS", me: { id: 42, email: "a@b.c" } })));
    expect(await snap().getUser(auth())).toEqual({ id: "42", name: "a@b.c" });
  });
});

describe("Snapchat error mapping", () => {
  it.each(STATUS_CODES)("HTTP %i → %s with Snap's display_message", async (status, code) => {
    server.use(http.get(`${SNAP_API}/me/organizations`, () => fail(status, snapError(`boom ${status}`))));
    const err = await snap().listAdAccounts(auth()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`boom ${status}`);
  });

  it("falls back to a generic message for an empty error body", async () => {
    server.use(http.get(`${SNAP_API}/me`, () => new HttpResponse(null, { status: 502 })));
    await expect(snap().getUser(auth())).rejects.toMatchObject({ code: "PLATFORM_ERROR", message: "Snapchat API error (502)" });
  });
});

describe("Snapchat accounts and structure", () => {
  it("listAdAccounts flattens every organization's ad accounts with org meta", async () => {
    server.use(snapOrganizations());
    const list = await snap().listAdAccounts(auth());
    expect(list).toEqual([
      { externalId: "acc-1", name: "Main", currency: "USD", timezone: "America/Los_Angeles", status: "ACTIVE", meta: { organizationId: "org-1" } },
      { externalId: "acc-2", name: "India", currency: "INR", timezone: "Asia/Kolkata", status: "PAUSED", meta: { organizationId: "org-1" } },
    ]);
    expect((await onlyHit({ path: "/me/organizations" })).url.searchParams.get("with_ad_accounts")).toBe("true");
  });

  it("fetchStructure follows paging.next_link to the last page and converts micro-currency", async () => {
    server.use(
      snapPagedList("/adaccounts/acc-1/campaigns", "campaigns", "campaign", [
        [SNAP_CAMPAIGN],
        [{ id: "camp-2", name: "Old", status: "PAUSED", objective: "WEB_CONVERSION", start_time: "2026-01-01T08:00:00.000Z" }],
        [{ id: "camp-3", name: "Gone", status: "DELETED" }],
      ]),
      snapPagedList("/adaccounts/acc-1/adsquads", "adsquads", "adsquad", [
        [{ id: "sq-1", campaign_id: "camp-1", name: "Squad", status: "ACTIVE", daily_budget_micro: 10_000_000, bid_strategy: "AUTO_BID" }],
        [{ id: "sq-2", campaign_id: "camp-2", name: "Squad 2", status: "PAUSED" }],
      ]),
      snapPagedList("/adaccounts/acc-1/ads", "ads", "ad", [
        [{ id: "ad-1", ad_squad_id: "sq-1", name: "Ad", status: "ACTIVE", creative_id: "cr-1" }],
        [{ id: "ad-orphan", ad_squad_id: "sq-unknown", name: "Orphan", status: "ACTIVE" }],
      ]),
    );
    const s = await snap().fetchStructure(auth(), acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status])).toEqual([
      ["camp-1", "ACTIVE"],
      ["camp-2", "PAUSED"],
      ["camp-3", "REMOVED"],
    ]);
    expect(s.campaigns[0]).toMatchObject({
      dailyBudget: 25.5,
      lifetimeBudget: 1000,
      deliveryStatus: "VALID",
      objective: "BRAND_AWARENESS",
      startDate: "2026-10-01",
      endDate: "2026-11-15",
      updatedAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(s.campaigns[1]).toMatchObject({ dailyBudget: null, lifetimeBudget: null, endDate: null, updatedAt: null, deliveryStatus: null });
    expect(s.adGroups).toEqual([
      expect.objectContaining({ externalId: "sq-1", campaignExternalId: "camp-1", dailyBudget: 10, bidStrategy: "AUTO_BID", status: "ACTIVE" }),
      expect.objectContaining({ externalId: "sq-2", campaignExternalId: "camp-2", dailyBudget: null, bidStrategy: null, status: "PAUSED" }),
    ]);
    // Ads whose squad isn't in the account are dropped.
    expect(s.ads).toEqual([expect.objectContaining({ externalId: "ad-1", adGroupExternalId: "sq-1", campaignExternalId: "camp-1", raw: { creative_id: "cr-1" } })]);
    const campaignCalls = await hits({ path: "/adaccounts/acc-1/campaigns" });
    expect(campaignCalls).toHaveLength(3);
    expect(campaignCalls[0]!.url.searchParams.get("limit")).toBe("1000");
  });

  it("propagates an error from a later page instead of returning a partial list", async () => {
    server.use(
      http.get(`${SNAP_API}/adaccounts/acc-1/campaigns`, ({ request }) =>
        new URL(request.url).searchParams.get("page") ? fail(500, snapError("Internal")) : HttpResponse.json(snapWrap("campaigns", "campaign", [SNAP_CAMPAIGN], { paging: { next_link: `${SNAP_API}/adaccounts/acc-1/campaigns?page=1` } })),
      ),
      snapPagedList("/adaccounts/acc-1/adsquads", "adsquads", "adsquad", [[]]),
      snapPagedList("/adaccounts/acc-1/ads", "ads", "ad", [[]]),
    );
    await expect(snap().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("propagates 401 from the structure lists as AUTH_EXPIRED", async () => {
    server.use(http.get(/adsapi\.snapchat\.com\/v1\/adaccounts\/acc-1\/.*/, () => fail(401, snapError("Token expired"))));
    await expect(snap().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("BUG: structure paging is capped like allPages (MAX_PAGES) instead of following next_link forever", async () => {
    let calls = 0;
    server.use(
      http.get(`${SNAP_API}/adaccounts/acc-1/campaigns`, () => {
        calls++;
        // Stop after 150 pages so the uncapped loop still ends; a capped one throws before that.
        const next = calls < 150 ? { paging: { next_link: `${SNAP_API}/adaccounts/acc-1/campaigns?cursor=${calls}` } } : {};
        return HttpResponse.json(snapWrap("campaigns", "campaign", [{ ...SNAP_CAMPAIGN, id: `c${calls}` }], next));
      }),
      snapPagedList("/adaccounts/acc-1/adsquads", "adsquads", "adsquad", [[]]),
      snapPagedList("/adaccounts/acc-1/ads", "ads", "ad", [[]]),
    );
    await expect(snap().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("mapSnapStatus", () => {
    expect(mapSnapStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapSnapStatus("PAUSED")).toBe("PAUSED");
    expect(mapSnapStatus("DELETED")).toBe("REMOVED");
    expect(mapSnapStatus(undefined)).toBe("PAUSED");
  });
});

describe("Snapchat metrics", () => {
  const statsHandler = () =>
    http.get(`${SNAP_API}/adaccounts/acc-1/stats`, ({ request }) => {
      const breakdown = new URL(request.url).searchParams.get("breakdown")!;
      const id = { campaign: "camp-1", adsquad: "sq-1", ad: "ad-1" }[breakdown]!;
      return HttpResponse.json(
        snapStatsBody(breakdown, [
          {
            id,
            days: [
              { start: "2026-10-01T00:00:00.000-07:00", stats: { impressions: 1000, swipes: 25, spend: 12_345_678, conversion_purchases: 3, conversion_purchases_value: 45_000_000, video_views: 400 } },
              // Numbers sometimes arrive as strings; missing stats count as zero.
              { start: "2026-10-02T00:00:00.000-07:00", stats: { impressions: "50", spend: "1000000" } },
            ],
          },
        ]),
      );
    });

  it("asks for DAY stats at each level and parses daily rows with micro-currency spend", async () => {
    server.use(statsHandler());
    const rows = await snap().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ date: "2026-10-01", level: "CAMPAIGN", externalId: "camp-1", impressions: 1000, clicks: 25, spend: 12.345678, conversions: 3, conversionValue: 45, videoViews: 400 });
    expect(rows[1]).toEqual({ date: "2026-10-02", level: "CAMPAIGN", externalId: "camp-1", impressions: 50, clicks: 0, spend: 1, conversions: 0, conversionValue: 0, videoViews: 0 });
    expect(rows.map((r) => r.level)).toEqual(["CAMPAIGN", "CAMPAIGN", "AD_GROUP", "AD_GROUP", "AD", "AD"]);
    const calls = await hits({ path: "/stats" });
    expect(calls.map((c) => c.url.searchParams.get("breakdown"))).toEqual(["campaign", "adsquad", "ad"]);
    for (const c of calls) {
      expect(c.url.searchParams.get("granularity")).toBe("DAY");
      expect(c.url.searchParams.get("fields")).toContain("spend");
    }
  });

  it("covers the whole requested range in a UTC account", async () => {
    server.use(statsHandler());
    await snap().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-31" });
    const first = (await hits({ path: "/stats" }))[0]!;
    expect(Date.parse(first.url.searchParams.get("start_time")!)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(Date.parse(first.url.searchParams.get("end_time")!)).toBeGreaterThanOrEqual(Date.parse("2026-10-31T23:59:59Z"));
  });

  // Snap rejects DAY queries whose start isn't midnight in the ad account's timezone
  // (https://developers.snap.com/api/marketing-api/Ads-API/measurement).
  it("BUG: day boundaries follow the ad account's timezone, not UTC", async () => {
    server.use(statsHandler());
    await snap().fetchMetrics(auth(), { ...acct, timezone: "America/Los_Angeles" }, { from: "2026-10-01", to: "2026-10-02" });
    const first = (await hits({ path: "/stats" }))[0]!;
    expect(Date.parse(first.url.searchParams.get("start_time")!)).toBe(Date.parse("2026-10-01T07:00:00Z"));
    // unverified: end_time as the next local midnight (exclusive end).
    expect(Date.parse(first.url.searchParams.get("end_time")!)).toBe(Date.parse("2026-10-03T07:00:00Z"));
  });

  it("propagates an expired token from the stats call", async () => {
    server.use(http.get(`${SNAP_API}/adaccounts/acc-1/stats`, () => fail(401, snapError("expired"))));
    await expect(snap().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("returns no rows for an empty stats response", async () => {
    server.use(http.get(`${SNAP_API}/adaccounts/acc-1/stats`, () => HttpResponse.json({ request_status: "SUCCESS" })));
    expect(await snap().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
  });
});

describe("Snapchat actions", () => {
  const getCampaign = () => http.get(`${SNAP_API}/campaigns/camp-1`, () => HttpResponse.json(snapWrap("campaigns", "campaign", [SNAP_CAMPAIGN])));
  const putCampaigns = () => http.put(`${SNAP_API}/adaccounts/acc-1/campaigns`, async ({ request }) => HttpResponse.json(snapWrap("campaigns", "campaign", ((await request.json()) as any).campaigns)));

  it("setCampaignStatus reads the full campaign and PUTs it back with the new status", async () => {
    server.use(getCampaign(), putCampaigns());
    await snap().setCampaignStatus(auth(), acct, { externalId: "camp-1" }, "PAUSED");
    const put = await onlyHit({ method: "PUT" });
    expect(put.url.pathname).toBe("/v1/adaccounts/acc-1/campaigns");
    expect(put.json).toEqual({ campaigns: [{ ...SNAP_CAMPAIGN, status: "PAUSED" }] });
  });

  it("setCampaignDailyBudget sends daily_budget_micro (rounded micros)", async () => {
    server.use(getCampaign(), putCampaigns());
    await snap().setCampaignDailyBudget(auth(), acct, { externalId: "camp-1" }, 12.345);
    const put = await onlyHit({ method: "PUT" });
    expect(put.json.campaigns[0].daily_budget_micro).toBe(12_345_000);
    expect(put.json.campaigns[0].name).toBe("Diwali");
  });

  it("refuses to update a campaign Snap doesn't return, without a PUT", async () => {
    server.use(http.get(`${SNAP_API}/campaigns/camp-1`, () => HttpResponse.json({ request_status: "SUCCESS", campaigns: [] })));
    await expect(snap().setCampaignStatus(auth(), acct, { externalId: "camp-1" }, "ACTIVE")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits({ method: "PUT" })).toHaveLength(0);
  });

  it("propagates a 403 from the update", async () => {
    server.use(getCampaign(), http.put(`${SNAP_API}/adaccounts/acc-1/campaigns`, () => fail(403, snapError("No access"))));
    await expect(snap().setCampaignStatus(auth(), acct, { externalId: "camp-1" }, "ACTIVE")).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: "No access" });
  });
});

describe("Snapchat builder options and targeting", () => {
  it("lists pixels and public profiles; a failing source gives an empty list", async () => {
    server.use(
      http.get(`${SNAP_API}/adaccounts/acc-1/pixels`, () => HttpResponse.json(snapWrap("pixels", "pixel", [{ id: "px-1", name: "Site pixel" }]))),
      // https://developers.snap.com/api/marketing-api/Ads-API/public-profiles
      http.get(`${SNAP_API}/organizations/org-1/public_profiles`, () => HttpResponse.json(snapWrap("public_profiles", "public_profile", [{ id: "pp-1", display_name: "Asha" }]))),
    );
    expect(await snap().getBuilderOptions(auth(), { ...acct, meta: { organizationId: "org-1" } })).toEqual({ pixels: [{ id: "px-1", name: "Site pixel" }], profiles: [{ id: "pp-1", name: "Asha" }] });
    server.use(http.get(`${SNAP_API}/adaccounts/acc-1/pixels`, () => fail(500)));
    expect(await snap().getBuilderOptions(auth(), acct)).toEqual({ pixels: [], profiles: [] });
  });

  it("searches Snap Lifestyle Categories by name; other kinds return nothing", async () => {
    // https://developers.snap.com/api/marketing-api/Ads-API/targeting (interests / SCLS)
    server.use(
      http.get(`${SNAP_API}/targeting/interests/scls`, () =>
        HttpResponse.json({ request_status: "SUCCESS", targeting_dimensions: [{ scls: { id: "SLC_1", name: "Fashion & Style Gurus", path: "/Lifestyle/Fashion" } }, { scls: { id: "SLC_2", name: "Foodies", path: "/Food" } }] }),
      ),
    );
    expect(await snap().searchTargeting(auth(), acct, "interest", "fash")).toEqual([{ id: "SLC_1", name: "Fashion & Style Gurus", detail: "/Lifestyle/Fashion" }]);
    expect(await snap().searchTargeting(auth(), acct, "location", "delhi")).toEqual([]);
  });
});

describe("Snapchat createCampaign", () => {
  const draftWithMedia = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("SNAPCHAT", { objective: "TRAFFIC" }, { ...over, ad: { media: ["img-1"], ...(over.ad ?? {}) } });

  it("creates campaign → squad → media → creative → ad, all paused by default", async () => {
    server.use(...snapCreateHandlers());
    const uploaded: string[] = [];
    const assets = assetsOf(imageAsset("img-1", { onUploaded: async (ref) => void uploaded.push(ref) }));
    const draft = draftWithMedia();
    const budget = draft.adGroups[0]!.values.budget as number;
    const out = await snap().createCampaign(auth(), acct, draft, assets);

    const campaign = (await onlyHit({ method: "POST", path: /\/adaccounts\/acc-1\/campaigns$/ })).json.campaigns[0];
    expect(campaign).toMatchObject({ name: "Festive Sale", ad_account_id: "acc-1", status: "PAUSED", objective_v2_properties: { objective_v2_type: "TRAFFIC" } });
    expect(typeof campaign.start_time).toBe("string");
    expect(campaign.lifetime_spend_cap_micro).toBe(Math.round((draft.campaign.spendCap as number) * 1e6));

    const squad = (await onlyHit({ path: /\/adsquads$/, method: "POST" })).json.adsquads[0];
    expect(squad).toMatchObject({
      campaign_id: "camp-1",
      type: "SNAP_ADS",
      status: "PAUSED",
      placement_v2: { config: "AUTOMATIC" },
      bid_strategy: "AUTO_BID",
      billing_event: "IMPRESSION",
      delivery_constraint: "DAILY_BUDGET",
      daily_budget_micro: Math.round(budget * 1e6),
      optimization_goal: "SWIPES",
    });
    expect(squad.bid_micro).toBeUndefined();
    expect(squad.lifetime_budget_micro).toBeUndefined();
    expect(squad.targeting.geos).toEqual([{ country_code: "in" }]);
    // Age 18–50+ is open-ended, so no max_age.
    expect(squad.targeting.demographics).toEqual([{ min_age: 18 }]);

    expect((await onlyHit({ path: /\/adaccounts\/acc-1\/media$/ })).json).toEqual({ media: [{ name: "img-1.jpg", type: "IMAGE", ad_account_id: "acc-1" }] });
    const upload = await onlyHit({ path: "/media/media-1/upload" });
    expect(upload.headers.get("content-type")).toMatch(/multipart\/form-data/);
    expect(upload.headers.get("authorization")).toBe("Bearer access-1");
    expect(uploaded).toEqual(["media:media-1"]);

    const creative = (await onlyHit({ path: "/creatives" })).json.creatives[0];
    expect(creative).toMatchObject({ type: "WEB_VIEW", top_snap_media_id: "media-1", call_to_action: "MORE", web_view_properties: { url: "https://shop.example.com/festive" }, shareable: true });

    const ad = (await onlyHit({ path: /\/adsquads\/squad-1\/ads$/ })).json.ads[0];
    expect(ad).toEqual({ ad_squad_id: "squad-1", creative_id: "cre-1", name: "Ad 1", type: "REMOTE_WEBPAGE", status: "PAUSED" });

    expect(out.campaigns[0]).toMatchObject({ externalId: "camp-1", status: "PAUSED", objective: "TRAFFIC" });
    expect(out.adGroups[0]).toMatchObject({ externalId: "squad-1", campaignExternalId: "camp-1", dailyBudget: budget, sourceKey: draft.adGroups[0]!.key });
    expect(out.ads[0]).toMatchObject({ externalId: "ad-1", adGroupExternalId: "squad-1", sourceKey: draft.adGroups[0]!.ads[0]!.key, finalUrl: "https://shop.example.com/festive" });
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
  });

  it("launches ACTIVE, with a lifetime budget, manual placements and a max bid when asked", async () => {
    server.use(...snapCreateHandlers());
    const draft = draftWithMedia({
      campaign: { launchStatus: "ACTIVE" },
      adGroup: { budget: 300, budgetType: "LIFETIME", placements: { mode: "MANUAL", items: ["FEED"] }, bidStrategy: "LOWEST_COST_WITH_MAX_BID", bidAmount: 1.5, gender: "FEMALE", age: { min: 21, max: 34 } },
    });
    draft.campaign.endDate = "2026-12-31";
    const out = await snap().createCampaign(auth(), acct, draft, assetsOf(imageAsset("img-1")));
    const squad = (await onlyHit({ path: /\/adsquads$/, method: "POST" })).json.adsquads[0];
    expect(squad).toMatchObject({ status: "ACTIVE", delivery_constraint: "LIFETIME_BUDGET", lifetime_budget_micro: 300_000_000, bid_micro: 1_500_000, placement_v2: { config: "CUSTOM", platforms: ["SNAPCHAT"], snapchat_positions: ["FEED"] } });
    expect(squad.daily_budget_micro).toBeUndefined();
    expect(squad.targeting.demographics).toEqual([{ min_age: 21, max_age: 34, gender: "FEMALE" }]);
    expect(squad.end_time).toBeDefined();
    expect(out.adGroups[0]!.dailyBudget).toBeNull();
    expect((await onlyHit({ path: /\/ads$/, method: "POST" })).json.ads[0].status).toBe("ACTIVE");
  });

  it("reuses a cached media id without uploading again", async () => {
    server.use(...snapCreateHandlers());
    await snap().createCampaign(auth(), acct, draftWithMedia(), assetsOf(imageAsset("img-1", { cachedRef: "media:cached-9" })));
    expect(await hits({ path: "/media" })).toHaveLength(0);
    expect((await onlyHit({ path: "/creatives" })).json.creatives[0].top_snap_media_id).toBe("cached-9");
  });

  it("uploads videos as VIDEO media", async () => {
    server.use(...snapCreateHandlers());
    await snap().createCampaign(auth(), acct, draftWithMedia({ ad: { media: ["vid-1"] } }), assetsOf(videoAsset("vid-1")));
    expect((await onlyHit({ path: /\/adaccounts\/acc-1\/media$/ })).json.media[0].type).toBe("VIDEO");
  });

  it("rolls the campaign back when an ad fails after the campaign was created", async () => {
    server.use(http.post(/\/v1\/adsquads\/[^/]+\/ads$/, () => fail(400, snapError("Ad rejected"))), ...snapCreateHandlers());
    const err = await snap().createCampaign(auth(), acct, draftWithMedia(), assetsOf(imageAsset("img-1"))).catch((e) => e);
    expect(err).toMatchObject({ code: "INVALID_REQUEST", message: "Ad rejected" });
    expect((await onlyHit({ method: "DELETE" })).url.pathname).toBe("/v1/campaigns/camp-1");
  });

  it("treats a per-item sub_request error as a failure and rolls back", async () => {
    server.use(
      http.post(/\/v1\/campaigns\/[^/]+\/adsquads$/, () =>
        HttpResponse.json({ request_status: "PARTIAL", adsquads: [{ sub_request_status: "ERROR", sub_request_error_reason: "Budget below minimum" }] }),
      ),
      ...snapCreateHandlers(),
    );
    const err = await snap().createCampaign(auth(), acct, draftWithMedia(), assetsOf(imageAsset("img-1"))).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.message).toContain("Budget below minimum");
    expect(await hits({ method: "DELETE" })).toHaveLength(1);
  });

  it("rolls back when an ad has no media and when Snap fails to process it", async () => {
    server.use(...snapCreateHandlers());
    await expect(snap().createCampaign(auth(), acct, draftWithMedia({ ad: { media: ["missing"] } }), assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits({ method: "DELETE" })).toHaveLength(1);

    server.use(http.get(/\/v1\/media\/[^/]+$/, () => HttpResponse.json(snapWrap("media", "media", [{ id: "media-1", media_status: "FAILED" }]))));
    await expect(snap().createCampaign(auth(), acct, draftWithMedia(), assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits({ method: "DELETE" })).toHaveLength(2);
  });

  it("does not try to roll back when the campaign itself is rejected", async () => {
    server.use(http.post(/\/v1\/adaccounts\/[^/]+\/campaigns$/, () => fail(400, snapError("Invalid objective"))), ...snapCreateHandlers());
    await expect(snap().createCampaign(auth(), acct, draftWithMedia(), assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ message: "Invalid objective" });
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
    expect(await hits({ path: "/adsquads" })).toHaveLength(0);
  });

  it("requires a budget on every squad", async () => {
    server.use(...snapCreateHandlers());
    const draft = draftWithMedia();
    draft.adGroups[0]!.values.budget = 0;
    await expect(snap().createCampaign(auth(), acct, draft, assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits({ method: "DELETE" })).toHaveLength(1);
  });

  it("builds a Story ad from snaps, a tile and a composite", async () => {
    server.use(...snapCreateHandlers());
    const draft = makeDraft("SNAPCHAT", { objective: "TRAFFIC" }, { ad: { format: "STORY", storySnaps: ["s1", "s2", "s3"], tileImage: ["tile"], tileHeadline: "Festive picks" } });
    await snap().createCampaign(auth(), acct, draft, assetsOf(imageAsset("s1"), imageAsset("s2"), imageAsset("s3"), imageAsset("tile")));
    const creatives = (await hits({ path: "/creatives" })).map((h) => h.json.creatives[0]);
    expect(creatives.map((c) => c.type)).toEqual(["WEB_VIEW", "WEB_VIEW", "WEB_VIEW", "PREVIEW", "COMPOSITE"]);
    expect(creatives[4].composite_properties.creative_ids).toEqual(["cre-1", "cre-2", "cre-3"]);
    expect(creatives[4].preview_creative_id).toBe("cre-4");
    expect((await onlyHit({ path: /\/ads$/, method: "POST" })).json.ads[0].type).toBe("STORY");
  });

  describe("in a server timezone east of UTC", () => {
    let tz: string | undefined;
    beforeEach(() => {
      tz = process.env.TZ;
      process.env.TZ = "Asia/Kolkata";
    });
    afterEach(() => {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it("the created campaign reports the start date that was entered, not the day before", async () => {
      server.use(...snapCreateHandlers());
      const draft = draftWithMedia({ campaign: { startDate: "2026-11-01", endDate: "2026-11-30" } });
      const out = await snap().createCampaign(auth(), acct, draft, assetsOf(imageAsset("img-1")));
      expect(out.campaigns[0]!.startDate).toBe("2026-11-01");
      expect(out.campaigns[0]!.endDate).toBe("2026-11-30");
    });
  });
});
