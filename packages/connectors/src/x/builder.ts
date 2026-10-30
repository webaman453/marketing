import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, mediaOf, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;
type Params = Record<string, string | number | boolean | undefined>;

export interface XApi {
  get<T = Row>(url: string, query?: Params): Promise<T>;
  /** Ads API write; the parameters go in the (signed) query string. */
  post<T = Row>(url: string, query: Params): Promise<T>;
  /** JSON body, for the v2 media upload. */
  postJson<T = Row>(url: string, body: unknown): Promise<T>;
  /** Ads API delete (rollback of a half-built campaign). */
  del<T = Row>(url: string): Promise<T>;
  /** The connected X user, from the access token. */
  userId?: string;
}

export const ADS = "https://ads-api.x.com/12";
const UPLOAD = "https://api.x.com/2/media/upload";
/** Raw bytes per APPEND; base64 makes it about 4 MB, under X's 5 MB guidance. */
const CHUNK = 3 * 1024 * 1024;

/**
 * Ads must never become public posts. `POST /2/tweets` (and the old statuses/update)
 * publish an organic post to the timeline, so they are refused outright; the Ads API's
 * own tweet endpoint is allowed only as a nullcast (promoted-only) post.
 */
export function assertPromotedOnly(url: string, query: Params) {
  const u = new URL(url);
  if (/^\/(2\/tweets|1\.1\/statuses\/)/.test(u.pathname)) {
    throw new ConnectorError("UNSUPPORTED", "Refusing to publish a public X post: ads are created as promoted-only posts.");
  }
  if (u.hostname === "ads-api.x.com" && /\/accounts\/[^/]+\/(tweet|draft_tweets|scheduled_tweets)$/.test(u.pathname) && query.nullcast !== true) {
    throw new ConnectorError("UNSUPPORTED", "Refusing to create an X post that is not promoted-only (nullcast).");
  }
}

export async function xCreateCampaign(api: XApi, accountId: string, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const entity = status === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const objective = String(draft.setup.objective || "WEBSITE_CLICKS");

  // Posts first: they are promoted-only, so nothing shows anywhere until a line item
  // promotes them, and a bad image or post fails before any campaign exists.
  const posts = new Map<string, { tweetId: string; text: string; url: string }>();
  if (draft.adGroups.some((g) => g.ads.length)) {
    const asUser = await promotableUser(api, accountId);
    for (const g of draft.adGroups) {
      for (const a of g.ads) {
        const text = str(a.values, "text");
        const url = str(a.values, "url");
        const keys = [];
        for (const asset of mediaOf(a.values, "video", assets)) keys.push(await mediaKey(api, accountId, asset));
        const tweet = await api.post<Row>(`${ADS}/accounts/${accountId}/tweet`, {
          as_user_id: asUser,
          text: [text, url].filter(Boolean).join("\n") || undefined,
          media_keys: keys.join(",") || undefined,
          nullcast: true,
          name: str(a.values, "name").slice(0, 80) || undefined,
          trim_user: true,
        });
        // The numeric id is past 2^53, so only id_str is exact.
        const tweetId = tweet?.data?.id_str;
        if (!tweetId) throw new ConnectorError("PLATFORM_ERROR", "X did not return an id for the post.", tweet);
        posts.set(a.key, { tweetId: String(tweetId), text, url });
      }
    }
  }

  const campaign = await api.post<Row>(`${ADS}/accounts/${accountId}/campaigns`, {
    name: str(c, "name"),
    funding_instrument_id: str(c, "fundingInstrumentId"),
    entity_status: entity,
    daily_budget_amount_local_micro: budget && !budget.lifetime ? Math.round(budget.amount * 1_000_000) : undefined,
    total_budget_amount_local_micro: budget?.lifetime ? Math.round(budget.amount * 1_000_000) : undefined,
  });
  const campaignId = idOf(campaign, "campaign");
  try {
    return await buildLines(api, accountId, draft, campaignId, posts, { status, entity, objective, budget });
  } catch (err) {
    // Deleting the campaign removes its line items and promoted posts, so a failed create leaves nothing behind.
    await api.del(`${ADS}/accounts/${accountId}/campaigns/${campaignId}`).catch(() => undefined);
    throw err;
  }
}

