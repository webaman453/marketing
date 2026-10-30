import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PinterestConnector, mapPinterestStatus } from "../../src/pinterest";
import { ConnectorError } from "../../src/errors";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft, videoAsset } from "../msw/drafts";
import { PIN_API, PIN_CAMPAIGN, pinBulk, pinCreateHandlers, pinError, pinPagedList, pinRefresh, pinToken, pinUser } from "../msw/handlers/pinterest";

useMswServer();

const pin = () => new PinterestConnector({ appId: "1234567", appSecret: "pin-secret" });
const acct = account("acc-1", { timezone: "UTC" });

describe("Pinterest OAuth", () => {
  it("getAuthUrl asks for comma-separated ads/pins/boards scopes with redirect and state", () => {
    const url = pin().getAuthUrl({ state: STATE, redirectUri: REDIRECT });
    expect(url.startsWith("https://www.pinterest.com/oauth/?")).toBe(true);
    const q = queryOf(url);
    expect(q).toMatchObject({ client_id: "1234567", redirect_uri: REDIRECT, response_type: "code", state: STATE });
    expect(q.scope!.split(",")).toEqual(expect.arrayContaining(["ads:read", "ads:write", "user_accounts:read", "pins:write", "boards:write"]));
  });

  it("getAuthUrl throws NOT_CONFIGURED without the app secret", () => {
    expect(() => new PinterestConnector({ appId: "1" }).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  describe("token math", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());

    it("exchangeCode uses HTTP Basic client auth and a form body; expiresAt = now + expires_in", async () => {
      server.use(pinToken());
      const t = await pin().exchangeCode({ code: "the-code", redirectUri: REDIRECT });
      expect(t).toEqual({ accessToken: "pina_access", refreshToken: "pinr_refresh", expiresAt: new Date(NOW.getTime() + 2_592_000_000), scopes: ["ads:read", "ads:write", "user_accounts:read"] });
      const h = await onlyHit({ path: "/v5/oauth/token" });
      expect(h.headers.get("authorization")).toBe(`Basic ${Buffer.from("1234567:pin-secret").toString("base64")}`);
      expect(Object.fromEntries(h.form!)).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT });
    });

    it("refreshTokens returns no refresh token when Pinterest sends none (core keeps the stored one)", async () => {
      server.use(pinRefresh());
      const t = await pin().refreshTokens("pinr_old");
      expect(t.accessToken).toBe("pina_access_2");
      expect(t.refreshToken).toBeUndefined();
      expect(t.expiresAt).toEqual(new Date(NOW.getTime() + 2_592_000_000));
      const h = await onlyHit({ path: "/v5/oauth/token" });
      expect(Object.fromEntries(h.form!)).toEqual({ grant_type: "refresh_token", refresh_token: "pinr_old" });
    });
  });

  it("maps a bad code to INVALID_REQUEST with Pinterest's message", async () => {
    server.use(http.post(`${PIN_API}/oauth/token`, () => fail(400, pinError("Invalid authorization code", 1))));
    await expect(pin().exchangeCode({ code: "x", redirectUri: REDIRECT })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Invalid authorization code" });
  });

  it("getUser prefers the business name", async () => {
    server.use(pinUser());
    expect(await pin().getUser(auth("tok"))).toEqual({ id: "user-9", name: "Asha Studio" });
    expect((await onlyHit({ path: "/user_account" })).headers.get("authorization")).toBe("Bearer tok");
    server.use(pinUser({ id: undefined, business_name: undefined }));
    expect(await pin().getUser(auth())).toEqual({ id: "ashastudio", name: "ashastudio" });
  });
});

describe("Pinterest error mapping", () => {
  it.each(STATUS_CODES)("HTTP %i → %s", async (status, code) => {
    server.use(http.get(`${PIN_API}/ad_accounts`, () => fail(status, pinError(`msg ${status}`))));
    const err = await pin().listAdAccounts(auth()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`msg ${status}`);
  });

  it("uses a generic message when the body has none", async () => {
    server.use(http.get(`${PIN_API}/user_account`, () => new HttpResponse("upstream timeout", { status: 504 })));
    await expect(pin().getUser(auth())).rejects.toMatchObject({ code: "PLATFORM_ERROR", message: "Pinterest API error (504)" });
  });
});

