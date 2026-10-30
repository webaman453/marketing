/**
 * Unit tests for the nine newer ad platforms (forms, credential groups, OAuth
 * helpers) and integration tests that run each connector against a fake HTTP API.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  BUILDER_SPECS,
  CONNECT_CREDENTIALS,
  CREDENTIAL_GROUPS,
  connectsWithCredentials,
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
import { AppleAdsConnector, appleClientSecret } from "./apple";
import { CriteoConnector } from "./criteo";
import { OutbrainConnector } from "./outbrain";
import { SpotifyAdsConnector } from "./spotify";
import { TaboolaConnector } from "./taboola";
import { TradeDeskConnector } from "./tradedesk";
import { XAdsConnector } from "./x";
import { ShopifyConnector } from "./shopify";
import { YahooDspConnector } from "./yahoo";
import { createHmac, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createdId } from "./amazon/builder";
import { midnightIn } from "./x";
import { oauthHeader, packToken, percentEncode, signatureBase, unpackToken } from "./x/oauth1";
import { verifyShopifyHmac } from "./shopify";
import { dateOf, dayOf, isoDate, splitBudget } from "./builder-values";
import { ConnectorError, noRowsUnlessFatal } from "./errors";
import { allPages, formBody, nextLink } from "./http";
import { removalAllowed } from "./tree";
import type { AccountRef, AdPlatformConnector, PlatformCredentials } from "./types";

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

describe("unit: shared connector helpers", () => {
  it("form-encodes without undefined or null values", () => {
    assert.equal(formBody({ a: 1, b: undefined, c: null, d: "x y" }), "a=1&d=x+y");
  });

  it("splits a campaign budget evenly, rounded down to cents", () => {
    assert.equal(splitBudget(25, 2), 12.5);
    assert.equal(splitBudget(10, 3), 3.33);
    assert.equal(splitBudget(0.05, 2), 0.02);
    assert.equal(splitBudget(40, 1), 40);
  });

  it("keeps builder dates as the calendar day typed, whatever the server timezone", () => {
    assert.equal(dayOf({ startDate: "2026-10-08" }, "startDate"), "2026-10-08");
    assert.equal(dayOf({ startDate: "2026-10-08T23:30" }, "startDate"), "2026-10-08");
    assert.equal(dayOf({ startDate: "2026-02-30" }, "startDate"), null);
    assert.equal(dayOf({}, "startDate"), null);
    assert.equal(isoDate(dateOf({ startDate: "2026-10-08" }, "startDate")), "2026-10-08");
  });

  it("follows pages to the end and stops at the page cap", async () => {
    const pages = [[1, 2], [3], []];
    assert.deepEqual(await allPages<number, number>(0, async (i) => ({ items: pages[i]!, next: i + 1 })), [1, 2, 3]);
    let calls = 0;
    await assert.rejects(() => allPages<number, number>(0, async (i) => (calls++, { items: [i], next: i + 1 })), /more than 100 pages/);
    assert.equal(calls, 100);
    assert.equal(nextLink('<https://a.test/x?page_info=1>; rel="previous", <https://a.test/x?page_info=2>; rel="next"'), "https://a.test/x?page_info=2");
    assert.equal(nextLink(null), null);
  });

  it("sync safety net: an empty structure never removes an account's campaigns", () => {
    assert.equal(removalAllowed(0, 5), false);
    assert.equal(removalAllowed(0, 0), true);
    assert.equal(removalAllowed(3, 5), true);
  });

  it("only swallows report errors that are about the report itself", () => {
    assert.deepEqual(noRowsUnlessFatal(new ConnectorError("INVALID_REQUEST", "bad metric")), []);
    for (const code of ["AUTH_EXPIRED", "RATE_LIMITED", "PERMISSION_DENIED", "PLATFORM_ERROR"] as const) {
      assert.throws(() => noRowsUnlessFatal(new ConnectorError(code, code)), (e: unknown) => e instanceof ConnectorError && e.code === code);
    }
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

describe("unit: X OAuth 1.0a signing", () => {
  // The worked example on docs.x.com (Creating a signature).
  const example = {
    method: "POST",
    url: "https://api.x.com/1.1/statuses/update.json?include_entities=true",
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    form: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: "1318622958",
  };

  it("matches X's documented signature base string and signature", () => {
    const oauth = { oauth_consumer_key: example.consumerKey, oauth_nonce: example.nonce, oauth_signature_method: "HMAC-SHA1", oauth_timestamp: example.timestamp, oauth_token: example.token, oauth_version: "1.0" };
    assert.equal(
      signatureBase(example, oauth),
      "POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    const header = oauthHeader(example);
    assert.equal(oauthParams(header).oauth_signature, "Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
    assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce=/);
  });

  it("encodes per RFC 3986 and changes the signature with any parameter", () => {
    assert.equal(percentEncode("a b+!*'()~é"), "a%20b%2B%21%2A%27%28%29~%C3%A9");
    const sig = (over: object) => oauthParams(oauthHeader({ ...example, ...over })).oauth_signature;
    assert.notEqual(sig({ url: "https://api.x.com/1.1/statuses/update.json?include_entities=false" }), sig({}));
    assert.notEqual(sig({ tokenSecret: "other" }), sig({}));
    // A fresh nonce and timestamp on every call when none are given.
    const a = oauthParams(oauthHeader({ ...example, nonce: undefined, timestamp: undefined }));
    const b = oauthParams(oauthHeader({ ...example, nonce: undefined, timestamp: undefined }));
    assert.notEqual(a.oauth_nonce, b.oauth_nonce);
    assert.match(String(a.oauth_timestamp), /^\d{10}$/);
  });

  it("stores the token with its secret and refuses anything else", () => {
    assert.deepEqual(unpackToken(packToken({ token: "t", secret: "s" })), { token: "t", secret: "s" });
    for (const old of ["access-1", "{}", '{"oauth1":{"token":"t"}}']) assert.throws(() => unpackToken(old), (e: unknown) => e instanceof ConnectorError && e.code === "AUTH_EXPIRED");
  });
});

/** The parameters of an `Authorization: OAuth …` header, decoded. */
function oauthParams(header = ""): Record<string, string> {
  return Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k!, decodeURIComponent(v!)]));
}

/** Whether a recorded request carries a valid OAuth 1.0a signature for these secrets. */
function signedWith(h: { method: string; url: string; headers: Record<string, string> }, consumerSecret: string, tokenSecret?: string) {
  const p = oauthParams(h.headers.authorization);
  const standard = ["oauth_signature", "oauth_consumer_key", "oauth_token", "oauth_nonce", "oauth_timestamp", "oauth_signature_method", "oauth_version"];
  const extra = Object.fromEntries(Object.entries(p).filter(([k]) => !standard.includes(k)));
  const again = oauthHeader({ method: h.method, url: h.url, consumerKey: p.oauth_consumer_key!, consumerSecret, token: p.oauth_token, tokenSecret, oauth: extra, nonce: p.oauth_nonce, timestamp: p.oauth_timestamp });
  return Boolean(p.oauth_signature) && oauthParams(again).oauth_signature === p.oauth_signature;
}

