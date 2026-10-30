/**
 * Snapchat campaign creation from a builder draft (Marketing API v1):
 * campaign → ad squads → media → creatives → ads. Rolled back on failure.
 */
import { type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type Values } from "@ashniva/shared";
import { bool, budgetOf, builderZone, countryCodes, dayIn, dayOf, included, instantOf, mediaOf, num, placements, range, str, strs } from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset } from "../types";

type Row = Record<string, any>;

export interface SnapApi {
  get<T = Row>(path: string, query?: Record<string, string | number>): Promise<T>;
  post<T = Row>(path: string, body: unknown): Promise<T>;
  upload<T = Row>(path: string, form: FormData): Promise<T>;
  del(path: string): Promise<void>;
}

const micro = (amount: number) => Math.round(amount * 1_000_000);

/** Snap wraps every create in an array and reports success per item. */
function first(res: Row, key: string, entity: string, what: string): Row {
  const item = res[key]?.[0];
  if (!item || item.sub_request_status !== "SUCCESS" || !item[entity]) {
    throw new ConnectorError("INVALID_REQUEST", `${what}: ${item?.sub_request_error_reason ?? res.request_status ?? "rejected"}`, res);
  }
  return item[entity];
}

export async function snapBuilderOptions(api: SnapApi, accountId: string, organizationId?: string): Promise<BuilderOptions> {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [pixels, profiles] = await Promise.all([
    safe(api.get(`/adaccounts/${accountId}/pixels`), {} as Row),
    organizationId ? safe(api.get(`/organizations/${organizationId}/public_profiles`), {} as Row) : Promise.resolve({} as Row),
  ]);
  return {
    pixels: (pixels.pixels ?? []).map((p: Row) => ({ id: String(p.pixel.id), name: p.pixel.name ?? p.pixel.id })),
    profiles: (profiles.public_profiles ?? []).map((p: Row) => ({ id: String(p.public_profile?.id ?? p.id), name: p.public_profile?.display_name ?? p.display_name ?? "Public profile" })),
  };
}

export async function snapSearchTargeting(api: SnapApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  const q = query.trim().toLowerCase();
  if (kind !== "interest") return [];
  const res = await api.get("/targeting/interests/scls", { country_code: "us" });
  const list = (res.targeting_dimensions ?? []) as Row[];
  return list
    .map((d) => d.scls ?? d)
    .filter((i) => i?.name && (!q || String(i.name).toLowerCase().includes(q)))
    .slice(0, 25)
    .map((i) => ({ id: String(i.id), name: String(i.name), detail: i.path }));
}

