/**
 * Pinterest campaign creation from a builder draft (API v5):
 * campaign → ad groups (+ keywords) → Pins on a secret board → ads.
 */
import { type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult } from "@ashniva/shared";
import { bool, budgetOf, countryCodes, dateOf, included, keywords, mediaOf, num, str, strs } from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset } from "../types";

type Row = Record<string, any>;

export interface PinterestApi {
  get<T = Row>(path: string, query?: Record<string, string | number>): Promise<T>;
  send<T = Row>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T>;
  uploadToS3(url: string, fields: Record<string, string>, file: Blob, filename: string): Promise<void>;
}

const micro = (amount: number) => Math.round(amount * 1_000_000);
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** Bulk endpoints return { items: [{ data, exceptions }] }. */
function firstItem(res: Row, what: string): Row {
  const item = res.items?.[0];
  if (!item?.data) {
    const ex = item?.exceptions?.[0] ?? item?.exception;
    throw new ConnectorError("INVALID_REQUEST", `${what}: ${ex?.message ?? "rejected"}`, res);
  }
  return item.data;
}

export async function pinterestBuilderOptions(api: PinterestApi, accountId: string): Promise<BuilderOptions> {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [tags, boards] = await Promise.all([
    safe(api.get(`/ad_accounts/${accountId}/conversion_tags`), {} as Row),
    safe(api.get(`/boards`, { page_size: 100 }), {} as Row),
  ]);
  return {
    pixels: ((tags.items ?? tags) as Row[]).filter?.((t) => t?.id).map((t) => ({ id: String(t.id), name: t.name ?? "Pinterest tag" })) ?? [],
    boards: (boards.items ?? []).map((b: Row) => ({ id: String(b.id), name: b.name, detail: b.privacy === "SECRET" ? "Secret board" : "Public board" })),
  };
}

let interestCache: { at: number; list: Row[] } | null = null;

export async function pinterestSearchTargeting(api: PinterestApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  if (kind !== "interest") return [];
  if (!interestCache || Date.now() - interestCache.at > 86_400_000) {
    const res = await api.get(`/resources/targeting/interests`);
    interestCache = { at: Date.now(), list: (res.items ?? res) as Row[] };
  }
  const q = query.trim().toLowerCase();
  return interestCache.list
    .filter((i) => i?.name && (!q || String(i.name).toLowerCase().includes(q)))
    .slice(0, 25)
    .map((i) => ({ id: String(i.id), name: String(i.name) }));
}

/** Ad-only Pins live on a secret board; reuse one we made before. */
async function boardFor(api: PinterestApi, chosen: string) {
  if (chosen) return chosen;
  const boards = await api.get(`/boards`, { page_size: 100 });
  const existing = (boards.items ?? []).find((b: Row) => b.name === "Ashniva Ads" && b.privacy === "SECRET");
  if (existing) return String(existing.id);
  const board = await api.send(`/boards`, "POST", { name: "Ashniva Ads", privacy: "SECRET", description: "Pins created for ads." });
  return String(board.id);
}