interface Hit {
  url: string;
  method: string;
  json: Record<string, any> | null;
  form: URLSearchParams | null;
  /** Request headers, lower-cased names. */
  headers: Record<string, string>;
}

let hits: Hit[] = [];
let restore: (() => void) | null = null;
/** A reply with a status and headers other than 200 JSON. */
class Reply {
  constructor(readonly body: unknown, readonly status = 200, readonly headers: Record<string, string> = {}) {}
}
/** Per-test routing that runs before `route`; return undefined to fall through. */
let override: ((url: URL, method: string, json: Record<string, any> | null, hit: Hit) => unknown) | null = null;

function installFetch() {
  hits = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : "";
    const json = raw.startsWith("{") || raw.startsWith("[") ? JSON.parse(raw) : null;
    const form = raw && !json ? new URLSearchParams(raw) : null;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const hit = { url, method, json, form, headers };
    hits.push(hit);
    const reply = override?.(new URL(url), method, json, hit) ?? route(url, method, json);
    const r = reply instanceof Reply ? reply : new Reply(reply);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = previous;
  };
}

afterEach(() => {
  restore?.();
  restore = null;
  override = null;
});

function route(url: string, method: string, json: Record<string, any> | null = null): unknown {
  const u = new URL(url);
  const path = u.pathname;
  const host = u.hostname;
  if (path.endsWith("/token") || path.endsWith("/get_token")) return { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "ads" };

  if (host.startsWith("advertising-api")) {
    if (path === "/v2/profiles") return host === "advertising-api.amazon.com" ? [{ profileId: "p1", countryCode: "IN", currencyCode: "INR", timezone: "Asia/Kolkata", accountInfo: { id: "shop", name: "Ashniva" } }] : [];
    // SP v3 lists page with nextToken: page one points at page two.
    if (path === "/sp/campaigns/list") return json?.nextToken === "t2" ? { campaigns: [{ campaignId: "c2", name: "Page two", state: "PAUSED", budget: { budget: 10 } }] } : { campaigns: [{ campaignId: "c1", name: "Live", state: "ENABLED", budget: { budget: 40 } }], nextToken: "t2" };
    if (path.endsWith("/campaigns/list")) return { campaigns: [{ campaignId: "sb1", name: "Brand", state: "ENABLED", budget: 30 }] };
    if (path.endsWith("/adGroups/list")) return { adGroups: [{ adGroupId: "g1", campaignId: "c1", name: "Group", state: "ENABLED" }] };
    if (path.endsWith("/productAds/list")) return { productAds: [{ adId: "a1", adGroupId: "g1", campaignId: "c1", state: "ENABLED", asin: "B0" }] };
    if (path === "/sd/campaigns" && method === "GET") return [{ campaignId: "sd1", name: "Display", state: "paused", budget: 12 }];
    if (path === "/sd/campaigns" && method === "POST") return [{ code: "SUCCESS", campaignId: "sd-new" }];
    if (path === "/sd/adGroups") return [{ code: "SUCCESS", adGroupId: "sd-g" }];
    if (path === "/sd/productAds") return [{ code: "SUCCESS", adId: "sd-a" }];
    if (path.endsWith("/delete")) return {};
    // SP v3 / SB v4 create calls answer 207 multi-status.
    const ok = (key: string, row: Record<string, string>) => ({ [key]: { success: [{ index: 0, ...row }], error: [] } });
    if (path.endsWith("/campaigns")) return ok("campaigns", { campaignId: "amz-c" });
    if (path.endsWith("/adGroups")) return ok("adGroups", { adGroupId: "amz-g" });
    if (path.endsWith("/productAds")) return ok("productAds", { adId: "amz-a" });
    if (path.endsWith("/ads")) return ok("ads", { adId: "amz-a" });
    if (path.endsWith("/keywords")) return ok("keywords", { keywordId: "amz-k" });
    return {};
  }

  if (host === "backstage.taboola.com") {
    if (path.endsWith("/users/current/account")) return { account_id: "tb", name: "Taboola user" };
    if (path.endsWith("/allowed-accounts")) return { results: [{ account_id: "acc", name: "News", currency: "USD", time_zone_name: "Asia/Kolkata" }] };
    if (path.includes("/reports/")) return { results: [{ date: "2026-10-01", campaign: "c1", impressions: 100, clicks: 4, spent: 3.5, cpa_actions_num: 1 }] };
    if (path.endsWith("/items/") && method === "GET") return { results: [{ id: "i1", title: "Story", description: "Body", url: "https://example.com", thumbnail_url: "https://cdn.example.com/a.jpg", is_active: true }] };
    if (path.endsWith("/campaigns/") && method === "GET") return { results: [{ id: "c1", name: "Native", is_active: true, status: "RUNNING", marketing_objective: "DRIVE_WEBSITE_TRAFFIC", daily_cap: 20 }] };
    if (method === "POST") return { id: path.includes("/items/") ? "item-new" : "camp-new" };
    return {};
  }

  if (host === "api.outbrain.com") {
    if (path.endsWith("/campaigns/periodic")) return { campaignResults: [{ campaignId: "c1", results: [{ metadata: { id: "2026-10-01" }, metrics: { impressions: 8, clicks: 2, spend: 1.2, conversions: 0 } }] }] };
    if (path === "/amplify/v0.1/marketers") return { marketers: [{ id: "m1", name: "Marketer", currency: "USD", enabled: true }] };
    if (path.endsWith("/campaigns") && method === "GET") return { campaigns: [{ id: "c1", name: "Links", enabled: true, budget: { amount: 15 }, cpc: 0.4 }] };
    if (path.endsWith("/promotedLinks") && method === "GET") return { promotedLinks: [{ id: "l1", text: "Headline", url: "https://example.com", enabled: true }] };
    if (method === "POST") return { id: path.includes("promotedLinks") ? "link-new" : "ob-new" };
    return {};
  }

  if (host === "ads-api.x.com" || host === "api.x.com") {
    // The OAuth 1.0a endpoints answer form-encoded text.
    if (path === "/oauth/request_token") return "oauth_token=req-1&oauth_token_secret=req-sec&oauth_callback_confirmed=true";
    if (path === "/oauth/access_token") return "oauth_token=1-acc&oauth_token_secret=acc-sec&user_id=42&screen_name=ashniva";
    if (path.endsWith("/promotable_users")) return { data: [{ id: "pu1", user_id: "756201191646691328", promotable_user_type: "FULL" }] };
    if (path === "/2/media/upload/initialize") return { data: { id: "m1", media_key: "3_m1", expires_after_secs: 86400 } };
    if (path.startsWith("/2/media/upload/")) return { data: { id: "m1", media_key: "3_m1" } };
    if (path.endsWith("/media_library")) return { data: { media_key: u.searchParams.get("media_key") } };
    // The real id is past 2^53, which JSON numbers can't hold exactly; id_str can.
    if (path.endsWith("/tweet")) return { data: { id: 1880028106020515840, id_str: "1880028106020515841", text: u.searchParams.get("text") } };
    if (path.endsWith("/promoted_tweets") && method === "POST") {
      return { data: String(u.searchParams.get("tweet_ids")).split(",").map((t, i) => ({ id: `pt-${i}`, line_item_id: u.searchParams.get("line_item_id"), tweet_id: t, entity_status: "ACTIVE" })) };
    }
    if (path === "/2/users/me") return { data: { id: "u1", name: "Ada", username: "ada" } };
    if (path === "/12/accounts") return { data: [{ id: "xacc", name: "X account", currency: "USD", timezone: "UTC", approval_status: "ACCEPTED" }] };
    // Lists page with cursor → next_cursor.
    if (path.endsWith("/campaigns") && method === "GET") {
      return u.searchParams.get("cursor") === "n2"
        ? { data: [{ id: "c2", name: "Later", entity_status: "PAUSED" }] }
        : { data: [{ id: "c1", name: "Reach", entity_status: "ACTIVE", daily_budget_amount_local_micro: 5_000_000 }], next_cursor: "n2" };
    }
    if (path.endsWith("/line_items") && method === "GET") return { data: [{ id: "l1", campaign_id: "c1", name: "Line", entity_status: "ACTIVE" }] };
    if (path.endsWith("/promoted_tweets") && method === "GET") return { data: [{ id: "p1", line_item_id: "l1", tweet_id: "t1", entity_status: "ACTIVE" }] };
    if (path.includes("/stats/")) return { data: [{ id: "c1", id_data: [{ metrics: { impressions: [9], clicks: [2], billed_charge_local_micro: [1_500_000] } }] }] };
    if (path === "/2/tweets") return { data: { id: "tw1" } };
    return { data: { id: "x-new" } };
  }

  if (host === "api.searchads.apple.com") {
    if (path === "/api/v5/acls") return { data: [{ orgId: "org1", orgName: "Ashniva", currency: "USD", timeZone: "Asia/Kolkata" }] };
    if (path === "/api/v5/reports/campaigns") return { data: { reportingDataResponse: { row: [{ metadata: { campaignId: "c1" }, granularity: [{ date: "2026-10-01", impressions: 4, taps: 1, localSpend: { amount: "1.5" }, tapInstalls: 1, viewInstalls: 0, totalInstalls: 1 }] }] } } };
    // offset/limit paging with pagination.totalResults: one campaign per page here.
    if (method === "GET" && path === "/api/v5/campaigns") {
      return u.searchParams.get("offset") === "1"
        ? { data: [{ id: "c2", name: "Later", status: "PAUSED", adChannelType: "SEARCH" }], pagination: { totalResults: 2 } }
        : { data: [{ id: "c1", name: "Search", status: "ENABLED", adChannelType: "SEARCH", dailyBudgetAmount: { amount: "20" }, adamId: 123 }], pagination: { totalResults: 2 } };
    }
    if (method === "GET" && path.endsWith("/adgroups")) return { data: [{ id: "g1", name: "Brand", status: "ENABLED" }] };
    if (method === "GET" && path.endsWith("/ads")) return { data: [{ id: "a1", name: "Results", status: "ENABLED", creativeType: "SEARCH_RESULTS" }] };
    return { data: { id: "apple-new" } };
  }

  if (host === "api-partner.spotify.com") {
    if (path === "/ads/v3/businesses") return { businesses: [{ id: "biz1", name: "Spotify user" }] };
    if (path === "/ads/v3/businesses/biz1/ad_accounts") return { ad_accounts: [{ id: "sa1", name: "Spotify ads", currency_code: "USD", status: "ACTIVE" }] };
    if (path.endsWith("/campaigns") && method === "GET") return { campaigns: [{ id: "c1", name: "Audio", status: "ACTIVE", objective: "CLICKS" }] };
    if (path.endsWith("/ad_sets") && method === "GET") return { ad_sets: [{ id: "g1", campaign_id: "c1", name: "Set", status: "ACTIVE", budget: { micro_amount: 8_000_000 } }] };
    if (path.endsWith("/ads") && method === "GET") return { ads: [{ id: "a1", ad_set_id: "g1", name: "Spot", status: "ACTIVE", format: "AUDIO" }] };
    return { id: "sp-new" };
  }

  if (host === "api.criteo.com" && !path.includes("oauth2")) {
    if (path === "/2025-10/advertisers/me") return { data: [{ id: "adv1", attributes: { advertiserName: "Shop", currency: "EUR" } }] };
    if (path === "/2025-10/marketing-solutions/ad-sets/search") return { data: [{ id: "set1", attributes: { name: "Visitors", advertiserId: "adv1", campaignId: "camp1", campaignName: "Retarget", status: "ACTIVE", budget: { amount: 30 } } }] };
    if (/\/marketing-solutions\/ad-sets\/(start|stop)$/.test(path)) return { data: json?.data ?? [], errors: [] };
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
      if (u.searchParams.get("page_info") === "p2") return { marketing_events: [{ id: 42, utm_campaign: "Second page", budget: "5.00", budget_type: "daily" }] };
      const next = `<https://${host}${path}?limit=250&page_info=p2>; rel="next"`;
      return new Reply({ marketing_events: [{ id: 41, utm_campaign: "Festive", marketing_channel: "social", budget: "25.00", budget_type: "daily", ended_at: "2020-01-01T00:00:00Z", description: "Store sale", referring_domain: "ashniva.com" }] }, 200, { link: next });
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
    assert.equal((await c.getUser(tokens)).id, "tb");
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
    const obMetrics = await c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(obMetrics[0]?.clicks, 2);
    // Each row lands on its own day, never the range total on the last day.
    assert.equal(obMetrics[0]?.date, "2026-10-01");
    assert.ok(hits.some((h) => h.url.includes("/campaigns/periodic") && new URL(h.url).searchParams.get("breakdown") === "daily"));
    const draft = readyDraft("OUTBRAIN");
    const made = await c.createCampaign(tokens, account, draft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    const body = posted("/marketers/")[0]?.json;
    assert.equal(body?.enabled, false);
    assert.equal(body?.cpc, 25);
    assert.equal(posted("/promotedLinks")[0]?.json?.imageMetadata?.url, "https://cdn.example.com/creative.jpg");
    const cpm = readyDraft("OUTBRAIN");
    cpm.campaign.bidType = "CPM";
    await c.createCampaign(tokens, account, cpm, new Map());
    assert.equal(posted("/marketers/").at(-1)?.json?.cpm, 25);
    assert.equal(posted("/marketers/").at(-1)?.json?.cpc, undefined);
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
    // nextToken was followed to the second page.
    assert.deepEqual(structure.campaigns.filter((x) => x.objective === "SPONSORED_PRODUCTS").map((x) => x.externalId), ["c1", "c2"]);
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
    brands.adGroups[0]!.ads[0]!.values.brandName = "Ashniva";
    const sbMade = await c.createCampaign(tokens, { ...account, currency: "INR" }, brands, new Map());
    const sb = hits.find((h) => h.url.includes("/sb/v4/ads"))?.json;
    assert.deepEqual(sb?.ads?.[0]?.creative?.asins, ["B0TESTASIN"]);
    assert.equal(sb?.ads?.[0]?.creative?.headline, "Festive edit");
    assert.equal(sb?.ads?.[0]?.creative?.brandName, "Ashniva");
    assert.equal(sbMade.campaigns[0]?.raw.product, "SPONSORED_BRANDS");

    const display = readyDraft("AMAZON", { adProduct: "SPONSORED_DISPLAY" });
    display.campaign.tactic = "T00030";
    display.adGroups[0]!.ads[0]!.values.asin = "B0TESTASIN";
    await c.createCampaign(tokens, { ...account, currency: "INR" }, display, new Map());
    const sd = hits.find((h) => h.url.endsWith("/sd/campaigns") && h.method === "POST")?.json;
    assert.equal(sd?.[0]?.tactic, "T00030");
    assert.equal(sd?.[0]?.state, "paused");
    assert.equal(hits.find((h) => h.url.endsWith("/sd/productAds"))?.json?.[0]?.asin, "B0TESTASIN");
    display.adGroups[0]!.ads[0]!.values.asin = "";
    const before = hits.length;
    await assert.rejects(() => c.createCampaign(tokens, { ...account, currency: "INR" }, display, new Map()), /needs the ASIN/);
    assert.equal(hits.length, before, "nothing is created for an ad group with nothing to serve");
  });

  it("Amazon reads multi-status replies, rolls back on failure and skips keywords for auto targeting", async () => {
    assert.equal(createdId({ campaigns: { success: [{ index: 0, campaignId: 991 }], error: [] } }, "campaigns", "SP"), "991");
    assert.throws(
      () => createdId({ campaigns: { success: [], error: [{ index: 0, errors: [{ errorType: "budget", errorValue: { budgetError: { message: "Budget is too low" } } }] }] } }, "campaigns", "SP campaign"),
      /SP campaign: Budget is too low/,
    );

    installFetch();
    const c = new AmazonAdsConnector({ clientId: "amz", clientSecret: "sec" });
    const account = { externalId: "p1", currency: "INR", meta: { host: "https://advertising-api.amazon.com" } };
    override = (u, method) =>
      u.pathname === "/sp/adGroups" && method === "POST" ? { adGroups: { success: [], error: [{ index: 0, errors: [{ errorValue: { otherError: { message: "Bad bid" } } }] }] } } : undefined;
    const draft = readyDraft("AMAZON", { adProduct: "SPONSORED_PRODUCTS" });
    draft.adGroups[0]!.ads[0]!.values.asin = "B0TESTASIN";
    await assert.rejects(() => c.createCampaign({ accessToken: "a" }, account, draft, new Map()), /Ad group: Bad bid/);
    assert.deepEqual(hits.find((h) => h.url.endsWith("/sp/campaigns/delete"))?.json?.campaignIdFilter?.include, ["amz-c"]);

    override = null;
    hits = [];
    draft.campaign.targetingType = "AUTO";
    draft.adGroups[0]!.values.keywords = [{ text: "lehenga", matchType: "EXACT" }];
    await c.createCampaign({ accessToken: "a" }, account, draft, new Map());
    assert.equal(hits.some((h) => h.url.endsWith("/sp/keywords")), false);
  });

  it("Amazon fails instead of connecting with no profiles, and does not hide list errors", async () => {
    installFetch();
    const c = new AmazonAdsConnector({ clientId: "amz", clientSecret: "sec" });
    override = (u) => (u.pathname === "/v2/profiles" ? new Reply({ message: "Unauthorized" }, 401) : undefined);
    await assert.rejects(() => c.listAdAccounts({ accessToken: "a" }), (e: unknown) => e instanceof ConnectorError && e.code === "AUTH_EXPIRED");

    const account = { externalId: "p1", currency: "INR", meta: { host: "https://advertising-api.amazon.com" } };
    override = (u) => (u.pathname === "/sp/campaigns/list" ? new Reply({ message: "Service unavailable" }, 503) : undefined);
    await assert.rejects(() => c.fetchStructure({ accessToken: "a" }, account), /Service unavailable/);
    // A profile without Sponsored Brands (403) still syncs its other products.
    override = (u) => (u.pathname === "/sb/v4/campaigns/list" ? new Reply({ message: "Not entitled" }, 403) : undefined);
    const structure = await c.fetchStructure({ accessToken: "a" }, account);
    assert.equal(structure.campaigns.some((x) => x.objective === "SPONSORED_BRANDS"), false);
    assert.ok(structure.campaigns.some((x) => x.objective === "SPONSORED_PRODUCTS"));
  });

  it("X Ads connects with 3-legged OAuth 1.0a and signs every call", async () => {
    installFetch();
    const c = new XAdsConnector({ consumerKey: "ck", consumerSecret: "cs" });
    assert.throws(() => c.getAuthUrl(), /OAuth 1\.0a/);
    const start = await c.startOAuth1({ redirectUri: redirect });
    assert.equal(start.url, "https://api.x.com/oauth/authorize?oauth_token=req-1");
    assert.equal(start.requestSecret, "req-sec");
    const requestToken = hits.at(-1)!;
    assert.equal(oauthParams(requestToken.headers.authorization).oauth_callback, redirect);
    assert.equal(oauthParams(requestToken.headers.authorization).oauth_token, undefined);
    assert.ok(signedWith(requestToken, "cs"));

    const tokens = await c.exchangeCode({ code: "verifier-1", redirectUri: redirect, query: { oauth_token: "req-1", oauth_verifier: "verifier-1" }, requestSecret: "req-sec" });
    const accessToken = hits.at(-1)!;
    assert.equal(oauthParams(accessToken.headers.authorization).oauth_verifier, "verifier-1");
    assert.equal(oauthParams(accessToken.headers.authorization).oauth_token, "req-1");
    assert.ok(signedWith(accessToken, "cs", "req-sec"));
    // OAuth 1.0a user tokens don't expire, so there's nothing to refresh.
    assert.equal(tokens.expiresAt, undefined);
    assert.equal(await c.refreshTokens(), null);
    assert.deepEqual(unpackToken(tokens.accessToken), { token: "1-acc", secret: "acc-sec", userId: "42", screenName: "ashniva" });
    assert.deepEqual(await c.getUser(tokens), { id: "42", name: "@ashniva" });
    await assert.rejects(() => c.exchangeCode({ code: "v", redirectUri: redirect, query: { oauth_token: "req-1" } }), /request token/);

    // A connection from the OAuth 2.0 days has to reconnect; nothing is sent with it.
    const sent = hits.length;
    await assert.rejects(() => c.listAdAccounts({ accessToken: "access-1" }), (e: unknown) => e instanceof ConnectorError && e.code === "AUTH_EXPIRED");
    assert.equal(hits.length, sent);

    const accounts = await c.listAdAccounts(tokens);
    const account = ref(accounts[0]!);
    const structure = await c.fetchStructure(tokens, account);
    assert.equal(structure.adGroups[0]?.campaignExternalId, "c1");
    // next_cursor was followed.
    assert.deepEqual(structure.campaigns.map((x) => x.externalId), ["c1", "c2"]);
    const metrics = await c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" });
    assert.equal(metrics[0]?.impressions, 9);
    assert.equal(metrics[0]?.spend, 1.5);
    const stats = new URL(hits.find((h) => h.url.includes("/stats/"))!.url).searchParams;
    assert.equal(stats.get("entity_ids"), "c1,c2");
    assert.equal(stats.get("start_time"), "2026-10-01T00:00:00Z");
    assert.equal(stats.get("end_time"), "2026-10-03T00:00:00Z"); // exclusive: the day after the last day
    assert.match(String(stats.get("metric_groups")), /VIDEO/);
    assert.equal(midnightIn("2026-10-01", "Asia/Kolkata"), "2026-09-30T18:30:00Z");
    assert.equal(midnightIn("2026-10-01", "America/New_York"), "2026-10-01T04:00:00Z");
    await c.setCampaignStatus(tokens, account, { externalId: "c1" }, "PAUSED");
    assert.equal(new URL(hits.at(-1)!.url).searchParams.get("entity_status"), "PAUSED");

    // Every Ads API call carried the user's token and a valid signature.
    const api = hits.slice(sent);
    assert.ok(api.length > 5);
    for (const h of api) {
      assert.equal(oauthParams(h.headers.authorization).oauth_token, "1-acc", h.url);
      assert.ok(signedWith(h, "cs", "acc-sec"), h.url);
    }
  });

  it("X Ads creates promoted-only posts on a paused line item and never posts publicly", async () => {
    installFetch();
    const c = new XAdsConnector({ consumerKey: "ck", consumerSecret: "cs" });
    const tokens = { accessToken: packToken({ token: "1-acc", secret: "acc-sec", userId: "42" }) };
    const draft = readyDraft("X");
    draft.campaign.fundingInstrumentId = "fi-9";
    const group = draft.adGroups[0]!;
    group.values.goal = "SITE_VISITS";
    group.values.bidAmount = 0;
    const ad = group.ads[0]!;
    ad.values.url = "https://ashniva.com/festive";
    ad.values.video = ["cr-1"];
    const uploaded: string[] = [];
    const assets = new Map([
      ["cr-1", { creativeId: "cr-1", type: "IMAGE" as const, filename: "festive.jpg", mimeType: "image/jpeg", width: 1200, height: 675, load: async () => Buffer.from("jpeg-bytes"), onUploaded: async (r: string) => void uploaded.push(r) }],
    ]);
    const made = await c.createCampaign(tokens, { externalId: "xacc", currency: "USD" }, draft, assets);

    // Nothing went to the endpoints that publish to the timeline.
    assert.equal(hits.some((h) => /^\/(2\/tweets|1\.1\/statuses)/.test(new URL(h.url).pathname)), false);
    const tweetAt = hits.findIndex((h) => new URL(h.url).pathname === "/12/accounts/xacc/tweet");
    const tweet = new URL(hits[tweetAt]!.url).searchParams;
    assert.equal(tweet.get("nullcast"), "true");
    assert.equal(tweet.get("as_user_id"), "756201191646691328"); // the account's FULL promotable user
    assert.equal(tweet.get("text"), "The festive edit is live\nhttps://ashniva.com/festive");
    assert.equal(tweet.get("media_keys"), "3_m1");
    // The post exists before the campaign, so a bad post leaves no half-made campaign.
    assert.ok(tweetAt < hits.findIndex((h) => h.method === "POST" && h.url.includes("/accounts/xacc/campaigns")));

    // Media: chunked v2 upload, then the ad account's Media Library.
    const init = hits.find((h) => h.url.endsWith("/2/media/upload/initialize"))!;
    assert.deepEqual(init.json, { media_type: "image/jpeg", total_bytes: 10, media_category: "tweet_image" });
    assert.equal(hits.find((h) => h.url.endsWith("/append"))?.json?.media, Buffer.from("jpeg-bytes").toString("base64"));
    assert.equal(new URL(hits.find((h) => h.url.includes("/media_library"))!.url).searchParams.get("media_key"), "3_m1");
    assert.deepEqual(uploaded, ["x:3_m1"]);

    const campaign = new URL(hits.find((h) => h.method === "POST" && h.url.includes("/accounts/xacc/campaigns"))!.url).searchParams;
    assert.equal(campaign.get("entity_status"), "PAUSED");
    assert.equal(campaign.get("funding_instrument_id"), "fi-9");
    assert.equal(campaign.get("daily_budget_amount_local_micro"), "25000000");
    // Unset fields are left out rather than sent as "undefined".
    assert.equal(campaign.has("total_budget_amount_local_micro"), false);
    for (const h of hits) assert.equal(h.url.includes("undefined"), false, h.url);
    const line = new URL(hits.find((h) => h.method === "POST" && h.url.includes("/line_items"))!.url).searchParams;
    assert.equal(line.get("entity_status"), "PAUSED");
    assert.equal(line.get("goal"), "SITE_VISITS");
    assert.equal(line.get("bid_strategy"), "AUTO");
    assert.match(String(line.get("start_time")), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const promoted = new URL(hits.find((h) => h.method === "POST" && h.url.includes("/promoted_tweets"))!.url).searchParams;
    assert.equal(promoted.get("line_item_id"), "x-new");
    assert.equal(promoted.get("tweet_ids"), "1880028106020515841"); // id_str, not the rounded number
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    assert.equal(made.ads[0]?.externalId, "pt-0");
    assert.equal(made.ads[0]?.sourceKey, ad.key);
    for (const h of hits) assert.ok(signedWith(h, "cs", "acc-sec"), h.url);

    // The guard holds even if something asks for a public post directly.
    const before = hits.length;
    const unsupported = (e: unknown) => e instanceof ConnectorError && e.code === "UNSUPPORTED";
    await assert.rejects(() => c.api(tokens).post("https://api.x.com/2/tweets", { text: "hi" }), unsupported);
    await assert.rejects(() => c.api(tokens).postJson("https://api.x.com/2/tweets", { text: "hi" }), unsupported);
    await assert.rejects(() => c.api(tokens).post("https://api.x.com/1.1/statuses/update.json", { status: "hi" }), unsupported);
    await assert.rejects(() => c.api(tokens).post(`https://ads-api.x.com/12/accounts/xacc/tweet`, { as_user_id: "42", text: "hi" }), unsupported);
    await assert.rejects(() => c.api(tokens).post(`https://ads-api.x.com/12/accounts/xacc/tweet`, { as_user_id: "42", text: "hi", nullcast: false }), unsupported);
    assert.equal(hits.length, before);

    // A bid uses MAX (TARGET for reach), since AUTO ignores the amount.
    installFetch();
    group.values.bidAmount = 2;
    group.ads = [];
    await c.createCampaign(tokens, { externalId: "xacc", currency: "USD" }, draft, new Map());
    const bid = new URL(hits.find((h) => h.method === "POST" && h.url.includes("/line_items"))!.url).searchParams;
    assert.equal(bid.get("bid_strategy"), "MAX");
    assert.equal(bid.get("bid_amount_local_micro"), "2000000");
    assert.equal(hits.some((h) => h.url.includes("/tweet")), false);
  });

  it("X video views campaigns need a video on every post", () => {
    const draft = readyDraft("X", { objective: "VIDEO_VIEWS" });
    const issues = validateDraft(BUILDER_SPECS.X, draft, new Map());
    assert.ok(issues.some((i) => i.field === "video"));
    assert.equal(BUILDER_SPECS.X.apiCreatable, undefined);
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
    // offset/limit paging read the second page from pagination.totalResults.
    assert.deepEqual(structure.campaigns.map((x) => x.externalId), ["c1", "c2"]);
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

    draft.campaign.adamId = "id12345";
    await assert.rejects(() => c.createCampaign(tokens, { ...account, currency: "USD" }, draft, new Map()), /adamId/);
    draft.campaign.adamId = "1234567890";
    override = (u, method) => (method === "POST" && u.pathname.endsWith("/adgroups") ? { data: {} } : undefined);
    await assert.rejects(() => c.createCampaign(tokens, { ...account, currency: "USD" }, draft, new Map()), /did not return an id for the ad group/);
    override = null;
    // Metrics: an expired login is not turned into an empty report.
    override = (u) => (u.pathname.includes("/reports/") ? new Reply({ error: { message: "Token expired" } }, 401) : undefined);
    await assert.rejects(() => c.fetchMetrics(tokens, account, { from: "2026-10-01", to: "2026-10-02" }), /Token expired/);
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

    // The campaign budget is split across ad sets, not copied to each; the asset follows the format.
    hits = [];
    const split = readyDraft("SPOTIFY", { objective: "CLICKS" });
    split.campaign.budget = 25;
    split.adGroups.push({ ...structuredClone(split.adGroups[0]!), key: "set-2" });
    split.adGroups[1]!.ads[0]!.values = { ...split.adGroups[1]!.ads[0]!.values, format: "VIDEO", audioUrl: "https://cdn.example.com/a.mp3", videoUrl: "https://cdn.example.com/v.mp4", thumbnailUrl: "https://cdn.example.com/t.jpg" };
    await spotify.createCampaign(auth, sAccount, split, new Map());
    assert.deepEqual(posted("/ad_sets").map((h) => h.json?.budget?.micro_amount), [12_500_000, 12_500_000]);
    const video = posted("/ads").at(-1)?.json;
    assert.equal(video?.assets?.asset_url, "https://cdn.example.com/v.mp4");
    assert.equal(video?.assets?.companion_image_url, "https://cdn.example.com/t.jpg");
    // Daily budget edits go to the ad sets.
    hits = [];
    await spotify.setCampaignDailyBudget(auth, sAccount, { externalId: "c1" }, 9);
    const patch = hits.find((h) => h.method === "PATCH");
    assert.match(patch!.url, /\/ad_sets\/g1$/);
    assert.equal(patch?.json?.budget?.micro_amount, 9_000_000);
    // A failing list is an error, not an empty account.
    override = (u) => (u.pathname.endsWith("/ad_sets") ? new Reply({ message: "Rate limited" }, 429) : undefined);
    await assert.rejects(() => spotify.fetchStructure(auth, sAccount), (e: unknown) => e instanceof ConnectorError && e.code === "RATE_LIMITED");
    override = null;

    const criteo = new CriteoConnector({ clientId: "c", clientSecret: "c" });
    await criteo.exchangeCode({ code: "client_credentials", redirectUri: redirect });
    const cAccount = ref((await criteo.listAdAccounts(auth))[0]!);
    assert.equal((await criteo.fetchStructure(auth, cAccount)).campaigns[0]?.name, "Retarget");
    const cMade = await criteo.createCampaign(auth, cAccount, readyDraft("CRITEO"), new Map());
    assert.equal(cMade.campaigns[0]?.objective, "RETARGETING");
    const cBody = hits.find((h) => h.method === "POST" && /\/advertisers\/[^/]+\/ad-sets$/.test(new URL(h.url).pathname))?.json;
    assert.equal(cBody?.data?.attributes?.status, "PAUSED");
    assert.equal(cBody?.data?.attributes?.goal, "RETARGETING");
    assert.deepEqual(cMade.campaigns[0]?.raw, { adSetIds: ["cr-new"] });
    // Status and budget go to the campaign's ad set, never to /ad-sets/<campaign id>.
    hits = [];
    await criteo.setCampaignStatus(auth, cAccount, { externalId: "camp1" }, "ACTIVE");
    await criteo.setCampaignDailyBudget(auth, cAccount, { externalId: "camp1", raw: { adSetIds: ["set1"] } }, 30);
    assert.deepEqual(hits.filter((h) => /\/ad-sets\/start$/.test(new URL(h.url).pathname)).map((h) => h.json), [{ data: [{ type: "AdSetId", id: "set1" }] }]);
    assert.deepEqual(hits.filter((h) => h.method === "PATCH").map((h) => new URL(h.url).pathname), ["/2025-10/ad-sets/set1"]);
    const twoSets = readyDraft("CRITEO");
    twoSets.adGroups.push({ ...structuredClone(twoSets.adGroups[0]!), key: "set-2" });
    await assert.rejects(() => criteo.createCampaign(auth, cAccount, twoSets, new Map()), /one ad set/);

    const yahoo = new YahooDspConnector({ clientId: "y", clientSecret: "y" });
    assert.match(yahoo.getAuthUrl({ state: "s", redirectUri: redirect }), /api.login.yahoo.com/);
    await yahoo.exchangeCode({ code: "code", redirectUri: redirect });
    const yAccount = ref((await yahoo.listAdAccounts(auth))[0]!);
    assert.equal((await yahoo.fetchStructure(auth, yAccount)).adGroups[0]?.campaignExternalId, "c1");
    const yDraft = readyDraft("YAHOO", { format: "DISPLAY" });
    yDraft.adGroups[0]!.ads[0]!.values.size = "300x250";
    yDraft.campaign.budget = 10;
    yDraft.adGroups.push({ ...structuredClone(yDraft.adGroups[0]!), key: "line-2" }, { ...structuredClone(yDraft.adGroups[0]!), key: "line-3" });
    const yMade = await yahoo.createCampaign(auth, yAccount, yDraft, new Map());
    assert.deepEqual(posted("/traffic/lines").map((h) => h.json?.budget), [3.33, 3.33, 3.33]);
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
    // Paused launch: the campaign stays Available (Archived is permanent); its ad groups are off.
    const tCampaign = created.find((h) => h.url.endsWith("/campaign"))?.json;
    assert.equal(tCampaign?.Availability, "Available");
    assert.equal(tCampaign?.DailyBudget?.CurrencyCode, "USD");
    assert.equal(tCampaign?.Budget, undefined);
    assert.equal(created[groupAt]?.json?.IsEnabled, false);
    assert.equal(created.find((h) => h.url.endsWith("/creative"))?.json?.Countries, undefined);
    hits = [];
    await ttd.setCampaignStatus(tTokens, tAccount, { externalId: "c1" }, "PAUSED");
    assert.equal(hits.some((h) => h.method === "PUT" && h.url.endsWith("/campaign")), false);
    assert.deepEqual(hits.filter((h) => h.method === "PUT").map((h) => [new URL(h.url).pathname, h.json?.IsEnabled]), [["/v3/adgroup", false]]);
    hits = [];
    await ttd.setCampaignDailyBudget(tTokens, { ...tAccount, currency: "EUR" }, { externalId: "c1" }, 40);
    assert.deepEqual(hits[0]?.json, { CampaignId: "c1", DailyBudget: { Amount: 40, CurrencyCode: "EUR" } });
    // The total Budget is reported as lifetime, not as the daily figure.
    const tStructure = await ttd.fetchStructure(tTokens, tAccount);
    assert.equal(tStructure.campaigns[0]?.dailyBudget, null);
    assert.equal(tStructure.campaigns[0]?.lifetimeBudget, 50);
    const native = readyDraft("TRADEDESK", { format: "NATIVE" });
    native.adGroups[0]!.ads[0]!.values.headline = "";
    await assert.rejects(() => ttd.createCampaign(tTokens, tAccount, native, new Map()), /headline/);
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
    const events = await c.fetchStructure(tokens, account);
    assert.equal(events.campaigns[0]?.status, "PAUSED");
    // The Link rel="next" page was read too.
    assert.deepEqual(events.campaigns.map((x) => x.externalId), ["41", "42"]);
    const shopDraft = readyDraft("SHOPIFY", { channel: "social" });
    shopDraft.campaign.utmSource = "";
    shopDraft.campaign.utmMedium = " ";
    const made = await c.createCampaign(tokens, account, shopDraft, new Map());
    assert.equal(made.campaigns[0]?.status, "PAUSED");
    assert.equal(made.campaigns[0]?.externalId, "77");
    const body = hits.find((h) => h.method === "POST" && h.url.includes("/marketing_events.json"))?.json?.marketing_event;
    assert.equal(body?.marketing_channel, "social");
    assert.equal(body?.paid, true);
    // Created paused is recorded as ended ("Record as ended" in the form), and blank UTMs are left out.
    assert.equal(body?.ended_at, body?.started_at);
    assert.ok(body?.ended_at);
    assert.equal("utm_source" in body!, false);
    assert.equal("utm_medium" in body!, false);
    assert.ok(made.warnings?.length);

    const query: Record<string, string> = { code: "abc", shop: "ashniva.myshopify.com", state, timestamp: "1700000000" };
    const message = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
    const hmac = createHmac("sha256", "sec").update(message).digest("hex");
    assert.equal(verifyShopifyHmac({ ...query, hmac }, "sec"), true);
    assert.equal(verifyShopifyHmac({ ...query, shop: "evil.myshopify.com", hmac }, "sec"), false);
    await assert.rejects(() => c.exchangeCode({ code: "abc", redirectUri: redirect, state, query: { ...query, hmac: "0".repeat(64) } }), /signature/);
  });
});

