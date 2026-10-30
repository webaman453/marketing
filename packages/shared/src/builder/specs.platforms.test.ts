/** The important per-platform rules of each builder spec. Generic invariants live in specs.invariants.test.ts. */
import { describe, expect, it } from "vitest";
import type { Platform } from "../platforms";
import { BUILDER_SPECS, GOOGLE_GOALS, META_OBJECTIVES, googleCampaignTypes, linkedinFormats, metaGoals, metaLocations } from "./index";
import { emptyContext, isRequired, isVisible, levelFields, newAdGroup, newDraft, previewValues, resolveOptions, setupOptions, validateDraft, visibleDraft, type MediaInfo } from "./engine";
import { DESCRIPTION_PINS, HEADLINE_PINS, keywordsField, negativeKeywordsField, rsaSections } from "./specs/search-ads";
import type { BuilderDraft, BuilderIssue, ChoiceField, Field, FieldContext, LevelSpec, Option, TextListField, Values } from "./types";

// ───────── helpers ─────────

const spec = (p: Platform) => BUILDER_SPECS[p];
const make = (p: Platform, setup: Values) => newDraft(spec(p), "acc", setup, "Campaign");
const g0 = (d: BuilderDraft) => d.adGroups[0]!;
const a0 = (d: BuilderDraft) => d.adGroups[0]!.ads[0]!;
const run = (d: BuilderDraft, media = new Map<string, MediaInfo>()) => validateDraft(spec(d.platform), d, media);
const at = (issues: BuilderIssue[], level: BuilderIssue["level"], field?: string) =>
  issues.filter((i) => i.level === level && (field === undefined || i.field === field)).map((i) => i.message);
const ctxFor = (d: BuilderDraft): FieldContext => ({ setup: d.setup, campaign: d.campaign, adGroup: g0(d).values, ad: a0(d)?.values ?? {} });
const values = (o: Option[]) => o.map((x) => x.value);

/** Whether some field with this key is visible (in a visible section) at a level. */
function shown(level: LevelSpec | null, key: string, ctx: FieldContext) {
  if (!level) return false;
  return level.sections.some((s) => isVisible(s, ctx) && s.fields.some((f) => f.key === key && isVisible(f, ctx)));
}
/** The visible field with a key (first match) at a level. */
function visibleField(level: LevelSpec, key: string, ctx: FieldContext): Field | undefined {
  for (const s of level.sections) if (isVisible(s, ctx)) for (const f of s.fields) if (f.key === key && isVisible(f, ctx)) return f;
  return undefined;
}
const adLevel = (d: BuilderDraft) => spec(d.platform).ad(d.setup)!;

const SQ: MediaInfo = { type: "IMAGE", width: 1080, height: 1080 };
const VERT: MediaInfo = { type: "IMAGE", width: 1080, height: 1920 };
const VIDEO: MediaInfo = { type: "VIDEO", width: 1080, height: 1920 };
const MEDIA = new Map<string, MediaInfo>([
  ["sq", SQ],
  ["v1", VERT],
  ["v2", VERT],
  ["v3", VERT],
  ["vid", VIDEO],
]);
const IN = [{ id: "IN", name: "India", type: "country" }];

// ───────── Meta ─────────

