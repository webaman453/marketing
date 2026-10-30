import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyAdsConnector } from "../../src/spotify";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import { SPOTIFY_API, SPOTIFY_TOKEN, spotifyData, spotifyHandlers } from "../msw/handlers/spotify";

useMswServer();
afterEach(() => vi.useRealTimers());

const sp = () => new SpotifyAdsConnector({ clientId: "sp-client", clientSecret: "sp-secret" });
const acc = account("acc-1", { currency: "INR", timezone: "Asia/Kolkata" });

/** A full Spotify draft: one or more ad sets, audio ads with their files. */
const draft = (opts: Parameters<typeof makeDraft>[2] = {}) =>
  makeDraft("SPOTIFY", { objective: "CLICKS" }, {
    ...opts,
    campaign: { budget: 100, ...opts.campaign },
    adGroup: { locations: [{ id: "IN", name: "India", type: "country" }], ...opts.adGroup },
    ad: { format: "AUDIO", audioUrl: "https://cdn.example.com/spot.mp3", companionUrl: "https://cdn.example.com/companion.jpg", headline: "Diwali sale", tagline: "Up to 50% off", url: "https://shop.example.com/festive", ...opts.ad },
  });

describe("Spotify OAuth", () => {
  it("is not configured without both client id and secret", () => {
    expect(new SpotifyAdsConnector({ clientId: "x" }).isConfigured()).toBe(false);
    expect(sp().isConfigured()).toBe(true);
    expect(() => new SpotifyAdsConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl sends client_id, response_type=code, redirect_uri and state to accounts.spotify.com", () => {
    const url = sp().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://accounts.spotify.com/authorize?")).toBe(true);
    expect(queryOf(url)).toMatchObject({ client_id: "sp-client", response_type: "code", redirect_uri: REDIRECT, state: STATE });
  });

  it("exchangeCode posts a form with Basic client auth and computes expiresAt from expires_in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...spotifyHandlers());
    const t = await sp().exchangeCode({ code: "auth-code", redirectUri: REDIRECT });
    expect(t).toMatchObject({ accessToken: "sp-access-1", refreshToken: "sp-refresh-1" });
    expect(t.expiresAt?.toISOString()).toBe("2026-10-15T11:00:00.000Z");
    const h = await onlyHit({ host: "accounts.spotify.com" });
    expect(h.headers.get("authorization")).toBe(`Basic ${Buffer.from("sp-client:sp-secret").toString("base64")}`);
    expect(Object.fromEntries(h.form!)).toEqual({ grant_type: "authorization_code", code: "auth-code", redirect_uri: REDIRECT });
  });

  it("refreshTokens never replaces the refresh token with a different one when Spotify omits it", async () => {
    server.use(...spotifyHandlers());
    const t = await sp().refreshTokens("sp-refresh-1");
    expect(t?.accessToken).toBe("sp-access-2");
    // core/tokens.ts keeps the stored refresh token when the connector returns none.
    expect([undefined, "sp-refresh-1"]).toContain(t?.refreshToken);
    const h = await onlyHit({ host: "accounts.spotify.com" });
    expect(Object.fromEntries(h.form!)).toEqual({ grant_type: "refresh_token", refresh_token: "sp-refresh-1" });
  });

  it.each([
    [400, "INVALID_REQUEST"],
    [401, "AUTH_EXPIRED"],
    [429, "RATE_LIMITED"],
    [503, "PLATFORM_ERROR"],
  ])("token endpoint HTTP %i → %s with Spotify's error_description", async (status, code) => {
    server.use(http.post(SPOTIFY_TOKEN, () => fail(status, { error: "invalid_grant", error_description: "Invalid authorization code" })));
    await expect(sp().exchangeCode({ code: "bad", redirectUri: REDIRECT })).rejects.toMatchObject({ code, message: "Invalid authorization code" });
  });
});

