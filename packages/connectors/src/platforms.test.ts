/**
 * Unit tests for the nine newer ad platforms (forms, credential groups, OAuth
 * helpers) and integration tests that run each connector against a fake HTTP API.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  BUILDER_SPECS,
  CREDENTIAL_GROUPS,
  PLATFORMS,
  PLATFORM_INFO,
  isVisible,
  levelFields,
  newDraft,
  validateDraft,
  type Field,
  type FieldContext,
  type Platform,
  type PlatformBuilderSpec,
  type Values,
} from "@ashniva/shared";
import { DEMO_ACCOUNTS } from "./demo";
import { mapStatus, pkce, selfRedirect } from "./oauth-flow";
import { createConnectorRegistry, type ConnectorsConfig } from "./index";
import { AmazonAdsConnector } from "./amazon";
import { AppleAdsConnector } from "./apple";
import { CriteoConnector } from "./criteo";
import { OutbrainConnector } from "./outbrain";
import { SpotifyAdsConnector } from "./spotify";
import { TaboolaConnector } from "./taboola";
import { TradeDeskConnector } from "./tradedesk";
import { XAdsConnector } from "./x";
import { ShopifyConnector } from "./shopify";
import { YahooDspConnector } from "./yahoo";
import type { AccountRef } from "./types";

const NEWER: Platform[] = ["AMAZON", "X", "APPLE", "SPOTIFY", "CRITEO", "TABOOLA", "OUTBRAIN", "TRADEDESK", "YAHOO"];

const SETUPS: Record<string, Values> = {
  AMAZON: { adProduct: "SPONSORED_PRODUCTS" },
  X: { objective: "WEBSITE_CLICKS" },
  APPLE: { channel: "SEARCH" },
  SPOTIFY: { objective: "CLICKS" },
  CRITEO: { goal: "RETARGETING" },
  TABOOLA: { objective: "TRAFFIC" },
  OUTBRAIN: { objective: "Traffic" },
  TRADEDESK: { format: "DISPLAY" },
  YAHOO: { format: "DISPLAY" },
};

function placeholder(field: Field): unknown {
  if (field.type === "url" || field.key.toLowerCase().includes("url")) return "https://cdn.example.com/creative.jpg";
  if (field.type === "keywords") return [{ text: "lehenga", matchType: "EXACT" }];
  if (field.type === "targeting") return [{ id: "IN", name: "India", type: "country" }];
  if (field.key === "adamId") return "1234567890";
  if (field.key === "asin" || field.key === "sku") return "B0TESTASIN";
  if (field.key === "asins") return "B0TESTASIN\nB0TESTASI2";
  if (field.key === "fundingInstrumentId") return "fi-1";
  if (field.type === "textarea" || field.type === "text") return field.key === "text" ? "The festive edit is live" : "Festive edit";
  return "Festive edit";
}

function fillLevel(level: { sections: { showIf?: FieldContext extends never ? never : (ctx: FieldContext) => boolean; fields: Field[] }[] }, values: Values, ctx: FieldContext) {
  for (const section of level.sections) {
    if (!isVisible(section, ctx)) continue;
    for (const field of section.fields) {
      if (field.type === "info" || !isVisible(field, ctx)) continue;
      if (field.type === "money" || field.type === "number") {
        if (values[field.key] == null || values[field.key] === "") values[field.key] = Math.max(field.min ?? 1, 25);
        continue;
      }
      const empty = values[field.key] == null || values[field.key] === "" || (Array.isArray(values[field.key]) && (values[field.key] as unknown[]).length === 0);
      if (field.required && empty) values[field.key] = placeholder(field);
    }
  }
}

function readyDraft(platform: Platform, setup: Values = SETUPS[platform]!) {
  const spec = BUILDER_SPECS[platform];
  const draft = newDraft(spec, "acct-1", setup, "Festive");
  const base: FieldContext = { setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  fillLevel(spec.campaign, draft.campaign, base);
  const adSpec = spec.ad(setup);
  for (const g of draft.adGroups) {
    const gctx = { ...base, adGroup: g.values };
    fillLevel(spec.adGroup, g.values, gctx);
    if (!adSpec) continue;
    for (const a of g.ads) fillLevel(adSpec, a.values, { ...gctx, ad: a.values });
  }
  return draft;
}

function fieldKeys(spec: PlatformBuilderSpec, setup: Values) {
  const ad = spec.ad(setup);
  return {
    campaign: levelFields(spec.campaign).map((f) => f.key),
    group: levelFields(spec.adGroup).map((f) => f.key),
    ad: ad ? levelFields(ad).map((f) => f.key) : [],
  };
}

describe("unit: platform catalogue and forms", () => {
  it("registers a live card, credential group and builder for every new platform", () => {
    for (const id of NEWER) {
      assert.equal(PLATFORM_INFO[id].availability, "live");
      assert.ok(PLATFORM_INFO[id].name.length > 1);
      assert.ok(BUILDER_SPECS[id].platform === id);
      const group = CREDENTIAL_GROUPS.find((g) => g.platform === id);
      assert.ok(group, `${id} credential group`);
      assert.ok(group.fields.length > 0);
      assert.ok(group.fields.some((f) => f.secret));
    }
    assert.deepEqual(PLATFORMS.filter((p) => NEWER.includes(p)), NEWER);
  });

  it("keeps OAuth redirects only on platforms that send the user to a login page", () => {
    const redirect = new Set(CREDENTIAL_GROUPS.filter((g) => g.needsRedirectUrl).map((g) => g.platform));
    for (const id of ["AMAZON", "X", "SPOTIFY", "YAHOO"] as const) assert.equal(redirect.has(id), true);
    for (const id of ["APPLE", "CRITEO", "TABOOLA", "OUTBRAIN", "TRADEDESK"] as const) assert.equal(redirect.has(id), false);
  });

  it("builds a valid paused draft for each platform's main setup", () => {
    for (const id of NEWER) {
      const draft = readyDraft(id);
      assert.equal(draft.campaign.launchStatus, "PAUSED");
      const issues = validateDraft(BUILDER_SPECS[id], draft, new Map());
      assert.deepEqual(issues, [], `${id}: ${issues.map((i) => i.message).join("; ")}`);
    }
  });

  it("rejects a campaign with no name", () => {
    const draft = readyDraft("TABOOLA");
    draft.campaign.name = "";
    const issues = validateDraft(BUILDER_SPECS.TABOOLA, draft, new Map());
    assert.ok(issues.some((i) => i.field === "name"));
  });

  it("matches each platform's ad formats", () => {
    const taboola = fieldKeys(BUILDER_SPECS.TABOOLA, SETUPS.TABOOLA!);
    assert.ok(taboola.campaign.includes("brand") && taboola.campaign.includes("devices") && taboola.campaign.includes("locations"));
    assert.ok(["title", "description", "url", "imageUrl"].every((k) => taboola.ad.includes(k)));

    const outbrain = fieldKeys(BUILDER_SPECS.OUTBRAIN, SETUPS.OUTBRAIN!);
    assert.ok(outbrain.campaign.includes("bidType") && outbrain.campaign.includes("cpc"));
    assert.ok(["title", "url", "imageUrl"].every((k) => outbrain.ad.includes(k)));

    const amazon = BUILDER_SPECS.AMAZON;
    assert.deepEqual(setupValues(amazon), ["SPONSORED_PRODUCTS", "SPONSORED_BRANDS", "SPONSORED_DISPLAY"]);
    const products = fieldKeys(amazon, { adProduct: "SPONSORED_PRODUCTS" });
    assert.ok(products.group.includes("keywords") && products.group.includes("defaultBid"));
    assert.ok(products.ad.includes("asin"));
    const brands = fieldKeys(amazon, { adProduct: "SPONSORED_BRANDS" });
    assert.ok(brands.ad.includes("headline") && brands.ad.includes("asins") && brands.ad.includes("url"));

    const x = fieldKeys(BUILDER_SPECS.X, SETUPS.X!);
    assert.deepEqual(setupValues(BUILDER_SPECS.X), ["REACH", "ENGAGEMENTS", "WEBSITE_CLICKS", "VIDEO_VIEWS", "APP_INSTALLS", "FOLLOWERS"]);
    assert.ok(x.campaign.includes("fundingInstrumentId") && x.group.includes("bidAmount"));
    assert.ok(x.ad.includes("text") && x.ad.includes("url") && x.ad.includes("appId") && x.ad.includes("video"));

    const apple = fieldKeys(BUILDER_SPECS.APPLE, SETUPS.APPLE!);
    assert.ok(apple.campaign.includes("adamId") && apple.campaign.includes("locations"));
    assert.ok(apple.group.includes("searchMatch") && apple.group.includes("cpt") && apple.group.includes("keywords"));
    assert.equal(apple.ad.includes("video"), false);

    const spotify = fieldKeys(BUILDER_SPECS.SPOTIFY, SETUPS.SPOTIFY!);
    assert.ok(["audioUrl", "companionUrl", "videoUrl", "thumbnailUrl", "imageUrl"].every((k) => spotify.ad.includes(k)));
    const audio = readyDraft("SPOTIFY", { objective: "REACH" });
    audio.adGroups[0]!.ads[0]!.values.audioUrl = "";
    assert.ok(validateDraft(BUILDER_SPECS.SPOTIFY, audio, new Map()).some((i) => i.field === "audioUrl"));

    const criteo = fieldKeys(BUILDER_SPECS.CRITEO, SETUPS.CRITEO!);
    assert.deepEqual(setupValues(BUILDER_SPECS.CRITEO), ["RETARGETING", "PROSPECTING"]);
    assert.ok(["headline", "url", "imageUrl", "format"].every((k) => criteo.ad.includes(k)));

    const yahoo = fieldKeys(BUILDER_SPECS.YAHOO, SETUPS.YAHOO!);
    assert.deepEqual(setupValues(BUILDER_SPECS.YAHOO), ["DISPLAY", "NATIVE", "VIDEO"]);
    assert.ok(yahoo.ad.includes("url") && yahoo.ad.includes("imageUrl") && yahoo.ad.includes("videoUrl") && yahoo.ad.includes("size"));

    const ttd = BUILDER_SPECS.TRADEDESK.setup[0]!.options as { value: string; disabled?: boolean; disabledReason?: string }[];
    assert.equal(ttd.find((o) => o.value === "CTV")?.disabled, true);
    assert.ok(ttd.find((o) => o.value === "AUDIO")?.disabledReason);
    const creative = fieldKeys(BUILDER_SPECS.TRADEDESK, SETUPS.TRADEDESK!);
    assert.ok(creative.group.includes("locations") && creative.group.includes("devices"));
    assert.ok(creative.ad.includes("url") && creative.ad.includes("imageUrl") && creative.ad.includes("tag"));
  });

  it("offers sample campaigns for every new platform", () => {
    for (const id of NEWER) assert.ok(DEMO_ACCOUNTS[id]?.campaigns.length);
  });
});

describe("unit: oauth helpers", () => {
  it("derives the same PKCE verifier from the state and secret", () => {
    const a = pkce("secret", "state-1");
    const b = pkce("secret", "state-1");
    assert.equal(a.verifier, b.verifier);
    assert.notEqual(a.verifier, pkce("secret", "state-2").verifier);
    assert.notEqual(a.challenge, a.verifier);
  });

  it("sends token platforms back to our callback", () => {
    const url = new URL(selfRedirect("https://marketing.example/api/oauth/taboola/callback", "jwt", "saved-token"));
    assert.equal(url.searchParams.get("code"), "saved-token");
    assert.equal(url.searchParams.get("state"), "jwt");
  });

  it("maps platform statuses onto active, paused and removed", () => {
    assert.equal(mapStatus("ENABLED", ["ENABLED"]), "ACTIVE");
    assert.equal(mapStatus("PAUSED"), "PAUSED");
    assert.equal(mapStatus("DELETED"), "REMOVED");
    assert.equal(mapStatus("ARCHIVED"), "ARCHIVED");
  });
});

interface Hit {
  url: string;
  method: string;
  json: Record<string, any> | null;
  form: URLSearchParams | null;
}

let hits: Hit[] = [];
let restore: (() => void) | null = null;

function installFetch() {
  hits = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : "";
    const json = raw.startsWith("{") || raw.startsWith("[") ? JSON.parse(raw) : null;
    const form = raw && !json ? new URLSearchParams(raw) : null;
    hits.push({ url, method, json, form });
    const body = route(url, method);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = previous;
  };
}

afterEach(() => {
  restore?.();
  restore = null;
});

function route(url: string, method: string): unknown {
  const u = new URL(url);
  const path = u.pathname;
  const host = u.hostname;
  if (path.endsWith("/token") || path.endsWith("/get_token")) return { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "ads" };

  if (host.startsWith("advertising-api")) {
    if (path === "/v2/profiles") return host === "advertising-api.amazon.com" ? [{ profileId: "p1", countryCode: "IN", currencyCode: "INR", timezone: "Asia/Kolkata", accountInfo: { id: "shop", name: "Ashniva" } }] : [];
    if (path.endsWith("/campaigns/list")) return { campaigns: [{ campaignId: "c1", name: "Live", state: "ENABLED", budget: { budget: 40 } }] };
    if (path.endsWith("/adGroups/list")) return { adGroups: [{ adGroupId: "g1", campaignId: "c1", name: "Group", state: "ENABLED" }] };
    if (path.endsWith("/productAds/list")) return { productAds: [{ adId: "a1", adGroupId: "g1", campaignId: "c1", state: "ENABLED", asin: "B0" }] };
    if (path === "/sd/campaigns" && method === "GET") return [{ campaignId: "sd1", name: "Display", state: "paused", budget: 12 }];
    if (path === "/sd/campaigns" && method === "POST") return [{ campaignId: "sd-new" }];
    if (path === "/sd/adGroups") return [{ adGroupId: "sd-g" }];
    if (path === "/sd/productAds") return [{ adId: "sd-a" }];
    if (path.endsWith("/campaigns")) return { campaigns: [{ campaignId: "amz-c" }] };
    if (path.endsWith("/adGroups")) return { adGroups: [{ adGroupId: "amz-g" }] };
    if (path.endsWith("/ads") || path.endsWith("/productAds")) return { ads: [{ adId: "amz-a" }], productAds: [{ adId: "amz-a" }] };
    if (path.endsWith("/keywords")) return { keywords: [{ keywordId: "amz-k" }] };
    return {};
  }

  if (host === "backstage.taboola.com") {
    if (path.endsWith("/users/current")) return { account_id: "tb", name: "Taboola user" };
    if (path.endsWith("/allowed-accounts")) return { results: [{ account_id: "acc", name: "News", currency: "USD", time_zone_name: "Asia/Kolkata" }] };
    if (path.includes("/reports/")) return { results: [{ date: "2026-10-01", campaign: "c1", impressions: 100, clicks: 4, spent: 3.5, cpa_actions_num: 1 }] };
    if (path.endsWith("/items/") && method === "GET") return { results: [{ id: "i1", title: "Story", description: "Body", url: "https://example.com", thumbnail_url: "https://cdn.example.com/a.jpg", is_active: true }] };
    if (path.endsWith("/campaigns/") && method === "GET") return { results: [{ id: "c1", name: "Native", is_active: true, status: "RUNNING", marketing_objective: "DRIVE_WEBSITE_TRAFFIC", daily_cap: 20 }] };
    if (method === "POST") return { id: path.includes("/items/") ? "item-new" : "camp-new" };
    return {};
  }

  if (host === "api.outbrain.com") {
    if (path.includes("/reports/")) return { results: [{ campaignId: "c1", metrics: { impressions: 8, clicks: 2, spend: 1.2, conversions: 0 } }] };
    if (path === "/amplify/v0.1/marketers") return { marketers: [{ id: "m1", name: "Marketer", currency: "USD", enabled: true }] };
    if (path.endsWith("/campaigns") && method === "GET") return { campaigns: [{ id: "c1", name: "Links", enabled: true, budget: { amount: 15 }, cpc: 0.4 }] };
    if (path.endsWith("/promotedLinks") && method === "GET") return { promotedLinks: [{ id: "l1", text: "Headline", url: "https://example.com", enabled: true }] };
    if (method === "POST") return { id: path.includes("promotedLinks") ? "link-new" : "ob-new" };
    return {};
  }

  if (host === "ads-api.x.com" || host === "api.x.com") {
    if (path === "/2/users/me") return { data: { id: "u1", name: "Ada", username: "ada" } };
    if (path === "/12/accounts") return { data: [{ id: "xacc", name: "X account", currency: "USD", timezone: "UTC", approval_status: "ACCEPTED" }] };
    if (path.endsWith("/campaigns") && method === "GET") return { data: [{ id: "c1", name: "Reach", entity_status: "ACTIVE", daily_budget_amount_local_micro: 5_000_000 }] };
    if (path.endsWith("/line_items") && method === "GET") return { data: [{ id: "l1", campaign_id: "c1", name: "Line", entity_status: "ACTIVE" }] };
    if (path.endsWith("/promoted_tweets") && method === "GET") return { data: [{ id: "p1", line_item_id: "l1", tweet_id: "t1", entity_status: "ACTIVE" }] };
    if (path.includes("/stats/")) return { data: [{ id: "c1", id_data: [{ metrics: { impressions: [9], clicks: [2], billed_charge_local_micro: [1_500_000] } }] }] };
    if (path === "/2/tweets") return { data: { id: "tw1" } };
    if (path.endsWith("/promoted_tweets")) return { data: [{ id: "promoted-new" }] };
    return { data: { id: "x-new" } };
  }

  if (host === "api.searchads.apple.com") {
    if (path === "/api/v5/acls") return { data: [{ orgId: "org1", orgName: "Ashniva", currency: "USD", timeZone: "Asia/Kolkata" }] };
    if (path === "/api/v5/reports/campaigns") return { data: { reportingDataResponse: { row: [{ metadata: { campaignId: "c1" }, granularity: [{ date: "2026-10-01", impressions: 4, taps: 1, localSpend: { amount: "1.5" }, installs: 1 }] }] } } };
    if (method === "GET" && path === "/api/v5/campaigns") return { data: [{ id: "c1", name: "Search", status: "ENABLED", adChannelType: "SEARCH", dailyBudgetAmount: { amount: "20" }, adamId: 123 }] };
    if (method === "GET" && path.endsWith("/adgroups")) return { data: [{ id: "g1", name: "Brand", status: "ENABLED" }] };
    if (method === "GET" && path.endsWith("/ads")) return { data: [{ id: "a1", name: "Results", status: "ENABLED", creativeType: "SEARCH_RESULTS" }] };
    return { data: { id: "apple-new" } };
  }

  if (host === "api-partner.spotify.com") {
    if (path === "/ads/v3/me") return { id: "sp-user", name: "Spotify user" };
    if (path === "/ads/v3/ad_accounts") return { ad_accounts: [{ id: "sa1", name: "Spotify ads", currency: "USD" }] };
    if (path.endsWith("/campaigns") && method === "GET") return { campaigns: [{ id: "c1", name: "Audio", status: "ACTIVE", objective: "CLICKS" }] };
    if (path.endsWith("/ad_sets") && method === "GET") return { ad_sets: [{ id: "g1", campaign_id: "c1", name: "Set", status: "ACTIVE", budget: { micro_amount: 8_000_000 } }] };
    if (path.endsWith("/ads") && method === "GET") return { ads: [{ id: "a1", ad_set_id: "g1", name: "Spot", status: "ACTIVE", format: "AUDIO" }] };
    return { id: "sp-new" };
  }

  if (host === "api.criteo.com" && !path.includes("oauth2")) {
    if (path === "/2025-10/advertisers") return { data: [{ id: "adv1", attributes: { advertiserName: "Shop", currency: "EUR" } }] };
    if (method === "GET") return { data: [{ id: "set1", attributes: { name: "Visitors", campaignId: "camp1", campaignName: "Retarget", status: "ACTIVE", budget: { amount: 30 } } }] };
    return { data: { id: "cr-new", attributes: { campaignId: "camp-new" } } };
  }

  if (host === "dspapi.admanagerplus.yahoo.com") {
    if (path === "/traffic/advertisers") return { response: [{ id: "y1", name: "Yahoo adv", currency: "USD", status: "ACTIVE" }] };
    if (method === "GET" && path === "/traffic/campaigns") return { response: [{ id: "c1", name: "Display", status: "ACTIVE", budget: 18, goalType: "DISPLAY" }] };
    if (method === "GET" && path === "/traffic/lines") return { response: [{ id: "l1", campaignId: "c1", name: "Line", status: "ACTIVE" }] };
    if (method === "GET" && path === "/traffic/ads") return { response: [{ id: "a1", lineId: "l1", name: "Banner", status: "ACTIVE", landingPageUrl: "https://example.com" }] };
    return { id: "yh-new" };
  }

  if (host.endsWith(".myshopify.com")) {
    if (path.endsWith("/shop.json")) return { shop: { name: "Ashniva", myshopify_domain: "ashniva.myshopify.com", currency: "INR", iana_timezone: "Asia/Kolkata" } };
    if (path.endsWith("/marketing_events.json") && method === "GET") {
      return { marketing_events: [{ id: 41, utm_campaign: "Festive", marketing_channel: "social", budget: "25.00", budget_type: "daily", ended_at: "2020-01-01T00:00:00Z", description: "Store sale", referring_domain: "ashniva.com" }] };
    }
    if (method === "POST") return { marketing_event: { id: 77 } };
    return {};
  }

  if (host === "api.thetradedesk.com") {
    if (path.endsWith("/advertiser/query/partner")) return { Result: [{ AdvertiserId: "adv1", AdvertiserName: "Desk", CurrencyCode: "USD" }] };
    if (path.endsWith("/campaign/query/advertiser")) return { Result: [{ CampaignId: "c1", CampaignName: "Prospecting", Availability: "Available", Budget: { Amount: 50 } }] };
    if (path.endsWith("/adgroup/query/campaign")) return { Result: [{ AdGroupId: "g1", AdGroupName: "Mobile", IsEnabled: true }] };
    if (path.endsWith("/creative")) return { CreativeId: "cr1" };
    if (path.endsWith("/adgroup")) return { AdGroupId: "ttd-g" };
    if (path.endsWith("/campaign")) return { CampaignId: "ttd-c" };
    return {};
  }

  return {};
}

const redirect = "https://marketing.example/api/oauth/x/callback";

function posted(part: string) {
  return hits.filter((h) => h.method === "POST" && h.url.includes(part));
}

describe("integration: connect, sync and paused create", () => {
  it("exposes every new platform from the connector registry", () => {
    const registry = createConnectorRegistry(fullConfig());
    const live = registry.livePlatforms();
    for (const id of NEWER) {
      assert.ok(live.includes(id));
      assert.equal(registry.isConfigured(id), true);
    }
    assert.equal(createConnectorRegistry(blankConfig()).isConfigured("TABOOLA"), false);
  });

  it("Taboola lists accounts, metrics and creates a paused item", async () => {
    installFetch();
    const c = new TaboolaConnector({ clientId: "id", clientSecret: "sec" });
    assert.throws(() => new TaboolaConnector({}).getAuthUrl({ state: "s", redirectUri: redirect }), /not configured/);
    assert.match(c.getAuthUrl({ state: "s", redirectUri: redirect }), /code=client_credentials/);
    const tokens = await c.exchangeCode({ code: "client_credentials", redirectUri: redirect });
    assert.equal(tokens.accessToken, "access-1");
    const accounts = await c.listAdAccounts({ accessToken: tokens.accessToken });
    assert.equal(accounts[0]?.externalId, "acc");
    const account = ref(accounts[0]!);
    const structure = await c.fetchStructure({ accessToken: tokens.accessToken }, account);
    assert.equal(structure.campaigns[0]?.externalId, "c1");
    assert.equal(structure.ads[0]?.headline, "Story");
    const metrics = await c.fetchMetrics({ accessToken: tokens.accessToken }, account, { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(metrics[0]?.spend, 3.5);
    await c.setCampaignStatus({ accessToken: tokens.accessToken }, account, { externalId: "c1" }, "PAUSED");
    const draft = readyDraft("TABOOLA");
    const made = await c.createCampaign({ accessToken: tokens.accessToken }, { ...account, currency: "USD" }, draft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    const body = posted("/campaigns/").map((h) => h.json).find((j) => j?.marketing_objective);
    assert.equal(body?.marketing_objective, "DRIVE_WEBSITE_TRAFFIC");
    assert.equal(body?.is_active, false);
    assert.equal(posted("/items/")[0]?.json?.thumbnail_url, "https://cdn.example.com/creative.jpg");
  });

  it("Outbrain uses the saved token and requires a public image", async () => {
    installFetch();
    const c = new OutbrainConnector({ apiToken: "ob-token" });
    assert.match(c.getAuthUrl({ state: "s", redirectUri: redirect }), /code=saved-token/);
    const tokens = await c.exchangeCode({ code: "saved-token", redirectUri: redirect });
    assert.equal(tokens.accessToken, "ob-token");
    assert.equal((await c.refreshTokens("x")), null);
    const accounts = await c.listAdAccounts(tokens);
    const account = ref(accounts[0]!);
    assert.equal((await c.fetchStructure(tokens, account)).ads.length, 1);
    assert.equal((await c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" }))[0]?.clicks, 2);
    const draft = readyDraft("OUTBRAIN");
    const made = await c.createCampaign(tokens, account, draft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    const body = posted("/marketers/")[0]?.json;
    assert.equal(body?.enabled, false);
    assert.equal(body?.cpc, 25);
    assert.equal(posted("/promotedLinks")[0]?.json?.imageMetadata?.url, "https://cdn.example.com/creative.jpg");
    draft.adGroups[0]!.ads[0]!.values.imageUrl = "";
    await assert.rejects(() => c.createCampaign(tokens, account, draft, new Map()), /public image URL/);
  });

  it("Amazon connects a profile and creates Sponsored Products, Brands and Display", async () => {
    installFetch();
    const c = new AmazonAdsConnector({ clientId: "amz", clientSecret: "sec" });
    assert.match(c.getAuthUrl({ state: "s", redirectUri: redirect }), /amazon.com\/ap\/oa/);
    const tokens = await c.exchangeCode({ code: "code", redirectUri: redirect });
    const accounts = await c.listAdAccounts(tokens);
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.meta?.host, "https://advertising-api.amazon.com");
    const account = ref(accounts[0]!);
    const structure = await c.fetchStructure(tokens, account);
    assert.ok(structure.campaigns.some((x) => x.objective === "SPONSORED_PRODUCTS"));
    assert.ok(structure.campaigns.some((x) => x.objective === "SPONSORED_BRANDS"));
    assert.ok(structure.campaigns.some((x) => x.objective === "SPONSORED_DISPLAY"));
    assert.deepEqual(await c.fetchMetrics(), []);

    const products = readyDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" });
    products.adGroups[0]!.values.keywords = [{ text: "lehenga", matchType: "EXACT" }];
    products.adGroups[0]!.ads[0]!.values.asin = "B0TESTASIN";
    await c.createCampaign(tokens, { ...account, currency: "INR" }, products, new Map());
    const sp = hits.find((h) => h.url.endsWith("/sp/campaigns") && h.method === "POST")?.json;
    assert.equal(sp?.campaigns?.[0]?.state, "PAUSED");
    assert.equal(hits.find((h) => h.url.endsWith("/sp/keywords"))?.json?.keywords?.[0]?.matchType, "EXACT");

    const brands = readyDraft("AMAZON", { adProduct: "SPONSORED_BRANDS" });
    brands.adGroups[0]!.ads[0]!.values.asins = "B0TESTASIN";
    brands.adGroups[0]!.ads[0]!.values.headline = "Festive edit";
    await c.createCampaign(tokens, { ...account, currency: "INR" }, brands, new Map());
    const sb = hits.find((h) => h.url.includes("/sb/v4/ads"))?.json;
    assert.deepEqual(sb?.ads?.[0]?.creative?.asins, ["B0TESTASIN"]);
    assert.equal(sb?.ads?.[0]?.creative?.headline, "Festive edit");

    const display = readyDraft("AMAZON", { adProduct: "SPONSORED_DISPLAY" });
    display.campaign.tactic = "T00030";
    display.adGroups[0]!.ads[0]!.values.asin = "B0TESTASIN";
    await c.createCampaign(tokens, { ...account, currency: "INR" }, display, new Map());
    const sd = hits.find((h) => h.url.endsWith("/sd/campaigns") && h.method === "POST")?.json;
    assert.equal(sd?.[0]?.tactic, "T00030");
    assert.equal(sd?.[0]?.state, "PAUSED");
    assert.equal(hits.find((h) => h.url.endsWith("/sd/productAds"))?.json?.[0]?.asin, "B0TESTASIN");
  });

  it("X Ads rebuilds PKCE on the token exchange and creates a paused line item", async () => {
    installFetch();
    const c = new XAdsConnector({ clientId: "xid", clientSecret: "xsec" });
    const authUrl = new URL(c.getAuthUrl({ state: "state-1", redirectUri: redirect }));
    assert.equal(authUrl.searchParams.get("code_challenge"), pkce("xsec", "state-1").challenge);
    await c.exchangeCode({ code: "code", redirectUri: redirect, state: "state-1" });
    const token = hits.find((h) => h.url.includes("/oauth2/token"));
    assert.equal(token?.form?.get("code_verifier"), pkce("xsec", "state-1").verifier);
    const tokens = { accessToken: "access-1" };
    const accounts = await c.listAdAccounts(tokens);
    const account = ref(accounts[0]!);
    const structure = await c.fetchStructure(tokens, account);
    assert.equal(structure.adGroups[0]?.campaignExternalId, "c1");
    const metrics = await c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(metrics[0]?.impressions, 9);
    assert.equal(metrics[0]?.spend, 1.5);
    const draft = readyDraft("X");
    draft.campaign.fundingInstrumentId = "fi-9";
    const made = await c.createCampaign(tokens, { ...account, currency: "USD" }, draft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    const campaign = hits.find((h) => h.url.endsWith("/campaigns") && h.method === "POST");
    assert.equal(campaign?.form?.get("entity_status"), "PAUSED");
    assert.equal(campaign?.form?.get("funding_instrument_id"), "fi-9");
    assert.match(String(hits.find((h) => h.url.endsWith("/2/tweets"))?.json?.text), /festive edit/i);
  });

  it("Apple Search Ads creates a paused search campaign from the app id", async () => {
    installFetch();
    const c = new AppleAdsConnector({ clientId: "apple", clientSecret: "sec" });
    assert.match(c.getAuthUrl({ state: "s", redirectUri: redirect }), /client_credentials/);
    const tokens = await c.exchangeCode({ code: "client_credentials", redirectUri: redirect });
    const accounts = await c.listAdAccounts(tokens);
    assert.equal(accounts[0]?.externalId, "org1");
    const account = ref(accounts[0]!);
    const structure = await c.fetchStructure(tokens, account);
    assert.equal(structure.ads[0]?.raw?.creativeType, "SEARCH_RESULTS");
    const metrics = await c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(metrics[0]?.clicks, 1);
    const draft = readyDraft("APPLE");
    draft.adGroups[0]!.values.keywords = [{ text: "ashniva", matchType: "EXACT" }];
    const made = await c.createCampaign(tokens, { ...account, currency: "USD" }, draft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    const body = posted("/api/v5/campaigns")[0]?.json;
    assert.equal(body?.status, "PAUSED");
    assert.equal(body?.adamId, 1234567890);
    assert.deepEqual(body?.countriesOrRegions, ["IN"]);
    assert.equal(hits.some((h) => h.url.includes("targetingkeywords")), true);
  });

  it("Spotify, Criteo, Yahoo and The Trade Desk publish their creative types paused", async () => {
    installFetch();
    const auth = { accessToken: "access-1" };

    const spotify = new SpotifyAdsConnector({ clientId: "s", clientSecret: "s" });
    assert.match(spotify.getAuthUrl({ state: "s", redirectUri: redirect }), /accounts.spotify.com/);
    await spotify.exchangeCode({ code: "code", redirectUri: redirect });
    const sAccount = ref((await spotify.listAdAccounts(auth))[0]!);
    assert.equal((await spotify.fetchStructure(auth, sAccount)).ads[0]?.externalId, "a1");
    const sDraft = readyDraft("SPOTIFY", { objective: "CLICKS" });
    const sMade = await spotify.createCampaign(auth, sAccount, sDraft, new Map());
    assert.equal(sMade.campaigns[0]?.status, "PAUSED");
    const sAd = hits.filter((h) => h.url.endsWith("/ads") && h.method === "POST").at(-1)?.json;
    assert.equal(sAd?.format, "AUDIO");
    assert.equal(sAd?.assets?.asset_url, "https://cdn.example.com/creative.jpg");
    assert.equal(sAd?.status, "PAUSED");

    const criteo = new CriteoConnector({ clientId: "c", clientSecret: "c" });
    await criteo.exchangeCode({ code: "client_credentials", redirectUri: redirect });
    const cAccount = ref((await criteo.listAdAccounts(auth))[0]!);
    assert.equal((await criteo.fetchStructure(auth, cAccount)).campaigns[0]?.name, "Retarget");
    const cMade = await criteo.createCampaign(auth, cAccount, readyDraft("CRITEO"), new Map());
    assert.equal(cMade.campaigns[0]?.objective, "RETARGETING");
    const cBody = hits.find((h) => h.method === "POST" && /\/advertisers\/[^/]+\/ad-sets$/.test(new URL(h.url).pathname))?.json;
    assert.equal(cBody?.data?.attributes?.status, "PAUSED");
    assert.equal(cBody?.data?.attributes?.goal, "RETARGETING");

    const yahoo = new YahooDspConnector({ clientId: "y", clientSecret: "y" });
    assert.match(yahoo.getAuthUrl({ state: "s", redirectUri: redirect }), /api.login.yahoo.com/);
    await yahoo.exchangeCode({ code: "code", redirectUri: redirect });
    const yAccount = ref((await yahoo.listAdAccounts(auth))[0]!);
    assert.equal((await yahoo.fetchStructure(auth, yAccount)).adGroups[0]?.campaignExternalId, "c1");
    const yDraft = readyDraft("YAHOO", { format: "DISPLAY" });
    yDraft.adGroups[0]!.ads[0]!.values.size = "300x250";
    const yMade = await yahoo.createCampaign(auth, yAccount, yDraft, new Map());
    assert.equal(yMade.campaigns[0]?.status, "PAUSED");
    const yAd = hits.filter((h) => h.method === "POST" && h.url.includes("dspapi.admanagerplus.yahoo.com") && h.url.endsWith("/ads")).at(-1)?.json;
    assert.equal(yAd?.imageUrl, "https://cdn.example.com/creative.jpg");
    assert.equal(yAd?.size, "300x250");
    assert.equal(yAd?.status, "PAUSED");

    const ttd = new TradeDeskConnector({ apiToken: "ttd-token", partnerId: "partner-1" });
    assert.match(ttd.getAuthUrl({ state: "s", redirectUri: redirect }), /saved-token/);
    const tTokens = await ttd.exchangeCode({ code: "saved-token", redirectUri: redirect });
    assert.equal(tTokens.accessToken, "ttd-token");
    const tAccount = ref((await ttd.listAdAccounts(tTokens))[0]!);
    assert.equal((await ttd.fetchStructure(tTokens, tAccount)).adGroups[0]?.externalId, "g1");
    const before = hits.length;
    const tMade = await ttd.createCampaign(tTokens, tAccount, readyDraft("TRADEDESK"), new Map());
    assert.equal(tMade.campaigns[0]?.status, "PAUSED");
    const created = hits.slice(before);
    const creativeAt = created.findIndex((h) => h.url.endsWith("/creative"));
    const groupAt = created.findIndex((h) => h.url.endsWith("/adgroup"));
    assert.ok(creativeAt >= 0 && creativeAt < groupAt);
    assert.deepEqual(created[groupAt]?.json?.RTBAttributes?.CreativeIds, ["cr1"]);
    assert.equal(created.find((h) => h.url.endsWith("/campaign"))?.json?.Availability, "Archived");
  });

  it("Shopify records a paused marketing event on the store", async () => {
    installFetch();
    const state = `h.${Buffer.from(JSON.stringify({ shop: "ashniva.myshopify.com" })).toString("base64url")}.s`;
    const c = new ShopifyConnector({ clientId: "shop", clientSecret: "sec" });
    assert.match(c.getAuthUrl({ state, redirectUri: redirect }), /ashniva\.myshopify\.com\/admin\/oauth\/authorize/);
    const tokens = await c.exchangeCode({ code: "code", redirectUri: redirect, state });
    assert.match(tokens.accessToken, /^ashniva\.myshopify\.com /);
    const account = ref((await c.listAdAccounts(tokens))[0]!);
    assert.equal(account.externalId, "ashniva.myshopify.com");
    assert.equal((await c.fetchStructure(tokens, account)).campaigns[0]?.status, "PAUSED");
    const made = await c.createCampaign(tokens, account, readyDraft("SHOPIFY", { channel: "social" }), new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    assert.equal(made.campaigns[0]?.externalId, "77");
    const body = hits.find((h) => h.method === "POST" && h.url.includes("/marketing_events.json"))?.json?.marketing_event;
    assert.equal(body?.marketing_channel, "social");
    assert.equal(body?.paid, true);
    assert.equal(body?.ended_at, body?.started_at);
    assert.ok(made.warnings?.length);
  });
});

function setupValues(spec: PlatformBuilderSpec) {
  const options = spec.setup[0]?.options;
  return (Array.isArray(options) ? options : []).map((o) => o.value);
}

function ref(account: { externalId: string; currency: string; meta?: Record<string, unknown> }): AccountRef & { currency: string } {
  return { externalId: account.externalId, currency: account.currency, meta: account.meta ?? null };
}

function fullConfig(): ConnectorsConfig {
  return {
    meta: { appId: "id", appSecret: "sec", apiVersion: "v26.0" },
    google: { clientId: "id", clientSecret: "sec", developerToken: "dev", apiVersion: "v25" },
    tiktok: { appId: "id", appSecret: "sec" },
    linkedin: { clientId: "id", clientSecret: "sec", apiVersion: "202609" },
    microsoft: { clientId: "id", clientSecret: "sec", developerToken: "dev", tenant: "common" },
    snapchat: { clientId: "id", clientSecret: "sec" },
    pinterest: { appId: "id", appSecret: "sec" },
    amazon: { clientId: "id", clientSecret: "sec" },
    x: { clientId: "id", clientSecret: "sec" },
    apple: { clientId: "id", clientSecret: "sec" },
    spotify: { clientId: "id", clientSecret: "sec" },
    criteo: { clientId: "id", clientSecret: "sec" },
    taboola: { clientId: "id", clientSecret: "sec" },
    outbrain: { apiToken: "tok" },
    tradedesk: { apiToken: "tok", partnerId: "partner" },
    yahoo: { clientId: "id", clientSecret: "sec" },
    shopify: { clientId: "id", clientSecret: "sec" },
  };
}

function blankConfig(): ConnectorsConfig {
  return {
    meta: { apiVersion: "v26.0" },
    google: { apiVersion: "v25" },
    tiktok: {},
    linkedin: { apiVersion: "202609" },
    microsoft: { tenant: "common" },
    snapchat: {},
    pinterest: {},
    amazon: {},
    x: {},
    apple: {},
    spotify: {},
    criteo: {},
    taboola: {},
    outbrain: {},
    tradedesk: {},
    yahoo: {},
    shopify: {},
  };
}
