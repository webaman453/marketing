import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsConnector } from "../../src/google";
import { ConnectorError } from "../../src/errors";
import { hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { account, auth } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft } from "../msw/drafts";
import { ADS, googleAdsError, googleConfig, googleMutate, googleSearch, languageRows } from "../msw/handlers/google";

useMswServer();

const CID = "1112223333";
const acct = account(CID, { currency: "INR", timezone: "Asia/Kolkata", meta: { loginCustomerId: "100" } });
const g = () => new GoogleAdsConnector(googleConfig);
const opKey = (op: Record<string, unknown>) => Object.keys(op)[0]!;
const opBody = (op: Record<string, any>) => Object.values(op)[0].create;

// dateOf/isoDate work in the process timezone; pin it so the suite runs the same everywhere.
const originalTz = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "UTC";
});
afterEach(() => {
  process.env.TZ = originalTz;
  vi.restoreAllMocks();
});

const searchDraft = (over: { campaign?: Record<string, unknown>; ad?: Record<string, unknown>; adGroup?: Record<string, unknown> } = {}) =>
  makeDraft(
    "GOOGLE",
    { goal: "SALES", campaignType: "SEARCH" },
    {
      campaign: { name: "Diwali Sarees", targetCpa: null, budget: 50, languages: ["en", "hi"], locations: [{ id: "IN", name: "India", type: "country" }, { id: "US", name: "United States", type: "country", exclude: true }], ...over.campaign },
      adGroup: { name: "Silk sarees", keywords: [{ text: "silk saree", matchType: "EXACT" }, { text: "banarasi saree", matchType: "PHRASE" }], negativeKeywords: [{ text: "cheap", matchType: "BROAD" }], ...over.adGroup },
      ad: {
        name: "RSA 1",
        finalUrl: "https://shop.example.com/sarees",
        path1: "sarees",
        headlines: [{ text: "Silk Sarees Online", pin: "H1" }, { text: "Free Shipping", pin: null }, { text: "Festive Sale", pin: null }],
        descriptions: [{ text: "Handwoven silk sarees from Varanasi.", pin: null }, { text: "Shop the festive edit today.", pin: "D2" }],
        sitelinks: [{ text: "New arrivals", url: "https://shop.example.com/new", description1: "Fresh weaves", description2: "Every week" }, { text: "", url: "https://x" }],
        callouts: ["Cash on delivery"],
        phone: "+91 98765-43210",
        ...over.ad,
      },
    },
  );

const languages = { language_constant: languageRows({ en: "1000", hi: "1023" }) };