describe("Pinterest accounts and structure", () => {
  it("listAdAccounts follows bookmarks to the last page", async () => {
    server.use(
      pinPagedList("/ad_accounts", [
        [{ id: "549755885175", name: "Asha US", currency: "USD", country: "US" }],
        [{ id: "549755885176", name: "Asha IN", currency: "INR" }],
        [{ id: "549755885177", name: "No currency" }],
      ]),
    );
    const list = await pin().listAdAccounts(auth());
    expect(list).toEqual([
      { externalId: "549755885175", name: "Asha US", currency: "USD", timezone: null, status: "ACTIVE" },
      { externalId: "549755885176", name: "Asha IN", currency: "INR", timezone: null, status: "ACTIVE" },
      { externalId: "549755885177", name: "No currency", currency: "USD", timezone: null, status: "ACTIVE" },
    ]);
    const calls = await hits({ path: "/ad_accounts" });
    expect(calls.map((c) => c.url.searchParams.get("bookmark"))).toEqual([null, "bm-1", "bm-2"]);
    expect(calls.every((c) => c.url.searchParams.get("page_size") === "250")).toBe(true);
  });

  const structureHandlers = () => [
    pinPagedList("/ad_accounts/acc-1/campaigns", [
      [PIN_CAMPAIGN],
      [
        { id: "c-2", name: "Archived", status: "ARCHIVED", objective_type: "AWARENESS" },
        { id: "c-3", name: "Draft", status: "DELETED_DRAFT" },
      ],
    ]),
    pinPagedList("/ad_accounts/acc-1/ad_groups", [
      [
        { id: "g-1", campaign_id: "626736533506", name: "Daily", status: "ACTIVE", budget_type: "DAILY", budget_in_micro_currency: 7_500_000, bid_strategy_type: "AUTOMATIC_BID" },
        { id: "g-2", campaign_id: "c-2", name: "Lifetime", status: "PAUSED", budget_type: "LIFETIME", budget_in_micro_currency: 900_000_000 },
      ],
    ]),
    pinPagedList("/ad_accounts/acc-1/ads", [[{ id: "ad-1", ad_group_id: "g-1", campaign_id: "626736533506", pin_id: "pin-77", status: "ACTIVE", destination_url: "https://asha.example/p" }]]),
  ];

  it("fetchStructure maps statuses, micro-currency budgets and unix dates", async () => {
    server.use(...structureHandlers());
    const s = await pin().fetchStructure(auth(), acct);
    expect(s.campaigns[0]).toMatchObject({
      externalId: "626736533506",
      status: "ACTIVE",
      deliveryStatus: "RUNNING",
      objective: "CONSIDERATION",
      dailyBudget: 12.34,
      lifetimeBudget: 5000,
      startDate: "2025-10-01",
      endDate: "2025-11-01",
      updatedAt: new Date(1_759_276_800_000),
    });
    expect(s.campaigns.map((c) => c.status)).toEqual(["ACTIVE", "ARCHIVED", "REMOVED"]);
    expect(s.campaigns[1]).toMatchObject({ dailyBudget: null, lifetimeBudget: null, startDate: null, updatedAt: null });
    expect(s.adGroups).toEqual([
      expect.objectContaining({ externalId: "g-1", campaignExternalId: "626736533506", dailyBudget: 7.5, bidStrategy: "AUTOMATIC_BID", status: "ACTIVE" }),
      // A lifetime budget isn't a daily budget.
      expect.objectContaining({ externalId: "g-2", dailyBudget: null, bidStrategy: null, status: "PAUSED" }),
    ]);
    expect(s.ads[0]).toMatchObject({ externalId: "ad-1", adGroupExternalId: "g-1", campaignExternalId: "626736533506", name: "Pin pin-77", finalUrl: "https://asha.example/p", raw: { pin_id: "pin-77" } });
    expect(await hits({ path: "/ad_accounts/acc-1/campaigns" })).toHaveLength(2);
  });

  it("propagates a failing page instead of returning what it had so far", async () => {
    server.use(
      http.get(`${PIN_API}/ad_accounts/acc-1/ads`, ({ request }) =>
        new URL(request.url).searchParams.get("bookmark") ? fail(429, pinError("Rate limit exceeded", 8)) : HttpResponse.json({ items: [{ id: "a" }], bookmark: "bm-1" }),
      ),
      ...structureHandlers().slice(0, 2),
    );
    await expect(pin().fetchStructure(auth(), acct)).rejects.toMatchObject({ code: "RATE_LIMITED", message: "Rate limit exceeded" });
  });

  it("BUG: bookmark paging is capped like allPages (MAX_PAGES) instead of running unbounded", async () => {
    let calls = 0;
    server.use(
      http.get(`${PIN_API}/ad_accounts`, () => {
        calls++;
        // Ends after 150 pages so the uncapped loop still finishes; a capped one throws first.
        return HttpResponse.json({ items: [{ id: `a${calls}`, name: "x" }], bookmark: calls < 150 ? `bm-${calls}` : null });
      }),
    );
    await expect(pin().listAdAccounts(auth())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("mapPinterestStatus", () => {
    expect(mapPinterestStatus("ACTIVE")).toBe("ACTIVE");
    expect(mapPinterestStatus("PAUSED")).toBe("PAUSED");
    expect(mapPinterestStatus("ARCHIVED")).toBe("ARCHIVED");
    expect(mapPinterestStatus("DELETED_DRAFT")).toBe("REMOVED");
    expect(mapPinterestStatus(undefined)).toBe("PAUSED");
  });
});

describe("Pinterest metrics", () => {
  const structure = (campaigns: number) => [
    pinPagedList("/ad_accounts/acc-1/campaigns", [Array.from({ length: campaigns }, (_, i) => ({ id: `c-${i}`, name: `C${i}`, status: "ACTIVE" }))]),
    pinPagedList("/ad_accounts/acc-1/ad_groups", [[{ id: "g-1", campaign_id: "c-0", name: "G", status: "ACTIVE" }]]),
    pinPagedList("/ad_accounts/acc-1/ads", [[{ id: "ad-1", ad_group_id: "g-1", campaign_id: "c-0", pin_id: "p" }]]),
  ];
  // https://developers.pinterest.com/docs/api/v5/campaigns-analytics/ : an array of rows keyed by column name.
  const analytics = () =>
    http.get(/\/v5\/ad_accounts\/acc-1\/(campaigns|ad_groups|ads)\/analytics$/, ({ request }) => {
      const u = new URL(request.url);
      const [param, col] = u.pathname.includes("/campaigns/") ? ["campaign_ids", "CAMPAIGN_ID"] : u.pathname.includes("/ad_groups/") ? ["ad_group_ids", "AD_GROUP_ID"] : ["ad_ids", "AD_ID"];
      const id = u.searchParams.get(param)!.split(",")[0];
      return HttpResponse.json([
        { DATE: u.searchParams.get("start_date"), [col]: id, SPEND_IN_MICRO_DOLLAR: 4_560_000, IMPRESSION_1: 1200, CLICKTHROUGH_1: 33, TOTAL_CONVERSIONS: 2, TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR: 99_990_000, VIDEO_3SEC_VIEWS_2: 10 },
        { DATE: u.searchParams.get("end_date"), [col]: id, SPEND_IN_MICRO_DOLLAR: "1000000", IMPRESSION_1: "5" },
      ]);
    });

  it("queries each level with DAY granularity and parses rows (spend in micro-dollars)", async () => {
    server.use(...structure(1), analytics());
    const rows = await pin().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-07" });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ date: "2026-10-01", level: "CAMPAIGN", externalId: "c-0", impressions: 1200, clicks: 33, spend: 4.56, conversions: 2, conversionValue: 99.99, videoViews: 10 });
    expect(rows[1]).toEqual({ date: "2026-10-07", level: "CAMPAIGN", externalId: "c-0", impressions: 5, clicks: 0, spend: 1, conversions: 0, conversionValue: 0, videoViews: 0 });
    expect(rows.map((r) => r.level)).toEqual(["CAMPAIGN", "CAMPAIGN", "AD_GROUP", "AD_GROUP", "AD", "AD"]);
    const calls = await hits({ path: "/analytics" });
    expect(calls.map((c) => [c.url.searchParams.get("start_date"), c.url.searchParams.get("end_date"), c.url.searchParams.get("granularity")])).toEqual([
      ["2026-10-01", "2026-10-07", "DAY"],
      ["2026-10-01", "2026-10-07", "DAY"],
      ["2026-10-01", "2026-10-07", "DAY"],
    ]);
    expect(calls[2]!.url.searchParams.get("ad_ids")).toBe("ad-1");
  });

  it("splits a long range into 90-day windows with no gap or overlap", async () => {
    server.use(...structure(1), analytics());
    await pin().fetchMetrics(auth(), acct, { from: "2026-01-01", to: "2026-04-10" });
    const windows = (await hits({ path: "/campaigns/analytics" })).map((c) => [c.url.searchParams.get("start_date"), c.url.searchParams.get("end_date")]);
    expect(windows).toEqual([
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-04-10"],
    ]);
  });

  it("chunks ids by 250 per request", async () => {
    server.use(...structure(251), analytics());
    await pin().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-01" });
    const calls = await hits({ path: "/campaigns/analytics" });
    expect(calls.map((c) => c.url.searchParams.get("campaign_ids")!.split(",").length)).toEqual([250, 1]);
  });

  it("skips analytics for a level with no entities", async () => {
    server.use(
      pinPagedList("/ad_accounts/acc-1/campaigns", [[]]),
      pinPagedList("/ad_accounts/acc-1/ad_groups", [[]]),
      pinPagedList("/ad_accounts/acc-1/ads", [[]]),
    );
    expect(await pin().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" })).toEqual([]);
    expect(await hits({ path: "/analytics" })).toHaveLength(0);
  });

  it("propagates an expired token from analytics", async () => {
    server.use(...structure(1), http.get(/\/analytics$/, () => fail(401, pinError("Authentication failed."))));
    await expect(pin().fetchMetrics(auth(), acct, { from: "2026-10-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Pinterest actions", () => {
  it("setCampaignStatus PATCHes the bulk campaigns endpoint", async () => {
    server.use(pinBulk("patch", `/ad_accounts/acc-1/campaigns`, "c"));
    await pin().setCampaignStatus(auth(), acct, { externalId: "626736533506" }, "PAUSED");
    const h = await onlyHit({ method: "PATCH" });
    expect(h.url.pathname).toBe("/v5/ad_accounts/acc-1/campaigns");
    expect(h.json).toEqual([{ id: "626736533506", status: "PAUSED" }]);
  });

  it("setCampaignDailyBudget sends daily_spend_cap in micro-currency", async () => {
    server.use(pinBulk("patch", `/ad_accounts/acc-1/campaigns`, "c"));
    await pin().setCampaignDailyBudget(auth(), acct, { externalId: "626736533506" }, 19.99);
    expect((await onlyHit({ method: "PATCH" })).json).toEqual([{ id: "626736533506", daily_spend_cap: 19_990_000 }]);
  });

  it("propagates a 403 from the update", async () => {
    server.use(http.patch(`${PIN_API}/ad_accounts/acc-1/campaigns`, () => fail(403, pinError("Not allowed", 29))));
    await expect(pin().setCampaignStatus(auth(), acct, { externalId: "1" }, "ACTIVE")).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});

describe("Pinterest builder options and targeting", () => {
  it("lists conversion tags and boards; a failing source gives an empty list", async () => {
    server.use(
      // https://developers.pinterest.com/docs/api/v5/conversion_tags-list/ (a bare array)
      http.get(`${PIN_API}/ad_accounts/acc-1/conversion_tags`, () => HttpResponse.json([{ id: "2612345", name: "Site tag" }])),
      http.get(`${PIN_API}/boards`, () => HttpResponse.json({ items: [{ id: "b1", name: "Decor", privacy: "PUBLIC" }, { id: "b2", name: "Ads", privacy: "SECRET" }], bookmark: null })),
    );
    expect(await pin().getBuilderOptions(auth(), acct)).toEqual({
      pixels: [{ id: "2612345", name: "Site tag" }],
      boards: [
        { id: "b1", name: "Decor", detail: "Public board" },
        { id: "b2", name: "Ads", detail: "Secret board" },
      ],
    });
    server.use(http.get(`${PIN_API}/ad_accounts/acc-1/conversion_tags`, () => fail(500)), http.get(`${PIN_API}/boards`, () => fail(500)));
    expect(await pin().getBuilderOptions(auth(), acct)).toEqual({ pixels: [], boards: [] });
  });

  it("searches interests by name; other kinds return nothing", async () => {
    // unverified: GET /resources/targeting/interests list shape ({ items: [{ id, name }] }).
    server.use(http.get(`${PIN_API}/resources/targeting/interests`, () => HttpResponse.json({ items: [{ id: "935249274030", name: "Home decor" }, { id: "1", name: "Recipes" }] })));
    expect(await pin().searchTargeting(auth(), acct, "interest", "decor")).toEqual([{ id: "935249274030", name: "Home decor" }]);
    expect(await pin().searchTargeting(auth(), acct, "jobTitle", "x")).toEqual([]);
  });
});

describe("Pinterest createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}, setup = { objective: "CONSIDERATION" }) => makeDraft("PINTEREST", setup, { ...over, ad: { image: ["img-1"], ...(over.ad ?? {}) } });

  it("creates campaign → ad group → Pin on the existing secret board → ad, all paused", async () => {
    server.use(...pinCreateHandlers());
    const d = draft();
    const budget = d.adGroups[0]!.values.budget as number;
    const out = await pin().createCampaign(auth(), acct, d, assetsOf(imageAsset("img-1")));

    const campaign = (await onlyHit({ method: "POST", path: /\/campaigns$/ })).json;
    expect(campaign).toEqual([{ ad_account_id: "acc-1", name: "Festive Sale", status: "PAUSED", objective_type: "CONSIDERATION", is_campaign_budget_optimization: false }]);

    const group = (await onlyHit({ method: "POST", path: /\/ad_groups$/ })).json[0];
    expect(group).toMatchObject({
      ad_account_id: "acc-1",
      campaign_id: "camp-1",
      status: "PAUSED",
      budget_type: "DAILY",
      budget_in_micro_currency: Math.round(budget * 1e6),
      targeting_spec: { LOCATION: ["IN"] },
      auto_targeting_enabled: true,
      placement_group: "ALL",
      pacing_delivery_type: "STANDARD",
      billable_event: "CLICKTHROUGH",
      bid_strategy_type: "AUTOMATIC_BID",
    });
    expect(group.bid_in_micro_currency).toBeUndefined();
    expect(group.optimization_goal_metadata).toBeUndefined();

    expect(await hits({ method: "POST", path: /\/boards$/ })).toHaveLength(0);
    const pinReq = await onlyHit({ method: "POST", path: /\/pins$/ });
    expect(pinReq.url.searchParams.get("ad_account_id")).toBe("acc-1");
    expect(pinReq.json).toEqual({
      board_id: "board-old",
      title: "Festive edit",
      link: "https://shop.example.com/festive",
      media_source: { source_type: "image_base64", content_type: "image/jpeg", data: Buffer.from("fake-jpeg-bytes").toString("base64") },
    });

    const ad = (await onlyHit({ method: "POST", path: /\/ads$/ })).json[0];
    expect(ad).toEqual({ ad_group_id: "group-1", pin_id: "pin-1", creative_type: "REGULAR", name: "Ad 1", status: "PAUSED", destination_url: "https://shop.example.com/festive", customizable_cta_type: "LEARN_MORE" });

    expect(out.campaigns[0]).toMatchObject({ externalId: "camp-1", status: "PAUSED", dailyBudget: null, lifetimeBudget: null });
    expect(out.adGroups[0]).toMatchObject({ externalId: "group-1", dailyBudget: budget, sourceKey: d.adGroups[0]!.key, targeting: { LOCATION: ["IN"] } });
    expect(out.ads[0]).toMatchObject({ externalId: "ad-1", sourceKey: d.adGroups[0]!.ads[0]!.key, raw: { pin_id: "pin-1" } });
    expect(await hits({ method: "PATCH" })).toHaveLength(0);
  });

  it("creates the secret board when there isn't one yet, and uses a chosen board as is", async () => {
    server.use(http.get(`${PIN_API}/boards`, () => HttpResponse.json({ items: [{ id: "pub", name: "Ashniva Ads", privacy: "PUBLIC" }], bookmark: null })), ...pinCreateHandlers());
    await pin().createCampaign(auth(), acct, draft(), assetsOf(imageAsset("img-1")));
    expect((await onlyHit({ method: "POST", path: /\/boards$/ })).json).toEqual({ name: "Ashniva Ads", privacy: "SECRET", description: "Pins created for ads." });
    expect((await onlyHit({ method: "POST", path: /\/pins$/ })).json.board_id).toBe("board-new");
  });

  it("uses the chosen board without listing boards", async () => {
    server.use(...pinCreateHandlers());
    await pin().createCampaign(auth(), acct, draft({ ad: { boardId: "mine" } }), assetsOf(imageAsset("img-1")));
    expect(await hits({ path: /\/boards$/ })).toHaveLength(0);
    expect((await onlyHit({ method: "POST", path: /\/pins$/ })).json.board_id).toBe("mine");
  });

  it("puts the budget on the campaign with CBO and none on the ad groups", async () => {
    server.use(...pinCreateHandlers());
    const out = await pin().createCampaign(auth(), acct, draft({ campaign: { cbo: true, budget: 100, budgetType: "DAILY", launchStatus: "ACTIVE" } }), assetsOf(imageAsset("img-1")));
    const campaign = (await onlyHit({ method: "POST", path: /\/campaigns$/ })).json[0];
    expect(campaign).toMatchObject({ status: "ACTIVE", is_campaign_budget_optimization: true, daily_spend_cap: 100_000_000 });
    const group = (await onlyHit({ method: "POST", path: /\/ad_groups$/ })).json[0];
    expect(group.budget_type).toBe("CBO_ADGROUP");
    expect(group.budget_in_micro_currency).toBeUndefined();
    expect(group.status).toBe("ACTIVE");
    expect(out.campaigns[0]!.dailyBudget).toBe(100);
    expect(out.adGroups[0]!.dailyBudget).toBeNull();
  });

  it("sends lifetime budgets, max bids, targeting and keywords", async () => {
    server.use(...pinCreateHandlers());
    await pin().createCampaign(
      auth(),
      acct,
      draft({
        adGroup: {
          budget: 500,
          budgetType: "LIFETIME",
          bidStrategy: "MAX_BID",
          bidAmount: 0.75,
          gender: "female",
          ageBuckets: ["25-34"],
          devices: ["iphone"],
          interests: [{ id: "935249274030", name: "Home decor" }],
          keywords: [{ text: "diwali decor", matchType: "PHRASE" }],
        },
      }),
      assetsOf(imageAsset("img-1")),
    );
    const group = (await onlyHit({ method: "POST", path: /\/ad_groups$/ })).json[0];
    expect(group).toMatchObject({ budget_type: "LIFETIME", budget_in_micro_currency: 500_000_000, bid_strategy_type: "MAX_BID", bid_in_micro_currency: 750_000 });
    expect(group.targeting_spec).toEqual({ LOCATION: ["IN"], GENDER: ["female"], AGE_BUCKET: ["25-34"], INTEREST: ["935249274030"], APPTYPE: ["iphone"] });
    expect((await onlyHit({ path: /\/keywords$/ })).json).toEqual({ keywords: [{ match_type: "PHRASE", value: "diwali decor" }], parent_id: "group-1" });
  });

  it("adds conversion goal metadata for WEB_CONVERSION", async () => {
    server.use(...pinCreateHandlers());
    await pin().createCampaign(auth(), acct, draft({ adGroup: { conversionTagId: "2612345" } }, { objective: "WEB_CONVERSION" }), assetsOf(imageAsset("img-1")));
    const group = (await onlyHit({ method: "POST", path: /\/ad_groups$/ })).json[0];
    expect(group.billable_event).toBe("IMPRESSION");
    expect(group.optimization_goal_metadata.conversion_tag_v3_goal_metadata).toMatchObject({ conversion_event: "CHECKOUT", conversion_tag_id: "2612345" });
  });

  it("registers, uploads and waits for a video Pin", async () => {
    server.use(...pinCreateHandlers());
    const uploaded: string[] = [];
    await pin().createCampaign(
      auth(),
      acct,
      draft({ ad: { format: "VIDEO", video: ["vid-1"], image: [] } }, { objective: "VIDEO_COMPLETION" }),
      assetsOf(videoAsset("vid-1", { onUploaded: async (r) => void uploaded.push(r) })),
    );
    expect((await onlyHit({ method: "POST", path: /\/v5\/media$/ })).json).toEqual({ media_type: "video" });
    const s3 = await onlyHit({ host: "pinterest-media-upload.s3-accelerate.amazonaws.com" });
    expect(s3.headers.get("content-type")).toMatch(/multipart\/form-data/);
    expect(s3.headers.get("authorization")).toBeNull();
    expect(s3.text).toContain('name="x-amz-signature"');
    expect((await onlyHit({ method: "POST", path: /\/pins$/ })).json.media_source).toEqual({ source_type: "video_id", media_id: "12345", cover_image_key_frame_time: 1 });
    expect((await onlyHit({ method: "POST", path: /\/ads$/ })).json[0].creative_type).toBe("VIDEO");
    expect(uploaded).toEqual(["media:12345"]);
    expect((await onlyHit({ method: "POST", path: /\/ad_groups$/ })).json[0].billable_event).toBe("VIDEO_V_50_MRC");
  });

  it("builds carousel Pins from several images", async () => {
    server.use(...pinCreateHandlers());
    await pin().createCampaign(auth(), acct, draft({ ad: { format: "CAROUSEL", images: ["i1", "i2"] } }), assetsOf(imageAsset("i1"), imageAsset("i2", { mimeType: "image/png" })));
    const src = (await onlyHit({ method: "POST", path: /\/pins$/ })).json.media_source;
    expect(src.source_type).toBe("multiple_image_base64");
    expect(src.items.map((i: { content_type: string }) => i.content_type)).toEqual(["image/jpeg", "image/png"]);
    expect((await onlyHit({ method: "POST", path: /\/ads$/ })).json[0].creative_type).toBe("CAROUSEL");
  });

  it("archives the campaign when an ad fails after the campaign was created", async () => {
    server.use(http.post(/\/v5\/ad_accounts\/[^/]+\/ads$/, () => fail(400, pinError("Pin is not promotable", 2741))), ...pinCreateHandlers());
    await expect(pin().createCampaign(auth(), acct, draft(), assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Pin is not promotable" });
    expect((await onlyHit({ method: "PATCH" })).json).toEqual([{ id: "camp-1", status: "ARCHIVED" }]);
  });

  it("treats a bulk item exception as a failure and archives the campaign", async () => {
    server.use(
      http.post(/\/v5\/ad_accounts\/[^/]+\/ad_groups$/, () => HttpResponse.json({ items: [{ data: null, exceptions: [{ code: 2479, message: "Budget is too low" }] }] })),
      ...pinCreateHandlers(),
    );
    const err = await pin().createCampaign(auth(), acct, draft(), assetsOf(imageAsset("img-1"))).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.message).toContain("Budget is too low");
    expect(await hits({ method: "PATCH" })).toHaveLength(1);
  });

  it("archives when a Pin has no image or a group no budget", async () => {
    server.use(...pinCreateHandlers());
    await expect(pin().createCampaign(auth(), acct, draft({ ad: { image: [] } }), assetsOf())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Each Pin needs an image." });
    const d = draft();
    d.adGroups[0]!.values.budget = null;
    await expect(pin().createCampaign(auth(), acct, d, assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits({ method: "PATCH" })).toHaveLength(2);
  });

  it("does not try to archive when the campaign itself is rejected", async () => {
    server.use(http.post(/\/v5\/ad_accounts\/[^/]+\/campaigns$/, () => HttpResponse.json({ items: [{ exceptions: [{ code: 1, message: "Invalid objective" }] }] })), ...pinCreateHandlers());
    await expect(pin().createCampaign(auth(), acct, draft(), assetsOf(imageAsset("img-1")))).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Campaign: Invalid objective" });
    expect(await hits({ method: "PATCH" })).toHaveLength(0);
    expect(await hits({ path: /\/ad_groups$/ })).toHaveLength(0);
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

    it("the created campaign reports the start/end dates that were entered, not the day before", async () => {
      server.use(...pinCreateHandlers());
      // The schedule is entered on the ad group (the Pinterest campaign form has none, specs/pinterest.ts).
      const out = await pin().createCampaign(auth(), acct, draft({ adGroup: { startDate: "2026-11-01", endDate: "2026-11-30" } }), assetsOf(imageAsset("img-1")));
      expect(out.campaigns[0]!.startDate).toBe("2026-11-01");
      expect(out.campaigns[0]!.endDate).toBe("2026-11-30");
    });
  });
});
