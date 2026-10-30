import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyConnector, shopifyShop, verifyShopifyHmac } from "../../src/shopify";
import { MAX_PAGES } from "../../src/http";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import { marketingEvent, SHOP, shopAdmin, shopifyHandlers, SHOPIFY_SECRET, shopRow, shopState, signQuery } from "../msw/handlers/shopify";

useMswServer();
afterEach(() => vi.useRealTimers());

const shopify = () => new ShopifyConnector({ clientId: "shp-client", clientSecret: SHOPIFY_SECRET });
const packed = `${SHOP} shpat_abc`;
const acc = account(SHOP, { currency: "INR", timezone: "Asia/Kolkata" });
const callback = (over: Record<string, string> = {}) => signQuery({ code: "auth-code", host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZmVzdGl2ZQ", shop: SHOP, state: shopState(), timestamp: "1760522400", ...over });

describe("shopifyShop (store domain validation)", () => {
  it.each([
    ["festive-store", SHOP],
    [" Festive-Store.MyShopify.com ", SHOP],
    ["https://festive-store.myshopify.com/admin/products", SHOP],
    ["http://festive-store.myshopify.com", SHOP],
    ["shop123.myshopify.com", "shop123.myshopify.com"],
  ])("accepts %j → %s", (raw, shop) => {
    expect(shopifyShop(raw)).toBe(shop);
  });

  it.each([
    "",
    "evil.com",
    "festive-store.myshopify.com.evil.com",
    "evil.com/festive-store.myshopify.com",
    "festive-store.myshopify.com@evil.com",
    "festive-store.myshopify.com:8443",
    "festive-store.myshopify.com?x=1",
    "festive-store.myshopify.com#frag",
    "localhost:3000",
    "127.0.0.1",
    "169.254.169.254",
    "-store.myshopify.com",
    "my_store.myshopify.com",
    "a.b.myshopify.com",
    "myshopify.com",
  ])("rejects %j with INVALID_REQUEST (no request to arbitrary hosts)", (raw) => {
    expect(() => shopifyShop(raw)).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });
});

describe("verifyShopifyHmac", () => {
  it("accepts Shopify's signature over the sorted query minus hmac", () => {
    expect(verifyShopifyHmac(callback(), SHOPIFY_SECRET)).toBe(true);
  });

  it("ignores a legacy `signature` param when checking", () => {
    expect(verifyShopifyHmac({ ...callback(), signature: "legacy" }, SHOPIFY_SECRET)).toBe(true);
  });

  it("rejects a tampered value, an added param, the wrong secret, a missing or truncated hmac", () => {
    expect(verifyShopifyHmac({ ...callback(), shop: "other.myshopify.com" }, SHOPIFY_SECRET)).toBe(false);
    expect(verifyShopifyHmac({ ...callback(), extra: "1" }, SHOPIFY_SECRET)).toBe(false);
    expect(verifyShopifyHmac(callback(), "other-secret")).toBe(false);
    const { hmac, ...rest } = callback();
    expect(verifyShopifyHmac(rest, SHOPIFY_SECRET)).toBe(false);
    expect(verifyShopifyHmac({ ...rest, hmac: hmac.slice(0, 32) }, SHOPIFY_SECRET)).toBe(false);
    expect(verifyShopifyHmac({ ...rest, hmac: "" }, SHOPIFY_SECRET)).toBe(false);
    expect(verifyShopifyHmac({ ...rest, hmac: ["x"] as unknown as string }, SHOPIFY_SECRET)).toBe(false);
  });

  it("joins array params with commas before signing", () => {
    const query = { ids: ["1", "2"], shop: SHOP, timestamp: "1" };
    const hmac = createHmac("sha256", SHOPIFY_SECRET).update(`ids=1,2&shop=${SHOP}&timestamp=1`).digest("hex");
    expect(verifyShopifyHmac({ ...query, hmac }, SHOPIFY_SECRET)).toBe(true);
  });

  it("returns false (does not throw) for a forged hmac of the right length with non-ASCII characters (shopify/index.ts:45)", () => {
    // 64 UTF-16 chars but 65 bytes: timingSafeEqual throws RangeError on the byte-length mismatch.
    const { hmac } = callback();
    const forged = `é${hmac.slice(1)}`;
    expect(verifyShopifyHmac({ ...callback(), hmac: forged }, SHOPIFY_SECRET)).toBe(false);
  });
});

describe("Shopify OAuth", () => {
  it("is not configured without both keys", () => {
    expect(new ShopifyConnector({ clientId: "x" }).isConfigured()).toBe(false);
    expect(() => new ShopifyConnector({}).getAuthUrl({ state: shopState(), redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("getAuthUrl goes to the store from the signed state with the marketing-events scope", () => {
    const url = new URL(shopify().getAuthUrl({ state: shopState(), redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`);
    expect(queryOf(url.toString())).toEqual({ client_id: "shp-client", scope: "write_marketing_events", redirect_uri: REDIRECT, state: shopState() });
  });

  it.each([["no payload", "just-a-string"], ["bad base64", "a.%%%.c"], ["no shop", shopState("")], ["foreign host", shopState("evil.com")], ["metadata IP", shopState("169.254.169.254")]])(
    "getAuthUrl rejects a state with %s",
    (_label, state) => {
      expect(() => shopify().getAuthUrl({ state, redirectUri: REDIRECT })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    },
  );

  it("exchangeCode checks the hmac, posts to the store's token URL and packs the shop into the token", async () => {
    server.use(...shopifyHandlers());
    const q = callback();
    const t = await shopify().exchangeCode({ code: "auth-code", redirectUri: REDIRECT, state: q.state, query: q });
    expect(t).toMatchObject({ accessToken: `${SHOP} shpat_abc`, refreshToken: undefined, expiresAt: undefined, scopes: ["write_marketing_events"] });
    const h = await onlyHit({ method: "POST" });
    expect(h.url.toString()).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(Object.fromEntries(h.form!)).toEqual({ client_id: "shp-client", client_secret: SHOPIFY_SECRET, code: "auth-code", redirect_uri: REDIRECT });
  });

  it("exchangeCode with an expiring offline token sets expiresAt and packs the refresh token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...shopifyHandlers({ token: { access_token: "shpat_x", expires_in: 86_400, refresh_token: "shprt_y", refresh_token_expires_in: 7_776_000, scope: "write_marketing_events,read_marketing_events" } }));
    const q = callback();
    const t = await shopify().exchangeCode({ code: "auth-code", redirectUri: REDIRECT, state: q.state, query: q });
    expect(t.expiresAt?.toISOString()).toBe("2026-10-16T10:00:00.000Z");
    expect(t.refreshToken).toBe(`${SHOP} shprt_y`);
  });

  it("exchangeCode rejects a forged callback before any request", async () => {
    server.use(...shopifyHandlers());
    const q = { ...callback(), code: "stolen" };
    await expect(shopify().exchangeCode({ code: "stolen", redirectUri: REDIRECT, state: q.state, query: q })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toEqual([]);
  });

  it("exchangeCode refuses a grant without write_marketing_events", async () => {
    server.use(...shopifyHandlers({ token: { access_token: "shpat_x", scope: "read_products" } }));
    const q = callback();
    await expect(shopify().exchangeCode({ code: "auth-code", redirectUri: REDIRECT, state: q.state, query: q })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.each([
    [400, "INVALID_REQUEST"],
    [401, "AUTH_EXPIRED"],
    [429, "RATE_LIMITED"],
    [500, "PLATFORM_ERROR"],
  ])("token endpoint HTTP %i → %s", async (status, code) => {
    server.use(http.post(`https://${SHOP}/admin/oauth/access_token`, () => fail(status, { error: "invalid_request", error_description: "The authorization code was not found or was already used" })));
    const q = callback();
    await expect(shopify().exchangeCode({ code: "auth-code", redirectUri: REDIRECT, state: q.state, query: q })).rejects.toMatchObject({ code });
  });

  it("refreshTokens keeps the old refresh token when Shopify returns none", async () => {
    server.use(...shopifyHandlers());
    const t = await shopify().refreshTokens(`${SHOP} shprt_old`);
    expect(t).toMatchObject({ accessToken: `${SHOP} shpat_new`, refreshToken: `${SHOP} shprt_old` });
    const h = await onlyHit({ method: "POST" });
    expect(Object.fromEntries(h.form!)).toEqual({ client_id: "shp-client", client_secret: SHOPIFY_SECRET, grant_type: "refresh_token", refresh_token: "shprt_old" });
  });

  it.each(["", "shprt_only", `evil.com shprt`, `${SHOP} `])("refreshTokens rejects an incomplete stored login %j as AUTH_EXPIRED", async (stored) => {
    await expect(shopify().refreshTokens(stored)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Shopify reads", () => {
  it("getUser and listAdAccounts read shop.json with X-Shopify-Access-Token", async () => {
    server.use(...shopifyHandlers());
    expect(await shopify().getUser(auth(packed))).toEqual({ id: SHOP, name: "Festive Store" });
    expect(await shopify().listAdAccounts(auth(packed))).toEqual([{ externalId: SHOP, name: "Festive Store", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE", meta: { shop: SHOP } }]);
    for (const h of await hits()) {
      expect(h.url.toString()).toBe(`${shopAdmin()}/shop.json`);
      expect(h.headers.get("x-shopify-access-token")).toBe("shpat_abc");
      expect(h.headers.get("authorization")).toBeNull();
    }
  });

  it("listAdAccounts falls back to the packed shop and USD when shop.json is sparse", async () => {
    server.use(...shopifyHandlers({ shop: {} }));
    expect((await shopify().listAdAccounts(auth(packed)))[0]).toMatchObject({ externalId: SHOP, name: SHOP, currency: "USD", timezone: null });
  });

  it.each([
    [401, "AUTH_EXPIRED"],
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "PLATFORM_ERROR"],
  ])("shop.json HTTP %i → %s", async (status, code) => {
    server.use(http.get(`${shopAdmin()}/shop.json`, () => fail(status, { errors: "[API] Invalid API key or access token" })));
    await expect(shopify().listAdAccounts(auth(packed))).rejects.toMatchObject({ code });
  });

  it("follows Link rel=next pages to the last one", async () => {
    const events = Array.from({ length: 5 }, (_, i) => marketingEvent(i + 1));
    server.use(...shopifyHandlers({ events, pageSize: 2 }));
    const s = await shopify().fetchStructure(auth(packed), acc);
    expect(s.campaigns.map((c) => c.externalId)).toEqual(["1", "2", "3", "4", "5"]);
    const gets = await hits({ path: "marketing_events.json" });
    expect(gets).toHaveLength(3);
    expect(gets[0]!.url.searchParams.get("limit")).toBe("250");
    expect(gets[2]!.url.searchParams.get("page_info")).toBe("p2");
  });

  it("stops with PLATFORM_ERROR instead of saving a partial list past the page cap", async () => {
    server.use(...shopifyHandlers({ endlessPages: true, pageSize: 1 }));
    await expect(shopify().fetchStructure(auth(packed), acc)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
    expect(await hits({ path: "marketing_events.json" })).toHaveLength(MAX_PAGES);
  });

  it("propagates an error on a later page", async () => {
    let n = 0;
    server.use(http.get(`${shopAdmin()}/marketing_events.json`, () => (n++ === 0 ? HttpResponse.json({ marketing_events: [marketingEvent(1)] }, { headers: { Link: `<${shopAdmin()}/marketing_events.json?page_info=x>; rel="next"` } }) : fail(401, { errors: "expired" }))));
    await expect(shopify().fetchStructure(auth(packed), acc)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("maps each marketing event to a campaign → tracking group → landing page", async () => {
    server.use(...shopifyHandlers({
      events: [
        marketingEvent(1),
        marketingEvent(2, { budget: "300.00", budget_type: "lifetime", ended_at: "2026-01-01T00:00:00Z", utm_campaign: null }),
        marketingEvent(3, { budget: null, ended_at: "2999-01-01T00:00:00Z", referring_domain: null }),
      ],
    }));
    const s = await shopify().fetchStructure(auth(packed), acc);
    expect(s.campaigns[0]).toMatchObject({ externalId: "1", name: "Campaign 1", status: "ACTIVE", objective: "social", dailyBudget: 12.5, lifetimeBudget: null, startDate: "2026-10-01", endDate: null });
    expect(s.campaigns[1]).toMatchObject({ name: "Event 2 description", status: "PAUSED", dailyBudget: null, lifetimeBudget: 300, endDate: "2026-01-01" });
    expect(s.campaigns[2]).toMatchObject({ status: "ACTIVE", dailyBudget: null });
    expect(s.adGroups[0]).toMatchObject({ externalId: "1:track", campaignExternalId: "1" });
    expect(s.ads[0]).toMatchObject({ externalId: "1:page", adGroupExternalId: "1:track", finalUrl: "https://shop.example.com", body: "Event 1 description" });
    expect(s.ads[2]?.finalUrl).toBeNull();
  });

  it("fetchMetrics returns no rows and makes no request", async () => {
    expect(await shopify().fetchMetrics()).toEqual([]);
    expect(await hits()).toEqual([]);
  });
});

describe("Shopify actions", () => {
  it("pausing ends the marketing event now; activating clears ended_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...shopifyHandlers());
    await shopify().setCampaignStatus(auth(packed), acc, { externalId: "42" }, "PAUSED");
    await shopify().setCampaignStatus(auth(packed), acc, { externalId: "42" }, "ACTIVE");
    const [pause, resume] = await hits({ method: "PUT" });
    expect(pause!.url.toString()).toBe(`${shopAdmin()}/marketing_events/42.json`);
    expect(pause!.json).toEqual({ marketing_event: { id: 42, ended_at: NOW.toISOString() } });
    expect(resume!.json).toEqual({ marketing_event: { id: 42, ended_at: null } });
  });

  it("setCampaignDailyBudget sends a decimal string with the currency", async () => {
    server.use(...shopifyHandlers());
    await shopify().setCampaignDailyBudget(auth(packed), acc, { externalId: "42" }, 25);
    expect((await onlyHit({ method: "PUT" })).json).toEqual({ marketing_event: { id: 42, budget: "25.00", budget_type: "daily", currency: "INR" } });
  });

  it("propagates a 404 on an unknown event as INVALID_REQUEST", async () => {
    server.use(http.put(`${shopAdmin()}/marketing_events/:id.json`, () => fail(404, { errors: "Not Found" })));
    await expect(shopify().setCampaignStatus(auth(packed), acc, { externalId: "9" }, "PAUSED")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("Shopify createCampaign", () => {
  const draft = (campaign: Record<string, unknown> = {}) =>
    makeDraft("SHOPIFY", { channel: "search" }, { campaign: { budget: 50, utmSource: "google", utmMedium: "cpc", ...campaign }, ad: { url: "https://festive-store.com/collections/diwali?ref=x", description: "Diwali edit" } });

  it("records a paid marketing event with UTMs, a decimal budget and the landing domain; paused by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(...shopifyHandlers());
    const d = draft();
    const made = await shopify().createCampaign(auth(packed), acc, d, new Map());
    const h = await onlyHit({ method: "POST" });
    expect(h.url.toString()).toBe(`${shopAdmin()}/marketing_events.json`);
    expect(h.json).toEqual({
      marketing_event: {
        event_type: "ad",
        marketing_channel: "search",
        paid: true,
        started_at: NOW.toISOString(),
        // "Create paused" is "Record as ended" (specs/shopify.ts): the event ends when it starts.
        ended_at: NOW.toISOString(),
        budget: "50.00",
        budget_type: "daily",
        currency: "INR",
        utm_campaign: "Festive Sale",
        utm_source: "google",
        utm_medium: "cpc",
        description: "Diwali edit",
        referring_domain: "festive-store.com",
      },
    });
    expect(made.campaigns[0]).toMatchObject({ externalId: "998730395", status: "PAUSED", dailyBudget: 50 });
    expect(made.adGroups[0]?.sourceKey).toBe(d.adGroups[0]!.key);
    expect(made.ads[0]?.sourceKey).toBe(d.adGroups[0]!.ads[0]!.key);
    expect(made.warnings?.[0]).toMatch(/marketing event/);
  });

  it("marks the result ACTIVE when asked and omits an unusable referring domain", async () => {
    server.use(...shopifyHandlers());
    const d = draft({ launchStatus: "ACTIVE" });
    d.adGroups[0]!.ads[0]!.values.url = "not a url";
    const made = await shopify().createCampaign(auth(packed), acc, d, new Map());
    expect(made.campaigns[0]?.status).toBe("ACTIVE");
    expect((await onlyHit({ method: "POST" })).json.marketing_event).not.toHaveProperty("referring_domain");
  });

  it("fails when Shopify returns no event id", async () => {
    server.use(http.post(`${shopAdmin()}/marketing_events.json`, () => HttpResponse.json({})));
    await expect(shopify().createCampaign(auth(packed), acc, draft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("propagates a 422 validation error", async () => {
    server.use(http.post(`${shopAdmin()}/marketing_events.json`, () => fail(422, { errors: { utm_source: ["can't be blank"] } })));
    await expect(shopify().createCampaign(auth(packed), acc, draft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("never calls a host other than the packed store", async () => {
    server.use(...shopifyHandlers());
    await shopify().createCampaign(auth(packed), acc, draft(), new Map());
    for (const h of await hits()) expect(h.url.hostname).toBe(SHOP);
  });
});

it("shopRow fixture matches the documented Shop resource fields", () => {
  expect(Object.keys(shopRow())).toEqual(expect.arrayContaining(["myshopify_domain", "currency", "iana_timezone"]));
});