async function videoMediaId(api: PinterestApi, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("media:")) return asset.cachedRef.slice(6);
  const reg = await api.send(`/media`, "POST", { media_type: "video" });
  await api.uploadToS3(reg.upload_url, reg.upload_parameters ?? {}, new Blob([new Uint8Array(await asset.load())], { type: asset.mimeType }), asset.filename);
  for (let i = 0; i < 40; i++) {
    const m = await api.get(`/media/${reg.media_id}`);
    if (m.status === "succeeded") break;
    if (m.status === "failed") throw new ConnectorError("PLATFORM_ERROR", `Pinterest couldn't process “${asset.filename}”.`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  await asset.onUploaded?.(`media:${reg.media_id}`);
  return String(reg.media_id);
}

const b64 = async (a: BuilderAsset) => ({ content_type: a.mimeType === "image/png" ? "image/png" : "image/jpeg", data: (await a.load()).toString("base64") });

export async function pinterestCreateCampaign(api: PinterestApi, account: { externalId: string; currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const acct = account.externalId;
  const c = draft.campaign;
  const status = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const cbo = bool(c, "cbo");
  const campaignBudget = cbo ? budgetOf(c) : null;
  const start = dateOf(c, "startDate");
  const end = dateOf(c, "endDate");
  const objective = String(draft.setup.objective);

  const campaign = firstItem(
    await api.send(`/ad_accounts/${acct}/campaigns`, "POST", [
      {
        ad_account_id: acct,
        name: str(c, "name"),
        status,
        objective_type: objective,
        ...(start ? { start_time: unix(start) } : {}),
        ...(end ? { end_time: unix(end) } : {}),
        is_campaign_budget_optimization: cbo,
        ...(campaignBudget ? { [campaignBudget.lifetime ? "lifetime_spend_cap" : "daily_spend_cap"]: micro(campaignBudget.amount) } : {}),
      },
    ]),
    "Campaign",
  );
  const campaignId = String(campaign.id);
  const structure: AccountStructure = {
    campaigns: [
      { externalId: campaignId, name: str(c, "name"), status, deliveryStatus: null, objective, dailyBudget: campaignBudget && !campaignBudget.lifetime ? campaignBudget.amount : null, lifetimeBudget: campaignBudget?.lifetime ? campaignBudget.amount : null, startDate: start ? start.toISOString().slice(0, 10) : null, endDate: end ? end.toISOString().slice(0, 10) : null, updatedAt: new Date(), raw: {} },
    ],
    adGroups: [],
    ads: [],
  };

  try {
    for (const g of draft.adGroups) {
      const v = g.values;
      const budget = cbo ? null : budgetOf(v);
      if (!cbo && !budget) throw new ConnectorError("INVALID_REQUEST", `Enter a budget for ad group “${str(v, "name")}”.`);
      const gStart = dateOf(v, "startDate") ?? start;
      const gEnd = dateOf(v, "endDate") ?? end;
      const bid = str(v, "bidStrategy") || "AUTOMATIC_BID";
      const spec: Row = { LOCATION: countryCodes(v) };
      if (strs(v, "languages").length) spec.LOCALE = strs(v, "languages");
      if (str(v, "gender") && str(v, "gender") !== "ALL") spec.GENDER = [str(v, "gender")];
      if (strs(v, "ageBuckets").length) spec.AGE_BUCKET = strs(v, "ageBuckets");
      if (included(v, "interests").length) spec.INTEREST = included(v, "interests").map((i) => i.id);
      if (strs(v, "devices").length) spec.APPTYPE = strs(v, "devices");
      if (str(v, "targetingStrategy") && str(v, "targetingStrategy") !== "CHOOSE_YOUR_OWN") spec.TARGETING_STRATEGY = [str(v, "targetingStrategy")];
      const conversion = objective === "WEB_CONVERSION";
      const group = firstItem(
        await api.send(`/ad_accounts/${acct}/ad_groups`, "POST", [
          {
            ad_account_id: acct,
            campaign_id: campaignId,
            name: str(v, "name"),
            status,
            budget_type: cbo ? "CBO_ADGROUP" : budget!.lifetime ? "LIFETIME" : "DAILY",
            ...(budget ? { budget_in_micro_currency: micro(budget.amount) } : {}),
            ...(gStart ? { start_time: unix(gStart) } : {}),
            ...(gEnd ? { end_time: unix(gEnd) } : {}),
            targeting_spec: spec,
            auto_targeting_enabled: v.expandedTargeting !== false,
            placement_group: str(v, "placementGroup") || "ALL",
            pacing_delivery_type: str(v, "pacing") || "STANDARD",
            billable_event: objective === "CONSIDERATION" ? "CLICKTHROUGH" : objective === "VIDEO_COMPLETION" ? "VIDEO_V_50_MRC" : "IMPRESSION",
            bid_strategy_type: bid,
            ...(bid !== "AUTOMATIC_BID" && num(v, "bidAmount") ? { bid_in_micro_currency: micro(num(v, "bidAmount")!) } : {}),
            ...(conversion
              ? { optimization_goal_metadata: { conversion_tag_v3_goal_metadata: { conversion_event: str(v, "conversionEvent") || "CHECKOUT", conversion_tag_id: str(v, "conversionTagId"), attribution_windows: { click_window_days: 30, engagement_window_days: 30, view_window_days: 1 } } } }
              : {}),
          },
        ]),
        `Ad group “${str(v, "name")}”`,
      );
      const groupId = String(group.id);
      const kws = keywords(v, "keywords");
      if (kws.length) await api.send(`/ad_accounts/${acct}/keywords`, "POST", { keywords: kws.map((k) => ({ match_type: k.matchType, value: k.text })), parent_id: groupId });
      structure.adGroups.push({ externalId: groupId, campaignExternalId: campaignId, name: str(v, "name"), status, dailyBudget: budget && !budget.lifetime ? budget.amount : null, bidStrategy: bid, targeting: spec, raw: {}, sourceKey: g.key });

      for (const ad of g.ads) {
        const a = ad.values;
        const format = str(a, "format") || "REGULAR";
        const board = await boardFor(api, str(a, "boardId"));
        let mediaSource: Row;
        if (format === "VIDEO") {
          const [video] = mediaOf(a, "video", assets);
          if (!video) throw new ConnectorError("INVALID_REQUEST", "Video Pins need a video.");
          mediaSource = { source_type: "video_id", media_id: await videoMediaId(api, video), cover_image_key_frame_time: 1 };
        } else if (format === "CAROUSEL") {
          mediaSource = { source_type: "multiple_image_base64", items: await Promise.all(mediaOf(a, "images", assets).map(async (img) => ({ ...(await b64(img)), title: str(a, "title"), link: str(a, "url") }))) };
        } else {
          const [img] = mediaOf(a, "image", assets);
          if (!img) throw new ConnectorError("INVALID_REQUEST", "Each Pin needs an image.");
          mediaSource = { source_type: "image_base64", ...(await b64(img)) };
        }
        const pin = await api.send(`/pins?ad_account_id=${acct}`, "POST", {
          board_id: board,
          title: str(a, "title"),
          description: str(a, "description") || undefined,
          link: str(a, "url"),
          alt_text: str(a, "altText") || undefined,
          media_source: mediaSource,
        });
        const created = firstItem(
          await api.send(`/ad_accounts/${acct}/ads`, "POST", [
            { ad_group_id: groupId, pin_id: String(pin.id), creative_type: format === "VIDEO" ? "VIDEO" : format === "CAROUSEL" ? "CAROUSEL" : "REGULAR", name: str(a, "name"), status, destination_url: str(a, "url"), ...(str(a, "cta") ? { customizable_cta_type: str(a, "cta") } : {}) },
          ]),
          `Ad “${str(a, "name")}”`,
        );
        structure.ads.push({ externalId: String(created.id), adGroupExternalId: groupId, campaignExternalId: campaignId, name: str(a, "name"), status, headline: str(a, "title") || null, body: str(a, "description") || null, thumbnailUrl: null, finalUrl: str(a, "url") || null, raw: { pin_id: pin.id }, sourceKey: ad.key });
      }
    }
    return structure;
  } catch (err) {
    await api.send(`/ad_accounts/${acct}/campaigns`, "PATCH", [{ id: campaignId, status: "ARCHIVED" }]).catch(() => undefined);
    throw err;
  }
}
