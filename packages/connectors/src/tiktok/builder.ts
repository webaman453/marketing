/**
 * TikTok campaign creation from a builder draft (API for Business v1.3):
 * campaign → ad groups → media/identity → ads. Rolled back on failure.
 */
import { TIKTOK_BILLING, type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type Values } from "@ashniva/shared";
import { createHash } from "node:crypto";
import { bool, budgetOf, builderZone, excluded, included, instantOf, mediaOf, num, placements, str, strs, withParams } from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset } from "../types";

type Row = Record<string, any>;

export interface TikTokApi {
  get<T>(path: string, query: Record<string, string | number>): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

const json = (v: unknown) => JSON.stringify(v);

export async function tiktokBuilderOptions(api: TikTokApi, advertiserId: string): Promise<BuilderOptions> {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [pixels, identities, apps] = await Promise.all([
    safe(api.get<{ pixels?: Row[] }>("/pixel/list/", { advertiser_id: advertiserId, page_size: 100 }), {}),
    safe(api.get<{ identity_list?: Row[] }>("/identity/get/", { advertiser_id: advertiserId }), {}),
    safe(api.get<{ apps?: Row[] }>("/app/list/", { advertiser_id: advertiserId }), {}),
  ]);
  return {
    pixels: (pixels.pixels ?? []).map((p) => ({ id: String(p.pixel_id), name: p.pixel_name ?? String(p.pixel_id) })),
    identities: (identities.identity_list ?? [])
      .filter((i) => i.identity_type !== "CUSTOMIZED_USER")
      .map((i) => ({ id: `${i.identity_type}|${i.identity_id}`, name: i.display_name ?? i.identity_id, detail: i.identity_type })),
    apps: (apps.apps ?? []).map((a) => ({ id: String(a.app_id), name: a.app_name ?? String(a.app_id), detail: a.platform })),
  };
}

let regionCache: { at: number; list: Row[] } | null = null;

/** Every location TikTok can target, cached for a day. */
async function regions(api: TikTokApi, advertiserId: string) {
  if (regionCache && Date.now() - regionCache.at < 86_400_000) return regionCache.list;
  const res = await api.get<{ region_info?: Row[] }>("/tool/region/", { advertiser_id: advertiserId, placements: json(["PLACEMENT_TIKTOK"]), objective_type: "TRAFFIC" });
  regionCache = { at: Date.now(), list: res.region_info ?? [] };
  return regionCache.list;
}

export async function tiktokSearchTargeting(api: TikTokApi, advertiserId: string, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  const q = query.trim().toLowerCase();
  if (kind === "location") {
    const list = await regions(api, advertiserId);
    return list
      .filter((r) => !q || String(r.name).toLowerCase().includes(q))
      .slice(0, 25)
      .map((r) => {
        const country = r.level === "COUNTRY";
        return {
          id: country && r.region_code ? String(r.region_code).toUpperCase() : String(r.location_id),
          name: r.name,
          type: country ? "country" : String(r.level ?? "region").toLowerCase() === "city" ? "city" : "region",
          countryCode: r.region_code ? String(r.region_code).slice(0, 2).toUpperCase() : undefined,
          detail: String(r.level ?? "").toLowerCase(),
        };
      });
  }
  if (kind === "interest" || kind === "behavior") {
    const path = kind === "interest" ? "/tool/interest_category/" : "/tool/action_category/";
    const res = await api.get<{ interest_categories?: Row[]; action_categories?: Row[] }>(path, { advertiser_id: advertiserId, version: 2 });
    const list = res.interest_categories ?? res.action_categories ?? [];
    return list
      .filter((c) => !q || String(c.interest_category_name ?? c.name).toLowerCase().includes(q))
      .slice(0, 25)
      .map((c) => ({ id: String(c.interest_category_id ?? c.action_category_id ?? c.id), name: String(c.interest_category_name ?? c.name), detail: (c.level ? `Level ${c.level}` : undefined) }));
  }
  return [];
}

/** TikTok's API speaks UTC "YYYY-MM-DD HH:MM:SS". */
const utc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

/** Dayparting is 7 × 48 half-hour slots, Monday first, as a 0/1 string. */
function dayparting(v: Values) {
  const days = (v.dayparting as { days?: Record<string, [number, number][]> } | undefined)?.days ?? {};
  if (!Object.keys(days).length) return undefined;
  return ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    .map((d) => Array.from({ length: 48 }, (_, slot) => ((days[d] ?? []).some(([a, b]) => slot / 2 >= a && slot / 2 < b) ? "1" : "0")).join(""))
    .join("");
}

async function locationIds(api: TikTokApi, advertiserId: string, list: ReturnType<typeof included>) {
  const countries = list.filter((l) => (l.type ?? "country") === "country");
  const ids = list.filter((l) => (l.type ?? "country") !== "country").map((l) => l.id);
  if (countries.length) {
    const all = await regions(api, advertiserId);
    for (const c of countries) {
      const hit = all.find((r) => r.level === "COUNTRY" && String(r.region_code).toUpperCase() === c.id.toUpperCase());
      if (!hit) throw new ConnectorError("INVALID_REQUEST", `TikTok can't target ${c.name}.`);
      ids.push(String(hit.location_id));
    }
  }
  return ids;
}

async function uploadImage(api: TikTokApi, advertiserId: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("img:")) return asset.cachedRef.slice(4);
  const data = await asset.load();
  const form = new FormData();
  form.set("advertiser_id", advertiserId);
  form.set("upload_type", "UPLOAD_BY_FILE");
  form.set("image_signature", createHash("md5").update(data).digest("hex"));
  form.set("image_file", new Blob([new Uint8Array(data)], { type: asset.mimeType }), asset.filename);
  const res = await api.upload<{ image_id: string }>("/file/image/ad/upload/", form);
  await asset.onUploaded?.(`img:${res.image_id}`);
  return res.image_id;
}