async function buildLines(
  api: XApi,
  accountId: string,
  draft: BuilderDraft,
  campaignId: string,
  posts: Map<string, { tweetId: string; text: string; url: string }>,
  { status, entity, objective, budget }: { status: EntityStatus; entity: string; objective: string; budget: ReturnType<typeof budgetOf> },
): Promise<AccountStructure> {
  const c = draft.campaign;
  const startTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const groups = [];
  const ads: Parameters<typeof accountTree>[0]["ads"] = [];
  for (const g of draft.adGroups) {
    const bid = Number(g.values.bidAmount ?? 0) > 0 ? Math.round(Number(g.values.bidAmount) * 1_000_000) : undefined;
    const line = await api.post<Row>(`${ADS}/accounts/${accountId}/line_items`, {
      campaign_id: campaignId,
      name: str(g.values, "name"),
      entity_status: entity,
      objective,
      product_type: "PROMOTED_TWEETS",
      placements: "ALL_ON_TWITTER",
      start_time: startTime,
      // A bid only counts with MAX or TARGET; X has no MAX for reach and followers.
      bid_strategy: bid ? (objective === "REACH" || objective === "FOLLOWERS" ? "TARGET" : "MAX") : "AUTO",
      bid_amount_local_micro: bid,
      goal: str(g.values, "goal") || (objective === "VIDEO_VIEWS" ? "VIDEO_VIEW" : "LINK_CLICKS"),
    });
    const groupId = idOf(line, "line item");
    groups.push({ id: groupId, name: str(g.values, "name"), status, bid: str(g.values, "bidAmount"), key: g.key });

    const mine = g.ads.map((a) => ({ a, post: posts.get(a.key)! })).filter((x) => x.post);
    if (!mine.length) continue;
    const promoted = await api.post<{ data?: Row[] }>(`${ADS}/accounts/${accountId}/promoted_tweets`, {
      line_item_id: groupId,
      tweet_ids: mine.map((x) => x.post.tweetId).join(","),
    });
    for (const { a, post } of mine) {
      const row = (promoted.data ?? []).find((p) => String(p.tweet_id) === post.tweetId);
      if (!row?.id) throw new ConnectorError("PLATFORM_ERROR", "X did not promote the post on the line item.", promoted);
      ads.push({ id: String(row.id), groupId, name: str(a.values, "name"), status, body: post.text, url: post.url || null, key: a.key });
    }
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective, daily: budget && !budget.lifetime ? budget.amount : null, lifetime: budget?.lifetime ? budget.amount : null },
    groups,
    ads,
  });
}

/** The handle the posts are made as: the account's FULL promotable user, else the connected user. */
async function promotableUser(api: XApi, accountId: string) {
  const res = await api.get<{ data?: Row[] }>(`${ADS}/accounts/${accountId}/promotable_users`);
  const full = (res.data ?? []).find((u) => u.promotable_user_type === "FULL");
  const id = full?.user_id ?? api.userId;
  if (!id) throw new ConnectorError("INVALID_REQUEST", "This X ad account has no handle that can post ads.");
  return String(id);
}

/** Chunked v2 upload (amplify_video for video), then the ad account's Media Library, which the tweet endpoint reads. */
async function mediaKey(api: XApi, accountId: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("x:")) return asset.cachedRef.slice(2);
  const bytes = await asset.load();
  const init = await api.postJson<Row>(`${UPLOAD}/initialize`, {
    media_type: asset.mimeType,
    total_bytes: bytes.length,
    media_category: asset.type === "VIDEO" ? "amplify_video" : "tweet_image",
  });
  const id = init?.data?.id;
  const key = init?.data?.media_key;
  if (!id || !key) throw new ConnectorError("PLATFORM_ERROR", `X did not start the upload of “${asset.filename}”.`, init);
  for (let at = 0, segment = 0; at < bytes.length; at += CHUNK, segment++) {
    await api.postJson(`${UPLOAD}/${id}/append`, { media: bytes.subarray(at, at + CHUNK).toString("base64"), segment_index: segment });
  }
  let info = (await api.post<Row>(`${UPLOAD}/${id}/finalize`, {}))?.data?.processing_info;
  for (let i = 0; info && info.state !== "succeeded"; i++) {
    if (info.state === "failed" || i >= 60) throw new ConnectorError("PLATFORM_ERROR", `X couldn't process “${asset.filename}”.`, info);
    await new Promise((r) => setTimeout(r, Math.min(Number(info.check_after_secs) || 2, 10) * 1000));
    info = (await api.get<Row>(UPLOAD, { command: "STATUS", media_id: String(id) }))?.data?.processing_info;
  }
  await api.post(`${ADS}/accounts/${accountId}/media_library`, { media_key: String(key), name: asset.filename.slice(0, 100), file_name: asset.filename.slice(0, 255) });
  await asset.onUploaded?.(`x:${key}`);
  return String(key);
}

function idOf(res: Row, what: string) {
  const id = res?.data?.id ?? res?.id;
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `X did not return an id for the ${what}.`, res);
  return String(id);
}
