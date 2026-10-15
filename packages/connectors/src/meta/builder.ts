/**
 * Meta campaign creation from a builder draft (Marketing API v26):
 * campaign → ad sets → media → ad creatives → ads, rolled back on failure.
 */
import { META_PLACEMENT_GROUPS, type AdNode, type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type Values } from "@ashniva/shared";
import {
  bool,
  budgetOf,
  dateOf,
  excluded,
  included,
  mediaOf,
  num,
  placements,
  range,
  repeater,
  str,
  strs,
  texts,
} from "../builder-values";
import { ConnectorError } from "../errors";
import { ZERO_DECIMAL_CURRENCIES } from "../http";
import type { AccountStructure, BuilderAsset, ExternalAd, ExternalAdGroup } from "../types";

export interface MetaApi {
  get<T>(path: string, query?: Record<string, string | number>): Promise<T>;
  post<T>(path: string, body: Record<string, unknown>): Promise<T>;
  upload<T>(path: string, form: FormData, timeoutMs?: number): Promise<T>;
  del(path: string): Promise<void>;
}

const minor = (v: number, currency: string) => String(ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(v) : Math.round(v * 100));

// ───────── Builder options & targeting search ─────────

export async function metaBuilderOptions(api: MetaApi, act: string): Promise<BuilderOptions> {
  type Named = { id: string; name?: string; username?: string };
  const safe = <T>(p: Promise<{ data: T[] }>) => p.then((r) => r.data).catch(() => [] as T[]);
  const [pages, ig, pixels, apps, audiences] = await Promise.all([
    safe(api.get<{ data: Named[] }>(`${act}/promote_pages`, { fields: "id,name", limit: 200 })),
    safe(api.get<{ data: Named[] }>(`${act}/instagram_accounts`, { fields: "id,username", limit: 100 })),
    safe(api.get<{ data: Named[] }>(`${act}/adspixels`, { fields: "id,name", limit: 100 })),
    safe(api.get<{ data: (Named & { object_store_urls?: Record<string, string> })[] }>(`${act}/advertisable_applications`, { fields: "id,name,object_store_urls", limit: 100 })),
    safe(api.get<{ data: (Named & { approximate_count_lower_bound?: number; subtype?: string })[] }>(`${act}/customaudiences`, { fields: "id,name,subtype,approximate_count_lower_bound", limit: 200 })),
  ]);
  // Lead forms belong to Pages; read them for the first few Pages.
  const leadForms = (
    await Promise.all(
      pages.slice(0, 5).map((p) =>
        safe(api.get<{ data: Named[] }>(`/${p.id}/leadgen_forms`, { fields: "id,name", limit: 100 })).then((forms) => forms.map((f) => ({ id: f.id, name: f.name ?? f.id, detail: p.name }))),
      ),
    )
  ).flat();
  return {
    pages: pages.map((p) => ({ id: p.id, name: p.name ?? p.id })),
    instagramAccounts: ig.map((a) => ({ id: a.id, name: a.username ? `@${a.username}` : a.id })),
    pixels: pixels.map((p) => ({ id: p.id, name: p.name ?? p.id })),
    apps: apps.map((a) => {
      const store = Object.values(a.object_store_urls ?? {})[0] ?? "";
      // The store URL travels with the id: Meta needs both in promoted_object.
      return { id: `${a.id}|${store}`, name: a.name ?? a.id, detail: store };
    }),
    audiences: audiences.map((a) => ({ id: a.id, name: a.name ?? a.id, detail: [a.subtype, a.approximate_count_lower_bound ? `≈ ${a.approximate_count_lower_bound.toLocaleString("en-IN")} people` : null].filter(Boolean).join(" · ") })),
    leadForms,
  };
}

