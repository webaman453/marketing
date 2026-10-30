/**
 * Google Ads campaign creation from a builder draft (Google Ads API v25).
 * Images are uploaded first (and cached per account); everything else —
 * budget, campaign, criteria, ad groups / asset groups, keywords, assets and
 * ads — goes in one atomic GoogleAdsService.Mutate with temporary ids.
 */
import { COUNTRIES, type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type Values } from "@ashniva/shared";
import {
  bool,
  budgetOf,
  dayOf,
  excluded,
  included,
  keywords,
  mediaOf,
  num,
  pinned,
  placements,
  repeater,
  str,
  strs,
  texts,
  youtubeId,
} from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset, ExternalAd, ExternalAdGroup } from "../types";

type Row = Record<string, any>;

export interface GoogleApi {
  search(query: string): Promise<Row[]>;
  mutate(operations: Record<string, unknown>[]): Promise<{ mutateOperationResponses?: Record<string, { resourceName?: string }>[] }>;
  suggestGeo(query: string): Promise<Row[]>;
}

const toMicros = (amount: number) => String(Math.round(amount * 100) * 10_000);
const gaqlString = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ───────── Options & search ─────────

export async function googleBuilderOptions(api: GoogleApi): Promise<BuilderOptions> {
  const safe = (q: string) => api.search(q).catch(() => [] as Row[]);
  const [conversions, merchants, lists] = await Promise.all([
    safe("SELECT conversion_action.id, conversion_action.name, conversion_action.category, conversion_action.primary_for_goal FROM conversion_action WHERE conversion_action.status = 'ENABLED'"),
    safe("SELECT product_link.merchant_center.merchant_center_id, product_link.type FROM product_link WHERE product_link.type = 'MERCHANT_CENTER'"),
    safe("SELECT user_list.id, user_list.name, user_list.size_for_search FROM user_list WHERE user_list.membership_status = 'OPEN'"),
  ]);
  return {
    conversionActions: conversions.map((r) => ({
      id: String(r.conversionAction.id),
      name: r.conversionAction.name,
      detail: [r.conversionAction.category, r.conversionAction.primaryForGoal ? "Primary" : "Secondary"].filter(Boolean).join(" · "),
    })),
    merchantCenters: merchants.map((r) => {
      const id = String(r.productLink?.merchantCenter?.merchantCenterId ?? "");
      return { id, name: `Merchant Center ${id}` };
    }),
    audiences: lists.map((r) => ({ id: String(r.userList.id), name: r.userList.name, detail: r.userList.sizeForSearch ? `≈ ${Number(r.userList.sizeForSearch).toLocaleString("en-IN")} people` : undefined })),
  };
}

export async function googleSearchTargeting(api: GoogleApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (kind === "location") {
    const rows = await api.suggestGeo(q);
    return rows.map((r) => {
      const g = r.geoTargetConstant ?? {};
      const country = g.targetType === "Country";
      return {
        // Countries are kept as ISO codes everywhere in the builder; other places by Google geo id.
        id: country ? String(g.countryCode) : String(g.id),
        name: g.name,
        type: country ? "country" : String(g.targetType ?? "").toLowerCase() === "city" ? "city" : "region",
        countryCode: g.countryCode,
        detail: [g.targetType, g.canonicalName].filter(Boolean).join(" · "),
      };
    });
  }
  if (kind === "interest") {
    const rows = await api.search(`SELECT user_interest.user_interest_id, user_interest.name, user_interest.taxonomy_type FROM user_interest WHERE user_interest.name LIKE '%${gaqlString(q)}%' LIMIT 25`);
    return rows.map((r) => ({
      id: String(r.userInterest.userInterestId),
      name: r.userInterest.name,
      detail: String(r.userInterest.taxonomyType ?? "").replace("_", " ").toLowerCase(),
    }));
  }
  return [];
}

// ───────── Helpers ─────────

/** Google country criteria ids are 2000 + the ISO numeric code. */
function geoConstant(loc: { id: string; type?: string }) {
  if ((loc.type ?? "country") === "country") {
    const c = COUNTRIES.find((x) => x.code === loc.id.toUpperCase());
    if (!c) throw new ConnectorError("INVALID_REQUEST", `Unknown country ${loc.id}.`);
    return `geoTargetConstants/${2000 + c.n}`;
  }
  return `geoTargetConstants/${loc.id}`;
}

