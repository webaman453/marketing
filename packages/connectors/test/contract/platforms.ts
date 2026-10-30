/**
 * Per-platform contract setup: how to build the connector, a fake account,
 * a responder that answers every request with a plausible success body, and
 * the known findings / allowlists the contract test checks against.
 */
import { expect } from "vitest";
import type { BuilderDraft, Platform } from "@ashniva/shared";
import type { AccountRef, AdPlatformConnector, ConnectorAuth } from "../../src/types";
import { reply, type Recorded, type Responder, type RunResult, type Samples } from "./harness";

type Row = Record<string, any>;

/** A known mismatch, asserted the correct way round with it.fails so it flips when fixed. */
export type Finding =
  /** The connector reads a key the form never collects. "level:key" */
  | { kind: "extraRead"; key: string; title: string }
  /** The form requires a key the connector never sends. "level:key" */
  | { kind: "unread"; key: string; title: string }
  /** A fully filled draft does not pass validateDraft for runs matching `where`. */
  | { kind: "invalid"; where: (r: RunResult) => boolean; title: string }
  /** createCampaign throws for runs matching `where` even though the form allows the draft. */
  | { kind: "createError"; where: (r: RunResult) => boolean; title: string }
  /** Anything else: `check` holds once the bug is fixed. */
  | { kind: "custom"; title: string; check: (runs: RunResult[]) => void };

export interface PlatformCase {
  platform: Platform;
  /** describe.skip with this reason (e.g. connector mid-edit by another session). */
  skip?: string;
  connector: () => Promise<AdPlatformConnector>;
  auth: ConnectorAuth;
  account: AccountRef & { currency: string; timezone?: string | null };
  /** Fresh responder per run, so ids in snapshots don't depend on test order. */
  respond: () => Responder;
  samples?: Samples;
  /** Platform-specific sample tweaks applied after the generic fill. */
  tweak?: (d: BuilderDraft) => void;
  /**
   * Required, visible form keys the connector legitimately never reads
   * ("level:key" → why). Every entry must say why it is form-only.
   */
  formOnly?: Record<string, string>;
  /** Status hits ("METHOD /path body.path") that may be active-like on a paused launch (children of a paused parent). */
  statusIgnore?: RegExp[];
  /** No status field exists on the platform (only the returned structure is checked). */
  noRequestStatus?: boolean;
  /** Requests left out of the snapshot (e.g. cached lookups whose order depends on test order). */
  snapshotSkip?: (c: Recorded) => boolean;
  findings?: Finding[];
}

const counter = () => {
  const n = new Map<string, number>();
  return (kind: string) => {
    const next = (n.get(kind) ?? 0) + 1;
    n.set(kind, next);
    return `${kind}-${next}`;
  };
};

const last = (path: string) => path.split("/").filter(Boolean).pop() ?? "x";

// ───────── Responders ─────────

function metaRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    if (req.method === "GET" && p.endsWith("/search")) return { data: [{ key: 6, name: "English (All)" }] };
    if (req.method === "GET") return { id: "vid-1", status: { video_status: "ready" }, picture: "https://cdn.example.com/thumb.jpg" };
    if (req.method === "DELETE") return { success: true };
    if (p.endsWith("/adimages")) return { images: { "image.jpg": { hash: "hash-1" } } };
    if (p.endsWith("/advideos")) return { id: "vid-1" };
    return { id: id(last(p)) };
  };
}

function googleRespond(cid: string): Responder {
  return (req) => {
    const p = req.url.pathname;
    if (p.endsWith("/googleAds:search")) return { results: [{ languageConstant: { resourceName: "languageConstants/1000", code: "en" } }] };
    if (p.endsWith("/geoTargetConstants:suggest")) return { geoTargetConstantSuggestions: [] };
    if (p.endsWith("/googleAds:mutate")) {
      const ops = ((req.body as Row)?.mutateOperations ?? []) as Row[];
      return {
        mutateOperationResponses: ops.map((op, i) => {
          const [opKey, inner] = Object.entries(op)[0] ?? ["unknownOperation", {}];
          const kind = opKey.replace(/Operation$/, "");
          const rn: string = (inner as Row)?.create?.resourceName ?? `customers/${cid}/${kind}s/${5000 + i}`;
          return { [`${kind}Result`]: { resourceName: rn.replace(/\/-(\d+)$/, (_m, d) => `/${1000 + Number(d)}`).replace(/~-(\d+)$/, (_m, d) => `~${1000 + Number(d)}`) } };
        }),
      };
    }
    return {};
  };
}

function linkedinRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    if (req.method === "GET" && p.endsWith("/adTargetingEntities")) return { elements: [{ urn: "urn:li:geo:102713980", name: "India" }] };
    if (req.method === "GET") return { elements: [] };
    if (req.method === "PUT") return reply("", { etag: "etag-1" });
    if (req.url.search.includes("action=initializeUpload") && p.endsWith("/images")) return { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/image-1", image: "urn:li:image:1" } };
    if (req.url.search.includes("action=initializeUpload") && p.endsWith("/videos")) {
      return { value: { video: "urn:li:video:1", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://www.linkedin.com/dms-uploads/video-1", firstByte: 0, lastByte: 1_000_000 }] } };
    }
    if (p.endsWith("/creatives")) return reply({}, { "x-restli-id": encodeURIComponent(`urn:li:sponsoredCreative:${id("creative").split("-")[1]}`) });
    if (/\/(adCampaignGroups|adCampaigns)$/.test(p)) return reply({}, { "x-restli-id": id(last(p)).split("-")[1]! });
    return {};
  };
}

function microsoftRespond(): Responder {
  return (req) => {
    const p = req.url.pathname;
    if (req.url.host.startsWith("download.")) return "Location Id,Bing Display Name,Location Type\n94,India,Country\n190,United States,Country\n";
    if (p.endsWith("/GeoLocationsFileUrl/Query")) return { FileUrl: "https://download.api.bingads.microsoft.com/geo/locations.csv" };
    if (p.endsWith("/Campaigns")) return { CampaignIds: [501], PartialErrors: [] };
    if (p.endsWith("/AdGroups")) return { AdGroupIds: [601], PartialErrors: [] };
    if (p.endsWith("/Ads")) return { AdIds: [701], PartialErrors: [] };
    if (p.endsWith("/AssetGroups")) return { AssetGroupIds: [801], PartialErrors: [] };
    if (p.endsWith("/Media")) return { MediaIds: [901], PartialErrors: [] };
    if (p.endsWith("/AdExtensions")) return { AdExtensionIdentities: [{ Id: 1001 }], PartialErrors: [] };
    return { PartialErrors: [] };
  };
}

function snapRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    if (req.method === "GET" && /\/media\/[^/]+$/.test(p)) return { media: [{ media: { media_status: "READY" } }] };
    if (req.method === "GET") return {};
    if (req.method === "DELETE") return { request_status: "SUCCESS" };
    if (p.endsWith("/upload")) return { request_status: "SUCCESS" };
    const body = (req.body ?? {}) as Row;
    const listKey = Object.keys(body).find((k) => Array.isArray(body[k]));
    if (!listKey) return { request_status: "SUCCESS" };
    const entity = listKey === "media" ? "media" : listKey.replace(/s$/, "");
    return { request_status: "SUCCESS", [listKey]: (body[listKey] as unknown[]).map(() => ({ sub_request_status: "SUCCESS", [entity]: { id: id(entity) } })) };
  };
}

function pinterestRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    if (req.url.host.includes("s3")) return "";
    if (req.method === "GET" && p.endsWith("/boards")) return { items: [] };
    if (req.method === "GET" && /\/media\/[^/]+$/.test(p)) return { status: "succeeded" };
    if (req.method === "GET") return {};
    if (p.endsWith("/boards")) return { id: "board-1" };
    if (p.endsWith("/media")) return { media_id: "media-1", upload_url: "https://pinterest-media-upload.s3-accelerate.amazonaws.com/", upload_parameters: { key: "uploads/1" } };
    if (p.endsWith("/pins")) return { id: id("pin") };
    if (Array.isArray(req.body)) return { items: (req.body as unknown[]).map(() => ({ data: { id: id(last(p)) } })) };
    return {};
  };
}

function amazonRespond(): Responder {
  return (req) => {
    const p = req.url.pathname;
    if (p === "/sd/campaigns" && req.method === "POST") return [{ code: "SUCCESS", campaignId: "sd-c" }];
    if (p === "/sd/adGroups") return [{ code: "SUCCESS", adGroupId: "sd-g" }];
    if (p === "/sd/productAds") return [{ code: "SUCCESS", adId: "sd-a" }];
    if (p.endsWith("/delete")) return {};
    const ok = (key: string, row: Row) => ({ [key]: { success: [{ index: 0, ...row }], error: [] } });
    if (p.endsWith("/campaigns")) return ok("campaigns", { campaignId: "amz-c" });
    if (p.endsWith("/adGroups")) return ok("adGroups", { adGroupId: "amz-g" });
    if (p.endsWith("/productAds")) return ok("productAds", { adId: "amz-a" });
    if (p.endsWith("/ads")) return ok("ads", { adId: "amz-sb-a" });
    if (p.endsWith("/keywords")) {
      const n = (((req.body as Row)?.keywords ?? []) as unknown[]).length || 1;
      return { keywords: { success: Array.from({ length: n }, (_, i) => ({ index: i, keywordId: `amz-k${i}` })), error: [] } };
    }
    return {};
  };
}

function xRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    const q = req.url.searchParams;
    if (p.endsWith("/promotable_users")) return { data: [{ id: "pu1", user_id: "756201191646691328", promotable_user_type: "FULL" }] };
    if (p === "/2/media/upload/initialize") return { data: { id: "m1", media_key: "3_m1", expires_after_secs: 86400 } };
    if (p.startsWith("/2/media/upload")) return { data: { id: "m1", media_key: "3_m1" } };
    if (p.endsWith("/media_library")) return { data: { media_key: q.get("media_key") } };
    if (p.endsWith("/tweet")) return { data: { id: 1880028106020515840, id_str: `18800281060205158${id("t").split("-")[1]!.padStart(2, "0")}`, text: q.get("text") } };
    if (p.endsWith("/promoted_tweets") && req.method === "POST") {
      return { data: String(q.get("tweet_ids")).split(",").map((t, i) => ({ id: `pt-${i}`, line_item_id: q.get("line_item_id"), tweet_id: t, entity_status: "ACTIVE" })) };
    }
    return { data: { id: id(last(p)) } };
  };
}

const simple = (wrap: (id: string, req: Recorded) => unknown) => (): Responder => {
  const id = counter();
  return (req) => wrap(id(last(req.url.pathname).replace(/[^a-zA-Z_-]/g, "") || "x"), req);
};

function tradeDeskRespond(): Responder {
  const id = counter();
  return (req) => {
    const p = req.url.pathname;
    if (p.endsWith("/creative")) return { CreativeId: id("cr") };
    if (p.endsWith("/adgroup")) return { AdGroupId: id("ttd-g") };
    if (p.endsWith("/campaign")) return { CampaignId: id("ttd-c") };
    return {};
  };
}

// ───────── Cases ─────────

const NOW_ACCOUNT = { currency: "USD", timezone: "Asia/Kolkata" };