export async function metaSearchTargeting(api: MetaApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  if (!query.trim()) return [];
  if (kind === "location") {
    const res = await api.get<{ data: { key: string; name: string; type: string; country_code?: string; region?: string; country_name?: string }[] }>("/search", {
      type: "adgeolocation",
      q: query,
      location_types: JSON.stringify(["country", "region", "city"]),
      limit: 25,
    });
    return res.data.map((l) => ({
      id: l.type === "country" ? (l.country_code ?? l.key) : l.key,
      name: l.name,
      type: l.type,
      countryCode: l.country_code,
      detail: [l.type === "city" ? "City" : l.type === "region" ? "Region" : "Country", l.region, l.type !== "country" ? l.country_name : null].filter(Boolean).join(" · "),
    }));
  }
  if (kind === "interest" || kind === "behavior") {
    const res = await api.get<{ data: { id: string; name: string; audience_size_lower_bound?: number; path?: string[]; type?: string }[] }>("/search", {
      type: "adinterest",
      q: query,
      limit: 25,
    });
    return res.data.map((i) => ({
      id: i.id,
      name: i.name,
      type: "interests",
      detail: [i.path?.slice(0, -1).join(" › "), i.audience_size_lower_bound ? `≈ ${i.audience_size_lower_bound.toLocaleString("en-IN")} people` : null].filter(Boolean).join(" · "),
    }));
  }
  return [];
}

// ───────── Mapping helpers ─────────

function destinationType(draft: BuilderDraft, group: Values): string | undefined {
  const loc = str(group, "conversionLocation");
  const goal = str(group, "optimizationGoal");
  switch (loc) {
    case "WEBSITE":
      return "WEBSITE";
    case "APP":
      return "APP";
    case "INSTAGRAM_PROFILE":
      return "INSTAGRAM_PROFILE";
    case "PHONE_CALL":
      return "PHONE_CALL";
    case "ON_PAGE":
      return "ON_PAGE";
    case "ON_AD":
      if (draft.setup.objective === "OUTCOME_LEADS") return "ON_AD";
      return goal === "THRUPLAY" || goal === "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS" ? "ON_VIDEO" : goal === "EVENT_RESPONSES" ? "ON_EVENT" : "ON_POST";
    case "MESSAGING": {
      if (draft.setup.objective === "OUTCOME_LEADS") return "LEAD_FROM_MESSENGER";
      const apps = new Set(strs(group, "messagingApps"));
      const m = apps.has("MESSENGER");
      const ig = apps.has("INSTAGRAM_DIRECT");
      const wa = apps.has("WHATSAPP");
      if (m && ig && wa) return "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP";
      if (ig && m) return "MESSAGING_INSTAGRAM_DIRECT_MESSENGER";
      if (ig && wa) return "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP";
      if (m && wa) return "MESSAGING_MESSENGER_WHATSAPP";
      return wa ? "WHATSAPP" : ig ? "INSTAGRAM_DIRECT" : "MESSENGER";
    }
    default:
      return undefined;
  }
}

function billingEvent(goal: string) {
  if (goal === "LINK_CLICKS") return "LINK_CLICKS";
  if (goal === "THRUPLAY") return "THRUPLAY";
  return "IMPRESSIONS";
}

const pixelGoal = (draft: BuilderDraft, group: Values) =>
  ["OFFSITE_CONVERSIONS", "VALUE"].includes(str(group, "optimizationGoal")) &&
  (["WEBSITE", "WEBSITE_AND_APP"].includes(str(group, "conversionLocation")) || draft.setup.objective === "OUTCOME_SALES");

function promotedObject(draft: BuilderDraft, group: Values, pageId: string | undefined) {
  const out: Record<string, unknown> = {};
  if (pixelGoal(draft, group) && str(group, "pixelId")) {
    out.pixel_id = str(group, "pixelId");
    out.custom_event_type = str(group, "conversionEvent") || "PURCHASE";
  }
  const app = str(group, "appId");
  if (app && (draft.setup.objective === "OUTCOME_APP_PROMOTION" || ["APP", "WEBSITE_AND_APP"].includes(str(group, "conversionLocation")))) {
    const [id, store] = app.split("|");
    out.application_id = id;
    if (store) out.object_store_url = store;
  }
  if (!out.pixel_id && !out.application_id && pageId) out.page_id = pageId;
  return Object.keys(out).length ? out : undefined;
}