async function languageConstants(api: GoogleApi, codes: string[]) {
  if (!codes.length) return [];
  const rows = await api.search(`SELECT language_constant.resource_name, language_constant.code FROM language_constant WHERE language_constant.code IN (${codes.map((c) => `'${gaqlString(c)}'`).join(", ")})`);
  return rows.map((r) => String(r.languageConstant.resourceName));
}

/**
 * "2026-10-08" → "2026-10-08 00:00:00" (Campaign.start_date_time format). Google
 * reads it in the account's own timezone, so the typed day goes through as is.
 */
const dateTime = (day: string | null, endOfDay = false) => (day ? `${day} ${endOfDay ? "23:59:59" : "00:00:00"}` : undefined);

const ratio = (a: BuilderAsset) => (a.width && a.height ? a.width / a.height : 1);

function biddingFields(c: Values, channel: string): Record<string, unknown> {
  const focus = str(c, "bidding");
  const cpa = num(c, "targetCpa");
  const roas = num(c, "targetRoas");
  const maxCpc = num(c, "maxCpc");
  switch (focus) {
    case "CONVERSIONS":
    case "INSTALLS":
    case "IN_APP_ACTIONS":
      return channel === "MULTI_CHANNEL" && cpa ? { targetCpa: { targetCpaMicros: toMicros(cpa) } } : { maximizeConversions: cpa ? { targetCpaMicros: toMicros(cpa) } : {} };
    case "CONVERSION_VALUE":
    case "IN_APP_VALUE":
      return channel === "MULTI_CHANNEL" && roas ? { targetRoas: { targetRoas: roas / 100 } } : { maximizeConversionValue: roas ? { targetRoas: roas / 100 } : {} };
    case "CLICKS":
      return { targetSpend: maxCpc ? { cpcBidCeilingMicros: toMicros(maxCpc) } : {} };
    case "IMPRESSION_SHARE":
      return {
        targetImpressionShare: {
          location: str(c, "impressionShareLocation") || "TOP_OF_PAGE",
          locationFractionMicros: String(Math.round((num(c, "impressionShareTarget") ?? 70) * 10_000)),
          ...(maxCpc ? { cpcBidCeilingMicros: toMicros(maxCpc) } : {}),
        },
      };
    case "VIEWABLE_IMPRESSIONS":
      return { manualCpm: {} };
    case "MANUAL_CPC":
      return { manualCpc: {} };
    default:
      return { maximizeConversions: {} };
  }
}

function appGoalType(c: Values) {
  const focus = str(c, "bidding");
  const hasCpa = Boolean(num(c, "targetCpa"));
  const hasRoas = Boolean(num(c, "targetRoas"));
  if (str(c, "appSubtype") === "APP_CAMPAIGN_FOR_PRE_REGISTRATION") return "OPTIMIZE_PRE_REGISTRATION_CONVERSION_VOLUME";
  if (focus === "IN_APP_ACTIONS") return hasCpa ? "OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST" : "OPTIMIZE_IN_APP_CONVERSIONS_WITHOUT_TARGET_CPA";
  if (focus === "IN_APP_VALUE") return hasRoas ? "OPTIMIZE_RETURN_ON_ADVERTISING_SPEND" : "OPTIMIZE_TOTAL_VALUE_WITHOUT_TARGET_ROAS";
  return hasCpa ? "OPTIMIZE_INSTALLS_TARGET_INSTALL_COST" : "OPTIMIZE_INSTALLS_WITHOUT_TARGET_INSTALL_COST";
}

const CHANNEL: Record<string, string> = {
  SEARCH: "SEARCH",
  DISPLAY: "DISPLAY",
  PERFORMANCE_MAX: "PERFORMANCE_MAX",
  DEMAND_GEN: "DEMAND_GEN",
  SHOPPING: "SHOPPING",
  APP: "MULTI_CHANNEL",
};

const DAY: Record<string, string> = { MON: "MONDAY", TUE: "TUESDAY", WED: "WEDNESDAY", THU: "THURSDAY", FRI: "FRIDAY", SAT: "SATURDAY", SUN: "SUNDAY" };

// ───────── Create ─────────