describe("Spotify account reads", () => {
  it("getUser returns the first business and sends the bearer token", async () => {
    server.use(...spotifyHandlers());
    expect(await sp().getUser(auth("tok"))).toEqual({ id: "biz-1", name: "Ashniva Music" });
    expect((await onlyHit({ path: "/businesses" })).headers.get("authorization")).toBe("Bearer tok");
  });

  it("getUser refuses a login with no business (PERMISSION_DENIED)", async () => {
    server.use(...spotifyHandlers(spotifyData({ businesses: [] })));
    await expect(sp().getUser(auth())).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "PLATFORM_ERROR"],
  ])("businesses HTTP %i → %s", async (status, code) => {
    server.use(http.get(`${SPOTIFY_API}/businesses`, () => fail(status, { error: { message: "nope" } })));
    await expect(sp().getUser(auth())).rejects.toMatchObject({ code });
  });

  it("explains a 403 from /businesses as missing Ads API access", async () => {
    server.use(http.get(`${SPOTIFY_API}/businesses`, () => fail(403, { error: { message: "Forbidden" } })));
    await expect(sp().listAdAccounts(auth())).rejects.toThrow(/Ads API/);
  });

  it("listAdAccounts walks every business and maps currency, timezone and INACTIVE status", async () => {
    server.use(...spotifyHandlers(spotifyData({
      businesses: [{ id: "biz-1", name: "A" }, { id: "biz-2", name: "B" }],
      adAccounts: {
        "biz-1": [{ id: "acc-1", name: "IN", currency_code: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" }],
        "biz-2": [{ id: "acc-2", status: "INACTIVE" }],
      },
    })));
    expect(await sp().listAdAccounts(auth())).toEqual([
      { externalId: "acc-1", name: "IN", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE", meta: { businessId: "biz-1" } },
      { externalId: "acc-2", name: "acc-2", currency: "USD", timezone: null, status: "PAUSED", meta: { businessId: "biz-2" } },
    ]);
  });

  it("listAdAccounts propagates an error from one business instead of returning a shorter list", async () => {
    server.use(
      http.get(`${SPOTIFY_API}/businesses/biz-2/ad_accounts`, () => fail(401, { error: { message: "expired" } })),
      ...spotifyHandlers(spotifyData({ businesses: [{ id: "biz-1" }, { id: "biz-2" }] })),
    );
    await expect(sp().listAdAccounts(auth())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Spotify structure", () => {
  it("maps campaigns, ad sets (budget micros → currency units) and ads", async () => {
    server.use(...spotifyHandlers(spotifyData({
      campaigns: [
        { id: "c1", name: "Live", status: "ACTIVE", objective: "CLICKS", start_date: "2026-10-01T05:30:00Z", end_date: "2026-11-01T00:00:00Z" },
        { id: "c2", name: "Old", status: "ARCHIVED" },
      ],
    })));
    const s = await sp().fetchStructure(auth(), acc);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.startDate, c.endDate])).toEqual([
      ["c1", "ACTIVE", "2026-10-01", "2026-11-01"],
      ["c2", "ARCHIVED", null, null],
    ]);
    expect(s.adGroups[0]).toMatchObject({ externalId: "s1", campaignExternalId: "c1", status: "PAUSED", dailyBudget: 25.5, bidStrategy: "MAX_BID" });
    expect(s.ads[0]).toMatchObject({ externalId: "ad1", adGroupExternalId: "s1", campaignExternalId: "c1", headline: "Diwali sale", body: "Up to 50% off", finalUrl: "https://shop.example.com", raw: { format: "AUDIO" } });
    const paths = (await hits()).map((h) => h.url.pathname).sort();
    expect(paths).toEqual(["/ads/v3/ad_accounts/acc-1/ad_sets", "/ads/v3/ad_accounts/acc-1/ads", "/ads/v3/ad_accounts/acc-1/campaigns"]);
  });

  it("an ad set without a budget has a null daily budget, not 0", async () => {
    server.use(...spotifyHandlers(spotifyData({ adSets: [{ id: "s9", campaign_id: "c1", name: "x", status: "ACTIVE" }] })));
    expect((await sp().fetchStructure(auth(), acc)).adGroups[0]?.dailyBudget).toBeNull();
  });

  it("propagates an auth error on any of the three lists (no partial structure)", async () => {
    server.use(http.get(`${SPOTIFY_API}/ad_accounts/:acc/ads`, () => fail(401, { error: { message: "token expired" } })), ...spotifyHandlers());
    await expect(sp().fetchStructure(auth(), acc)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "token expired" });
  });

  it("fetchStructure follows limit/offset paging to the last page (spotify/index.ts:105-109 reads only the first page)", async () => {
    const campaigns = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, status: "ACTIVE" }));
    server.use(...spotifyHandlers(spotifyData({ campaigns })));
    expect((await sp().fetchStructure(auth(), acc)).campaigns).toHaveLength(120);
  });

  it("fetchMetrics returns no rows and makes no request (reporting not implemented)", async () => {
    expect(await sp().fetchMetrics()).toEqual([]);
    expect(await hits()).toEqual([]);
  });
});