async function localeIds(api: MetaApi, languages: string[]) {
  const names: Record<string, string> = { en: "English", hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi", ur: "Urdu", ar: "Arabic", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian", nl: "Dutch", ru: "Russian", tr: "Turkish", id: "Indonesian", ms: "Malay", th: "Thai", vi: "Vietnamese", ja: "Japanese", ko: "Korean", zh: "Chinese" };
  const ids: number[] = [];
  for (const code of languages) {
    const res = await api.get<{ data: { key: number; name: string }[] }>("/search", { type: "adlocale", q: names[code] ?? code, limit: 5 }).catch(() => ({ data: [] }));
    const hit = res.data.find((l) => /\(all\)/i.test(l.name)) ?? res.data[0];
    if (hit) ids.push(hit.key);
  }
  return ids;
}

function geo(list: ReturnType<typeof included>) {
  const out: Record<string, unknown> = {};
  const countries = list.filter((l) => (l.type ?? "country") === "country").map((l) => l.id.toUpperCase());
  const regions = list.filter((l) => l.type === "region").map((l) => ({ key: l.id }));
  const cities = list.filter((l) => l.type === "city").map((l) => ({ key: l.id }));
  if (countries.length) out.countries = countries;
  if (regions.length) out.regions = regions;
  if (cities.length) out.cities = cities;
  return out;
}

async function targetingSpec(api: MetaApi, draft: BuilderDraft, g: Values) {
  const t: Record<string, unknown> = { geo_locations: geo(included(g, "locations")) };
  const ex = geo(excluded(g, "locations"));
  if (Object.keys(ex).length) t.excluded_geo_locations = ex;
  const age = range(g, "age");
  if (age) {
    t.age_min = age.min;
    t.age_max = age.max;
  }
  const gender = str(g, "gender");
  if (gender === "MALE") t.genders = [1];
  if (gender === "FEMALE") t.genders = [2];
  const interests = included(g, "interests");
  if (interests.length) t.flexible_spec = [{ interests: interests.map((i) => ({ id: i.id, name: i.name })) }];
  const custom = strs(g, "customAudiences");
  if (custom.length) t.custom_audiences = custom.map((id) => ({ id }));
  const exclude = strs(g, "excludedAudiences");
  if (exclude.length) t.excluded_custom_audiences = exclude.map((id) => ({ id }));
  const langs = strs(g, "languages");
  if (langs.length) {
    const locales = await localeIds(api, langs);
    if (locales.length) t.locales = locales;
  }
  const special = strs(draft.campaign, "specialAdCategories");
  t.targeting_automation = { advantage_audience: bool(g, "advantageAudience") && special.length === 0 ? 1 : 0 };

  const p = placements(g, "placements");
  if (p.mode === "MANUAL" && p.items.length) {
    const byPublisher = new Map<string, string[]>();
    for (const item of p.items) {
      const [publisher, position] = item.split(".");
      if (!publisher || !position) continue;
      byPublisher.set(publisher, [...(byPublisher.get(publisher) ?? []), position]);
    }
    t.publisher_platforms = [...byPublisher.keys()];
    for (const [publisher, positions] of byPublisher) t[`${publisher}_positions`] = positions;
  }
  const devices = str(g, "devices");
  if (devices === "mobile" || devices === "desktop") t.device_platforms = [devices];
  return t;
}

function adsetSchedule(v: Values) {
  const s = v.dayparting as { days?: Record<string, [number, number][]> } | undefined;
  const days = Object.entries(s?.days ?? {});
  if (!days.length) return undefined;
  const index: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  return days.flatMap(([day, slots]) => slots.map(([from, to]) => ({ start_minute: from * 60, end_minute: to * 60, days: [index[day] ?? 1], timezone_type: "USER" })));
}

/** Validates that every placement we send is one Meta still accepts. */
const ALLOWED_PLACEMENTS = new Set(META_PLACEMENT_GROUPS.flatMap((g) => g.items.map((i) => i.value)));

// ───────── Media ─────────