export async function googleCreateCampaign(
  api: GoogleApi,
  account: { externalId: string; currency: string },
  draft: BuilderDraft,
  assets: Map<string, BuilderAsset>,
): Promise<AccountStructure> {
  const cid = account.externalId;
  const type = String(draft.setup.campaignType);
  const channel = CHANNEL[type];
  if (!channel) throw new ConnectorError("INVALID_REQUEST", type === "VIDEO" ? "Google doesn't allow Video campaigns to be created through its API. Use Demand Gen for YouTube." : `Unsupported campaign type ${type}.`);
  const c = draft.campaign;
  const status = c.launchStatus === "ACTIVE" ? "ENABLED" : "PAUSED";
  const budget = budgetOf(c);
  if (!budget) throw new ConnectorError("INVALID_REQUEST", "Enter the campaign budget.");

  let tempId = -1;
  const temp = (kind: string) => `customers/${cid}/${kind}/${tempId--}`;
  const ops: Record<string, unknown>[] = [];
  /** What each operation creates, so responses can be matched back to draft nodes. */
  const meta: { kind: string; key?: string; label?: string }[] = [];
  const push = (op: Record<string, unknown>, m: { kind: string; key?: string; label?: string } = { kind: "other" }) => {
    ops.push(op);
    meta.push(m);
  };

  // Images go up first, outside the atomic mutate, and are cached per ad account.
  const imageAssets = new Map<string, string>();
  const allImages = new Set<BuilderAsset>();
  const collect = (v: Values, ...keys: string[]) => keys.forEach((k) => mediaOf(v, k, assets).forEach((a) => a.type === "IMAGE" && allImages.add(a)));
  collect(c, "logos");
  for (const g of draft.adGroups) {
    collect(g.values, "landscapeImages", "squareImages", "portraitImages");
    for (const a of g.ads) {
      collect(a.values, "landscapeImages", "squareImages", "logos", "images");
      repeater(a.values, "cards").forEach((card) => collect(card, "image"));
    }
  }
  const fresh = [...allImages].filter((a) => !a.cachedRef?.startsWith(`customers/${cid}/assets/`));
  for (const a of allImages) if (a.cachedRef?.startsWith(`customers/${cid}/assets/`)) imageAssets.set(a.creativeId, a.cachedRef);
  if (fresh.length) {
    const uploads = await Promise.all(fresh.map(async (a) => ({ a, data: (await a.load()).toString("base64") })));
    const res = await api.mutate(uploads.map(({ a, data }) => ({ assetOperation: { create: { name: `${a.filename} ${a.creativeId.slice(-6)}`, type: "IMAGE", imageAsset: { data } } } })));
    const results = res.mutateOperationResponses ?? [];
    for (const [i, { a }] of uploads.entries()) {
      const rn = results[i]?.assetResult?.resourceName;
      if (!rn) throw new ConnectorError("PLATFORM_ERROR", `Google didn't accept the image “${a.filename}”.`);
      imageAssets.set(a.creativeId, rn);
      await a.onUploaded?.(rn);
    }
  }
  const img = (a: BuilderAsset) => ({ asset: imageAssets.get(a.creativeId)! });
  const imgs = (v: Values, key: string) => mediaOf(v, key, assets).filter((a) => imageAssets.has(a.creativeId));

  const textAsset = (text: string) => {
    const rn = temp("assets");
    push({ assetOperation: { create: { resourceName: rn, textAsset: { text } } } });
    return rn;
  };
  const youtubeAsset = (url: string) => {
    const id = youtubeId(url);
    if (!id) throw new ConnectorError("INVALID_REQUEST", `“${url}” isn't a YouTube link.`);
    const rn = temp("assets");
    push({ assetOperation: { create: { resourceName: rn, type: "YOUTUBE_VIDEO", youtubeVideoAsset: { youtubeVideoId: id } } } });
    return rn;
  };

  // ── Budget & campaign ──
  const budgetRn = temp("campaignBudgets");
  push({
    campaignBudgetOperation: {
      create: {
        resourceName: budgetRn,
        name: `${str(c, "name")} · ${Date.now()}`,
        deliveryMethod: "STANDARD",
        explicitlyShared: false,
        ...(budget.lifetime ? { period: "CUSTOM_PERIOD", totalAmountMicros: toMicros(budget.amount) } : { amountMicros: toMicros(budget.amount) }),
      },
    },
  });

  const campaignRn = temp("campaigns");
  const start = dayOf(c, "startDate");
  const end = dayOf(c, "endDate");
  const campaign: Record<string, unknown> = {
    resourceName: campaignRn,
    name: str(c, "name"),
    status,
    advertisingChannelType: channel,
    campaignBudget: budgetRn,
    containsEuPoliticalAdvertising: c.euPolitical === "YES" ? "CONTAINS_EU_POLITICAL_ADVERTISING" : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    geoTargetTypeSetting: { positiveGeoTargetType: str(c, "locationOption") || "PRESENCE_OR_INTEREST" },
    ...biddingFields(c, channel),
    ...(start ? { startDateTime: dateTime(start) } : {}),
    ...(end ? { endDateTime: dateTime(end, true) } : {}),
    ...(str(c, "trackingTemplate") ? { trackingUrlTemplate: str(c, "trackingTemplate") } : {}),
    ...(str(c, "finalUrlSuffix") ? { finalUrlSuffix: str(c, "finalUrlSuffix") } : {}),
  };
  if (type === "SEARCH") {
    campaign.networkSettings = { targetGoogleSearch: true, targetSearchNetwork: bool(c, "searchPartners"), targetContentNetwork: bool(c, "displayExpansion"), targetPartnerSearchNetwork: false };
    if (bool(c, "aiMax")) {
      campaign.aiMaxSetting = { enableAiMax: true };
      campaign.assetAutomationSettings = [
        { assetAutomationType: "TEXT_ASSET_AUTOMATION", assetAutomationStatus: c.textCustomization === false ? "OPTED_OUT" : "OPTED_IN" },
        { assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: c.urlExpansion === false || c.textCustomization === false ? "OPTED_OUT" : "OPTED_IN" },
      ];
    }
  }
  if (type === "DISPLAY") campaign.networkSettings = { targetContentNetwork: true };
  if (type === "PERFORMANCE_MAX") {
    campaign.brandGuidelinesEnabled = true;
    campaign.assetAutomationSettings = [{ assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION", assetAutomationStatus: c.finalUrlExpansion === false ? "OPTED_OUT" : "OPTED_IN" }];
  }
  if (type === "SHOPPING") {
    campaign.shoppingSetting = { merchantId: str(c, "merchantId"), campaignPriority: Number(str(c, "shoppingPriority") || 0), ...(str(c, "feedLabel") ? { feedLabel: str(c, "feedLabel") } : {}) };
  }
  if (type === "APP") {
    campaign.advertisingChannelSubType = str(c, "appSubtype") || "APP_CAMPAIGN";
    campaign.appCampaignSetting = { appId: str(c, "appId"), appStore: str(c, "appStore") || "GOOGLE_APP_STORE", biddingStrategyGoalType: appGoalType(c) };
  }
  push({ campaignOperation: { create: campaign } }, { kind: "campaign" });

  // ── Campaign criteria ──
  const locIn = included(c, "locations");
  const locOut = excluded(c, "locations");
  const langs = await languageConstants(api, strs(c, "languages"));
  // Demand Gen targets locations and languages per ad group.
  const criteriaOn = (parent: { campaign?: string; adGroup?: string }, op: "campaignCriterionOperation" | "adGroupCriterionOperation") => {
    for (const l of locIn) push({ [op]: { create: { ...parent, location: { geoTargetConstant: geoConstant(l) } } } });
    for (const l of locOut) push({ [op]: { create: { ...parent, negative: true, location: { geoTargetConstant: geoConstant(l) } } } });
    for (const lang of langs) push({ [op]: { create: { ...parent, language: { languageConstant: lang } } } });
  };
  if (type !== "DEMAND_GEN") criteriaOn({ campaign: campaignRn }, "campaignCriterionOperation");

  const schedule = (c.adSchedule as { days?: Record<string, [number, number][]> } | undefined)?.days ?? {};
  for (const [day, slots] of Object.entries(schedule)) {
    for (const [from, to] of slots) {
      push({ campaignCriterionOperation: { create: { campaign: campaignRn, adSchedule: { dayOfWeek: DAY[day], startHour: from, startMinute: "ZERO", endHour: to, endMinute: "ZERO" } } } });
    }
  }
  if (["DISPLAY", "DEMAND_GEN"].includes(type) && Array.isArray(c.devices)) {
    const on = new Set(strs(c, "devices"));
    for (const d of ["DESKTOP", "MOBILE", "TABLET", "CONNECTED_TV"]) {
      if (!on.has(d)) push({ campaignCriterionOperation: { create: { campaign: campaignRn, device: { type: d }, bidModifier: 0 } } });
    }
  }
  for (const id of strs(c, "conversionGoals")) {
    // Campaign-specific conversion goal selection needs a custom goal; best effort via selective optimization for App.
    if (type === "APP") campaign.selectiveOptimization = { conversionActions: [...(((campaign.selectiveOptimization as { conversionActions?: string[] })?.conversionActions) ?? []), `customers/${cid}/conversionActions/${id}`] };
  }

  // PMax brand guidelines: business name and logos are campaign assets.
  if (type === "PERFORMANCE_MAX") {
    const nameRn = textAsset(str(c, "businessName"));
    push({ campaignAssetOperation: { create: { campaign: campaignRn, asset: nameRn, fieldType: "BUSINESS_NAME" } } });
    for (const logo of imgs(c, "logos")) {
      push({ campaignAssetOperation: { create: { campaign: campaignRn, asset: imageAssets.get(logo.creativeId), fieldType: Math.abs(ratio(logo) - 4) < 0.2 ? "LANDSCAPE_LOGO" : "LOGO" } } });
    }
  }

  // ── Ad groups / asset groups and ads ──
  for (const g of draft.adGroups) {
    const v = g.values;
    if (type === "PERFORMANCE_MAX") {
      const agRn = temp("assetGroups");
      push(
        {
          assetGroupOperation: {
            create: { resourceName: agRn, campaign: campaignRn, name: str(v, "name"), finalUrls: [str(v, "finalUrl")], status: "ENABLED", ...(str(v, "path1") ? { path1: str(v, "path1") } : {}), ...(str(v, "path2") ? { path2: str(v, "path2") } : {}) },
          },
        },
        { kind: "assetGroup", key: g.key, label: str(v, "name") },
      );
      const link = (asset: string, fieldType: string) => push({ assetGroupAssetOperation: { create: { assetGroup: agRn, asset, fieldType } } });
      texts(v, "headlines").forEach((t) => link(textAsset(t), "HEADLINE"));
      texts(v, "longHeadlines").forEach((t) => link(textAsset(t), "LONG_HEADLINE"));
      texts(v, "descriptions").forEach((t) => link(textAsset(t), "DESCRIPTION"));
      imgs(v, "landscapeImages").forEach((a) => link(img(a).asset, "MARKETING_IMAGE"));
      imgs(v, "squareImages").forEach((a) => link(img(a).asset, "SQUARE_MARKETING_IMAGE"));
      imgs(v, "portraitImages").forEach((a) => link(img(a).asset, "PORTRAIT_MARKETING_IMAGE"));
      texts(v, "youtubeVideos").forEach((u) => link(youtubeAsset(u), "YOUTUBE_VIDEO"));
      if (str(v, "cta") && str(v, "cta") !== "AUTOMATED") {
        const rn = temp("assets");
        push({ assetOperation: { create: { resourceName: rn, callToActionAsset: { callToAction: str(v, "cta") } } } });
        link(rn, "CALL_TO_ACTION_SELECTION");
      }
      for (const theme of texts(v, "searchThemes")) push({ assetGroupSignalOperation: { create: { assetGroup: agRn, searchTheme: { text: theme } } } });
      continue;
    }

    const groupRn = temp("adGroups");
    const groupBody: Record<string, unknown> = { resourceName: groupRn, campaign: campaignRn, name: str(v, "name"), status: "ENABLED" };
    if (type === "SEARCH") groupBody.type = "SEARCH_STANDARD";
    if (type === "DISPLAY") {
      groupBody.type = "DISPLAY_STANDARD";
      groupBody.optimizedTargetingEnabled = v.optimizedTargeting !== false;
    }
    if (type === "SHOPPING") groupBody.type = "SHOPPING_PRODUCT_ADS";
    if (num(v, "defaultBid")) groupBody.cpcBidMicros = toMicros(num(v, "defaultBid")!);
    if (type === "DEMAND_GEN") {
      const ch = placements(v, "channels");
      groupBody.demandGenAdGroupSettings = {
        channelControls:
          ch.mode === "MANUAL"
            ? {
                selectedChannels: {
                  youtubeInStream: ch.items.includes("youtube_in_stream"),
                  youtubeInFeed: ch.items.includes("youtube_in_feed"),
                  youtubeShorts: ch.items.includes("youtube_shorts"),
                  discover: ch.items.includes("discover"),
                  gmail: ch.items.includes("gmail"),
                  display: ch.items.includes("display"),
                  maps: ch.items.includes("maps"),
                },
              }
            : { channelStrategy: "ALL_CHANNELS" },
      };
    }
    push({ adGroupOperation: { create: groupBody } }, { kind: "adGroup", key: g.key, label: str(v, "name") });
    if (type === "DEMAND_GEN") criteriaOn({ adGroup: groupRn }, "adGroupCriterionOperation");

    const criterion = (body: Record<string, unknown>) => push({ adGroupCriterionOperation: { create: { adGroup: groupRn, ...body } } });
    if (type === "SEARCH") {
      for (const k of keywords(v, "keywords")) criterion({ status: "ENABLED", keyword: { text: k.text, matchType: k.matchType } });
      for (const k of keywords(v, "negativeKeywords")) criterion({ negative: true, keyword: { text: k.text, matchType: k.matchType } });
    }
    if (type === "DISPLAY") {
      for (const i of included(v, "audiences")) criterion({ userInterest: { userInterestCategory: `customers/${cid}/userInterests/${i.id}` } });
      const ages = new Set(strs(v, "ageRanges"));
      if (ages.size) for (const a of ["AGE_RANGE_18_24", "AGE_RANGE_25_34", "AGE_RANGE_35_44", "AGE_RANGE_45_54", "AGE_RANGE_55_64", "AGE_RANGE_65_UP", "AGE_RANGE_UNDETERMINED"]) if (!ages.has(a)) criterion({ negative: true, ageRange: { type: a } });
      const genders = new Set(strs(v, "genders"));
      if (genders.size) for (const x of ["FEMALE", "MALE", "UNDETERMINED"]) if (!genders.has(x)) criterion({ negative: true, gender: { type: x } });
      for (const k of texts(v, "contentKeywords")) criterion({ keyword: { text: k, matchType: "BROAD" } });
      for (const url of texts(v, "placementUrls")) criterion({ placement: { url } });
    }
    if (type === "SHOPPING") {
      criterion({ status: "ENABLED", listingGroup: { type: "UNIT" }, ...(num(v, "defaultBid") ? { cpcBidMicros: toMicros(num(v, "defaultBid")!) } : {}) });
      push({ adGroupAdOperation: { create: { adGroup: groupRn, status: "ENABLED", ad: { shoppingProductAd: {} } } } }, { kind: "ad", key: g.key, label: "Product ads" });
    }

    for (const ad of g.ads) {
      const a = ad.values;
      let adBody: Record<string, unknown>;
      if (type === "SEARCH") {
        const pin = (p: string | null) => (p ? ({ H1: "HEADLINE_1", H2: "HEADLINE_2", H3: "HEADLINE_3", D1: "DESCRIPTION_1", D2: "DESCRIPTION_2" } as Record<string, string>)[p] : undefined);
        adBody = {
          finalUrls: [str(a, "finalUrl")],
          responsiveSearchAd: {
            headlines: pinned(a, "headlines").map((h) => ({ text: h.text, ...(pin(h.pin) ? { pinnedField: pin(h.pin) } : {}) })),
            descriptions: pinned(a, "descriptions").map((d) => ({ text: d.text, ...(pin(d.pin) ? { pinnedField: pin(d.pin) } : {}) })),
            ...(str(a, "path1") ? { path1: str(a, "path1") } : {}),
            ...(str(a, "path2") ? { path2: str(a, "path2") } : {}),
          },
        };
        // Assets for this ad's ad group.
        const linkGroup = (asset: string, fieldType: string) => push({ adGroupAssetOperation: { create: { adGroup: groupRn, asset, fieldType } } });
        for (const sl of repeater(a, "sitelinks").filter((x) => str(x, "text") && str(x, "url"))) {
          const rn = temp("assets");
          push({
            assetOperation: {
              create: {
                resourceName: rn,
                finalUrls: [str(sl, "url")],
                sitelinkAsset: { linkText: str(sl, "text"), ...(str(sl, "description1") && str(sl, "description2") ? { description1: str(sl, "description1"), description2: str(sl, "description2") } : {}) },
              },
            },
          });
          linkGroup(rn, "SITELINK");
        }
        for (const text of texts(a, "callouts")) {
          const rn = temp("assets");
          push({ assetOperation: { create: { resourceName: rn, calloutAsset: { calloutText: text } } } });
          linkGroup(rn, "CALLOUT");
        }
        if (str(a, "snippetHeader") && texts(a, "snippetValues").length >= 3) {
          const rn = temp("assets");
          push({ assetOperation: { create: { resourceName: rn, structuredSnippetAsset: { header: str(a, "snippetHeader"), values: texts(a, "snippetValues") } } } });
          linkGroup(rn, "STRUCTURED_SNIPPET");
        }
        if (str(a, "phone")) {
          const phone = str(a, "phone").replace(/[^\d+]/g, "");
          const country = included(c, "locations").find((l) => (l.type ?? "country") === "country")?.id ?? "IN";
          const rn = temp("assets");
          push({ assetOperation: { create: { resourceName: rn, callAsset: { countryCode: country, phoneNumber: phone } } } });
          linkGroup(rn, "CALL");
        }
      } else if (type === "DISPLAY") {
        const logos = imgs(a, "logos");
        adBody = {
          finalUrls: [str(a, "finalUrl")],
          responsiveDisplayAd: {
            marketingImages: imgs(a, "landscapeImages").map(img),
            squareMarketingImages: imgs(a, "squareImages").map(img),
            logoImages: logos.filter((l) => ratio(l) > 2).map(img),
            squareLogoImages: logos.filter((l) => ratio(l) <= 2).map(img),
            headlines: texts(a, "headlines").map((text) => ({ text })),
            longHeadline: { text: str(a, "longHeadline") },
            descriptions: texts(a, "descriptions").map((text) => ({ text })),
            businessName: str(a, "businessName"),
            ...(str(a, "cta") && str(a, "cta") !== "AUTOMATED" ? { callToActionText: str(a, "cta").replace(/_/g, " ").toLowerCase().replace(/^\w/, (m) => m.toUpperCase()) } : {}),
            ...(str(a, "mainColor") && str(a, "accentColor") ? { mainColor: str(a, "mainColor"), accentColor: str(a, "accentColor") } : {}),
          },
        };
      } else if (type === "DEMAND_GEN") {
        const common = {
          logoImages: imgs(a, "logos").map(img),
          headlines: texts(a, "headlines").map((text) => ({ text })),
          descriptions: texts(a, "descriptions").map((text) => ({ text })),
          businessName: { text: str(a, "businessName") },
        };
        if (a.format === "VIDEO") {
          adBody = {
            finalUrls: [str(a, "finalUrl")],
            demandGenVideoResponsiveAd: { ...common, videos: texts(a, "youtubeVideos").map((u) => ({ asset: youtubeAsset(u) })), longHeadlines: texts(a, "longHeadlines").map((text) => ({ text })) },
          };
        } else if (a.format === "CAROUSEL") {
          const cards = repeater(a, "cards").map((card) => {
            const [image] = imgs(card, "image");
            if (!image) throw new ConnectorError("INVALID_REQUEST", "Every carousel card needs an image.");
            const r = ratio(image);
            const imageField = Math.abs(r - 1) < 0.05 ? "squareMarketingImageAsset" : r > 1 ? "marketingImageAsset" : "portraitMarketingImageAsset";
            const rn = temp("assets");
            push({ assetOperation: { create: { resourceName: rn, demandGenCarouselCardAsset: { [imageField]: imageAssets.get(image.creativeId), headline: str(card, "headline"), callToActionText: "Learn more" } } } });
            return { asset: rn };
          });
          adBody = {
            finalUrls: [str(a, "finalUrl")],
            demandGenCarouselAd: { businessName: str(a, "businessName"), logoImage: imgs(a, "logos").map(img)[0], headline: { text: texts(a, "headlines")[0] }, description: { text: texts(a, "descriptions")[0] }, carouselCards: cards },
          };
        } else {
          const images = imgs(a, "images");
          const by = (test: (r: number) => boolean) => images.filter((i) => test(ratio(i))).map(img);
          adBody = {
            finalUrls: [str(a, "finalUrl")],
            demandGenMultiAssetAd: {
              ...common,
              businessName: str(a, "businessName"),
              marketingImages: by((r) => r > 1.5),
              squareMarketingImages: by((r) => Math.abs(r - 1) < 0.05),
              portraitMarketingImages: by((r) => r > 0.7 && r < 0.9),
              tallPortraitMarketingImages: by((r) => r <= 0.6),
            },
          };
        }
        if (str(a, "cta") && str(a, "cta") !== "AUTOMATED" && a.format !== "VIDEO") {
          const target = (adBody.demandGenMultiAssetAd ?? adBody.demandGenCarouselAd) as Record<string, unknown>;
          target.callToActionText = str(a, "cta").replace(/_/g, " ").toLowerCase().replace(/^\w/, (m) => m.toUpperCase());
        }
      } else if (type === "APP") {
        adBody = {
          appAd: {
            headlines: texts(a, "headlines").map((text) => ({ text })),
            descriptions: texts(a, "descriptions").map((text) => ({ text })),
            images: imgs(a, "images").map(img),
            youtubeVideos: texts(a, "youtubeVideos").map((u) => ({ asset: youtubeAsset(u) })),
          },
        };
      } else {
        continue;
      }
      push({ adGroupAdOperation: { create: { adGroup: groupRn, status: "ENABLED", ad: { ...(str(a, "name") ? { name: str(a, "name") } : {}), ...adBody } } } }, { kind: "ad", key: ad.key, label: str(a, "name") });
    }
  }

  const res = await api.mutate(ops);
  const results = res.mutateOperationResponses ?? [];
  const resourceAt = (i: number) => Object.values(results[i] ?? {})[0]?.resourceName ?? "";
  const idOf = (rn: string) => rn.split("/").pop()!;

  const campaignIndex = meta.findIndex((m) => m.kind === "campaign");
  const campaignId = idOf(resourceAt(campaignIndex));
  const entityStatus = status === "ENABLED" ? "ACTIVE" : "PAUSED";
  const structure: AccountStructure = {
    campaigns: [
      {
        externalId: campaignId,
        name: str(c, "name"),
        status: entityStatus,
        deliveryStatus: null,
        objective: type,
        dailyBudget: budget.lifetime ? null : budget.amount,
        lifetimeBudget: budget.lifetime ? budget.amount : null,
        startDate: start,
        endDate: end,
        updatedAt: new Date(),
        raw: { channelType: channel, budgetResourceName: resourceAt(0), budgetShared: false },
      },
    ],
    adGroups: [],
    ads: [],
  };

  let currentGroup: ExternalAdGroup | null = null;
  meta.forEach((m, i) => {
    if (m.kind === "adGroup" || m.kind === "assetGroup") {
      currentGroup = {
        externalId: idOf(resourceAt(i)),
        campaignExternalId: campaignId,
        name: m.label ?? "",
        status: "ACTIVE",
        dailyBudget: null,
        bidStrategy: str(c, "bidding") || null,
        targeting: null,
        raw: { kind: m.kind },
        sourceKey: m.key,
      };
      structure.adGroups.push(currentGroup);
      // An asset group is also the "ad" people see in reports.
      if (m.kind === "assetGroup") {
        structure.ads.push(adFor(currentGroup, `${currentGroup.externalId}~ag`, m.key, m.label ?? "Asset group", draft.adGroups.find((g) => g.key === m.key)?.values ?? {}));
      }
    }
    if (m.kind === "ad" && currentGroup) {
      const rn = resourceAt(i);
      const values = draft.adGroups.flatMap((g) => g.ads).find((a) => a.key === m.key)?.values ?? {};
      structure.ads.push(adFor(currentGroup, idOf(rn), m.key, m.label || "Ad", values));
    }
  });
  return structure;

  function adFor(group: ExternalAdGroup, externalId: string, key: string | undefined, name: string, v: Values): ExternalAd {
    const headline = texts(v, "headlines")[0] ?? (str(v, "longHeadline") || null);
    return {
      externalId,
      adGroupExternalId: group.externalId,
      campaignExternalId: campaignId,
      name,
      status: "ACTIVE",
      headline,
      body: texts(v, "descriptions")[0] ?? null,
      thumbnailUrl: null,
      finalUrl: str(v, "finalUrl") || null,
      raw: {},
      sourceKey: key,
    };
  }
}