async function uploadMedia(api: SnapApi, accountId: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("media:")) return asset.cachedRef.slice(6);
  const created = first(await api.post(`/adaccounts/${accountId}/media`, { media: [{ name: asset.filename, type: asset.type === "VIDEO" ? "VIDEO" : "IMAGE", ad_account_id: accountId }] }), "media", "media", `Media “${asset.filename}”`);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(await asset.load())], { type: asset.mimeType }), asset.filename);
  await api.upload(`/media/${created.id}/upload`, form);
  for (let i = 0; i < 30; i++) {
    const m = await api.get(`/media/${created.id}`);
    const status = m.media?.[0]?.media?.media_status;
    if (status === "READY") break;
    if (status === "FAILED") throw new ConnectorError("PLATFORM_ERROR", `Snapchat couldn't process “${asset.filename}”.`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await asset.onUploaded?.(`media:${created.id}`);
  return String(created.id);
}

const AD_TYPE: Record<string, string> = { WEB_VIEW: "REMOTE_WEBPAGE", APP_INSTALL: "APP_INSTALL", DEEP_LINK: "DEEP_LINK", LEAD_GENERATION: "LEAD_GENERATION", NONE: "SNAP_AD" };

function targeting(v: Values) {
  const age = range(v, "age");
  const demo: Row = {};
  if (age) {
    demo.min_age = age.min;
    if (age.max < 50) demo.max_age = age.max;
  }
  if (str(v, "gender") && str(v, "gender") !== "ALL") demo.gender = str(v, "gender");
  if (strs(v, "languages").length) demo.languages = strs(v, "languages");
  const t: Row = {
    geos: countryCodes(v).map((cc) => ({ country_code: cc.toLowerCase() })),
    ...(Object.keys(demo).length ? { demographics: [demo] } : {}),
    ...(included(v, "interests").length ? { interests: [{ category_id: included(v, "interests").map((i) => i.id) }] } : {}),
  };
  const devices: Row = {};
  if (strs(v, "operatingSystems").length === 1) devices.os_type = strs(v, "operatingSystems")[0];
  if (str(v, "connectionType") && str(v, "connectionType") !== "ALL") devices.connection_type = str(v, "connectionType");
  if (Object.keys(devices).length) t.devices = [devices];
  if (v.audienceExpansion !== false) t.auto_expansion_options = { interest_expansion_option: { enabled: true } };
  return t;
}

/** The app an install or deep-link ad opens: an Android package name ("com.x.y") or an iOS App Store id. */
function appProperties(a: Values) {
  const appId = str(a, "appId");
  return { app_name: str(a, "brandName"), ...(appId.includes(".") ? { android_app_url: appId } : { ios_app_id: appId }) };
}

export async function snapCreateCampaign(api: SnapApi, account: { externalId: string; currency: string; timezone?: string | null }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const acct = account.externalId;
  const c = draft.campaign;
  const status = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  // Dates are days in the ad account's zone: start of the start day, end of the end day.
  const tz = builderZone(account);
  const start = instantOf(c, "startDate", tz) ?? new Date(Date.now() + 5 * 60_000);
  const end = instantOf(c, "endDate", tz, "end");

  const campaign = first(
    await api.post(`/adaccounts/${acct}/campaigns`, {
      campaigns: [
        {
          name: str(c, "name"),
          ad_account_id: acct,
          status,
          start_time: start.toISOString(),
          ...(end ? { end_time: end.toISOString() } : {}),
          objective_v2_properties: { objective_v2_type: draft.setup.objective },
          ...(num(c, "spendCap") ? { lifetime_spend_cap_micro: micro(num(c, "spendCap")!) } : {}),
        },
      ],
    }),
    "campaigns",
    "campaign",
    "Campaign",
  );
  const campaignId = String(campaign.id);
  const structure: AccountStructure = {
    campaigns: [{ externalId: campaignId, name: str(c, "name"), status, deliveryStatus: null, objective: String(draft.setup.objective), dailyBudget: null, lifetimeBudget: null, startDate: dayOf(c, "startDate") ?? dayIn(start, tz), endDate: dayOf(c, "endDate"), updatedAt: new Date(), raw: {} }],
    adGroups: [],
    ads: [],
  };

  try {
    for (const g of draft.adGroups) {
      const v = g.values;
      const budget = budgetOf(v);
      if (!budget) throw new ConnectorError("INVALID_REQUEST", `Enter a budget for ad squad “${str(v, "name")}”.`);
      const p = placements(v, "placements");
      // The schedule lives on the campaign (the ad squad form has none): squads run for its dates.
      const gStart = start;
      const gEnd = end;
      const bid = str(v, "bidStrategy") || "AUTO_BID";
      const squad = first(
        await api.post(`/campaigns/${campaignId}/adsquads`, {
          adsquads: [
            {
              campaign_id: campaignId,
              name: str(v, "name"),
              type: "SNAP_ADS",
              status,
              targeting: targeting(v),
              placement_v2: p.mode === "MANUAL" ? { config: "CUSTOM", platforms: ["SNAPCHAT"], snapchat_positions: p.items } : { config: "AUTOMATIC" },
              optimization_goal: str(v, "optimizationGoal"),
              bid_strategy: bid,
              ...(bid !== "AUTO_BID" && num(v, "bidAmount") ? { bid_micro: micro(num(v, "bidAmount")!) } : {}),
              billing_event: "IMPRESSION",
              delivery_constraint: budget.lifetime ? "LIFETIME_BUDGET" : "DAILY_BUDGET",
              [budget.lifetime ? "lifetime_budget_micro" : "daily_budget_micro"]: micro(budget.amount),
              start_time: gStart.toISOString(),
              ...(gEnd ? { end_time: gEnd.toISOString() } : {}),
              ...(str(v, "pixelId") ? { pixel_id: str(v, "pixelId"), conversion_window: str(v, "attribution") || "SWIPE_28DAY_VIEW_1DAY" } : {}),
            },
          ],
        }),
        "adsquads",
        "adsquad",
        `Ad squad “${str(v, "name")}”`,
      );
      structure.adGroups.push({ externalId: String(squad.id), campaignExternalId: campaignId, name: str(v, "name"), status, dailyBudget: budget.lifetime ? null : budget.amount, bidStrategy: bid, targeting: null, raw: {}, sourceKey: g.key });

      for (const ad of g.ads) {
        const a = ad.values;
        const attachment = str(a, "attachment") || "WEB_VIEW";
        const creativeType = attachment === "NONE" ? "SNAP_AD" : attachment;
        const base = {
          ad_account_id: acct,
          brand_name: str(a, "brandName"),
          headline: str(a, "headline"),
          profile_properties: { profile_id: str(a, "profileId") },
          shareable: bool(a, "shareable") || a.shareable === undefined,
          ...(attachment !== "NONE" ? { call_to_action: str(a, "cta") || "MORE" } : {}),
          ...(attachment === "WEB_VIEW" ? { web_view_properties: { url: str(a, "url") } } : {}),
          ...(attachment === "APP_INSTALL" ? { app_install_properties: appProperties(a) } : {}),
          // DeepLinkProperties carry the app as well as the URI (app_name + ios_app_id / android_app_url).
          ...(attachment === "DEEP_LINK" ? { deep_link_properties: { deep_link_uri: str(a, "deeplink"), ...appProperties(a) } } : {}),
          ...(attachment === "LEAD_GENERATION" ? { lead_generation_properties: { lead_generation_form_id: str(a, "leadFormId") } } : {}),
        };
        let creativeId: string;
        let adType = AD_TYPE[attachment] ?? "SNAP_AD";
        if (a.format === "STORY") {
          // Story ad: one creative per Snap, a tile (preview) and a composite tying them together.
          const snapIds: string[] = [];
          for (const snap of mediaOf(a, "storySnaps", assets)) {
            const mediaId = await uploadMedia(api, acct, snap);
            snapIds.push(String(first(await api.post(`/adaccounts/${acct}/creatives`, { creatives: [{ ...base, name: `${str(a, "name")} · ${snap.filename}`, type: creativeType, top_snap_media_id: mediaId }] }), "creatives", "creative", "Story Snap").id));
          }
          const [tile] = mediaOf(a, "tileImage", assets);
          if (!tile) throw new ConnectorError("INVALID_REQUEST", "Story ads need a tile image.");
          const preview = first(
            await api.post(`/adaccounts/${acct}/creatives`, { creatives: [{ ad_account_id: acct, name: `${str(a, "name")} · tile`, type: "PREVIEW", brand_name: str(a, "brandName"), headline: str(a, "tileHeadline"), profile_properties: { profile_id: str(a, "profileId") }, preview_properties: { preview_media_id: await uploadMedia(api, acct, tile), preview_headline: str(a, "tileHeadline") } }] }),
            "creatives",
            "creative",
            "Story tile",
          );
          creativeId = String(
            first(
              await api.post(`/adaccounts/${acct}/creatives`, { creatives: [{ ad_account_id: acct, name: str(a, "name"), type: "COMPOSITE", brand_name: str(a, "brandName"), headline: str(a, "headline"), profile_properties: { profile_id: str(a, "profileId") }, preview_creative_id: preview.id, composite_properties: { creative_ids: snapIds } }] }),
              "creatives",
              "creative",
              "Story ad",
            ).id,
          );
          adType = "STORY";
        } else {
          const [media] = mediaOf(a, "media", assets);
          if (!media) throw new ConnectorError("INVALID_REQUEST", "Each Snap ad needs an image or video.");
          creativeId = String(first(await api.post(`/adaccounts/${acct}/creatives`, { creatives: [{ ...base, name: str(a, "name"), type: creativeType, top_snap_media_id: await uploadMedia(api, acct, media) }] }), "creatives", "creative", `Creative “${str(a, "name")}”`).id);
        }
        const created = first(await api.post(`/adsquads/${squad.id}/ads`, { ads: [{ ad_squad_id: squad.id, creative_id: creativeId, name: str(a, "name"), type: adType, status }] }), "ads", "ad", `Ad “${str(a, "name")}”`);
        structure.ads.push({ externalId: String(created.id), adGroupExternalId: String(squad.id), campaignExternalId: campaignId, name: str(a, "name"), status, headline: str(a, "headline") || null, body: null, thumbnailUrl: null, finalUrl: str(a, "url") || null, raw: {}, sourceKey: ad.key });
      }
    }
    return structure;
  } catch (err) {
    await api.del(`/campaigns/${campaignId}`).catch(() => undefined);
    throw err;
  }
}