describe("Google createCampaign — Search", () => {
  it("sends one atomic googleAds:mutate with budget, paused campaign, criteria, ad group, keywords, assets and RSA", async () => {
    server.use(googleSearch(languages), googleMutate());
    const draft = searchDraft();
    expect(draft.campaign.launchStatus).toBe("PAUSED");
    const made = await g().createCampaign(auth("ya29.tok"), acct, draft, new Map());

    const langQuery = await onlyHit({ path: "googleAds:search" });
    expect(langQuery.json.query).toContain("FROM language_constant WHERE language_constant.code IN ('en', 'hi')");

    const m = await onlyHit({ path: "googleAds:mutate" });
    expect(m.url.pathname).toBe(`/v21/customers/${CID}/googleAds:mutate`);
    expect(m.headers.get("login-customer-id")).toBe("100");
    expect(m.headers.get("authorization")).toBe("Bearer ya29.tok");
    const ops = m.json.mutateOperations as Record<string, any>[];

    const budget = ops[0]!.campaignBudgetOperation.create;
    expect(budget).toMatchObject({ resourceName: `customers/${CID}/campaignBudgets/-1`, deliveryMethod: "STANDARD", explicitlyShared: false, amountMicros: "50000000" });
    expect(budget.name).toMatch(/^Diwali Sarees · \d+$/);
    expect(budget.totalAmountMicros).toBeUndefined();

    const campaign = ops[1]!.campaignOperation.create;
    expect(campaign).toEqual({
      resourceName: `customers/${CID}/campaigns/-2`,
      name: "Diwali Sarees",
      status: "PAUSED",
      advertisingChannelType: "SEARCH",
      campaignBudget: `customers/${CID}/campaignBudgets/-1`,
      containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
      geoTargetTypeSetting: { positiveGeoTargetType: "PRESENCE_OR_INTEREST" },
      // makeDraft fills optional money fields (targetCpa) with 25.
      maximizeConversions: { targetCpaMicros: "25000000" },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    });

    const criteria = ops.filter((o) => opKey(o) === "campaignCriterionOperation").map(opBody);
    expect(criteria).toEqual([
      { campaign: campaign.resourceName, location: { geoTargetConstant: "geoTargetConstants/2356" } },
      { campaign: campaign.resourceName, negative: true, location: { geoTargetConstant: "geoTargetConstants/2840" } },
      { campaign: campaign.resourceName, language: { languageConstant: "languageConstants/1000" } },
      { campaign: campaign.resourceName, language: { languageConstant: "languageConstants/1023" } },
    ]);

    const group = ops.find((o) => opKey(o) === "adGroupOperation")!.adGroupOperation.create;
    expect(group).toMatchObject({ campaign: campaign.resourceName, name: "Silk sarees", status: "ENABLED", type: "SEARCH_STANDARD" });
    expect(group.cpcBidMicros).toBeUndefined();

    const kw = ops.filter((o) => opKey(o) === "adGroupCriterionOperation").map(opBody);
    expect(kw).toEqual([
      { adGroup: group.resourceName, status: "ENABLED", keyword: { text: "silk saree", matchType: "EXACT" } },
      { adGroup: group.resourceName, status: "ENABLED", keyword: { text: "banarasi saree", matchType: "PHRASE" } },
      { adGroup: group.resourceName, negative: true, keyword: { text: "cheap", matchType: "BROAD" } },
    ]);

    const assets = ops.filter((o) => opKey(o) === "assetOperation").map(opBody);
    expect(assets).toHaveLength(3); // the sitelink without text is skipped
    expect(assets[0]).toMatchObject({ finalUrls: ["https://shop.example.com/new"], sitelinkAsset: { linkText: "New arrivals", description1: "Fresh weaves", description2: "Every week" } });
    expect(assets[1]).toMatchObject({ calloutAsset: { calloutText: "Cash on delivery" } });
    expect(assets[2]).toMatchObject({ callAsset: { countryCode: "IN", phoneNumber: "+919876543210" } });
    const links = ops.filter((o) => opKey(o) === "adGroupAssetOperation").map(opBody);
    expect(links.map((l) => l.fieldType)).toEqual(["SITELINK", "CALLOUT", "CALL"]);
    expect(links.map((l) => l.asset)).toEqual(assets.map((a) => a.resourceName));

    const ad = ops.find((o) => opKey(o) === "adGroupAdOperation")!.adGroupAdOperation.create;
    expect(ad).toEqual({
      adGroup: group.resourceName,
      status: "ENABLED",
      ad: {
        name: "RSA 1",
        finalUrls: ["https://shop.example.com/sarees"],
        responsiveSearchAd: {
          headlines: [{ text: "Silk Sarees Online", pinnedField: "HEADLINE_1" }, { text: "Free Shipping" }, { text: "Festive Sale" }],
          descriptions: [{ text: "Handwoven silk sarees from Varanasi." }, { text: "Shop the festive edit today.", pinnedField: "DESCRIPTION_2" }],
          path1: "sarees",
        },
      },
    });
    // Temporary ids are unique negatives.
    const temps = ops.map((o) => opBody(o)?.resourceName).filter(Boolean) as string[];
    expect(new Set(temps).size).toBe(temps.length);
    expect(temps.every((t) => /\/-\d+$/.test(t))).toBe(true);

    // Returned structure is read back from the mutate responses.
    expect(made.campaigns).toHaveLength(1);
    expect(made.campaigns[0]).toMatchObject({ name: "Diwali Sarees", status: "PAUSED", objective: "SEARCH", dailyBudget: 50, lifetimeBudget: null, startDate: null, endDate: null });
    expect(made.campaigns[0]!.externalId).toBe("1001");
    expect(made.campaigns[0]!.raw).toEqual({ channelType: "SEARCH", budgetResourceName: `customers/${CID}/campaignBudgets/1000`, budgetShared: false });
    expect(made.adGroups).toEqual([expect.objectContaining({ campaignExternalId: "1001", name: "Silk sarees", sourceKey: draft.adGroups[0]!.key, raw: { kind: "adGroup" } })]);
    expect(made.ads).toEqual([
      expect.objectContaining({ adGroupExternalId: made.adGroups[0]!.externalId, campaignExternalId: "1001", name: "RSA 1", sourceKey: draft.adGroups[0]!.ads[0]!.key, finalUrl: "https://shop.example.com/sarees" }),
    ]);
  });

  it("launchStatus ACTIVE creates an ENABLED campaign", async () => {
    server.use(googleSearch(languages), googleMutate());
    const made = await g().createCampaign(auth(), acct, searchDraft({ campaign: { launchStatus: "ACTIVE" } }), new Map());
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations;
    expect(ops[1].campaignOperation.create.status).toBe("ENABLED");
    expect(made.campaigns[0]!.status).toBe("ACTIVE");
  });

  it("a total budget uses CUSTOM_PERIOD totalAmountMicros and start/end date-times", async () => {
    server.use(googleSearch(languages), googleMutate());
    const made = await g().createCampaign(auth(), acct, searchDraft({ campaign: { budgetType: "TOTAL", budget: 3000.5, startDate: "2026-11-01", endDate: "2026-11-30" } }), new Map());
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations;
    expect(ops[0].campaignBudgetOperation.create).toMatchObject({ period: "CUSTOM_PERIOD", totalAmountMicros: "3000500000" });
    expect(ops[0].campaignBudgetOperation.create.amountMicros).toBeUndefined();
    // Campaign.start_date_time / end_date_time "yyyy-MM-dd HH:mm:ss" (v20+)  // unverified exact format
    expect(ops[1].campaignOperation.create).toMatchObject({ startDateTime: "2026-11-01 00:00:00", endDateTime: "2026-11-30 23:59:59" });
    expect(made.campaigns[0]).toMatchObject({ dailyBudget: null, lifetimeBudget: 3000.5, startDate: "2026-11-01", endDate: "2026-11-30" });
  });

  // Google reads start/end in the account's own zone, so the typed day must go through unchanged
  // whatever the server's zone (dateOf() + toISOString() used to move it back a day east of UTC).
  it("start/end dates keep the calendar day when the server runs east of UTC", async () => {
    process.env.TZ = "Asia/Kolkata";
    server.use(googleSearch(languages), googleMutate());
    const made = await g().createCampaign(auth(), acct, searchDraft({ campaign: { startDate: "2026-11-01", endDate: "2026-11-30" } }), new Map());
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations;
    expect(ops[1].campaignOperation.create.startDateTime).toBe("2026-11-01 00:00:00");
    expect(ops[1].campaignOperation.create.endDateTime).toBe("2026-11-30 23:59:59");
    expect(made.campaigns[0]).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-30" });
  });

  it("bidding: target impression share, max clicks with a CPC cap, manual CPC with a default bid", async () => {
    server.use(googleSearch(languages), googleMutate());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { bidding: "IMPRESSION_SHARE", impressionShareTarget: 65, maxCpc: 12.5 } }), new Map());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { bidding: "CLICKS", maxCpc: 4 } }), new Map());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { bidding: "MANUAL_CPC" }, adGroup: { defaultBid: 7.25 } }), new Map());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { bidding: "CONVERSIONS", targetCpa: 150 } }), new Map());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { bidding: "CONVERSION_VALUE", targetRoas: 400 } }), new Map());
    const [is, clicks, manual, cpa, roas] = (await hits({ path: "googleAds:mutate" })).map((h) => h.json.mutateOperations);
    expect(is[1].campaignOperation.create.targetImpressionShare).toEqual({ location: "TOP_OF_PAGE", locationFractionMicros: "650000", cpcBidCeilingMicros: "12500000" });
    expect(clicks[1].campaignOperation.create.targetSpend).toEqual({ cpcBidCeilingMicros: "4000000" });
    expect(manual[1].campaignOperation.create.manualCpc).toEqual({});
    expect(manual.find((o: any) => o.adGroupOperation).adGroupOperation.create.cpcBidMicros).toBe("7250000");
    expect(cpa[1].campaignOperation.create.maximizeConversions).toEqual({ targetCpaMicros: "150000000" });
    expect(roas[1].campaignOperation.create.maximizeConversionValue).toEqual({ targetRoas: 4 });
  });

  it("ad schedule becomes adSchedule criteria", async () => {
    server.use(googleSearch(languages), googleMutate());
    await g().createCampaign(auth(), acct, searchDraft({ campaign: { adSchedule: { days: { MON: [[9, 18]], SAT: [[10, 14]] } } } }), new Map());
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations as Record<string, any>[];
    const sched = ops.filter((o) => o.campaignCriterionOperation?.create.adSchedule).map((o) => o.campaignCriterionOperation.create.adSchedule);
    expect(sched).toEqual([
      { dayOfWeek: "MONDAY", startHour: 9, startMinute: "ZERO", endHour: 18, endMinute: "ZERO" },
      { dayOfWeek: "SATURDAY", startHour: 10, startMinute: "ZERO", endHour: 14, endMinute: "ZERO" },
    ]);
  });

  it("rejects Video campaigns, missing budgets and unknown countries before mutating anything", async () => {
    server.use(googleSearch(languages), googleMutate());
    const video = makeDraft("GOOGLE", { goal: "YOUTUBE_REACH", campaignType: "VIDEO" });
    await expect(g().createCampaign(auth(), acct, video, new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringMatching(/Demand Gen/) });
    await expect(g().createCampaign(auth(), acct, searchDraft({ campaign: { budget: 0 } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(g().createCampaign(auth(), acct, searchDraft({ campaign: { locations: [{ id: "ZZ", name: "Nowhere", type: "country" }] } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Unknown country ZZ." });
    expect(await hits({ path: "googleAds:mutate" })).toHaveLength(0);
  });

  it("a rejected mutate creates nothing (Mutate is atomic), throws Google's detail and sends no clean-up calls", async () => {
    server.use(
      googleSearch(languages),
      googleMutate(() => googleAdsError(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", "Too many headlines.", { adError: "TOO_MANY_HEADLINES" })),
    );
    const err = await g().createCampaign(auth(), acct, searchDraft(), new Map()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.message).toBe("Too many headlines.");
    const mutates = await hits({ path: ":mutate" });
    expect(mutates).toHaveLength(1);
    expect(mutates[0]!.json.partialFailure).toBeUndefined();
    expect(JSON.stringify(mutates[0]!.json)).not.toContain('"remove"');
  });

  it("maps auth errors from the mutate", async () => {
    server.use(googleSearch(languages), googleMutate(() => googleAdsError(401, "UNAUTHENTICATED", "expired")));
    await expect(g().createCampaign(auth(), acct, searchDraft(), new Map())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Google createCampaign — Performance Max with images", () => {
  const assets = () =>
    assetsOf(
      imageAsset("logo-square", { width: 1200, height: 1200 }),
      imageAsset("logo-wide", { width: 1200, height: 300 }),
      imageAsset("landscape", { width: 1200, height: 628, cachedRef: `customers/${CID}/assets/777` }),
      imageAsset("square", { width: 1200, height: 1200, cachedRef: "customers/9999999999/assets/1" }),
    );
  const pmaxDraft = () =>
    makeDraft(
      "GOOGLE",
      { goal: "SALES", campaignType: "PERFORMANCE_MAX" },
      {
        campaign: { name: "PMax Festive", targetCpa: null, businessName: "Saree House", logos: ["logo-square", "logo-wide"], languages: [] },
        adGroup: {
          name: "All products",
          finalUrl: "https://shop.example.com",
          headlines: ["Silk sarees", "Free shipping", "Festive sale"],
          longHeadlines: ["Handwoven silk sarees, shipped free across India"],
          descriptions: ["Shop the festive edit.", "New weaves every week."],
          landscapeImages: ["landscape"],
          squareImages: ["square"],
          portraitImages: [],
          youtubeVideos: ["https://youtu.be/dQw4w9WgXcQ"],
          cta: "SHOP_NOW",
          searchThemes: ["silk saree online"],
        },
      },
    );

  it("uploads new images first (base64, cached per account), then links everything to an asset group", async () => {
    server.use(googleSearch({}), googleMutate());
    const a = assets();
    const uploaded: string[] = [];
    for (const asset of a.values()) asset.onUploaded = async (ref) => void uploaded.push(`${asset.creativeId}=${ref}`);
    const draft = pmaxDraft();
    const made = await g().createCampaign(auth(), acct, draft, a);

    const [upload, main] = await hits({ path: "googleAds:mutate" });
    const up = upload!.json.mutateOperations as Record<string, any>[];
    // The cached asset of this account is reused; the one cached for another account is uploaded again.
    expect(up.map((o) => o.assetOperation.create.name)).toEqual(["logo-square.jpg square", "logo-wide.jpg o-wide", "square.jpg square"]);
    for (const o of up) expect(o.assetOperation.create).toMatchObject({ type: "IMAGE", imageAsset: { data: Buffer.from("fake-jpeg-bytes").toString("base64") } });
    expect(uploaded).toEqual([`logo-square=customers/${CID}/assets/1000`, `logo-wide=customers/${CID}/assets/1001`, `square=customers/${CID}/assets/1002`]);

    const ops = main!.json.mutateOperations as Record<string, any>[];
    const campaign = ops[1].campaignOperation.create;
    expect(campaign).toMatchObject({ advertisingChannelType: "PERFORMANCE_MAX", status: "PAUSED", brandGuidelinesEnabled: true });
    expect(campaign.networkSettings).toBeUndefined();

    const campaignAssets = ops.filter((o) => o.campaignAssetOperation).map((o) => o.campaignAssetOperation.create);
    expect(campaignAssets.map((c) => c.fieldType)).toEqual(["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"]);
    expect(campaignAssets[1].asset).toBe(`customers/${CID}/assets/1000`);
    expect(campaignAssets[2].asset).toBe(`customers/${CID}/assets/1001`);

    const ag = ops.find((o) => o.assetGroupOperation).assetGroupOperation.create;
    expect(ag).toMatchObject({ campaign: campaign.resourceName, name: "All products", finalUrls: ["https://shop.example.com"], status: "ENABLED" });
    const links = ops.filter((o) => o.assetGroupAssetOperation).map((o) => o.assetGroupAssetOperation.create);
    expect(links.every((l) => l.assetGroup === ag.resourceName)).toBe(true);
    const fields = links.map((l) => l.fieldType);
    expect(fields.filter((f) => f === "HEADLINE")).toHaveLength(3);
    expect(fields).toEqual(expect.arrayContaining(["LONG_HEADLINE", "DESCRIPTION", "MARKETING_IMAGE", "SQUARE_MARKETING_IMAGE", "YOUTUBE_VIDEO", "CALL_TO_ACTION_SELECTION"]));
    expect(links.find((l) => l.fieldType === "MARKETING_IMAGE").asset).toBe(`customers/${CID}/assets/777`);
    expect(links.find((l) => l.fieldType === "SQUARE_MARKETING_IMAGE").asset).toBe(`customers/${CID}/assets/1002`);
    expect(ops.find((o) => o.assetOperation?.create.youtubeVideoAsset).assetOperation.create.youtubeVideoAsset).toEqual({ youtubeVideoId: "dQw4w9WgXcQ" });
    expect(ops.find((o) => o.assetGroupSignalOperation).assetGroupSignalOperation.create).toEqual({ assetGroup: ag.resourceName, searchTheme: { text: "silk saree online" } });
    // No ad groups or ads for PMax: the asset group is both.
    expect(ops.some((o) => o.adGroupOperation || o.adGroupAdOperation)).toBe(false);

    expect(made.adGroups).toHaveLength(1);
    expect(made.adGroups[0]).toMatchObject({ raw: { kind: "assetGroup" }, sourceKey: draft.adGroups[0]!.key });
    expect(made.ads).toEqual([expect.objectContaining({ externalId: `${made.adGroups[0]!.externalId}~ag`, sourceKey: draft.adGroups[0]!.key, headline: "Silk sarees", body: "Shop the festive edit.", finalUrl: "https://shop.example.com" })]);
  });

  it("skips the upload call when every image is already cached for this account", async () => {
    server.use(googleSearch({}), googleMutate());
    const a = assetsOf(
      imageAsset("logo-square", { width: 1200, height: 1200, cachedRef: `customers/${CID}/assets/1` }),
      imageAsset("logo-wide", { width: 1200, height: 300, cachedRef: `customers/${CID}/assets/2` }),
      imageAsset("landscape", { cachedRef: `customers/${CID}/assets/3` }),
      imageAsset("square", { width: 1200, height: 1200, cachedRef: `customers/${CID}/assets/4` }),
    );
    const loads = [...a.values()].map((x) => vi.spyOn(x, "load"));
    await g().createCampaign(auth(), acct, pmaxDraft(), a);
    expect(await hits({ path: "googleAds:mutate" })).toHaveLength(1);
    for (const l of loads) expect(l).not.toHaveBeenCalled();
  });

  it("an image Google didn't accept stops before the campaign is created", async () => {
    server.use(googleSearch({}), googleMutate(() => ({ mutateOperationResponses: [{ assetResult: { resourceName: `customers/${CID}/assets/1` } }, {}] })));
    const err = await g().createCampaign(auth(), acct, pmaxDraft(), assets()).catch((e) => e);
    expect(err).toMatchObject({ code: "PLATFORM_ERROR", message: expect.stringContaining("logo-wide.jpg") });
    expect(await hits({ path: "googleAds:mutate" })).toHaveLength(1);
  });

  it("a non-YouTube video link is rejected", async () => {
    server.use(googleSearch({}), googleMutate());
    const draft = pmaxDraft();
    draft.adGroups[0]!.values.youtubeVideos = ["https://vimeo.com/1"];
    await expect(g().createCampaign(auth(), acct, draft, assets())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("Google createCampaign — Display and Shopping", () => {
  it("Display: responsive display ad with images split by ratio, devices off via bidModifier 0", async () => {
    server.use(googleSearch(languages), googleMutate());
    const a = assetsOf(
      imageAsset("land", { width: 1200, height: 628, cachedRef: `customers/${CID}/assets/11` }),
      imageAsset("sq", { width: 1200, height: 1200, cachedRef: `customers/${CID}/assets/12` }),
      imageAsset("logo-sq", { width: 512, height: 512, cachedRef: `customers/${CID}/assets/13` }),
      imageAsset("logo-wide", { width: 1200, height: 300, cachedRef: `customers/${CID}/assets/14` }),
    );
    const draft = makeDraft(
      "GOOGLE",
      { goal: "SALES", campaignType: "DISPLAY" },
      {
        campaign: { targetCpa: null, devices: ["MOBILE", "DESKTOP"] },
        adGroup: { ageRanges: ["AGE_RANGE_25_34"], audiences: [{ id: "80432", name: "Fashion" }] },
        ad: { landscapeImages: ["land"], squareImages: ["sq"], logos: ["logo-sq", "logo-wide"], headlines: ["Festive sale"], longHeadline: "Festive sale on silk sarees", descriptions: ["Free shipping"], businessName: "Saree House", cta: "SHOP_NOW" },
      },
    );
    await g().createCampaign(auth(), acct, draft, a);
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations as Record<string, any>[];
    expect(ops[1].campaignOperation.create.networkSettings).toEqual({ targetContentNetwork: true });
    const devices = ops.filter((o) => o.campaignCriterionOperation?.create.device).map((o) => o.campaignCriterionOperation.create);
    expect(devices).toEqual([
      { campaign: `customers/${CID}/campaigns/-2`, device: { type: "TABLET" }, bidModifier: 0 },
      { campaign: `customers/${CID}/campaigns/-2`, device: { type: "CONNECTED_TV" }, bidModifier: 0 },
    ]);
    const group = ops.find((o) => o.adGroupOperation).adGroupOperation.create;
    expect(group).toMatchObject({ type: "DISPLAY_STANDARD", optimizedTargetingEnabled: true });
    const crit = ops.filter((o) => o.adGroupCriterionOperation).map((o) => o.adGroupCriterionOperation.create);
    expect(crit[0]).toEqual({ adGroup: group.resourceName, userInterest: { userInterestCategory: `customers/${CID}/userInterests/80432` } });
    // Every age range but the chosen one is excluded.
    expect(crit.filter((c) => c.ageRange).map((c) => c.ageRange.type)).not.toContain("AGE_RANGE_25_34");
    expect(crit.filter((c) => c.ageRange && c.negative)).toHaveLength(6);
    const ad = ops.find((o) => o.adGroupAdOperation).adGroupAdOperation.create.ad.responsiveDisplayAd;
    expect(ad).toMatchObject({
      marketingImages: [{ asset: `customers/${CID}/assets/11` }],
      squareMarketingImages: [{ asset: `customers/${CID}/assets/12` }],
      squareLogoImages: [{ asset: `customers/${CID}/assets/13` }],
      logoImages: [{ asset: `customers/${CID}/assets/14` }],
      headlines: [{ text: "Festive sale" }],
      longHeadline: { text: "Festive sale on silk sarees" },
      descriptions: [{ text: "Free shipping" }],
      businessName: "Saree House",
      callToActionText: "Shop now",
    });
  });

  it("Shopping: merchant setting, a UNIT listing group and a product ad", async () => {
    server.use(googleSearch(languages), googleMutate());
    const draft = makeDraft("GOOGLE", { goal: "SALES", campaignType: "SHOPPING" }, { campaign: { merchantId: "5551234", feedLabel: "IN", shoppingPriority: "1", targetCpa: null }, adGroup: { defaultBid: 3.5 } });
    const made = await g().createCampaign(auth(), acct, draft, new Map());
    const ops = (await onlyHit({ path: "googleAds:mutate" })).json.mutateOperations as Record<string, any>[];
    expect(ops[1].campaignOperation.create.shoppingSetting).toEqual({ merchantId: "5551234", campaignPriority: 1, feedLabel: "IN" });
    const group = ops.find((o) => o.adGroupOperation).adGroupOperation.create;
    expect(group).toMatchObject({ type: "SHOPPING_PRODUCT_ADS", cpcBidMicros: "3500000" });
    expect(ops.find((o) => o.adGroupCriterionOperation).adGroupCriterionOperation.create).toEqual({ adGroup: group.resourceName, status: "ENABLED", listingGroup: { type: "UNIT" }, cpcBidMicros: "3500000" });
    expect(ops.find((o) => o.adGroupAdOperation).adGroupAdOperation.create).toEqual({ adGroup: group.resourceName, status: "ENABLED", ad: { shoppingProductAd: {} } });
    expect(made.ads).toEqual([expect.objectContaining({ name: "Product ads", sourceKey: draft.adGroups[0]!.key })]);
  });
});

describe("Google builder options and targeting search", () => {
  it("getBuilderOptions maps conversion actions, merchant centers and audiences", async () => {
    server.use(
      googleSearch({
        conversion_action: [{ conversionAction: { id: "7", name: "Purchase", category: "PURCHASE", primaryForGoal: true } }],
        product_link: [{ productLink: { merchantCenter: { merchantCenterId: "5551234" }, type: "MERCHANT_CENTER" } }],
        user_list: [{ userList: { id: "88", name: "Cart abandoners", sizeForSearch: "120000" } }],
      }),
    );
    const o = await g().getBuilderOptions(auth(), acct);
    expect(o.conversionActions).toEqual([{ id: "7", name: "Purchase", detail: "PURCHASE · Primary" }]);
    expect(o.merchantCenters).toEqual([{ id: "5551234", name: "Merchant Center 5551234" }]);
    expect(o.audiences?.[0]).toMatchObject({ id: "88", name: "Cart abandoners" });
    expect(o.audiences?.[0]?.detail).toMatch(/1,20,000/);
  });

  it("getBuilderOptions degrades to empty lists when a query fails", async () => {
    server.use(googleSearch({ conversion_action: () => googleAdsError(403, "PERMISSION_DENIED", "denied") }));
    const o = await g().getBuilderOptions(auth(), acct);
    expect(o.conversionActions).toEqual([]);
  });

  it("location search uses geoTargetConstants:suggest and keeps countries as ISO codes", async () => {
    server.use(
      http.post(`${ADS}/geoTargetConstants\\:suggest`, () =>
        HttpResponse.json({
          geoTargetConstantSuggestions: [
            { locale: "en", reach: "1000", searchTerm: "ind", geoTargetConstant: { resourceName: "geoTargetConstants/2356", id: "2356", name: "India", countryCode: "IN", targetType: "Country", canonicalName: "India" } },
            { locale: "en", reach: "10", searchTerm: "ind", geoTargetConstant: { resourceName: "geoTargetConstants/1007751", id: "1007751", name: "Indore", countryCode: "IN", targetType: "City", canonicalName: "Indore,Madhya Pradesh,India" } },
            { geoTargetConstant: { id: "20453", name: "Indiana", countryCode: "US", targetType: "State" } },
          ],
        }),
      ),
    );
    const res = await g().searchTargeting(auth(), acct, "location", " ind ");
    expect(res.map((r) => [r.id, r.type])).toEqual([["IN", "country"], ["1007751", "city"], ["20453", "region"]]);
    const h = await onlyHit({ path: "geoTargetConstants:suggest" });
    expect(h.json).toEqual({ locale: "en", locationNames: { names: ["ind"] } });
    expect(h.headers.get("login-customer-id")).toBe("100");
  });

  it("interest search escapes quotes in GAQL; empty queries and other kinds make no request", async () => {
    server.use(googleSearch({ user_interest: [{ userInterest: { userInterestId: "92", name: "Women's Apparel", taxonomyType: "IN_MARKET" } }] }));
    const res = await g().searchTargeting(auth(), acct, "interest", "women's");
    expect(res).toEqual([{ id: "92", name: "Women's Apparel", detail: "in market" }]);
    expect((await onlyHit({ path: "googleAds:search" })).json.query).toContain("LIKE '%women\\'s%'");
    expect(await g().searchTargeting(auth(), acct, "interest", "   ")).toEqual([]);
    expect(await g().searchTargeting(auth(), acct, "jobTitle", "engineer")).toEqual([]);
    expect(await hits()).toHaveLength(1);
  });
});