async function uploadVideo(api: TikTokApi, advertiserId: string, asset: BuilderAsset) {
  let videoId = asset.cachedRef?.startsWith("vid:") ? asset.cachedRef.slice(4) : null;
  if (!videoId) {
    const data = await asset.load();
    const form = new FormData();
    form.set("advertiser_id", advertiserId);
    form.set("upload_type", "UPLOAD_BY_FILE");
    form.set("video_signature", createHash("md5").update(data).digest("hex"));
    form.set("video_file", new Blob([new Uint8Array(data)], { type: asset.mimeType }), asset.filename);
    const res = await api.upload<{ video_id: string }[] | { video_id: string }>("/file/video/ad/upload/", form);
    videoId = (Array.isArray(res) ? res[0]?.video_id : res.video_id) ?? null;
    if (!videoId) throw new ConnectorError("PLATFORM_ERROR", "TikTok didn't return a video id.");
    await asset.onUploaded?.(`vid:${videoId}`);
  }
  // Video ads need a cover image: wait for TikTok to make one, then upload it by URL.
  for (let i = 0; i < 20; i++) {
    const info = await api.get<{ list?: Row[] }>("/file/video/ad/info/", { advertiser_id: advertiserId, video_ids: json([videoId]) });
    const cover = info.list?.[0]?.video_cover_url;
    if (cover) {
      const img = await api.post<{ image_id: string }>("/file/image/ad/upload/", { advertiser_id: advertiserId, upload_type: "UPLOAD_BY_URL", image_url: cover });
      return { videoId, coverId: img.image_id };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new ConnectorError("PLATFORM_ERROR", "TikTok is still processing a video. Try publishing again in a minute.");
}

export async function tiktokCreateCampaign(api: TikTokApi, account: { externalId: string; currency: string; timezone?: string | null }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const adv = account.externalId;
  // The schedule is entered as wall-clock time in the ad account's zone; utc() converts for the API.
  const tz = builderZone(account);
  const c = draft.campaign;
  const enable = c.launchStatus === "ACTIVE";
  const cbo = bool(c, "cbo");
  const campaignBudget = cbo ? budgetOf(c) : null;
  const objective = String(draft.setup.objective);

  const created = await api.post<{ campaign_id: string }>("/campaign/create/", {
    advertiser_id: adv,
    campaign_name: str(c, "name"),
    objective_type: objective,
    operation_status: enable ? "ENABLE" : "DISABLE",
    budget_optimize_on: cbo,
    budget_mode: campaignBudget ? (campaignBudget.lifetime ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY") : "BUDGET_MODE_INFINITE",
    ...(campaignBudget ? { budget: campaignBudget.amount } : {}),
    ...(strs(c, "specialIndustries").length ? { special_industries: strs(c, "specialIndustries") } : {}),
    ...(objective === "APP_PROMOTION" ? { app_promotion_type: str(c, "appPromotionType") || "APP_INSTALL" } : {}),
    ...(objective === "PRODUCT_SALES" ? { sales_destination: str(c, "salesDestination") || "WEBSITE" } : {}),
  });
  const campaignId = created.campaign_id;
  const structure: AccountStructure = {
    campaigns: [
      {
        externalId: campaignId,
        name: str(c, "name"),
        status: enable ? "ACTIVE" : "PAUSED",
        deliveryStatus: null,
        objective,
        dailyBudget: campaignBudget && !campaignBudget.lifetime ? campaignBudget.amount : null,
        lifetimeBudget: campaignBudget?.lifetime ? campaignBudget.amount : null,
        startDate: null,
        endDate: null,
        updatedAt: new Date(),
        raw: { budget_mode: campaignBudget ? (campaignBudget.lifetime ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY") : "BUDGET_MODE_INFINITE" },
      },
    ],
    adGroups: [],
    ads: [],
  };

  try {
    for (const g of draft.adGroups) {
      const v = g.values;
      const goal = str(v, "optimizationGoal");
      const budget = cbo ? null : budgetOf(v);
      if (!cbo && !budget) throw new ConnectorError("INVALID_REQUEST", `Enter a budget for ad group “${str(v, "name")}”.`);
      const p = placements(v, "placements");
      const scheduled = v.scheduleType === "SCHEDULE_START_END";
      const start = (scheduled && instantOf(v, "startDate", tz)) || new Date(Date.now() + 5 * 60_000);
      const end = scheduled ? instantOf(v, "endDate", tz, "end") : null;
      const custom = v.bidStrategy === "BID_TYPE_CUSTOM";
      const billing = TIKTOK_BILLING[goal] ?? "OCPM";

      const body: Record<string, unknown> = {
        advertiser_id: adv,
        campaign_id: campaignId,
        adgroup_name: str(v, "name"),
        operation_status: enable ? "ENABLE" : "DISABLE",
        placement_type: p.mode === "MANUAL" ? "PLACEMENT_TYPE_NORMAL" : "PLACEMENT_TYPE_AUTOMATIC",
        ...(p.mode === "MANUAL" ? { placements: p.items } : {}),
        location_ids: await locationIds(api, adv, included(v, "locations")),
        ...(excluded(v, "locations").length ? { excluded_location_ids: await locationIds(api, adv, excluded(v, "locations")) } : {}),
        gender: str(v, "gender") || "GENDER_UNLIMITED",
        ...(strs(v, "ageGroups").length ? { age_groups: strs(v, "ageGroups") } : {}),
        ...(strs(v, "languages").length ? { languages: strs(v, "languages") } : {}),
        ...(included(v, "interests").length ? { interest_category_ids: included(v, "interests").map((i) => i.id) } : {}),
        ...(included(v, "behaviors").length ? { actions: [{ action_scene: "VIDEO_RELATED", action_period: 30, video_user_actions: ["WATCHED_TO_END", "LIKED", "SHARED"], action_category_ids: included(v, "behaviors").map((b) => b.id) }] } : {}),
        ...(strs(v, "operatingSystems").length ? { operating_systems: strs(v, "operatingSystems") } : {}),
        ...(strs(v, "networkTypes").length ? { network_types: strs(v, "networkTypes") } : {}),
        ...(str(v, "spendingPower") === "HIGH" ? { spending_power: "HIGH" } : {}),
        smart_audience_enabled: v.smartTargeting !== false,
        comment_disabled: v.allowComments === false,
        video_download_disabled: v.allowDownload !== true,
        share_disabled: v.allowShare === false,
        schedule_type: scheduled ? "SCHEDULE_START_END" : "SCHEDULE_FROM_NOW",
        schedule_start_time: utc(start),
        ...(end ? { schedule_end_time: utc(end) } : {}),
        ...(dayparting(v) ? { dayparting: dayparting(v) } : {}),
        pacing: str(v, "pacing") || "PACING_MODE_SMOOTH",
        optimization_goal: goal,
        billing_event: billing,
        bid_type: custom ? "BID_TYPE_CUSTOM" : "BID_TYPE_NO_BID",
        ...(custom && num(v, "bidAmount") ? (billing === "OCPM" ? { conversion_bid_price: num(v, "bidAmount") } : { bid_price: num(v, "bidAmount") }) : {}),
        ...(budget ? { budget_mode: budget.lifetime ? "BUDGET_MODE_TOTAL" : "BUDGET_MODE_DAY", budget: budget.amount } : {}),
        ...(str(v, "promotionType") ? { promotion_type: str(v, "promotionType") } : {}),
        ...(str(v, "pixelId") ? { pixel_id: str(v, "pixelId"), optimization_event: str(v, "optimizationEvent") || undefined } : {}),
        ...(str(v, "appId") ? { app_id: str(v, "appId") } : {}),
        ...(objective === "REACH" && num(v, "frequencyCap") ? { frequency: num(v, "frequencyCap"), frequency_schedule: 7 } : {}),
        ...(str(v, "pixelId") ? { click_attribution_window: str(v, "clickWindow") || "SEVEN_DAYS", view_attribution_window: str(v, "viewWindow") || "ONE_DAY" } : {}),
      };
      const group = await api.post<{ adgroup_id: string }>("/adgroup/create/", body);
      structure.adGroups.push({
        externalId: group.adgroup_id,
        campaignExternalId: campaignId,
        name: str(v, "name"),
        status: enable ? "ACTIVE" : "PAUSED",
        dailyBudget: budget && !budget.lifetime ? budget.amount : null,
        bidStrategy: custom ? "BID_TYPE_CUSTOM" : "BID_TYPE_NO_BID",
        targeting: body,
        raw: {},
        sourceKey: g.key,
      });

      for (const ad of g.ads) {
        const a = ad.values;
        let identityType = str(a, "identityType") || "CUSTOMIZED_USER";
        let identityId = "";
        if (identityType === "TT_USER") {
          const [type, id] = str(a, "identityId").split("|");
          identityType = type || "TT_USER";
          identityId = id ?? "";
        } else {
          const [avatar] = mediaOf(a, "avatar", assets);
          const avatarId = avatar ? await uploadImage(api, adv, avatar) : undefined;
          const identity = await api.post<{ identity_id: string }>("/identity/create/", { advertiser_id: adv, display_name: str(a, "displayName"), ...(avatarId ? { image_uri: avatarId } : {}) });
          identityId = identity.identity_id;
        }

        const format = str(a, "format") || "SINGLE_VIDEO";
        const creative: Record<string, unknown> = {
          ad_name: str(a, "name"),
          identity_type: identityType,
          identity_id: identityId,
          ad_format: format,
          ad_text: str(a, "adText"),
          call_to_action: str(a, "cta") || "LEARN_MORE",
          ...(str(a, "url") ? { landing_page_url: withParams(str(a, "url"), str(a, "urlParams")) } : {}),
          ...(str(a, "deeplink") ? { deeplink: str(a, "deeplink"), deeplink_type: "NORMAL" } : {}),
          ...(str(a, "trackingPixelId") ? { tracking_pixel_id: Number(str(a, "trackingPixelId")) } : {}),
          ...(str(a, "impressionTrackingUrl") ? { impression_tracking_url: str(a, "impressionTrackingUrl") } : {}),
          ...(str(a, "clickTrackingUrl") ? { click_tracking_url: str(a, "clickTrackingUrl") } : {}),
        };
        if (format === "SINGLE_VIDEO") {
          const [video] = mediaOf(a, "video", assets);
          if (!video) throw new ConnectorError("INVALID_REQUEST", "Each video ad needs a video.");
          const { videoId, coverId } = await uploadVideo(api, adv, video);
          creative.video_id = videoId;
          creative.image_ids = [coverId];
        } else {
          const list = format === "CAROUSEL_ADS" ? mediaOf(a, "images", assets) : mediaOf(a, "image", assets);
          creative.image_ids = await Promise.all(list.map((img) => uploadImage(api, adv, img)));
        }
        const res = await api.post<{ ad_ids?: string[] }>("/ad/create/", { advertiser_id: adv, adgroup_id: group.adgroup_id, creatives: [creative] });
        const adId = res.ad_ids?.[0];
        if (!adId) throw new ConnectorError("PLATFORM_ERROR", "TikTok didn't return an ad id.");
        structure.ads.push({
          externalId: adId,
          adGroupExternalId: group.adgroup_id,
          campaignExternalId: campaignId,
          name: str(a, "name"),
          status: enable ? "ACTIVE" : "PAUSED",
          headline: null,
          body: str(a, "adText") || null,
          thumbnailUrl: null,
          finalUrl: str(a, "url") || null,
          raw: {},
          sourceKey: ad.key,
        });
      }
    }
    return structure;
  } catch (err) {
    await api.post("/campaign/status/update/", { advertiser_id: adv, campaign_ids: [campaignId], operation_status: "DELETE" }).catch(() => undefined);
    throw err;
  }
}