describe("Spotify actions", () => {
  it("setCampaignStatus PATCHes the campaign with the new status", async () => {
    server.use(...spotifyHandlers());
    await sp().setCampaignStatus(auth(), acc, { externalId: "c1" }, "PAUSED");
    const h = await onlyHit({ method: "PATCH" });
    expect(h.url.pathname).toBe("/ads/v3/ad_accounts/acc-1/campaigns/c1");
    expect(h.json).toEqual({ status: "PAUSED" });
  });

  it("setCampaignDailyBudget splits the amount across the campaign's ad sets, in micros, rounded down to cents", async () => {
    server.use(...spotifyHandlers(spotifyData({
      adSets: [
        { id: "s1", campaign_id: "c1" },
        { id: "s2", campaign_id: "c1" },
        { id: "s3", campaign_id: "c1" },
        { id: "other", campaign_id: "c2" },
      ],
    })));
    await sp().setCampaignDailyBudget(auth(), acc, { externalId: "c1" }, 100);
    const patches = await hits({ method: "PATCH" });
    expect(patches.map((h) => h.url.pathname.split("/").pop())).toEqual(["s1", "s2", "s3"]);
    for (const h of patches) expect(h.json).toEqual({ budget: { micro_amount: 33_330_000, type: "DAILY" } });
    expect(await hits({ method: "PATCH", path: "/campaigns/" })).toHaveLength(0);
  });

  it("setCampaignDailyBudget refuses a campaign with no ad sets and sends no PATCH", async () => {
    server.use(...spotifyHandlers(spotifyData({ adSets: [] })));
    await expect(sp().setCampaignDailyBudget(auth(), acc, { externalId: "c1" }, 50)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits({ method: "PATCH" })).toHaveLength(0);
  });

  it("setCampaignDailyBudget propagates a PATCH failure", async () => {
    server.use(http.patch(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets/:id`, () => fail(429, { error: { message: "slow down" } })), ...spotifyHandlers());
    await expect(sp().setCampaignDailyBudget(auth(), acc, { externalId: "c1" }, 50)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("Spotify createCampaign", () => {
  it("creates a paused campaign, ad sets with the budget split in micros, and audio ads", async () => {
    server.use(...spotifyHandlers());
    const d = draft({ groups: 2 });
    expect(d.campaign.launchStatus).toBe("PAUSED");
    const made = await sp().createCampaign(auth(), acc, d, new Map());

    const [campaign] = await hits({ method: "POST", path: /\/campaigns$/ });
    expect(campaign!.url.pathname).toBe("/ads/v3/ad_accounts/acc-1/campaigns");
    expect(campaign!.json).toEqual({ name: "Festive Sale", objective: "CLICKS", status: "PAUSED" });

    const sets = await hits({ method: "POST", path: /\/ad_sets$/ });
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(s.json).toMatchObject({ campaign_id: made.campaigns[0]!.externalId, status: "PAUSED", budget: { micro_amount: 50_000_000, type: "DAILY" }, targets: { countries: ["IN"] } });
    }

    const ads = await hits({ method: "POST", path: /\/ads$/ });
    expect(ads).toHaveLength(2);
    expect(ads[0]!.json).toMatchObject({
      status: "PAUSED",
      format: "AUDIO",
      assets: { headline: "Diwali sale", tagline: "Up to 50% off", click_url: "https://shop.example.com/festive", asset_url: "https://cdn.example.com/spot.mp3", companion_image_url: "https://cdn.example.com/companion.jpg" },
    });

    expect(made.campaigns[0]).toMatchObject({ status: "PAUSED", dailyBudget: 100 });
    expect(made.adGroups.map((g) => g.dailyBudget)).toEqual([50, 50]);
    expect(made.adGroups.map((g) => g.sourceKey)).toEqual(d.adGroups.map((g) => g.key));
    expect(made.ads.map((a) => a.sourceKey)).toEqual(d.adGroups.flatMap((g) => g.ads.map((a) => a.key)));
  });

  it("an odd split never exceeds the campaign budget (3 ad sets of 100 → 33.33 each)", async () => {
    server.use(...spotifyHandlers());
    await sp().createCampaign(auth(), acc, draft({ groups: 3 }), new Map());
    const sets = await hits({ method: "POST", path: /\/ad_sets$/ });
    expect(sets.map((s) => s.json.budget.micro_amount)).toEqual([33_330_000, 33_330_000, 33_330_000]);
  });

  it("launches active only when asked, and a display ad sends its image", async () => {
    server.use(...spotifyHandlers());
    await sp().createCampaign(auth(), acc, draft({ campaign: { launchStatus: "ACTIVE" }, ad: { format: "DISPLAY", imageUrl: "https://cdn.example.com/banner.jpg" } }), new Map());
    expect((await hits({ method: "POST", path: /\/campaigns$/ }))[0]!.json.status).toBe("ACTIVE");
    const ad = (await hits({ method: "POST", path: /\/ads$/ }))[0]!.json;
    expect(ad.format).toBe("DISPLAY");
    expect(ad.assets.asset_url).toBe("https://cdn.example.com/banner.jpg");
    expect(ad.assets).not.toHaveProperty("companion_image_url", expect.anything());
  });

  it("falls back to the campaign's countries when an ad set has none", async () => {
    server.use(...spotifyHandlers());
    const d = draft({ campaign: { locations: [{ id: "us", name: "US", type: "country" }] } });
    d.adGroups[0]!.values.locations = [];
    await sp().createCampaign(auth(), acc, d, new Map());
    expect((await hits({ method: "POST", path: /\/ad_sets$/ }))[0]!.json.targets).toEqual({ countries: ["US"] });
  });

  it("checks every creative before creating anything", async () => {
    server.use(...spotifyHandlers());
    const d = draft({ groups: 2 });
    d.adGroups[1]!.ads[0]!.values.audioUrl = "";
    await expect(sp().createCampaign(auth(), acc, d, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toEqual([]);
  });

  it("requires a budget before calling Spotify", async () => {
    server.use(...spotifyHandlers());
    await expect(sp().createCampaign(auth(), acc, draft({ campaign: { budget: 0 } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toEqual([]);
  });

  it("fails with PLATFORM_ERROR when Spotify returns no id", async () => {
    server.use(http.post(`${SPOTIFY_API}/ad_accounts/:acc/campaigns`, () => HttpResponse.json({})), ...spotifyHandlers());
    await expect(sp().createCampaign(auth(), acc, draft(), new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("propagates an ad set failure with its mapped code", async () => {
    server.use(http.post(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets`, () => fail(400, { error: { message: "Invalid targeting" } })), ...spotifyHandlers());
    await expect(sp().createCampaign(auth(), acc, draft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Invalid targeting" });
  });

  it("rolls back (archives/deletes) the created campaign when an ad set fails (spotify/builder.ts:49-57 leaves it behind)", async () => {
    server.use(http.post(`${SPOTIFY_API}/ad_accounts/:acc/ad_sets`, () => fail(500)), ...spotifyHandlers());
    await sp().createCampaign(auth(), acc, draft(), new Map()).catch(() => undefined);
    const cleanup = (await hits()).filter((h) => /\/campaigns\/new-c\d+$/.test(h.url.pathname) && (h.method === "DELETE" || h.json?.status === "ARCHIVED"));
    expect(cleanup).toHaveLength(1);
  });
});