export const PLATFORMS: PlatformCase[] = [
  {
    platform: "META",
    connector: async () => new (await import("../../src/meta")).MetaConnector({ appId: "app", appSecret: "secret", apiVersion: "v26.0" }),
    auth: { accessToken: "meta-token" },
    account: { externalId: "1001", ...NOW_ACCOUNT },
    respond: metaRespond,
    samples: { accountOption: { apps: "app-1|https://play.google.com/store/apps/details?id=com.example.app", pageId: "page-1", instagramId: "ig-1" } },
  },
  {
    platform: "GOOGLE",
    connector: async () => new (await import("../../src/google")).GoogleAdsConnector({ clientId: "id", clientSecret: "secret", developerToken: "dev", apiVersion: "v22" }),
    auth: { accessToken: "google-token" },
    account: { externalId: "1234567890", ...NOW_ACCOUNT },
    respond: () => googleRespond("1234567890"),
    statusIgnore: [/\.(adGroupOperation|adGroupAdOperation|assetGroupOperation|adGroupCriterionOperation|campaignCriterionOperation|assetGroupAssetOperation|assetGroupSignalOperation)\./],
  },
  {
    platform: "LINKEDIN",
    connector: async () => new (await import("../../src/linkedin")).LinkedInConnector({ clientId: "id", clientSecret: "secret", apiVersion: "202609" }),
    auth: { accessToken: "li-token" },
    account: { externalId: "5001", ...NOW_ACCOUNT },
    respond: linkedinRespond,
    samples: { accountOption: { organizationId: "urn:li:organization:1001", leadFormId: "urn:li:adForm:1", conversions: "7001" } },
  },
  {
    platform: "MICROSOFT",
    connector: async () => new (await import("../../src/microsoft")).MicrosoftAdsConnector({ clientId: "id", clientSecret: "secret", developerToken: "dev", tenant: "common" }),
    auth: { accessToken: "ms-token" },
    account: { externalId: "7001", ...NOW_ACCOUNT },
    respond: microsoftRespond,
    // Child entities are Active under a Paused campaign: the campaign status gates delivery.
    statusIgnore: [/ \/CampaignManagement\/v13\/(AdGroups|Ads|Keywords|AssetGroups)\b/],
    // The locations file is cached per process, so whether it is fetched depends on test order.
    snapshotSkip: (c) => c.url.pathname.endsWith("/GeoLocationsFileUrl/Query") || c.url.host.startsWith("download."),
  },
  {
    platform: "SNAPCHAT",
    connector: async () => new (await import("../../src/snapchat")).SnapchatConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "snap-token" },
    account: { externalId: "snap-acct", ...NOW_ACCOUNT },
    respond: snapRespond,
    // targeting.auto_expansion_options.*.enabled is audience expansion, not delivery status.
    statusIgnore: [/auto_expansion_options/],
  },
  {
    platform: "PINTEREST",
    connector: async () => new (await import("../../src/pinterest")).PinterestConnector({ appId: "id", appSecret: "secret" }),
    auth: { accessToken: "pin-token" },
    account: { externalId: "549755885175", ...NOW_ACCOUNT },
    respond: pinterestRespond,
  },
  {
    platform: "AMAZON",
    connector: async () => new (await import("../../src/amazon")).AmazonAdsConnector({ clientId: "amz", clientSecret: "secret" }),
    auth: { accessToken: "amz-token" },
    account: { externalId: "profile-1", currency: "INR", timezone: "Asia/Kolkata", meta: { host: "https://advertising-api-eu.amazon.com" } },
    respond: amazonRespond,
  },
  {
    platform: "X",
    connector: async () => new (await import("../../src/x")).XAdsConnector({ consumerKey: "ck", consumerSecret: "cs" }),
    auth: { accessToken: JSON.stringify({ oauth1: { token: "1-acc", secret: "acc-sec", userId: "42", screenName: "ashniva" } }) },
    account: { externalId: "xacc", ...NOW_ACCOUNT },
    respond: xRespond,
  },
  {
    platform: "APPLE",
    connector: async () => new (await import("../../src/apple")).AppleAdsConnector({ clientId: "apple", clientSecret: "secret" }),
    auth: { accessToken: "apple-token", credentials: null },
    account: { externalId: "org-1", ...NOW_ACCOUNT },
    respond: simple((id) => ({ data: { id } })),
    // Keywords are ACTIVE inside a paused ad group; the ad group and campaign carry the pause.
    statusIgnore: [/\/targetingkeywords\/bulk body\[/],
  },
  {
    platform: "SPOTIFY",
    connector: async () => new (await import("../../src/spotify")).SpotifyAdsConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "spotify-token" },
    account: { externalId: "sa1", ...NOW_ACCOUNT },
    respond: simple((id) => ({ id })),
  },
  {
    platform: "CRITEO",
    connector: async () => new (await import("../../src/criteo")).CriteoConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "criteo-token", credentials: null },
    account: { externalId: "adv1", ...NOW_ACCOUNT },
    respond: simple((id, req) => ({ data: { id, attributes: req.url.pathname.endsWith("/ad-sets") ? { campaignId: "criteo-campaign-1" } : {} } })),
  },
  {
    platform: "TABOOLA",
    connector: async () => new (await import("../../src/taboola")).TaboolaConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "taboola-token", credentials: null },
    account: { externalId: "acc-1", ...NOW_ACCOUNT },
    respond: simple((id, req) => (req.url.pathname.endsWith("/images/") ? { url: "https://cdn.taboola.example/thumb.jpg" } : { id })),
  },
  {
    platform: "OUTBRAIN",
    connector: async () => new (await import("../../src/outbrain")).OutbrainConnector({ apiToken: "ob-token" }),
    auth: { accessToken: "ob-token", credentials: null },
    account: { externalId: "m1", ...NOW_ACCOUNT },
    respond: simple((id) => ({ id })),
  },
  {
    platform: "TRADEDESK",
    connector: async () => new (await import("../../src/tradedesk")).TradeDeskConnector({ apiToken: "ttd-token", partnerId: "partner-1" }),
    auth: { accessToken: "ttd-token", credentials: null },
    account: { externalId: "adv1", ...NOW_ACCOUNT },
    respond: tradeDeskRespond,
    formOnly: {
      // specs/tradedesk.ts:47 says so in its help: "Saved with the draft. Not applied to the ad group yet".
      // Still required, so people must pick a location that does nothing (worth making optional).
      "adGroup:locations": "draft-only: geo targeting is not applied to the TTD ad group yet (documented in the field help)",
    },
  },
  {
    platform: "YAHOO",
    connector: async () => new (await import("../../src/yahoo")).YahooDspConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "yahoo-token" },
    account: { externalId: "4242", ...NOW_ACCOUNT },
    respond: simple((id) => ({ response: { id } })),
  },
  {
    platform: "SHOPIFY",
    connector: async () => new (await import("../../src/shopify")).ShopifyConnector({ clientId: "id", clientSecret: "secret" }),
    auth: { accessToken: "contract-store.myshopify.com shpat_contract" },
    account: { externalId: "contract-store.myshopify.com", currency: "INR", timezone: "Asia/Kolkata" },
    respond: () => () => ({ marketing_event: { id: 77 } }),
    noRequestStatus: true,
    formOnly: {
      // A Shopify marketing event has no ad group or ad: the connector records one event from the
      // campaign and the landing page, and names the tree "Tracking" / the campaign name.
      "adGroup:name": "form-only: Shopify has no ad group entity (the tree's group is always named Tracking)",
      "ad:name": "form-only: Shopify has no ad entity (the event's ad takes the campaign name)",
    },
  },
];