describe("Meta", () => {
  const goalsFor = (objective: string, conversionLocation?: string) => values(metaGoals({ ...emptyContext(), setup: { objective }, adGroup: { conversionLocation } }));

  it("offers the six outcome objectives", () => {
    expect(values(META_OBJECTIVES)).toEqual(["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES"]);
  });

  it("maps objective + conversion location to performance goals", () => {
    expect(goalsFor("OUTCOME_AWARENESS")).toEqual(["REACH", "IMPRESSIONS", "AD_RECALL_LIFT", "THRUPLAY"]);
    expect(goalsFor("OUTCOME_APP_PROMOTION")).toEqual(["APP_INSTALLS", "OFFSITE_CONVERSIONS", "VALUE", "LINK_CLICKS"]);
    expect(goalsFor("OUTCOME_TRAFFIC", "WEBSITE")[0]).toBe("LANDING_PAGE_VIEWS");
    expect(goalsFor("OUTCOME_TRAFFIC", "MESSAGING")).toEqual(["CONVERSATIONS", "LINK_CLICKS"]);
    expect(goalsFor("OUTCOME_SALES", "PHONE_CALL")).toEqual(["QUALITY_CALL"]);
    expect(goalsFor("OUTCOME_TRAFFIC", "INSTAGRAM_PROFILE")).toEqual(["VISIT_INSTAGRAM_PROFILE"]);
    expect(goalsFor("OUTCOME_ENGAGEMENT", "ON_PAGE")).toEqual(["PAGE_LIKES"]);
    expect(goalsFor("OUTCOME_ENGAGEMENT", "ON_AD")).toEqual(["POST_ENGAGEMENT", "THRUPLAY", "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS", "EVENT_RESPONSES"]);
    expect(goalsFor("OUTCOME_LEADS", "ON_AD")).toEqual(["LEAD_GENERATION", "QUALITY_LEAD"]);
    expect(goalsFor("OUTCOME_LEADS", "WEBSITE")).toEqual(["OFFSITE_CONVERSIONS", "LANDING_PAGE_VIEWS", "LINK_CLICKS"]);
    expect(goalsFor("OUTCOME_SALES", "WEBSITE")).toEqual(["OFFSITE_CONVERSIONS", "VALUE", "LANDING_PAGE_VIEWS", "LINK_CLICKS", "REACH"]);
  });

  it("offers conversion locations per objective (none for awareness and app promotion)", () => {
    const locs = (objective: string) => values(metaLocations({ ...emptyContext(), setup: { objective } }));
    expect(locs("OUTCOME_AWARENESS")).toEqual([]);
    expect(locs("OUTCOME_APP_PROMOTION")).toEqual([]);
    expect(locs("OUTCOME_LEADS")).toEqual(["WEBSITE", "ON_AD", "MESSAGING", "PHONE_CALL", "APP"]);
    expect(locs("OUTCOME_SALES")).toContain("WEBSITE_AND_APP");
    expect(locs("NOPE")).toEqual([]);
  });

  it.each(["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_APP_PROMOTION", "OUTCOME_SALES"])(
    "%s: the default performance goal fits the default conversion location",
    (objective) => {
      const d = make("META", { objective });
      expect(goalsFor(objective, g0(d).values.conversionLocation as string)).toContain(g0(d).values.optimizationGoal);
    },
  );

  it("Engagement's default performance goal is one Meta offers for its default location (On your ad)", () => {
    const d = make("META", { objective: "OUTCOME_ENGAGEMENT" });
    expect(g0(d).values.conversionLocation).toBe("ON_AD");
    expect(goalsFor("OUTCOME_ENGAGEMENT", "ON_AD")).toContain(g0(d).values.optimizationGoal);
  });

  it("hides the conversion section for awareness; app promotion needs an app", () => {
    const aw = make("META", { objective: "OUTCOME_AWARENESS" });
    expect(shown(spec("META").adGroup, "conversionLocation", ctxFor(aw))).toBe(false);
    const app = make("META", { objective: "OUTCOME_APP_PROMOTION" });
    expect(shown(spec("META").adGroup, "appId", ctxFor(app))).toBe(true);
    expect(at(run(app), "adGroup", "appId")).toEqual(["App is required."]);
  });

  it("needs a pixel and event only for website conversion goals", () => {
    const d = make("META", { objective: "OUTCOME_SALES" });
    expect(g0(d).values.optimizationGoal).toBe("OFFSITE_CONVERSIONS");
    expect(g0(d).values.conversionEvent).toBe("PURCHASE");
    expect(at(run(d), "adGroup", "pixelId")).toEqual(["Dataset (pixel) is required."]);
    g0(d).values.optimizationGoal = "LINK_CLICKS";
    expect(at(run(d), "adGroup", "pixelId")).toEqual([]);
    expect(visibleDraft(spec("META"), d).adGroups[0]!.values).not.toHaveProperty("conversionEvent");
  });

  it("defaults the conversion event to Lead for lead campaigns", () => {
    expect(g0(make("META", { objective: "OUTCOME_LEADS" })).values.conversionEvent).toBe("LEAD");
  });

  it("Advantage+ campaign budget moves budget and bidding between campaign and ad set", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    expect(d.campaign.cbo).toBe(true);
    let v = visibleDraft(spec("META"), d);
    expect(v.campaign).toHaveProperty("budget");
    expect(v.campaign).toHaveProperty("bidStrategy");
    expect(v.adGroups[0]!.values).not.toHaveProperty("budget");
    expect(v.adGroups[0]!.values).not.toHaveProperty("bidStrategy");
    expect(at(run(d), "campaign", "budget")).toEqual(["Budget is required."]);
    expect(at(run(d), "adGroup", "budget")).toEqual([]);

    d.campaign.cbo = false;
    v = visibleDraft(spec("META"), d);
    expect(v.campaign).not.toHaveProperty("budget");
    expect(v.adGroups[0]!.values).toHaveProperty("budget");
    expect(at(run(d), "adGroup", "budget")).toEqual(["Budget is required."]);
  });

  it("offers the ROAS goal only for sales; cost caps need an amount", () => {
    const opts = (objective: string) => {
      const d = make("META", { objective });
      const f = levelFields(spec("META").campaign).find((x) => x.key === "bidStrategy")!;
      return values(resolveOptions(f as ChoiceField, ctxFor(d)));
    };
    expect(opts("OUTCOME_SALES")).toContain("LOWEST_COST_WITH_MIN_ROAS");
    expect(opts("OUTCOME_TRAFFIC")).not.toContain("LOWEST_COST_WITH_MIN_ROAS");

    const d = make("META", { objective: "OUTCOME_SALES" });
    d.campaign.bidStrategy = "COST_CAP";
    expect(at(run(d), "campaign", "bidAmount")).toEqual(["Amount is required."]);
    d.campaign.bidStrategy = "LOWEST_COST_WITH_MIN_ROAS";
    expect(at(run(d), "campaign", "roasGoal")).toEqual(["Minimum ROAS is required."]);
  });

  it("a lifetime budget needs an end date", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    expect(at(run(d), "adGroup", "endDate")).toEqual([]);
    d.campaign.budgetType = "LIFETIME";
    expect(at(run(d), "adGroup", "endDate")).toEqual(["End date is required."]);
  });

  it("Special Ad Categories need countries, ages 18–65+ and all genders", () => {
    const d = make("META", { objective: "OUTCOME_LEADS" });
    d.campaign.specialAdCategories = ["EMPLOYMENT"];
    g0(d).values.age = { min: 25, max: 65 };
    g0(d).values.gender = "FEMALE";
    const issues = run(d);
    expect(at(issues, "campaign", "specialCountries")).toEqual(["Choose at least one countries."]);
    expect(at(issues, "adGroup", "age")).toEqual(["Special Ad Categories must target ages 18–65+."]);
    expect(at(issues, "adGroup", "gender")).toEqual(["Special Ad Categories must target all genders."]);
    d.campaign.specialAdCategories = [];
    expect(at(run(d), "adGroup", "age")).toEqual([]);
  });

  it("EU locations need DSA beneficiary and payer; excluded EU countries don't", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    expect(at(run(d), "adGroup", "dsaBeneficiary")).toEqual([]);
    g0(d).values.locations = [{ id: "DE", name: "Germany", type: "country" }];
    expect(at(run(d), "adGroup", "dsaBeneficiary")).toEqual(["Beneficiary (EU) is required."]);
    expect(at(run(d), "adGroup", "dsaPayer")).toEqual(["Payer (EU) is required."]);
    g0(d).values.locations = [{ id: "2250", name: "Paris", type: "city", countryCode: "fr" }];
    expect(at(run(d), "adGroup", "dsaBeneficiary")).toHaveLength(1);
    g0(d).values.locations = [...IN, { id: "FR", name: "France", type: "country", exclude: true }];
    expect(at(run(d), "adGroup", "dsaBeneficiary")).toEqual([]);
  });

  it("carousel ads need 2–10 cards and drop single-image fields", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    Object.assign(a0(d).values, { format: "CAROUSEL", media: ["sq"], url: "https://shop.example.com" });
    expect(at(run(d, MEDIA), "ad", "cards")).toEqual(["Add at least 2 cards."]);
    expect(at(run(d, MEDIA), "ad", "media")).toEqual([]);
    expect(at(run(d, MEDIA), "ad", "url")).toEqual([]);
    const v = visibleDraft(spec("META"), d).adGroups[0]!.ads[0]!.values;
    expect(v).not.toHaveProperty("media");
    expect(v).not.toHaveProperty("headlines");
    expect(v).toHaveProperty("cards");
  });

  it("a single ad needs media, primary text and (except awareness) a URL", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    const ad = at(run(d), "ad");
    expect(ad).toEqual(expect.arrayContaining(["Media: add an image or video.", "Add at least one primary text.", "Website URL is required.", "Facebook Page is required."]));
    const aw = make("META", { objective: "OUTCOME_AWARENESS" });
    expect(at(run(aw), "ad", "url")).toEqual([]);
  });

  it("app promotion and on-ad leads have no website destination", () => {
    const app = make("META", { objective: "OUTCOME_APP_PROMOTION" });
    expect(shown(adLevel(app), "url", ctxFor(app))).toBe(false);
    const lead = make("META", { objective: "OUTCOME_LEADS" });
    g0(lead).values.conversionLocation = "ON_AD";
    expect(shown(adLevel(lead), "url", ctxFor(lead))).toBe(false);
    expect(shown(spec("META").adGroup, "leadFormId", ctxFor(lead))).toBe(true);
  });

  it("“Call now” needs the Calls location or a phone number", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    a0(d).values.cta = "CALL_NOW";
    expect(at(run(d), "ad", "cta")).toEqual(["“Call now” needs the Calls conversion location and a phone number."]);
    g0(d).values.conversionLocation = "PHONE_CALL";
    expect(at(run(d), "ad", "cta")).toEqual([]);
    expect(at(run(d), "ad", "phone")).toEqual(["Phone number is required."]);
  });

  it("defaults the CTA by objective", () => {
    const cta = (objective: string) => a0(make("META", { objective })).values.cta;
    expect(cta("OUTCOME_SALES")).toBe("SHOP_NOW");
    expect(cta("OUTCOME_LEADS")).toBe("SIGN_UP");
    expect(cta("OUTCOME_APP_PROMOTION")).toBe("INSTALL_MOBILE_APP");
    expect(cta("OUTCOME_TRAFFIC")).toBe("LEARN_MORE");
  });

  it("previews follow manual placements", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    const previews = () => spec("META").previews(ctxFor(d));
    expect(previews()).toEqual(["fb_feed", "ig_feed", "ig_story", "ig_reels", "fb_reels", "fb_right_column"]);
    g0(d).values.placements = { mode: "MANUAL", items: ["instagram.story", "instagram.reels"] };
    expect(previews()).toEqual(["ig_story", "ig_reels"]);
    g0(d).values.placements = { mode: "MANUAL", items: ["audience_network.classic"] };
    expect(previews()).toEqual(["fb_feed"]);
  });

  it("previewValues hides carousel cards on a single ad", () => {
    const d = make("META", { objective: "OUTCOME_TRAFFIC" });
    a0(d).values.cards = [{ headline: "x" }];
    expect(previewValues(spec("META"), d, g0(d), a0(d)).ad).not.toHaveProperty("cards");
  });
});

