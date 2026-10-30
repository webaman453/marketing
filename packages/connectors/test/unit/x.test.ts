import { describe, expect, it } from "vitest";
import { XAdsConnector, midnightIn } from "../../src/x";
import { assertPromotedOnly } from "../../src/x/builder";
import { encodeParams, oauthHeader, packToken, percentEncode, signatureBase, unpackToken } from "../../src/x/oauth1";
import { ConnectorError } from "../../src/errors";
import { MAX_PAGES } from "../../src/http";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { account, REDIRECT, STATUS_CODES } from "../msw/fixtures";
import { expectedSignature, parseOAuthHeader, statsRow, X_ADS, X_CONSUMER, X_OAUTH, X_REQUEST, X_USER, xAccessToken, xDelete, xGet, xList, xPost, xPut, xRequestToken } from "../msw/handlers/x";
import { hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";

useMswServer();

const x = () => new XAdsConnector(X_CONSUMER);
const userAuth = (t: Partial<typeof X_USER> = X_USER) => ({ accessToken: packToken({ token: X_USER.token, secret: X_USER.secret, ...t }) });
const acct = (over = {}) => account("18ce54d4x5t", { timezone: "America/New_York", ...over });

describe("X OAuth 1.0a signing (oauth1.ts)", () => {
  // Worked example from https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
  const docs = {
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    form: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: "1318622958",
  };

  it("matches the X docs' worked example signature", () => {
    const h = parseOAuthHeader(oauthHeader(docs))!;
    expect(h.oauth_signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
    expect(h).toMatchObject({ oauth_consumer_key: docs.consumerKey, oauth_nonce: docs.nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: docs.timestamp, oauth_token: docs.token, oauth_version: "1.0" });
  });

  it("builds the docs' signature base string", () => {
    const oauth = { oauth_consumer_key: docs.consumerKey, oauth_nonce: docs.nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: docs.timestamp, oauth_token: docs.token, oauth_version: "1.0" };
    expect(signatureBase(docs, oauth)).toBe(
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
  });

  // OAuth Core 1.0 Appendix A.5 (the photos.example.net example, also used by RFC 5849 §1.2). // unverified: vector from memory
  it("matches the OAuth Core 1.0 Appendix A GET example", () => {
    const h = parseOAuthHeader(
      oauthHeader({ method: "GET", url: "http://photos.example.net/photos?file=vacation.jpg&size=original", consumerKey: "dpf43f3p2l4k3l03", consumerSecret: "kd94hf93k423kf44", token: "nnch734d00sl2jdk", tokenSecret: "pfkkdhi9sl3r4s00", nonce: "kllo9940pd9333jh", timestamp: "1191242096" }),
    )!;
    expect(h.oauth_signature).toBe("tR3+Ty81lMeYAr/Fid0kMTYa/WM=");
  });

  it("agrees with an independent RFC 5849 implementation, incl. oauth_callback and repeated keys", () => {
    const input = { method: "post", url: "https://API.x.com/oauth/request_token?b=2&a=1&a=0", consumerKey: "ck", consumerSecret: "c s!", nonce: "n", timestamp: "1", oauth: { oauth_callback: REDIRECT } };
    const h = parseOAuthHeader(oauthHeader(input))!;
    expect(h.oauth_token).toBeUndefined();
    expect(h.oauth_callback).toBe(REDIRECT);
    expect(h.oauth_signature).toBe(expectedSignature("POST", input.url, h, "c s!", ""));
  });

  it("percentEncode is RFC 3986 (encodes !'()* and space as %20)", () => {
    expect(percentEncode("Hello Ladies + Gentlemen, a signed OAuth request!")).toBe("Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21");
    expect(percentEncode("(it's)*~-._")).toBe("%28it%27s%29%2A~-._");
    expect(percentEncode("☃")).toBe("%E2%98%83");
    expect(encodeParams({ a: "x y", b: undefined, c: null, d: 0, e: true })).toBe("a=x%20y&d=0&e=true");
  });

  it("packToken/unpackToken round-trip; an old OAuth 2.0 token asks for a reconnect", () => {
    expect(unpackToken(packToken(X_USER))).toEqual(X_USER);
    for (const bad of ["plain-oauth2-bearer", JSON.stringify({ oauth1: { token: "t" } }), "{}"]) {
      expect(() => unpackToken(bad)).toThrow(expect.objectContaining({ code: "AUTH_EXPIRED" }));
    }
  });
});

describe("X connect (3-legged OAuth 1.0a)", () => {
  it("is configured only with consumer key and secret; getAuthUrl is unsupported; refresh returns null", async () => {
    expect(x().isConfigured()).toBe(true);
    expect(new XAdsConnector({ consumerKey: "k" }).isConfigured()).toBe(false);
    await expect(new XAdsConnector({}).startOAuth1({ redirectUri: REDIRECT })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    expect(() => x().getAuthUrl()).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(await x().refreshTokens()).toBeNull();
  });

  it("startOAuth1 signs a request_token call with oauth_callback and returns the authorize URL", async () => {
    server.use(xRequestToken());
    const out = await x().startOAuth1({ redirectUri: REDIRECT });
    expect(out).toEqual({ url: `${X_OAUTH}/authorize?oauth_token=${X_REQUEST.token}`, requestToken: X_REQUEST.token, requestSecret: X_REQUEST.secret });
    const h = await onlyHit({ path: "/oauth/request_token" });
    expect(h.method).toBe("POST");
    const oauth = parseOAuthHeader(h.headers.get("authorization"))!;
    expect(oauth.oauth_callback).toBe(REDIRECT);
    expect(oauth.oauth_token).toBeUndefined();
  });

  it("startOAuth1 fails clearly when X does not confirm the callback", async () => {
    server.use(xRequestToken(`oauth_token=t&oauth_token_secret=s&oauth_callback_confirmed=false`));
    await expect(x().startOAuth1({ redirectUri: REDIRECT })).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("exchangeCode signs access_token with the request token + verifier and packs the user token (no expiry)", async () => {
    server.use(xAccessToken());
    const t = await x().exchangeCode({ code: "verifier-1", redirectUri: REDIRECT, query: { oauth_token: X_REQUEST.token, oauth_verifier: "verifier-1" }, requestSecret: X_REQUEST.secret });
    expect(t.expiresAt).toBeUndefined();
    expect(t.refreshToken).toBeUndefined();
    expect(t.scopes).toEqual([]);
    expect(unpackToken(t.accessToken)).toEqual(X_USER);
    const oauth = parseOAuthHeader((await onlyHit({ path: "/oauth/access_token" })).headers.get("authorization"))!;
    expect(oauth).toMatchObject({ oauth_token: X_REQUEST.token, oauth_verifier: "verifier-1" });
  });

  it("exchangeCode refuses a callback without the request token or secret", async () => {
    await expect(x().exchangeCode({ code: "v", redirectUri: REDIRECT, query: {}, requestSecret: "s" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(x().exchangeCode({ code: "v", redirectUri: REDIRECT, query: { oauth_token: "t" } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("exchangeCode maps a rejected verifier (401) to AUTH_EXPIRED", async () => {
    server.use(http.post(`${X_OAUTH}/access_token`, () => HttpResponse.json({ errors: [{ code: 32, message: "Could not authenticate you." }] }, { status: 401 })));
    const err = await x().exchangeCode({ code: "v", redirectUri: REDIRECT, query: { oauth_token: "t" }, requestSecret: "s" }).catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.message).toBe("Could not authenticate you.");
  });

  it("getUser reads the id from the token, else GET /2/users/me", async () => {
    expect(await x().getUser(userAuth())).toEqual({ id: "777", name: "@ashniva" });
    server.use(http.get("https://api.x.com/2/users/me", () => HttpResponse.json({ data: { id: "888", name: "Ashniva Store", username: "ashnivastore" } })));
    expect(await x().getUser(userAuth({ userId: undefined, screenName: undefined }))).toEqual({ id: "888", name: "Ashniva Store" });
  });
});

describe("X accounts and structure", () => {
  it("listAdAccounts maps approval status and keeps the timezone", async () => {
    server.use(
      xList("/accounts", [[
        { id: "18ce54d4x5t", name: "Ashniva", currency: "INR", timezone: "Asia/Kolkata", approval_status: "ACCEPTED" },
        { id: "gq1", name: "Pending", currency: "USD", timezone: "America/New_York", approval_status: "UNDER_REVIEW" },
      ]]),
    );
    expect(await x().listAdAccounts(userAuth())).toEqual([
      { externalId: "18ce54d4x5t", name: "Ashniva", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE", meta: { timezone: "Asia/Kolkata" } },
      { externalId: "gq1", name: "Pending", currency: "USD", timezone: "America/New_York", status: "UNDER_REVIEW", meta: { timezone: "America/New_York" } },
    ]);
  });

  it("listAdAccounts follows next_cursor past the first page of accounts", async () => {
    server.use(xList("/accounts", [[{ id: "a1", name: "One" }], [{ id: "a2", name: "Two" }]]));
    expect((await x().listAdAccounts(userAuth())).map((a) => a.externalId)).toEqual(["a1", "a2"]);
  });

  it("an old OAuth 2.0 connection is AUTH_EXPIRED before any request", async () => {
    await expect(x().listAdAccounts({ accessToken: "oauth2-bearer" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await hits()).toHaveLength(0);
  });

  it("fetchStructure follows cursors on every list and converts micros", async () => {
    const id = "18ce54d4x5t";
    server.use(
      xList(`/accounts/${id}/campaigns`, [
        [{ id: "c1", name: "Festive", entity_status: "ACTIVE", objective: "WEBSITE_CLICKS", daily_budget_amount_local_micro: 5_500_000, total_budget_amount_local_micro: null, start_time: "2026-10-01T04:00:00Z", end_time: null, servable: true }],
        [{ id: "c2", name: "Old", entity_status: "PAUSED", daily_budget_amount_local_micro: null, total_budget_amount_local_micro: 100_000_000, start_time: "2026-09-01T00:00:00Z", end_time: "2026-09-30T00:00:00Z", servable: false }],
        [{ id: "c3", name: "Draft", entity_status: "DRAFT" }],
      ]),
      xList(`/accounts/${id}/line_items`, [[{ id: "l1", campaign_id: "c1", name: "IN feed", entity_status: "ACTIVE", bid_type: "AUTO" }]]),
      xList(`/accounts/${id}/promoted_tweets`, [[{ id: "p1", line_item_id: "l1", tweet_id: "1700000000000000001", entity_status: "ACTIVE" }]]),
    );
    const s = await x().fetchStructure(userAuth(), acct());
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.dailyBudget, c.lifetimeBudget, c.startDate, c.endDate, c.deliveryStatus])).toEqual([
      ["c1", "ACTIVE", 5.5, null, "2026-10-01", null, null],
      ["c2", "PAUSED", null, 100, "2026-09-01", "2026-09-30", "NOT_SERVABLE"],
      ["c3", "PAUSED", null, null, null, null, null],
    ]);
    expect(s.adGroups[0]).toMatchObject({ externalId: "l1", campaignExternalId: "c1", bidStrategy: "AUTO", status: "ACTIVE" });
    expect(s.ads[0]).toMatchObject({ externalId: "p1", adGroupExternalId: "l1", campaignExternalId: "c1", name: "Post 1700000000000000001", raw: { tweet_id: "1700000000000000001" } });
    const pages = await hits({ path: `/accounts/${id}/campaigns` });
    expect(pages.map((h) => h.url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    expect(pages.every((h) => h.url.searchParams.get("count") === "1000")).toBe(true);
  });

  it("fetchStructure stops at MAX_PAGES and propagates list errors", async () => {
    const id = "18ce54d4x5t";
    server.use(xList(`/accounts/${id}/campaigns`, [[{ id: "c" }]], { endless: true }), xList(`/accounts/${id}/line_items`, [[]]), xList(`/accounts/${id}/promoted_tweets`, [[]]));
    expect((await x().fetchStructure(userAuth(), acct()).catch((e) => e)).code).toBe("PLATFORM_ERROR");
    expect(await hits({ path: "/campaigns" })).toHaveLength(MAX_PAGES);

    server.use(xList(`/accounts/${id}/line_items`, [[{ id: "l" }], 401]), xList(`/accounts/${id}/campaigns`, [[]]));
    expect((await x().fetchStructure(userAuth(), acct()).catch((e) => e)).code).toBe("AUTH_EXPIRED");
  });

  it("rejects a request X cannot verify (wrong token secret → 401 AUTH_EXPIRED)", async () => {
    server.use(xList("/accounts", [[]]));
    const err = await x().listAdAccounts({ accessToken: packToken({ token: X_USER.token, secret: "wrong" }) }).catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.message).toBe("Could not authenticate you");
  });
});

describe("X stats (fetchMetrics)", () => {
  const id = "18ce54d4x5t";

  it("asks for DAY stats from account-timezone midnight to an exclusive end, and parses micros", async () => {
    server.use(
      xList(`/accounts/${id}/campaigns`, [[{ id: "c1" }, { id: "c2" }]]),
      xGet(`/stats/accounts/${id}`, () =>
        HttpResponse.json({
          data_type: "stats",
          time_series_length: 3,
          data: [
            statsRow("c1", { impressions: [100, 200, 0], clicks: [1, 2, 0], billed_charge_local_micro: [1_500_000, 2_250_000, 0], video_total_views: null }),
            statsRow("c2", { impressions: null, clicks: null, billed_charge_local_micro: null, video_total_views: null }),
          ],
          request: { params: {} },
        }),
      ),
    );
    const rows = await x().fetchMetrics(userAuth(), acct(), { from: "2026-10-01", to: "2026-10-03" });
    expect(rows).toEqual([
      { date: "2026-10-01", level: "CAMPAIGN", externalId: "c1", impressions: 100, clicks: 1, spend: 1.5, conversions: 0, conversionValue: 0, videoViews: 0 },
      { date: "2026-10-02", level: "CAMPAIGN", externalId: "c1", impressions: 200, clicks: 2, spend: 2.25, conversions: 0, conversionValue: 0, videoViews: 0 },
      { date: "2026-10-03", level: "CAMPAIGN", externalId: "c1", impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 },
    ]);
    const q = Object.fromEntries((await onlyHit({ path: "/stats/" })).url.searchParams);
    expect(q).toMatchObject({
      entity: "CAMPAIGN",
      entity_ids: "c1,c2",
      start_time: "2026-10-01T04:00:00Z",
      end_time: "2026-10-04T04:00:00Z",
      granularity: "DAY",
      metric_groups: "ENGAGEMENT,BILLING,VIDEO",
      placement: "ALL_ON_TWITTER",
    });
  });

  it("splits by 20 entity ids and 7-day windows", async () => {
    server.use(
      xList(`/accounts/${id}/campaigns`, [Array.from({ length: 25 }, (_, i) => ({ id: `c${i}` }))]),
      xGet(`/stats/accounts/${id}`, () => HttpResponse.json({ data: [] })),
    );
    await x().fetchMetrics(userAuth(), acct({ timezone: "UTC" }), { from: "2026-10-01", to: "2026-10-10" });
    const calls = (await hits({ path: "/stats/" })).map((h) => [h.url.searchParams.get("entity_ids")!.split(",").length, h.url.searchParams.get("start_time"), h.url.searchParams.get("end_time")]);
    expect(calls).toEqual([
      [20, "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z"],
      [20, "2026-10-08T00:00:00Z", "2026-10-11T00:00:00Z"],
      [5, "2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z"],
      [5, "2026-10-08T00:00:00Z", "2026-10-11T00:00:00Z"],
    ]);
  });

  it("midnightIn handles DST changes and falls back to UTC for unknown zones", () => {
    expect(midnightIn("2026-10-31", "America/New_York")).toBe("2026-10-31T04:00:00Z");
    expect(midnightIn("2026-11-02", "America/New_York")).toBe("2026-11-02T05:00:00Z");
    expect(midnightIn("2026-03-29", "Europe/London")).toBe("2026-03-29T00:00:00Z");
    expect(midnightIn("2026-03-30", "Europe/London")).toBe("2026-03-29T23:00:00Z");
    expect(midnightIn("2026-10-01", "Asia/Kolkata")).toBe("2026-09-30T18:30:00Z");
    expect(midnightIn("2026-10-01", "Not/AZone")).toBe("2026-10-01T00:00:00Z");
  });

  it("uses the timezone stored in meta when the account ref has none", async () => {
    server.use(xList(`/accounts/${id}/campaigns`, [[{ id: "c1" }]]), xGet(`/stats/accounts/${id}`, () => HttpResponse.json({ data: [] })));
    await x().fetchMetrics(userAuth(), acct({ timezone: null, meta: { timezone: "Asia/Tokyo" } }), { from: "2026-10-01", to: "2026-10-01" });
    expect((await onlyHit({ path: "/stats/" })).url.searchParams.get("start_time")).toBe("2026-09-30T15:00:00Z");
  });

  it("a 400 on the report gives no rows, but auth/rate-limit/outage errors propagate", async () => {
    server.use(xList(`/accounts/${id}/campaigns`, [[{ id: "c1" }]]), xGet(`/stats/accounts/${id}`, () => HttpResponse.json({ errors: [{ code: "INVALID_PARAMETER", message: "bad" }] }, { status: 400 })));
    expect(await x().fetchMetrics(userAuth(), acct(), { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
    for (const [status, code] of [[401, "AUTH_EXPIRED"], [403, "PERMISSION_DENIED"], [429, "RATE_LIMITED"], [503, "PLATFORM_ERROR"]] as const) {
      server.use(xGet(`/stats/accounts/${id}`, () => HttpResponse.json({ errors: [{ message: "x" }] }, { status })));
      expect((await x().fetchMetrics(userAuth(), acct(), { from: "2026-10-01", to: "2026-10-01" }).catch((e) => e)).code).toBe(code);
    }
  });
});

describe("X actions", () => {
  const id = "18ce54d4x5t";

  it("setCampaignStatus and setCampaignDailyBudget PUT signed query params (budget in micros)", async () => {
    server.use(xPut(`/accounts/${id}/campaigns/c1`, () => HttpResponse.json({ data: { id: "c1" } })));
    await x().setCampaignStatus(userAuth(), acct(), { externalId: "c1" }, "PAUSED");
    await x().setCampaignStatus(userAuth(), acct(), { externalId: "c1" }, "ACTIVE");
    await x().setCampaignDailyBudget(userAuth(), acct(), { externalId: "c1" }, 12.345678);
    const puts = await hits({ method: "PUT" });
    expect(puts.map((h) => Object.fromEntries(h.url.searchParams))).toEqual([{ entity_status: "PAUSED" }, { entity_status: "ACTIVE" }, { daily_budget_amount_local_micro: "12345678" }]);
    expect(puts.every((h) => h.text === "")).toBe(true);
  });

  it.each(STATUS_CODES)("maps HTTP %i to %s", async (status, code) => {
    server.use(xPut(`/accounts/${id}/campaigns/c1`, () => HttpResponse.json({ errors: [{ code: "E", message: `status ${status}` }] }, { status })));
    const err = await x().setCampaignStatus(userAuth(), acct(), { externalId: "c1" }, "PAUSED").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(`status ${status}`);
  });
});

describe("X createCampaign", () => {
  const id = "18ce54d4x5t";
  const TWEET = "1850000000000000001"; // > 2^53: only id_str is exact

  function happyPath(opts: { lineFails?: boolean } = {}) {
    return [
      xGet(`/accounts/${id}/promotable_users`, () => HttpResponse.json({ data: [{ id: "pu1", user_id: "999", promotable_user_type: "RETWEETS_ONLY" }, { id: "pu2", user_id: "4242", promotable_user_type: "FULL" }] })),
      http.post("https://api.x.com/2/media/upload/initialize", () => HttpResponse.json({ data: { id: "1880028106020515840", media_key: "3_1880028106020515840", expires_after_secs: 86400 } })),
      http.post("https://api.x.com/2/media/upload/:mediaId/append", () => HttpResponse.json({ data: { expires_at: 1_900_000_000 } })),
      http.post("https://api.x.com/2/media/upload/:mediaId/finalize", () => HttpResponse.json({ data: { id: "1880028106020515840", media_key: "3_1880028106020515840", size: 15 } })),
      xPost(`/accounts/${id}/media_library`, () => HttpResponse.json({ data: { media_key: "3_1880028106020515840" } })),
      xPost(`/accounts/${id}/tweet`, () => HttpResponse.json({ data: { id: 1850000000000000001, id_str: TWEET, text: "The festive edit is live" } })),
      xPost(`/accounts/${id}/campaigns`, () => HttpResponse.json({ data: { id: "8wku2", entity_status: "PAUSED" } })),
      xPost(`/accounts/${id}/line_items`, () => (opts.lineFails ? HttpResponse.json({ errors: [{ code: "INVALID_PARAMETER", message: "bid too low" }] }, { status: 400 }) : HttpResponse.json({ data: { id: "8v7jo" } }))),
      xPost(`/accounts/${id}/promoted_tweets`, () => HttpResponse.json({ data: [{ id: "6thl4", line_item_id: "8v7jo", tweet_id: TWEET, entity_status: "ACTIVE" }] })),
      xDelete(`/accounts/${id}/campaigns/8wku2`, () => HttpResponse.json({ data: { id: "8wku2", deleted: true } })),
    ];
  }

  const draft = (over: { campaign?: Record<string, unknown>; adGroup?: Record<string, unknown> } = {}) =>
    makeDraft("X", { objective: "WEBSITE_CLICKS" }, {
      campaign: { fundingInstrumentId: "lygyi", budget: 25, ...over.campaign },
      adGroup: { bidAmount: 0, ...over.adGroup },
      ad: { text: "The festive edit is live", url: "https://shop.example.com/festive", video: ["img-1"] },
    });

  it("creates a nullcast post, then a paused campaign, line item and promoted tweet with documented params", async () => {
    server.use(...happyPath());
    const d = draft();
    const uploaded: string[] = [];
    const out = await x().createCampaign(userAuth(), acct(), d, assetsOf(imageAsset("img-1", { onUploaded: async (r) => void uploaded.push(r) })));

    const init = await onlyHit({ path: "/2/media/upload/initialize" });
    expect(init.json).toEqual({ media_type: "image/jpeg", total_bytes: 15, media_category: "tweet_image" });
    expect((await onlyHit({ path: /\/append$/ })).json).toEqual({ media: Buffer.from("fake-jpeg-bytes").toString("base64"), segment_index: 0 });
    expect(Object.fromEntries((await onlyHit({ path: "/media_library" })).url.searchParams)).toMatchObject({ media_key: "3_1880028106020515840", file_name: "img-1.jpg" });
    expect(uploaded).toEqual(["x:3_1880028106020515840"]);

    const tweet = Object.fromEntries((await onlyHit({ path: `/accounts/${id}/tweet` })).url.searchParams);
    expect(tweet).toEqual({ as_user_id: "4242", text: "The festive edit is live\nhttps://shop.example.com/festive", media_keys: "3_1880028106020515840", nullcast: "true", name: "Ad 1", trim_user: "true" });

    const campaign = Object.fromEntries((await onlyHit({ path: `/accounts/${id}/campaigns` })).url.searchParams);
    expect(campaign).toEqual({ name: "Festive Sale", funding_instrument_id: "lygyi", entity_status: "PAUSED", daily_budget_amount_local_micro: "25000000" });

    const line = Object.fromEntries((await onlyHit({ path: "/line_items" })).url.searchParams);
    expect(line).toMatchObject({ campaign_id: "8wku2", entity_status: "PAUSED", objective: "WEBSITE_CLICKS", product_type: "PROMOTED_TWEETS", placements: "ALL_ON_TWITTER", bid_strategy: "AUTO", goal: "LINK_CLICKS" });
    expect(line.bid_amount_local_micro).toBeUndefined();
    expect(line.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Object.fromEntries((await onlyHit({ path: "/promoted_tweets" })).url.searchParams)).toEqual({ line_item_id: "8v7jo", tweet_ids: TWEET });

    expect(out.campaigns[0]).toMatchObject({ externalId: "8wku2", status: "PAUSED", dailyBudget: 25, lifetimeBudget: null });
    expect(out.adGroups[0]).toMatchObject({ externalId: "8v7jo", sourceKey: d.adGroups[0]!.key });
    expect(out.ads[0]).toMatchObject({ externalId: "6thl4", body: "The festive edit is live", finalUrl: "https://shop.example.com/festive", sourceKey: d.adGroups[0]!.ads[0]!.key });
  });

  it("never calls api.x.com/2/tweets or the v1.1 statuses endpoints", async () => {
    server.use(...happyPath());
    await x().createCampaign(userAuth(), acct(), draft(), assetsOf(imageAsset("img-1")));
    const all = await hits();
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((h) => /^\/(2\/tweets|1\.1\/statuses)/.test(h.url.pathname))).toEqual([]);
    for (const h of all) expect(parseOAuthHeader(h.headers.get("authorization"))?.oauth_token).toBe(X_USER.token);
  });

  it("reuses a cached Media Library key, bids in micros with MAX, and launches ACTIVE when asked", async () => {
    server.use(...happyPath());
    await x().createCampaign(userAuth(), acct(), draft({ campaign: { launchStatus: "ACTIVE" }, adGroup: { bidAmount: 1.25, goal: "SITE_VISITS" } }), assetsOf(imageAsset("img-1", { cachedRef: "x:3_cached" })));
    expect(await hits({ path: "/2/media" })).toHaveLength(0);
    expect((await onlyHit({ path: `/accounts/${id}/tweet` })).url.searchParams.get("media_keys")).toBe("3_cached");
    expect((await onlyHit({ path: `/accounts/${id}/campaigns` })).url.searchParams.get("entity_status")).toBe("ACTIVE");
    const line = (await onlyHit({ path: "/line_items" })).url.searchParams;
    expect([line.get("bid_strategy"), line.get("bid_amount_local_micro"), line.get("goal"), line.get("entity_status")]).toEqual(["MAX", "1250000", "SITE_VISITS", "ACTIVE"]);
  });

  it("falls back to the connected user when the account has no FULL promotable user, and fails without either", async () => {
    server.use(xGet(`/accounts/${id}/promotable_users`, () => HttpResponse.json({ data: [] })), ...happyPath());
    await x().createCampaign(userAuth(), acct(), draft(), assetsOf(imageAsset("img-1", { cachedRef: "x:k" })));
    expect((await onlyHit({ path: `/accounts/${id}/tweet` })).url.searchParams.get("as_user_id")).toBe("777");

    const err = await x().createCampaign(userAuth({ userId: undefined }), acct(), draft(), new Map()).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
  });

  it("a post X rejects fails before any campaign exists", async () => {
    server.use(xPost(`/accounts/${id}/tweet`, () => HttpResponse.json({ data: { id: 1 } })), ...happyPath());
    const err = await x().createCampaign(userAuth(), acct(), draft(), assetsOf(imageAsset("img-1", { cachedRef: "x:k" }))).catch((e) => e);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(await hits({ path: `/accounts/${id}/campaigns` })).toHaveLength(0);
  });

  it("a line item failure after the campaign was created deletes the campaign (rollback)", async () => {
    server.use(...happyPath({ lineFails: true }));
    const err = await x().createCampaign(userAuth(), acct(), draft(), assetsOf(imageAsset("img-1", { cachedRef: "x:k" }))).catch((e) => e);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(await hits({ method: "DELETE", path: "/campaigns/8wku2" })).toHaveLength(1);
  });

  it("assertPromotedOnly refuses public posts and non-nullcast Ads API tweets", () => {
    expect(() => assertPromotedOnly("https://api.x.com/2/tweets", {})).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(() => assertPromotedOnly("https://api.x.com/1.1/statuses/update.json", {})).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(() => assertPromotedOnly(`${X_ADS}/accounts/a/tweet`, {})).toThrow(/nullcast/);
    expect(() => assertPromotedOnly(`${X_ADS}/accounts/a/draft_tweets`, { nullcast: false })).toThrow(/nullcast/);
    expect(() => assertPromotedOnly(`${X_ADS}/accounts/a/tweet`, { nullcast: true })).not.toThrow();
    expect(() => assertPromotedOnly(`${X_ADS}/accounts/a/campaigns`, {})).not.toThrow();
  });

  it("builder options and targeting are empty without HTTP", async () => {
    expect(await x().getBuilderOptions()).toEqual({});
    expect(await x().searchTargeting()).toEqual([]);
  });
});