// ───────── Per-organization API keys (key-based platforms) ─────────

type KeyPlatform = "OUTBRAIN" | "TRADEDESK" | "CRITEO" | "APPLE" | "TABOOLA";
const KEY_PLATFORMS: KeyPlatform[] = ["OUTBRAIN", "TRADEDESK", "CRITEO", "APPLE", "TABOOLA"];
type Org = "A" | "B";

const appleKeyPairs: Record<Org, { privateKey: KeyObject; publicKey: KeyObject }> = {
  A: generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
  B: generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
};

/** Each customer organization's own keys. The operator's are the ones in fullConfig(). */
function orgKeys(org: Org): Record<KeyPlatform, PlatformCredentials> {
  return {
    OUTBRAIN: { apiToken: `ob-${org}` },
    TRADEDESK: { apiToken: `ttd-${org}`, partnerId: `partner-${org}` },
    CRITEO: { clientId: `criteo-${org}`, clientSecret: `criteo-${org}-secret` },
    APPLE: {
      clientId: `SEARCHADS.apple-${org}`,
      teamId: `SEARCHADS.team-${org}`,
      keyId: `key-${org}`,
      privateKey: appleKeyPairs[org].privateKey.export({ type: "sec1", format: "pem" }).toString(),
    },
    TABOOLA: { clientId: `taboola-${org}`, clientSecret: `taboola-${org}-secret` },
  };
}