async function imageHash(api: MetaApi, act: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("img:")) return asset.cachedRef.slice(4);
  const data = await asset.load();
  const res = await api.post<{ images: Record<string, { hash: string }> }>(`${act}/adimages`, { bytes: data.toString("base64") });
  const hash = Object.values(res.images ?? {})[0]?.hash;
  if (!hash) throw new ConnectorError("PLATFORM_ERROR", "Meta did not return an image hash.");
  await asset.onUploaded?.(`img:${hash}`);
  return hash;
}

async function videoId(api: MetaApi, act: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("vid:")) return asset.cachedRef.slice(4);
  const form = new FormData();
  form.set("name", asset.filename);
  form.set("source", new Blob([new Uint8Array(await asset.load())], { type: asset.mimeType }), asset.filename);
  const res = await api.upload<{ id: string }>(`${act}/advideos`, form, 10 * 60_000);
  await asset.onUploaded?.(`vid:${res.id}`);
  return res.id;
}

/** Video ads need a thumbnail; wait for Meta to process the video and use its picture. */
async function videoThumbnail(api: MetaApi, id: string) {
  for (let i = 0; i < 20; i++) {
    const v = await api.get<{ status?: { video_status?: string }; picture?: string }>(`/${id}`, { fields: "status,picture" }).catch(() => null);
    if (v?.picture && v.status?.video_status !== "processing") return v.picture;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new ConnectorError("PLATFORM_ERROR", "Meta is still processing a video. Try launching again in a minute.");
}

interface MediaRef {
  kind: "image" | "video";
  hash?: string;
  videoId?: string;
  thumbnail?: string;
}

async function mediaRef(api: MetaApi, act: string, asset: BuilderAsset): Promise<MediaRef> {
  if (asset.type === "VIDEO") {
    const id = await videoId(api, act, asset);
    return { kind: "video", videoId: id, thumbnail: await videoThumbnail(api, id) };
  }
  return { kind: "image", hash: await imageHash(api, act, asset) };
}

// ───────── Creatives ─────────

function ctaValue(draft: BuilderDraft, group: Values, ad: Values, link: string) {
  const loc = str(group, "conversionLocation");
  if (draft.setup.objective === "OUTCOME_LEADS" && loc === "ON_AD") {
    const form = str(group, "leadFormId");
    return form ? { lead_gen_form_id: form } : { link };
  }
  if (loc === "PHONE_CALL") return { link: `tel:${str(ad, "phone").replace(/[^\d+]/g, "")}` };
  if (loc === "MESSAGING") {
    const apps = strs(group, "messagingApps");
    return { app_destination: apps.length === 1 ? apps[0] : "MESSENGER" };
  }
  return { link };
}

async function creativeSpec(api: MetaApi, act: string, draft: BuilderDraft, group: Values, ad: AdNode, assets: Map<string, BuilderAsset>) {
  const v = ad.values;
  const pageId = str(v, "pageId");
  if (!pageId) throw new ConnectorError("INVALID_REQUEST", "Choose the Facebook Page for each ad.");
  const igId = str(v, "instagramId");
  const loc = str(group, "conversionLocation");
  const [appId, storeUrl] = str(group, "appId").split("|");
  const appAd = draft.setup.objective === "OUTCOME_APP_PROMOTION";
  // App ads link to the app's store page; instant forms use Meta's placeholder link.
  const url = appAd && storeUrl ? storeUrl : str(v, "url") || (loc === "ON_AD" ? "http://fb.me/" : `https://facebook.com/${pageId}`);
  const cta = str(v, "cta") || "LEARN_MORE";
  const bodies = texts(v, "primaryTexts");
  const titles = texts(v, "headlines");
  const descriptions = texts(v, "descriptions");
  const identity: Record<string, unknown> = { page_id: pageId, ...(igId ? { instagram_user_id: igId } : {}) };
  const callToAction = cta === "NO_BUTTON" ? undefined : { type: cta, value: appAd ? { link: url, application: appId } : ctaValue(draft, group, v, url) };
  const base: Record<string, unknown> = { name: str(v, "name") || "Ad creative" };
  if (str(v, "urlParams")) base.url_tags = str(v, "urlParams");
  if (bool(v, "enhancements")) {
    base.degrees_of_freedom_spec = {
      creative_features_spec: Object.fromEntries(["image_touchups", "image_brightness_and_contrast", "text_optimizations", "enhance_cta", "adapt_to_placement"].map((k) => [k, { enroll_status: "OPT_IN" }])),
    };
  }

  if (v.format === "CAROUSEL") {
    const cards = repeater(v, "cards");
    const children = [];
    for (const card of cards) {
      const [asset] = mediaOf(card, "media", assets);
      if (!asset) throw new ConnectorError("INVALID_REQUEST", "Every carousel card needs an image or video.");
      const m = await mediaRef(api, act, asset);
      children.push({
        link: str(card, "url"),
        name: str(card, "headline") || undefined,
        description: str(card, "description") || undefined,
        ...(m.kind === "image" ? { image_hash: m.hash } : { video_id: m.videoId, picture: m.thumbnail }),
        ...(callToAction ? { call_to_action: { type: cta, value: { link: str(card, "url") } } } : {}),
      });
    }
    return {
      ...base,
      object_story_spec: {
        ...identity,
        link_data: { link: str(cards[0] ?? {}, "url") || url, message: bodies[0], child_attachments: children, multi_share_optimized: true, ...(callToAction ? { call_to_action: callToAction } : {}) },
      },
    };
  }

  const [feedAsset] = mediaOf(v, "media", assets);
  if (!feedAsset) throw new ConnectorError("INVALID_REQUEST", "Each ad needs an image or video.");
  const feed = await mediaRef(api, act, feedAsset);
  const [storyAsset] = mediaOf(v, "storyMedia", assets);
  const story = storyAsset ? await mediaRef(api, act, storyAsset) : null;
  const caption = str(v, "displayLink") || undefined;

  // Placement customization (a 9:16 version for Stories/Reels) and multiple text options
  // both use asset_feed_spec; a plain single creative uses object_story_spec only.
  if (story || bodies.length > 1 || titles.length > 1 || descriptions.length > 1) {
    const media = (m: MediaRef, label?: string): Record<string, unknown[]> => {
      const labels = label ? { adlabels: [{ name: label }] } : {};
      return m.kind === "image" ? { images: [{ hash: m.hash, ...labels }] } : { videos: [{ video_id: m.videoId, thumbnail_url: m.thumbnail, ...labels }] };
    };
    const merge = (a: Record<string, unknown[]>, b: Record<string, unknown[]>) => {
      const out: Record<string, unknown[]> = { ...a };
      for (const [k, list] of Object.entries(b)) out[k] = [...(out[k] ?? []), ...list];
      return out;
    };
    const assetFeed: Record<string, unknown> = {
      ...(story ? merge(media(feed, "feed"), media(story, "story")) : media(feed)),
      bodies: (bodies.length ? bodies : [""]).slice(0, story ? 1 : 5).map((text) => ({ text })),
      titles: titles.slice(0, story ? 1 : 5).map((text) => ({ text })),
      descriptions: descriptions.slice(0, story ? 1 : 5).map((text) => ({ text })),
      link_urls: [{ website_url: url, ...(caption ? { display_url: caption } : {}) }],
      call_to_action_types: [cta],
      ad_formats: [feed.kind === "video" ? "SINGLE_VIDEO" : "SINGLE_IMAGE"],
      optimization_type: story ? "PLACEMENT" : "DEGREES_OF_FREEDOM",
    };
    if (story) {
      const label = feed.kind === "video" ? "video_label" : "image_label";
      assetFeed.asset_customization_rules = [
        { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "marketplace", "search"], instagram_positions: ["stream", "explore_home"] }, [label]: { name: "feed" } },
        { customization_spec: { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["story", "facebook_reels"], instagram_positions: ["story", "reels"] }, [label]: { name: "story" } },
      ];
    }
    return { ...base, object_story_spec: identity, asset_feed_spec: assetFeed };
  }

  if (feed.kind === "video") {
    return {
      ...base,
      object_story_spec: {
        ...identity,
        video_data: { video_id: feed.videoId, image_url: feed.thumbnail, message: bodies[0], title: titles[0], link_description: descriptions[0], ...(callToAction ? { call_to_action: callToAction } : {}) },
      },
    };
  }
  return {
    ...base,
    object_story_spec: {
      ...identity,
      link_data: { link: url, message: bodies[0], name: titles[0], description: descriptions[0], caption, image_hash: feed.hash, ...(callToAction ? { call_to_action: callToAction } : {}) },
    },
  };
}