// ───────── Google ─────────

describe("Google", () => {
  it("offers campaign types by goal, with Video disabled", () => {
    expect(values(googleCampaignTypes("APP_PROMOTION"))).toEqual(["APP"]);
    expect(values(googleCampaignTypes("LOCAL_STORE_VISITS"))).toEqual(["PERFORMANCE_MAX"]);
    expect(values(googleCampaignTypes("unknown"))).toEqual(values(googleCampaignTypes("NONE")));
    const video = googleCampaignTypes("SALES").find((t) => t.value === "VIDEO")!;
    expect(video.disabled).toBe(true);
    expect(video.disabledReason).toMatch(/Demand Gen/);
    expect(values(GOOGLE_GOALS)).toContain("NONE");
  });

  it("shows the campaign type choice only after a goal", () => {
    const choice = spec("GOOGLE").setup[1]!;
    expect(choice.showIf!({})).toBe(false);
    expect(choice.showIf!({ goal: "SALES" })).toBe(true);
    expect(values(setupOptions(choice, {}))).toEqual(values(googleCampaignTypes("NONE")));
  });

  it("rejects Video campaigns with an API message", () => {
    const d = make("GOOGLE", { goal: "SALES", campaignType: "VIDEO" });
    expect(at(run(d), "setup", "campaignType")[0]).toMatch(/can't be created through the Google Ads API/);
  });

  it("recommends clicks for traffic goals, conversions otherwise", () => {
    expect(make("GOOGLE", { goal: "WEBSITE_TRAFFIC", campaignType: "SEARCH" }).campaign.bidding).toBe("CLICKS");
    expect(make("GOOGLE", { goal: "SALES", campaignType: "SEARCH" }).campaign.bidding).toBe("CONVERSIONS");
    expect(make("GOOGLE", { goal: "SALES", campaignType: "SHOPPING" }).campaign.bidding).toBe("CONVERSION_VALUE");
    expect(make("GOOGLE", { goal: "WEBSITE_TRAFFIC", campaignType: "SHOPPING" }).campaign.bidding).toBe("CLICKS");
    expect(make("GOOGLE", { goal: "APP_PROMOTION", campaignType: "APP" }).campaign.bidding).toBe("INSTALLS");
  });

  it("a campaign total budget needs an end date", () => {
    const d = make("GOOGLE", { goal: "SALES", campaignType: "SEARCH" });
    expect(at(run(d), "campaign", "endDate")).toEqual([]);
    d.campaign.budgetType = "TOTAL";
    expect(at(run(d), "campaign", "endDate")).toEqual(["End date is required."]);
  });

  describe("Search: responsive search ads", () => {
    const search = () => make("GOOGLE", { goal: "SALES", campaignType: "SEARCH" });
    const fields = () => levelFields(adLevel(search()));
    const headlines = () => fields().find((f) => f.key === "headlines") as TextListField;
    const descriptions = () => fields().find((f) => f.key === "descriptions") as TextListField;

    it("has 3–15 headlines of 30 and 2–4 descriptions of 90, pinnable to H1–H3 / D1–D2", () => {
      expect(headlines()).toMatchObject({ min: 3, max: 15, maxLength: 30, required: true, pinnable: { positions: ["H1", "H2", "H3"] } });
      expect(descriptions()).toMatchObject({ min: 2, max: 4, maxLength: 90, required: true, pinnable: { positions: ["D1", "D2"] } });
      expect(HEADLINE_PINS.positions).toEqual(["H1", "H2", "H3"]);
      expect(DESCRIPTION_PINS.positions).toEqual(["D1", "D2"]);
    });

    it("starts with 5 empty unpinned headlines and 2 descriptions", () => {
      const ad = a0(search()).values;
      expect(ad.headlines).toEqual(Array.from({ length: 5 }, () => ({ text: "", pin: null })));
      expect(ad.descriptions).toEqual([{ text: "", pin: null }, { text: "", pin: null }]);
    });

    const h = (n: number, len = 10) => Array.from({ length: n }, (_, i) => ({ text: `${i}`.padEnd(len, "x"), pin: null }));
    const check = (patch: Values) => {
      const d = search();
      Object.assign(a0(d).values, patch);
      return run(d);
    };

    it("counts headlines and descriptions, pinned or not", () => {
      expect(at(check({ headlines: h(2) }), "ad", "headlines")).toEqual(["Add at least 3 headlines."]);
      expect(at(check({ headlines: [...h(2), { text: "Pinned", pin: "H1" }] }), "ad", "headlines")).toEqual([]);
      expect(at(check({ headlines: h(16) }), "ad", "headlines")).toEqual(["Use at most 15 headlines."]);
      expect(at(check({ headlines: h(15) }), "ad", "headlines")).toEqual([]);
      expect(at(check({ descriptions: h(1, 20) }), "ad", "descriptions")).toEqual(["Add at least 2 descriptions."]);
      expect(at(check({ descriptions: h(5, 20) }), "ad", "descriptions")).toEqual(["Use at most 4 descriptions."]);
    });

    it("limits headline and description length", () => {
      expect(at(check({ headlines: [...h(2), { text: "x".repeat(31), pin: "H2" }] }), "ad", "headlines")).toEqual(["Headline 3 is over 30 characters."]);
      expect(at(check({ headlines: [...h(2), { text: "x".repeat(30), pin: null }] }), "ad", "headlines")).toEqual([]);
      expect(at(check({ descriptions: [{ text: "y".repeat(91), pin: "D1" }, { text: "ok desc", pin: null }] }), "ad", "descriptions")).toEqual(["Description 1 is over 90 characters."]);
    });

    it("rejects duplicate headlines", () => {
      expect(at(check({ headlines: [...h(2), { text: h(1)[0]!.text.toUpperCase(), pin: "H1" }] }), "ad", "headlines")).toEqual(["Headlines must be different from each other."]);
    });

    it("keeps pins through visibleDraft", () => {
      const d = search();
      a0(d).values.headlines = [{ text: "Brand", pin: "H1" }, ...h(2)];
      expect((visibleDraft(spec("GOOGLE"), d).adGroups[0]!.ads[0]!.values.headlines as { pin: string }[])[0]!.pin).toBe("H1");
    });

    it("shows display path 2 only after path 1", () => {
      const d = search();
      expect(shown(adLevel(d), "path2", ctxFor(d))).toBe(false);
      a0(d).values.path1 = "sale";
      expect(shown(adLevel(d), "path2", ctxFor(d))).toBe(true);
    });

    it("needs keywords, and a default bid only with manual CPC", () => {
      const d = search();
      expect(at(run(d), "adGroup", "keywords")).toEqual(["Add at least 1 keyword."]);
      expect(at(run(d), "adGroup", "defaultBid")).toEqual([]);
      d.campaign.bidding = "MANUAL_CPC";
      expect(at(run(d), "adGroup", "defaultBid")).toEqual(["Default max. CPC is required."]);
    });

    it("validates sitelinks as a repeater", () => {
      const d = search();
      a0(d).values.sitelinks = [{ text: "x".repeat(26), url: "nope" }];
      expect(at(run(d), "ad", "sitelinks")).toEqual(["Sitelink 1: Sitelink text is over 25 characters.", "Sitelink 1: Final URL must be a full URL starting with https://"]);
    });

    it("previews search results on mobile and desktop", () => {
      expect(spec("GOOGLE").previews(ctxFor(search()))).toEqual(["google_search_mobile", "google_search_desktop"]);
    });
  });

  describe("Performance Max", () => {
    const pmax = () => make("GOOGLE", { goal: "SALES", campaignType: "PERFORMANCE_MAX" });
    it("has no ad level; assets live on the asset group", () => {
      const d = pmax();
      expect(spec("GOOGLE").ad(d.setup)).toBeNull();
      expect(g0(d).ads).toEqual([]);
      expect(g0(d).values.name).toBe("Ad group 1");
      expect(shown(spec("GOOGLE").adGroup, "landscapeImages", ctxFor(d))).toBe(true);
      expect(shown(spec("GOOGLE").campaign, "businessName", ctxFor(d))).toBe(true);
    });
    it("needs one description of 60 characters or less", () => {
      const d = pmax();
      g0(d).values.descriptions = ["x".repeat(70), "y".repeat(80)];
      expect(at(run(d), "adGroup", "descriptions")).toContain("Add at least one description of 60 characters or less.");
      g0(d).values.descriptions = ["x".repeat(60), "y".repeat(80)];
      expect(at(run(d), "adGroup", "descriptions")).toEqual([]);
    });
    it("square images must be 1:1", () => {
      const d = pmax();
      g0(d).values.squareImages = ["v1"];
      expect(at(run(d, MEDIA), "adGroup", "squareImages")).toEqual(["Square images (1:1) must be 1:1."]);
    });
  });

  describe("Demand Gen", () => {
    it("defaults to video ads for YouTube reach, image otherwise", () => {
      expect(a0(make("GOOGLE", { goal: "YOUTUBE_REACH", campaignType: "DEMAND_GEN" })).values.format).toBe("VIDEO");
      expect(a0(make("GOOGLE", { goal: "SALES", campaignType: "DEMAND_GEN" })).values.format).toBe("IMAGE");
    });
    it("checks YouTube links", () => {
      const d = make("GOOGLE", { goal: "YOUTUBE_REACH", campaignType: "DEMAND_GEN" });
      a0(d).values.youtubeVideos = ["https://vimeo.com/123456"];
      expect(at(run(d), "ad", "youtubeVideos")).toEqual(["“https://vimeo.com/123456” isn't a YouTube link."]);
      a0(d).values.youtubeVideos = ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/abcdefg"];
      expect(at(run(d), "ad", "youtubeVideos")).toEqual([]);
    });
    it("previews follow the ad type and channels", () => {
      const d = make("GOOGLE", { goal: "YOUTUBE_REACH", campaignType: "DEMAND_GEN" });
      expect(spec("GOOGLE").previews(ctxFor(d))).toEqual(["youtube_instream", "youtube_infeed", "youtube_shorts"]);
      g0(d).values.channels = { mode: "MANUAL", items: ["youtube_shorts"] };
      expect(spec("GOOGLE").previews(ctxFor(d))).toEqual(["youtube_shorts"]);
      a0(d).values.format = "IMAGE";
      expect(spec("GOOGLE").previews(ctxFor(d))).toEqual(["discover"]);
    });
  });

  it("Display uses responsive display ads; Shopping has no ads; max 3 ads per group", () => {
    expect(adLevel(make("GOOGLE", { goal: "SALES", campaignType: "DISPLAY" })).sections[0]!.id).toBe("ad");
    expect(spec("GOOGLE").ad({ campaignType: "SHOPPING" })).toBeNull();
    expect(spec("GOOGLE").maxAds).toBe(3);
    const shop = make("GOOGLE", { goal: "SALES", campaignType: "SHOPPING" });
    expect(at(run(shop), "adGroup", "defaultBid")).toEqual(["Default max. CPC is required."]);
    expect(at(run(shop), "campaign", "merchantId")).toEqual(["Merchant Center account is required."]);
  });
});

describe("search-ads helpers", () => {
  it("rsaSections names the platform and keyword fields have the expected shape", () => {
    expect(rsaSections({ platformName: "Bing" })[0]!.description).toMatch(/^Bing mixes/);
    expect(keywordsField()).toMatchObject({ key: "keywords", type: "keywords", min: 1, max: 1000, required: true });
    expect(keywordsField(50)).toMatchObject({ max: 50 });
    expect(negativeKeywordsField()).toMatchObject({ key: "negativeKeywords", negative: true });
    expect(negativeKeywordsField()).not.toHaveProperty("required");
  });
  it("snippet values appear only with a header", () => {
    const level: LevelSpec = { label: "Ad", sections: rsaSections({ platformName: "G" }) };
    const ctx = emptyContext();
    expect(shown(level, "snippetValues", ctx)).toBe(false);
    expect(shown(level, "snippetValues", { ...ctx, ad: { snippetHeader: "Brands" } })).toBe(true);
  });
});

// ───────── Microsoft ─────────

describe("Microsoft", () => {
  it("Performance Max has no ad level; Audience uses responsive ads; Search uses RSAs", () => {
    expect(spec("MICROSOFT").ad({ campaignType: "PERFORMANCE_MAX" })).toBeNull();
    expect(spec("MICROSOFT").ad({ campaignType: "AUDIENCE" })!.sections[0]!.title).toBe("Responsive ad");
    expect(spec("MICROSOFT").ad({ campaignType: "SEARCH" })!.sections[0]!.description).toMatch(/^Microsoft mixes/);
  });
  it("defaults the bid strategy per campaign type", () => {
    expect(make("MICROSOFT", { campaignType: "SEARCH" }).campaign.bidStrategy).toBe("MaxConversions");
    expect(make("MICROSOFT", { campaignType: "AUDIENCE" }).campaign.bidStrategy).toBe("MaxConversions");
  });
  it("audience campaigns hide languages and show dates; search needs a language", () => {
    const aud = make("MICROSOFT", { campaignType: "AUDIENCE" });
    expect(shown(spec("MICROSOFT").campaign, "languages", ctxFor(aud))).toBe(false);
    expect(shown(spec("MICROSOFT").campaign, "startDate", ctxFor(aud))).toBe(true);
    const s = make("MICROSOFT", { campaignType: "SEARCH" });
    s.campaign.languages = [];
    expect(at(run(s), "campaign", "languages")).toEqual(["Choose at least one ad languages."]);
  });
  it("shows the default bid only for (enhanced) manual CPC", () => {
    const d = make("MICROSOFT", { campaignType: "SEARCH" });
    expect(shown(spec("MICROSOFT").adGroup, "defaultBid", ctxFor(d))).toBe(false);
    d.campaign.bidStrategy = "EnhancedCpc";
    expect(shown(spec("MICROSOFT").adGroup, "defaultBid", ctxFor(d))).toBe(true);
  });
  it("previews", () => {
    expect(spec("MICROSOFT").previews({ ...emptyContext(), setup: { campaignType: "PERFORMANCE_MAX" } })).toEqual(["bing_search", "bing_audience"]);
    expect(spec("MICROSOFT").previews({ ...emptyContext(), setup: { campaignType: "AUDIENCE" } })).toEqual(["bing_audience"]);
  });
});

// ───────── Disabled setup options ─────────

describe("disabled start-screen options", () => {
  const disabled = (Object.keys(BUILDER_SPECS) as Platform[]).flatMap((platform) =>
    spec(platform).setup.flatMap((choice) => {
      const opts = typeof choice.options === "function" ? choice.options({ goal: "SALES" }) : choice.options;
      return opts.filter((o) => o.disabled).map((o) => ({ platform, key: choice.key, value: o.value, reason: o.disabledReason }));
    }),
  );
  it("all carry a reason", () => {
    expect(disabled.map((d) => `${d.platform}.${d.value}`).sort()).toEqual(
      ["GOOGLE.VIDEO", "MICROSOFT.SHOPPING", "PINTEREST.CATALOG_SALES", "TRADEDESK.AUDIO", "TRADEDESK.CTV", "X.APP_INSTALLS"].sort(),
    );
    for (const d of disabled) expect(d.reason).toBeTruthy();
  });
  // A draft saved with a disabled option (e.g. via the API or AI fill) must not pass validation and reach the live launch path.
  it.each(disabled.filter((d) => !(d.platform === "GOOGLE" && d.value === "VIDEO")))(
    "a draft using disabled option $platform $key=$value gets a setup issue",
    ({ platform, key, value }) => {
      const base = platform === "GOOGLE" ? { goal: "SALES" } : {};
      const d = make(platform, { ...base, [key]: value });
      const blocked = at(run(d), "setup").length > 0 || (spec(platform).apiCreatable?.(d.setup) ?? true) !== true;
      expect(blocked).toBe(true);
    },
  );
});

// ───────── LinkedIn ─────────

describe("LinkedIn", () => {
  it("offers formats by objective", () => {
    expect(values(linkedinFormats("VIDEO_VIEW"))).toEqual(["VIDEO"]);
    expect(values(linkedinFormats("JOB_APPLICANT"))).toEqual(["SINGLE_IMAGE"]);
    expect(values(linkedinFormats("ENGAGEMENT"))).toEqual(["SINGLE_IMAGE", "VIDEO", "CAROUSEL"]);
    expect(values(linkedinFormats("LEAD_GENERATION"))).toEqual(["SINGLE_IMAGE", "VIDEO", "CAROUSEL", "MESSAGE"]);
    expect(values(linkedinFormats("BRAND_AWARENESS"))).not.toContain("MESSAGE");
    expect(linkedinFormats("nope")).toEqual([]);
    expect(values(setupOptions(spec("LINKEDIN").setup[1]!, { objective: "VIDEO_VIEW" }))).toEqual(["VIDEO"]);
  });
  it("rejects a format the objective doesn't allow", () => {
    const d = make("LINKEDIN", { objective: "VIDEO_VIEW", format: "SINGLE_IMAGE" });
    expect(at(run(d), "setup", "format")).toEqual(["Choose ad format."]);
  });
  it("message ads can't be created through the API; other formats can", () => {
    expect(spec("LINKEDIN").apiCreatable!({ objective: "WEBSITE_VISIT", format: "MESSAGE" })).toMatch(/sender's approval/);
    expect(spec("LINKEDIN").apiCreatable!({ objective: "WEBSITE_VISIT", format: "SINGLE_IMAGE" })).toBe(true);
  });
  it("defaults the optimization goal to the objective's first goal", () => {
    expect(g0(make("LINKEDIN", { objective: "LEAD_GENERATION", format: "SINGLE_IMAGE" })).values.optimizationGoal).toBe("MAX_LEAD");
    expect(g0(make("LINKEDIN", { objective: "BRAND_AWARENESS", format: "VIDEO" })).values.optimizationGoal).toBe("MAX_REACH");
  });
  it("lead gen needs a form instead of a URL", () => {
    const d = make("LINKEDIN", { objective: "LEAD_GENERATION", format: "SINGLE_IMAGE" });
    expect(at(run(d), "ad", "leadFormId")).toEqual(["Lead gen form is required."]);
    expect(at(run(d), "ad", "url")).toEqual([]);
    expect(shown(spec("LINKEDIN").adGroup, "audienceNetwork", ctxFor(d))).toBe(false);
  });
  it("message ads need a sender, subject, body and button, not a company page", () => {
    const d = make("LINKEDIN", { objective: "WEBSITE_VISIT", format: "MESSAGE" });
    const ad = run(d);
    expect(at(ad, "ad", "organizationId")).toEqual([]);
    for (const f of ["sender", "subject", "messageBody", "buttonLabel", "url"]) expect(at(ad, "ad", f)).toHaveLength(1);
    expect(at(ad, "ad", "introText")).toEqual([]);
    expect(spec("LINKEDIN").previews(ctxFor(d))).toEqual(["linkedin_message"]);
  });
  it("text ads limit headline to 25 and description to 75", () => {
    const d = make("LINKEDIN", { objective: "WEBSITE_VISIT", format: "TEXT_AD" });
    Object.assign(a0(d).values, { textHeadline: "x".repeat(26), textDescription: "y".repeat(76) });
    expect(at(run(d), "ad", "textHeadline")).toEqual(["Headline is over 25 characters."]);
    expect(at(run(d), "ad", "textDescription")).toEqual(["Description is over 75 characters."]);
    expect(spec("LINKEDIN").previews(ctxFor(d))).toEqual(["linkedin_text"]);
  });
  it("website conversions need conversions; carousel has per-card URLs", () => {
    const d = make("LINKEDIN", { objective: "WEBSITE_CONVERSION", format: "CAROUSEL" });
    expect(at(run(d), "adGroup", "conversions")).toEqual(["Conversions is required."]);
    expect(shown(adLevel(d), "url", ctxFor(d))).toBe(false);
    expect(at(run(d), "ad", "cards")).toEqual(["Add at least 2 cards."]);
  });
  it("a lifetime budget needs an end date; bids need an amount", () => {
    const d = make("LINKEDIN", { objective: "WEBSITE_VISIT", format: "SINGLE_IMAGE" });
    g0(d).values.budgetType = "LIFETIME";
    g0(d).values.bidStrategy = "MANUAL";
    expect(at(run(d), "adGroup", "endDate")).toEqual(["End date is required."]);
    expect(at(run(d), "adGroup", "bidAmount")).toEqual(["Bid or cost cap is required."]);
  });
  it("group budget is required only when turned on", () => {
    const d = make("LINKEDIN", { objective: "WEBSITE_VISIT", format: "SINGLE_IMAGE" });
    expect(at(run(d), "campaign", "groupBudgetAmount")).toEqual([]);
    d.campaign.groupBudget = true;
    d.campaign.groupBudgetAmount = 50;
    expect(at(run(d), "campaign", "groupBudgetAmount")).toEqual(["Total group budget must be at least 100."]);
  });
});

// ───────── Snapchat ─────────

describe("Snapchat", () => {
  it("story ads need 3–20 vertical snaps, a tile and a tile headline", () => {
    const d = make("SNAPCHAT", { objective: "TRAFFIC" });
    a0(d).values.format = "STORY";
    a0(d).values.storySnaps = ["v1", "v2"];
    const issues = run(d, MEDIA);
    expect(at(issues, "ad", "storySnaps")).toEqual(["Story Snaps: add at least 3 files."]);
    expect(at(issues, "ad", "tileImage")).toEqual(["Story tile image: add an image."]);
    expect(at(issues, "ad", "media")).toEqual([]);
    a0(d).values.storySnaps = ["v1", "v2", "sq"];
    expect(at(run(d, MEDIA), "ad", "storySnaps")).toEqual(["Story Snaps must be 9:16."]);
  });
  it("a single Snap must be 9:16", () => {
    const d = make("SNAPCHAT", { objective: "TRAFFIC" });
    a0(d).values.media = ["sq"];
    expect(at(run(d, MEDIA), "ad", "media")).toEqual(["Top Snap must be 9:16."]);
    a0(d).values.media = ["vid"];
    expect(at(run(d, MEDIA), "ad", "media")).toEqual([]);
  });
  it("lifetime ad squad budgets need a campaign end date", () => {
    const d = make("SNAPCHAT", { objective: "TRAFFIC" });
    g0(d).values.budgetType = "LIFETIME";
    expect(at(run(d), "campaign", "endDate")).toEqual(["Lifetime budgets need an end date on the campaign."]);
    d.campaign.endDate = "2026-12-31";
    expect(at(run(d), "campaign", "endDate")).toEqual([]);
  });
  it("sales and lead campaigns must target 18+", () => {
    const d = make("SNAPCHAT", { objective: "SALES" });
    g0(d).values.age = { min: 13, max: 50 };
    expect(at(run(d), "adGroup", "age")).toEqual(["Sales and lead campaigns must target 18 and over."]);
    const aw = make("SNAPCHAT", { objective: "AWARENESS_AND_ENGAGEMENT" });
    g0(aw).values.age = { min: 13, max: 50 };
    expect(at(run(aw), "adGroup", "age")).toEqual([]);
  });
  it("attachments and CTAs follow the objective", () => {
    const app = make("SNAPCHAT", { objective: "APP_PROMOTION" });
    expect(a0(app).values.attachment).toBe("APP_INSTALL");
    expect(a0(app).values.cta).toBe("INSTALL_NOW");
    expect(at(run(app), "ad", "appId")).toEqual(["App is required."]);
    const lead = make("SNAPCHAT", { objective: "LEADS" });
    expect(a0(lead).values.attachment).toBe("LEAD_GENERATION");
    expect(at(run(lead), "ad", "leadFormId")).toEqual(["Instant form is required."]);
    const traffic = make("SNAPCHAT", { objective: "TRAFFIC" });
    expect(at(run(traffic), "ad", "url")).toEqual(["Website URL is required."]);
    a0(traffic).values.attachment = "NONE";
    expect(shown(adLevel(traffic), "cta", ctxFor(traffic))).toBe(false);
    expect(at(run(traffic), "ad", "url")).toEqual([]);
  });
  it("pixel goals need a Snap Pixel", () => {
    const d = make("SNAPCHAT", { objective: "SALES" });
    expect(g0(d).values.optimizationGoal).toBe("PIXEL_PURCHASE");
    expect(at(run(d), "adGroup", "pixelId")).toEqual(["Snap Pixel is required."]);
  });
});

// ───────── Pinterest ─────────

describe("Pinterest", () => {
  it("video completion allows only video pins and automatic bids", () => {
    const d = make("PINTEREST", { objective: "VIDEO_COMPLETION" });
    expect(a0(d).values.format).toBe("VIDEO");
    const ctx = ctxFor(d);
    expect(values(resolveOptions(visibleField(adLevel(d), "format", ctx) as ChoiceField, ctx))).toEqual(["VIDEO"]);
    expect(values(resolveOptions(visibleField(spec("PINTEREST").adGroup, "bidStrategy", ctx) as ChoiceField, ctx))).toEqual(["AUTOMATIC_BID"]);
  });
  it("conversions need a Pinterest tag and default the CTA to Shop now", () => {
    const d = make("PINTEREST", { objective: "WEB_CONVERSION" });
    expect(at(run(d), "adGroup", "conversionTagId")).toEqual(["Pinterest tag is required."]);
    expect(a0(d).values.cta).toBe("SHOP_NOW");
    expect(a0(make("PINTEREST", { objective: "AWARENESS" })).values.cta).toBe("LEARN_MORE");
  });
  it("campaign budget optimization hides the ad group budget", () => {
    const d = make("PINTEREST", { objective: "CONSIDERATION" });
    expect(at(run(d), "adGroup", "budget")).toEqual(["Budget is required."]);
    d.campaign.cbo = true;
    expect(at(run(d), "adGroup", "budget")).toEqual([]);
    expect(at(run(d), "campaign", "budget")).toEqual(["Budget is required."]);
  });
  it("carousel pins need 2–5 images", () => {
    const d = make("PINTEREST", { objective: "CONSIDERATION" });
    a0(d).values.format = "CAROUSEL";
    a0(d).values.images = ["sq"];
    expect(at(run(d, MEDIA), "ad", "images")).toEqual(["Carousel images: add at least 2 files."]);
  });
});

// ───────── Amazon ─────────

describe("Amazon", () => {
  it("Sponsored Products needs an ASIN or a SKU", () => {
    const d = make("AMAZON", { adProduct: "SPONSORED_PRODUCTS" });
    expect(at(run(d), "ad", "asin")).toEqual(["ASIN is required."]);
    a0(d).values.sku = "LEHENGA-RED-M";
    expect(at(run(d), "ad", "asin")).toEqual([]);
    a0(d).values.sku = "   ";
    expect(at(run(d), "ad", "asin")).toEqual(["ASIN is required."]);
    a0(d).values.sku = "";
    a0(d).values.asin = "B0XXXXXXXX";
    expect(at(run(d), "ad", "asin")).toEqual([]);
  });
  it("Sponsored Display always needs an ASIN; SKU is hidden", () => {
    const d = make("AMAZON", { adProduct: "SPONSORED_DISPLAY" });
    a0(d).values.sku = "X";
    expect(at(run(d), "ad", "asin")).toEqual(["ASIN is required."]);
    expect(visibleDraft(spec("AMAZON"), d).adGroups[0]!.ads[0]!.values).not.toHaveProperty("sku");
    expect(at(run(d), "ad", "headline")).toEqual([]);
  });
  it("Sponsored Brands needs a brand name, headline and up to 3 ASINs", () => {
    const d = make("AMAZON", { adProduct: "SPONSORED_BRANDS" });
    const issues = run(d);
    expect(at(issues, "ad", "brandName")).toEqual(["Brand name is required."]);
    expect(at(issues, "ad", "headline")).toEqual(["Headline is required."]);
    expect(at(issues, "ad", "asins")).toEqual(["Product ASINs is required."]);
    a0(d).values.brandName = "x".repeat(31);
    a0(d).values.asins = "B01, B02\nB03 B04";
    expect(at(run(d), "ad", "brandName")).toEqual(["Brand name is over 30 characters."]);
    expect(at(run(d), "ad", "asins")).toEqual(["Use at most 3 ASINs."]);
    a0(d).values.asins = "B01,B02,B03";
    expect(at(run(d), "ad", "asins")).toEqual([]);
  });
  it("Brands and Display use one ad group with one ad", () => {
    for (const adProduct of ["SPONSORED_BRANDS", "SPONSORED_DISPLAY"]) {
      const d = make("AMAZON", { adProduct });
      d.adGroups.push(newAdGroup(spec("AMAZON"), d));
      g0(d).ads.push({ ...a0(d), key: "second" });
      const issues = run(d);
      expect(at(issues, "campaign").some((m) => /campaigns use one ad group/.test(m))).toBe(true);
      expect(at(issues, "adGroup").some((m) => /campaigns use one ad per ad group/.test(m))).toBe(true);
    }
    const sp = make("AMAZON", { adProduct: "SPONSORED_PRODUCTS" });
    sp.adGroups.push(newAdGroup(spec("AMAZON"), sp));
    expect(at(run(sp), "campaign").some((m) => /one ad group/.test(m))).toBe(false);
  });
  it("keywords only for manual Sponsored Products; minimum bid 0.02", () => {
    const d = make("AMAZON", { adProduct: "SPONSORED_PRODUCTS" });
    expect(shown(spec("AMAZON").adGroup, "keywords", ctxFor(d))).toBe(true);
    d.campaign.targetingType = "AUTO";
    expect(shown(spec("AMAZON").adGroup, "keywords", ctxFor(d))).toBe(false);
    g0(d).values.defaultBid = 0.01;
    expect(at(run(d), "adGroup", "defaultBid")).toEqual(["Default bid must be at least 0.02."]);
  });
  it("previews", () => {
    expect(spec("AMAZON").previews({ ...emptyContext(), setup: { adProduct: "SPONSORED_DISPLAY" } })).toEqual(["amazon_shopping", "display_banner"]);
    expect(spec("AMAZON").previews({ ...emptyContext(), setup: { adProduct: "SPONSORED_PRODUCTS" } })).toEqual(["amazon_shopping"]);
  });
});

// ───────── X ─────────

describe("X", () => {
  const valid = () => {
    const d = make("X", { objective: "WEBSITE_CLICKS" });
    Object.assign(d.campaign, { fundingInstrumentId: "fi-1", budget: 500 });
    Object.assign(a0(d).values, { text: "The festive edit is live." });
    return d;
  };
  it("accepts a complete draft", () => {
    expect(run(valid())).toEqual([]);
  });
  it("text plus a URL must fit 280 (the link costs 24)", () => {
    const d = valid();
    a0(d).values.url = "https://yourstore.com/sale";
    a0(d).values.text = "x".repeat(256);
    expect(run(d)).toEqual([]);
    a0(d).values.text = "x".repeat(257);
    expect(at(run(d), "ad", "text")).toEqual(["Post text and link need 281 of 280 characters. Keep the text to 256 with a URL."]);
  });
  it("without a URL the 280 field limit applies", () => {
    const d = valid();
    a0(d).values.text = "x".repeat(280);
    expect(run(d)).toEqual([]);
    a0(d).values.text = "x".repeat(281);
    expect(at(run(d), "ad", "text")).toEqual(["Post text is over 280 characters."]);
  });
  it("the ad group goal must fit the objective", () => {
    const d = valid();
    expect(g0(d).values.goal).toBe("LINK_CLICKS");
    g0(d).values.goal = "FOLLOWERS";
    expect(at(run(d), "adGroup", "goal")).toEqual(["Choose a goal that fits the campaign objective."]);
  });
  it("video views campaigns need a video on every ad", () => {
    const d = make("X", { objective: "VIDEO_VIEWS" });
    expect(at(run(d), "ad", "video")).toEqual(["Add a video: a video views campaign promotes video posts."]);
  });
  it("App installs is disabled; the app id field is draft-only; no apiCreatable is declared", () => {
    const opt = (spec("X").setup[0]!.options as { value: string; disabled?: boolean }[]).find((o) => o.value === "APP_INSTALLS")!;
    expect(opt.disabled).toBe(true);
    const d = make("X", { objective: "APP_INSTALLS" });
    expect(shown(adLevel(d), "appId", ctxFor(d))).toBe(true);
    expect(shown(adLevel(valid()), "appId", ctxFor(valid()))).toBe(false);
    expect(spec("X").apiCreatable).toBeUndefined();
  });
  it("offers a daily budget only (no schedule is sent)", () => {
    expect(levelFields(spec("X").campaign).some((f) => f.key === "budgetType")).toBe(false);
  });
});

// ───────── Apple ─────────

describe("Apple", () => {
  const valid = () => {
    const d = make("APPLE", { channel: "SEARCH" });
    Object.assign(d.campaign, { adamId: "1234567890", budget: 100 });
    g0(d).values.cpt = 1.5;
    return d;
  };
  it("accepts a complete draft", () => {
    expect(run(valid())).toEqual([]);
  });
  it("adam ID must be digits only; a non-string value counts as empty for the text field", () => {
    const d = valid();
    d.campaign.adamId = "id1234567890".slice(0, 12);
    expect(at(run(d), "campaign", "adamId")).toEqual(["App Store adam ID must be digits only, e.g. 1234567890."]);
    d.campaign.adamId = 1234567890;
    expect(at(run(d), "campaign", "adamId")).toEqual(["App Store adam ID is required."]);
    d.campaign.adamId = "  987654321 ";
    expect(at(run(d), "campaign", "adamId")).toEqual([]);
    d.campaign.adamId = "1234567890123";
    expect(at(run(d), "campaign", "adamId")).toEqual(["App Store adam ID is over 12 characters."]);
  });
  it("a custom product page needs its id", () => {
    const d = valid();
    a0(d).values.creativeType = "CUSTOM_PRODUCT_PAGE";
    expect(at(run(d), "ad", "productPageId")).toEqual(["Product page id is required."]);
    a0(d).values.productPageId = "45812c9b-c296-43d3-c6a0-c5a02f74bf6e";
    expect(run(d)).toEqual([]);
    a0(d).values.creativeType = "SEARCH_RESULTS";
    expect(visibleDraft(spec("APPLE"), d).adGroups[0]!.ads[0]!.values).not.toHaveProperty("productPageId");
  });
  it("keywords allow broad and exact only", () => {
    const kw = levelFields(spec("APPLE").adGroup).find((f) => f.key === "keywords")!;
    expect(kw).toMatchObject({ matchTypes: ["BROAD", "EXACT"] });
  });
});

// ───────── Spotify ─────────

describe("Spotify", () => {
  it("each format needs its own asset URLs, and switching drops the others", () => {
    const d = make("SPOTIFY", { objective: "REACH" });
    expect(at(run(d), "ad").sort()).toEqual(["Audio file URL is required.", "Companion image URL is required."]);
    a0(d).values.audioUrl = "https://cdn.example.com/a.mp3";
    a0(d).values.format = "VIDEO";
    expect(at(run(d), "ad").sort()).toEqual(["Thumbnail URL is required.", "Video file URL is required."]);
    a0(d).values.format = "DISPLAY";
    expect(at(run(d), "ad")).toEqual(["Image URL is required."]);
    expect(visibleDraft(spec("SPOTIFY"), d).adGroups[0]!.ads[0]!.values).not.toHaveProperty("audioUrl");
    expect(spec("SPOTIFY").previews(ctxFor(d))).toEqual(["display_banner"]);
    a0(d).values.format = "AUDIO";
    expect(spec("SPOTIFY").previews(ctxFor(d))).toEqual(["spotify_audio"]);
  });
});

// ───────── Criteo ─────────

describe("Criteo", () => {
  const valid = () => {
    const d = make("CRITEO", { goal: "RETARGETING" });
    d.campaign.budget = 100;
    Object.assign(a0(d).values, { url: "https://shop.example.com", imageUrl: "https://cdn.example.com/b.png" });
    return d;
  };
  it("accepts a complete draft", () => {
    expect(run(valid())).toEqual([]);
  });
  it("uses a single ad set per campaign", () => {
    expect(spec("CRITEO").maxAdGroups).toBe(1);
    const d = valid();
    d.adGroups.push(structuredClone(g0(d)));
    expect(at(run(d), "campaign")).toEqual(["Use at most 1 ad sets."]);
  });
  it("native ads need a headline; display ads hide it", () => {
    const d = valid();
    a0(d).values.headline = "stale";
    expect(visibleDraft(spec("CRITEO"), d).adGroups[0]!.ads[0]!.values).not.toHaveProperty("headline");
    a0(d).values.format = "NATIVE";
    a0(d).values.headline = "";
    expect(at(run(d), "ad", "headline")).toEqual(["Headline is required."]);
    expect(spec("CRITEO").previews(ctxFor(d))).toEqual(["native_feed"]);
  });
});

// ───────── Taboola ─────────

describe("Taboola", () => {
  const valid = () => {
    const d = make("TABOOLA", { objective: "TRAFFIC" });
    Object.assign(d.campaign, { brand: "Ashniva", budget: 100 });
    Object.assign(a0(d).values, { title: "The festive edit", url: "https://shop.example.com", imageUrl: "https://cdn.example.com/t.jpg" });
    return d;
  };
  it("accepts a complete draft", () => {
    expect(run(valid())).toEqual([]);
  });
  it("needs a thumbnail URL unless one is uploaded", () => {
    const d = valid();
    a0(d).values.imageUrl = "";
    expect(at(run(d), "ad", "imageUrl")).toEqual(["Thumbnail URL is required."]);
    a0(d).values.image = ["sq"];
    expect(at(run(d, MEDIA), "ad", "imageUrl")).toEqual([]);
  });
  it("a lifetime budget needs an end date", () => {
    const d = valid();
    d.campaign.budgetType = "LIFETIME";
    expect(at(run(d), "campaign", "endDate")).toEqual(["End date is required."]);
    d.campaign.endDate = "2026-12-31";
    expect(run(d)).toEqual([]);
  });
});

// ───────── Outbrain ─────────

describe("Outbrain", () => {
  it("labels the bid by bid type, under the same `cpc` key", () => {
    const d = make("OUTBRAIN", { objective: "Traffic" });
    expect(d.campaign.bidType).toBe("CPC");
    expect(at(run(d), "campaign", "cpc")).toEqual(["CPC bid is required."]);
    d.campaign.bidType = "CPM";
    expect(at(run(d), "campaign", "cpc")).toEqual(["CPM bid is required."]);
    d.campaign.cpc = 2;
    expect(at(run(d), "campaign", "cpc")).toEqual([]);
    expect(visibleDraft(spec("OUTBRAIN"), d).campaign.cpc).toBe(2);
    d.campaign.cpc = 0;
    expect(at(run(d), "campaign", "cpc")).toEqual(["CPM bid must be at least 0.01."]);
  });
  it("accepts a complete draft", () => {
    const d = make("OUTBRAIN", { objective: "Awareness" });
    Object.assign(d.campaign, { cpc: 1, budget: 100 });
    Object.assign(a0(d).values, { title: "5 looks", url: "https://shop.example.com", imageUrl: "https://cdn.example.com/i.jpg" });
    expect(run(d)).toEqual([]);
  });
});

// ───────── The Trade Desk ─────────

describe("The Trade Desk", () => {
  it("native needs headline, description and image", () => {
    const d = make("TRADEDESK", { format: "NATIVE" });
    a0(d).values.tag = "<script></script>";
    const issues = run(d);
    expect(at(issues, "ad", "headline")).toEqual(["Headline is required."]);
    expect(at(issues, "ad", "description")).toEqual(["Description is required."]);
    expect(at(issues, "ad", "imageUrl")).toEqual(["Hosted image URL is required."]);
    expect(spec("TRADEDESK").previews(ctxFor(d))).toEqual(["native_feed"]);
  });
  it("video needs a VAST tag and has no image", () => {
    const d = make("TRADEDESK", { format: "VIDEO" });
    expect(at(run(d), "ad", "tag")).toEqual(["VAST tag or URL is required."]);
    expect(shown(adLevel(d), "imageUrl", ctxFor(d))).toBe(false);
    expect(shown(adLevel(d), "headline", ctxFor(d))).toBe(false);
    expect(spec("TRADEDESK").previews(ctxFor(d))).toEqual(["video_instream"]);
  });
  it("display needs a hosted image or a third-party tag", () => {
    const d = make("TRADEDESK", { format: "DISPLAY" });
    expect(at(run(d), "ad", "imageUrl")).toEqual(["Hosted image URL is required."]);
    a0(d).values.tag = "<ins></ins>";
    expect(at(run(d), "ad", "imageUrl")).toEqual([]);
    expect(at(run(d), "ad", "tag")).toEqual([]);
  });
});

// ───────── Yahoo, Shopify ─────────

describe("Yahoo", () => {
  it("image for display/native, video URL for video", () => {
    const disp = make("YAHOO", { format: "DISPLAY" });
    expect(a0(disp).values.size).toBe("300x250");
    expect(at(run(disp), "ad", "imageUrl")).toEqual(["Image URL is required."]);
    const vid = make("YAHOO", { format: "VIDEO" });
    expect(at(run(vid), "ad", "videoUrl")).toEqual(["Video URL is required."]);
    expect(at(run(vid), "ad", "imageUrl")).toEqual([]);
    expect(spec("YAHOO").previews(ctxFor(vid))).toEqual(["video_instream"]);
  });
});

describe("Shopify", () => {
  it("records one tracking group with one landing page and needs UTM tags", () => {
    const d = make("SHOPIFY", { channel: "social" });
    expect([spec("SHOPIFY").maxAdGroups, spec("SHOPIFY").maxAds]).toEqual([1, 1]);
    const issues = run(d);
    expect(at(issues, "campaign", "utmSource")).toEqual(["UTM source is required."]);
    expect(at(issues, "campaign", "utmMedium")).toEqual(["UTM medium is required."]);
    Object.assign(d.campaign, { utmSource: "facebook", utmMedium: "cpc", budget: 10 });
    a0(d).values.url = "https://store.example.com";
    expect(run(d)).toEqual([]);
    expect(levelFields(spec("SHOPIFY").campaign).find((f) => f.key === "launchStatus")).toMatchObject({
      options: [{ label: "Record as ended" }, { label: "Record as running" }],
    });
  });
});

// ───────── Hidden platforms ─────────

describe("Naukri", () => {
  const valid = () => {
    const d = make("NAUKRI", { posting: "HOT" });
    Object.assign(d.campaign, { description: "Build APIs", minExperience: 2, maxExperience: 5, minSalary: 10, maxSalary: 20, vacancies: 1 });
    Object.assign(g0(d).values, { city: "Bengaluru", industry: "IT", functionalArea: "Engineering" });
    a0(d).values.contact = "careers@example.com";
    return d;
  };
  it("accepts a complete draft", () => {
    expect(run(valid())).toEqual([]);
    expect(valid().campaign.currency).toBe("INR");
  });
  it("minimum must not exceed maximum (equal is fine)", () => {
    const d = valid();
    Object.assign(d.campaign, { minExperience: 6, maxExperience: 5, minSalary: "30", maxSalary: "20" });
    expect(at(run(d), "campaign", "maxExperience")).toEqual(["Maximum experience must be at least the minimum."]);
    expect(at(run(d), "campaign", "maxSalary")).toEqual(["Maximum salary must be at least the minimum."]);
    Object.assign(d.campaign, { minExperience: 5, minSalary: 20 });
    expect(run(d)).toEqual([]);
  });
  it("checks the contact email", () => {
    const d = valid();
    a0(d).values.contact = "not-an-email";
    expect(at(run(d), "ad", "contact")).toEqual(["Enter a valid contact email."]);
  });
  it("classified posts limit the description to 254 characters", () => {
    const d = valid();
    d.setup = { posting: "CLASSIFIED" };
    d.campaign.description = "x".repeat(255);
    expect(at(run(d), "campaign", "description")).toEqual(["Description is over 254 characters."]);
    d.setup = { posting: "HOT" };
    expect(at(run(d), "campaign", "description")).toEqual([]);
  });
});

describe("Zepto / Swiggy", () => {
  it("Zepto needs a keyword or a category depending on targeting", () => {
    const kw = make("ZEPTO", { targeting: "KEYWORD" });
    expect(at(run(kw), "adGroup", "keyword")).toEqual(["Keyword is required."]);
    expect(at(run(kw), "adGroup", "categoryName")).toEqual([]);
    const cat = make("ZEPTO", { targeting: "CATEGORY" });
    expect(at(run(cat), "adGroup", "categoryName")).toEqual(["Category is required."]);
  });
  it("Swiggy days are 1–90", () => {
    const d = make("SWIGGY", { surface: "FOOD" });
    d.campaign.days = 91;
    expect(at(run(d), "campaign", "days")).toEqual(["Days must be at most 90."]);
  });
});

describe("TikTok (hidden)", () => {
  it("still builds drafts for every objective", () => {
    for (const o of spec("TIKTOK").setup[0]!.options as Option[]) {
      const d = make("TIKTOK", { objective: o.value });
      expect(spec("TIKTOK").previews(ctxFor(d))).toEqual(["tiktok_feed"]);
      expect(isRequired(levelFields(spec("TIKTOK").campaign)[0]!, ctxFor(d))).toBe(true);
    }
  });
});