/** The Trade Desk token that may read each partner (the operator's is "tok" for "partner"). */
const TTD_PARTNER_TOKEN: Record<string, string> = { "partner-A": "ttd-A", "partner-B": "ttd-B", partner: "tok" };

const jwtPart = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, any>;

/** Apple's check of a signed client secret: the API user's public key, kid, team, audience and expiry. */
function appleSecretValid(clientId: string, secret: string) {
  if (clientId === "id") return secret === "sec"; // the operator's pre-signed secret from config
  const org = (["A", "B"] as const).find((o) => clientId === `SEARCHADS.apple-${o}`);
  const [h, p, sig] = secret.split(".");
  if (!org || !h || !p || !sig) return false;
  const header = jwtPart(h);
  const payload = jwtPart(p);
  const signed = verify("sha256", Buffer.from(`${h}.${p}`), { key: appleKeyPairs[org].publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
  return (
    signed &&
    header.alg === "ES256" &&
    header.kid === `key-${org}` &&
    payload.sub === clientId &&
    payload.iss === `SEARCHADS.team-${org}` &&
    payload.aud === "https://appleid.apple.com" &&
    payload.exp > Date.now() / 1000
  );
}

/**
 * A fake of each platform where a key only reaches the accounts it owns: the
 * account ids are derived from the token or client id that asked for them.
 */
function tenantApi(u: URL, _method: string, json: Record<string, any> | null, hit: Hit): unknown {
  const path = u.pathname;
  const bearer = hit.headers.authorization?.replace(/^Bearer /, "");
  const clientId = hit.form?.get("client_id") ?? "";
  const clientSecret = hit.form?.get("client_secret") ?? "";
  if ((u.hostname === "api.criteo.com" && path === "/oauth2/token") || (u.hostname === "backstage.taboola.com" && path.endsWith("/oauth/token"))) {
    const ok = clientSecret === `${clientId}-secret` || (clientId === "id" && clientSecret === "sec");
    return ok ? { access_token: `bearer-${clientId}`, expires_in: 3600 } : new Reply({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
  }
  if (u.hostname === "appleid.apple.com") {
    return appleSecretValid(clientId, clientSecret) ? { access_token: `bearer-${clientId}`, expires_in: 3600 } : new Reply({ error: "invalid_client" }, 400);
  }
  if (u.hostname === "api.outbrain.com" && path.endsWith("/marketers")) {
    return { marketers: [{ id: `marketer-of-${hit.headers["ob-token-v1"]}`, name: "Marketer", currency: "USD" }] };
  }
  if (u.hostname === "api.thetradedesk.com" && path.endsWith("/advertiser/query/partner")) {
    const partner = String(json?.PartnerId);
    if (TTD_PARTNER_TOKEN[partner] !== hit.headers["ttd-auth"]) return new Reply({ message: "Not authorized for this partner" }, 403);
    return { Result: [{ AdvertiserId: `advertiser-of-${partner}`, AdvertiserName: "Desk", CurrencyCode: "USD" }] };
  }
  if (u.hostname === "api.criteo.com" && path.endsWith("/advertisers/me")) return { data: [{ id: `advertiser-of-${bearer}`, attributes: { advertiserName: "Shop" } }] };
  if (u.hostname === "backstage.taboola.com" && path.endsWith("/users/current/account")) return { account_id: `user-of-${bearer}`, name: "Taboola user" };
  if (u.hostname === "backstage.taboola.com" && path.endsWith("/allowed-accounts")) return { results: [{ account_id: `account-of-${bearer}`, name: "News" }] };
  if (u.hostname === "api.searchads.apple.com" && path.endsWith("/acls")) return { data: [{ orgId: `org-of-${bearer}`, orgName: "Apps" }] };
  return undefined;
}

/** True when a request sent any of the operator's keys from fullConfig(). */
function usedOperatorKeys(h: Hit) {
  return h.headers["ob-token-v1"] === "tok" || h.headers["ttd-auth"] === "tok" || h.json?.PartnerId === "partner" || h.form?.get("client_id") === "id";
}

describe("integration: each organization connects with its own API keys", () => {
  it("lists exactly the five key-based platforms, each with a secret field", () => {
    assert.deepEqual(Object.keys(CONNECT_CREDENTIALS).sort(), [...KEY_PLATFORMS].sort());
    for (const p of PLATFORMS) assert.equal(connectsWithCredentials(p), KEY_PLATFORMS.includes(p as KeyPlatform), p);
    const registry = createConnectorRegistry(fullConfig());
    for (const p of KEY_PLATFORMS) {
      assert.ok(CONNECT_CREDENTIALS[p]!.fields.some((f) => f.secret), p);
      assert.equal(typeof registry.get(p).connectWithCredentials, "function", p);
    }
    for (const p of ["META", "GOOGLE", "AMAZON", "SPOTIFY"] as const) assert.equal(registry.get(p).connectWithCredentials, undefined, p);
  });

  it("one organization never sees another's accounts, nor the operator's", async () => {
    for (const platform of KEY_PLATFORMS) {
      installFetch();
      override = tenantApi;
      // The operator's keys are configured too: customer connections must still not use them.
      const connector: AdPlatformConnector = createConnectorRegistry(fullConfig()).get(platform);
      const seen = {} as Record<Org, string[]>;
      for (const org of ["A", "B"] as const) {
        const credentials = orgKeys(org)[platform];
        const tokens = await connector.connectWithCredentials!(credentials);
        const auth = { accessToken: tokens.accessToken, credentials };
        assert.ok((await connector.getUser(auth)).id, `${platform} ${org} user`);
        seen[org] = (await connector.listAdAccounts(auth)).map((a) => a.externalId);
      }
      assert.equal(hits.some(usedOperatorKeys), false, `${platform} sent the operator's keys for a customer`);

      // The operator's own connection (no stored keys) still runs on the keys from config.
      const opTokens = await connector.exchangeCode({ code: "client_credentials", redirectUri: redirect });
      const operator = (await connector.listAdAccounts({ accessToken: opTokens.accessToken })).map((a) => a.externalId);

      assert.equal(seen.A.length, 1, platform);
      assert.equal(seen.B.length, 1, platform);
      assert.equal(operator.length, 1, platform);
      assert.equal(new Set([...seen.A, ...seen.B, ...operator]).size, 3, `${platform}: ${seen.A} / ${seen.B} / ${operator}`);
      restore?.();
    }
  });

  it("refreshes client-credential tokens with the connection's own keys", async () => {
    installFetch();
    override = tenantApi;
    const registry = createConnectorRegistry(fullConfig());
    for (const platform of ["CRITEO", "TABOOLA", "APPLE"] as const) {
      const credentials = orgKeys("B")[platform];
      const tokens = await registry.get(platform).refreshTokens("client_credentials", credentials);
      assert.equal(tokens?.accessToken, `bearer-${credentials.clientId}`, platform);
    }
    assert.equal(hits.some(usedOperatorKeys), false);
  });

  it("turns down wrong or incomplete keys with a clear error", async () => {
    installFetch();
    override = tenantApi;
    const registry = createConnectorRegistry(fullConfig());
    const isPlatformReply = (code: string, message: RegExp) => (e: unknown) =>
      e instanceof ConnectorError && e.code === code && e.details !== undefined && message.test(e.message);

    await assert.rejects(
      () => registry.get("CRITEO").connectWithCredentials!({ clientId: "criteo-A", clientSecret: "wrong" }),
      isPlatformReply("AUTH_EXPIRED", /Client authentication failed/),
    );
    // A's client id signed with B's private key.
    await assert.rejects(
      () => registry.get("APPLE").connectWithCredentials!({ ...orgKeys("A").APPLE, privateKey: orgKeys("B").APPLE.privateKey! }),
      isPlatformReply("INVALID_REQUEST", /invalid_client/),
    );
    // A's token cannot read B's partner.
    const ttd = registry.get("TRADEDESK");
    await assert.rejects(
      () => ttd.listAdAccounts({ accessToken: "ttd-A", credentials: { apiToken: "ttd-A", partnerId: "partner-B" } }),
      isPlatformReply("PERMISSION_DENIED", /Not authorized/),
    );
    // A customer connection missing its partner id never falls back to the operator's.
    await assert.rejects(() => ttd.getUser({ accessToken: "ttd-A", credentials: { apiToken: "ttd-A" } }), /partner id is missing/);

    const before = hits.length;
    await assert.rejects(
      () => registry.get("TABOOLA").connectWithCredentials!({ clientId: "taboola-A", clientSecret: "  " }),
      (e: unknown) => e instanceof ConnectorError && e.code === "INVALID_REQUEST" && e.details === undefined && /Enter the Taboola Client secret/.test(e.message),
    );
    await assert.rejects(() => registry.get("OUTBRAIN").connectWithCredentials!({}), /Enter the Outbrain Amplify API token/);
    assert.equal(hits.length, before, "incomplete keys are not sent anywhere");
  });

  it("signs Apple's ES256 client secret on the server, well inside the 180-day limit", () => {
    const keys = orgKeys("A").APPLE as { clientId: string; teamId: string; keyId: string; privateKey: string };
    const now = Date.UTC(2026, 9, 30);
    const secret = appleClientSecret(keys, now);
    const [h, p] = secret.split(".");
    assert.deepEqual(jwtPart(h!), { alg: "ES256", kid: "key-A" });
    const payload = jwtPart(p!);
    assert.equal(payload.sub, keys.clientId);
    assert.equal(payload.iss, keys.teamId);
    assert.equal(payload.aud, "https://appleid.apple.com");
    assert.equal(payload.iat, now / 1000);
    assert.ok(payload.exp > payload.iat && payload.exp - payload.iat <= 180 * 86400);
    assert.equal(appleSecretValid(keys.clientId, appleClientSecret(keys)), true);
    // A key pasted with literal \n (from a .env file) still works.
    assert.equal(appleSecretValid(keys.clientId, appleClientSecret({ ...keys, privateKey: keys.privateKey.replace(/\n/g, "\\n") })), true);

    assert.throws(() => appleClientSecret({ ...keys, privateKey: "not a key" }), /valid PEM/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => appleClientSecret({ ...keys, privateKey: rsa }), /P-256/);
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
    x: { consumerKey: "id", consumerSecret: "sec" },
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