// ───────── Create ─────────

export async function metaCreateCampaign(
  api: MetaApi,
  account: { externalId: string; currency: string },
  draft: BuilderDraft,
  assets: Map<string, BuilderAsset>,
): Promise<AccountStructure> {
  const act = `/act_${account.externalId}`;
  const c = draft.campaign;
  const cur = account.currency;
  const status = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const cbo = bool(c, "cbo");
  const special = strs(c, "specialAdCategories");
  const campaignBudget = cbo ? budgetOf(c) : null;
  if (cbo && !campaignBudget) throw new ConnectorError("INVALID_REQUEST", "Enter the campaign budget.");

  for (const g of draft.adGroups) {
    const bad = placements(g.values, "placements").items.filter((p) => !ALLOWED_PLACEMENTS.has(p));
    if (placements(g.values, "placements").mode === "MANUAL" && bad.length) throw new ConnectorError("INVALID_REQUEST", `Meta no longer offers the placement ${bad[0]}.`);
  }

  const campaign = await api.post<{ id: string }>(`${act}/campaigns`, {
    name: str(c, "name"),
    objective: draft.setup.objective,
    status,
    buying_type: "AUCTION",
    special_ad_categories: special,
    ...(special.length ? { special_ad_category_country: strs(c, "specialCountries") } : {}),
    ...(campaignBudget
      ? {
          [campaignBudget.lifetime ? "lifetime_budget" : "daily_budget"]: minor(campaignBudget.amount, cur),
          bid_strategy: str(c, "bidStrategy") || "LOWEST_COST_WITHOUT_CAP",
        }
      : { is_adset_budget_sharing_enabled: false }),
  });

  const structure: AccountStructure = {
    campaigns: [
      {
        externalId: campaign.id,
        name: str(c, "name"),
        status,
        deliveryStatus: status === "ACTIVE" ? "IN_PROCESS" : "PAUSED",
        objective: String(draft.setup.objective),
        dailyBudget: campaignBudget && !campaignBudget.lifetime ? campaignBudget.amount : null,
        lifetimeBudget: campaignBudget?.lifetime ? campaignBudget.amount : null,
        startDate: null,
        endDate: null,
        updatedAt: new Date(),
        raw: campaignBudget ? { [campaignBudget.lifetime ? "lifetime_budget" : "daily_budget"]: minor(campaignBudget.amount, cur) } : {},
      },
    ],
    adGroups: [],
    ads: [],
  };

  try {
    for (const g of draft.adGroups) {
      const v = g.values;
      const goal = str(v, "optimizationGoal");
      const pageId = str(g.ads[0]?.values ?? {}, "pageId") || undefined;
      const budget = cbo ? null : budgetOf(v);
      if (!cbo && !budget) throw new ConnectorError("INVALID_REQUEST", `Enter a budget for ad set “${str(v, "name")}”.`);
      const bidStrategy = cbo ? str(c, "bidStrategy") : str(v, "bidStrategy");
      const bidSource = cbo ? c : v;
      const start = dateOf(v, "startDate");
      const end = dateOf(v, "endDate");
      const targeting = await targetingSpec(api, draft, v);

      const body: Record<string, unknown> = {
        name: str(v, "name"),
        campaign_id: campaign.id,
        status,
        optimization_goal: goal,
        billing_event: billingEvent(goal),
        destination_type: destinationType(draft, v),
        promoted_object: promotedObject(draft, v, pageId),
        targeting,
        start_time: (start ?? new Date()).toISOString(),
        end_time: end?.toISOString(),
      };
      if (budget) body[budget.lifetime ? "lifetime_budget" : "daily_budget"] = minor(budget.amount, cur);
      if (!cbo) body.bid_strategy = bidStrategy || "LOWEST_COST_WITHOUT_CAP";
      if (["COST_CAP", "LOWEST_COST_WITH_BID_CAP"].includes(bidStrategy) && num(bidSource, "bidAmount")) body.bid_amount = minor(num(bidSource, "bidAmount")!, cur);
      if (bidStrategy === "LOWEST_COST_WITH_MIN_ROAS" && num(bidSource, "roasGoal")) body.bid_constraints = { roas_average_floor: Math.round(num(bidSource, "roasGoal")! * 10000) };
      if (cbo && num(v, "minSpend")) body[campaignBudget?.lifetime ? "lifetime_min_spend_target" : "daily_min_spend_target"] = minor(num(v, "minSpend")!, cur);
      if (cbo && num(v, "maxSpend")) body[campaignBudget?.lifetime ? "lifetime_spend_cap" : "daily_spend_cap"] = minor(num(v, "maxSpend")!, cur);
      if (goal === "REACH" && num(v, "frequencyCap")) body.frequency_control_specs = [{ event: "IMPRESSIONS", interval_days: 7, max_frequency: num(v, "frequencyCap") }];
      if (pixelGoal(draft, v)) {
        const attribution = str(v, "attribution") || "7d_click_1d_view";
        const click = attribution.startsWith("1d") ? 1 : 7;
        body.attribution_spec = [{ event_type: "CLICK_THROUGH", window_days: click }, ...(attribution.endsWith("1d_view") ? [{ event_type: "VIEW_THROUGH", window_days: 1 }] : [])];
      }
      if (str(v, "dsaBeneficiary")) body.dsa_beneficiary = str(v, "dsaBeneficiary");
      if (str(v, "dsaPayer")) body.dsa_payor = str(v, "dsaPayer");
      const schedule = adsetSchedule(v);
      if (schedule && (budget?.lifetime || campaignBudget?.lifetime)) {
        body.adset_schedule = schedule;
        body.pacing_type = ["day_parting"];
      }

      const adSet = await api.post<{ id: string }>(`${act}/adsets`, body);
      const group: ExternalAdGroup = {
        externalId: adSet.id,
        campaignExternalId: campaign.id,
        name: str(v, "name"),
        status,
        dailyBudget: budget && !budget.lifetime ? budget.amount : null,
        bidStrategy: bidStrategy || "LOWEST_COST_WITHOUT_CAP",
        targeting,
        raw: { optimization_goal: goal },
        sourceKey: g.key,
      };
      structure.adGroups.push(group);

      for (const ad of g.ads) {
        const spec = await creativeSpec(api, act, draft, v, ad, assets);
        const creative = await api.post<{ id: string }>(`${act}/adcreatives`, spec);
        const created = await api.post<{ id: string }>(`${act}/ads`, { name: str(ad.values, "name"), adset_id: adSet.id, creative: { creative_id: creative.id }, status });
        const external: ExternalAd = {
          externalId: created.id,
          adGroupExternalId: adSet.id,
          campaignExternalId: campaign.id,
          name: str(ad.values, "name"),
          status,
          headline: texts(ad.values, "headlines")[0] ?? str(repeater(ad.values, "cards")[0] ?? {}, "headline") ?? null,
          body: texts(ad.values, "primaryTexts")[0] ?? null,
          thumbnailUrl: null,
          finalUrl: str(ad.values, "url") || null,
          raw: { creative_id: creative.id },
          sourceKey: ad.key,
        };
        structure.ads.push(external);
      }
    }
    return structure;
  } catch (err) {
    // Don't leave a half-built campaign behind on the platform.
    await api.del(`/${campaign.id}`).catch(() => undefined);
    throw err;
  }
}
