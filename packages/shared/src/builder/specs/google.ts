/**
 * Google Ads flow: Objective → Campaign type → Campaign → Ad group / Asset
 * group → Ads (Google Ads API v25).
 */
import { budgetFields, campaignIs, ctaOptions, infoField, launchSection, locationsField, nameField, opts, scheduleFields, setupIs, urlField } from "../common";
import { LANGUAGES } from "../geo";
import type { BuilderIssue, Field, FieldContext, LevelSpec, Option, PlacementPreview, PlatformBuilderSpec, SetupOption } from "../types";
import { keywordsField, negativeKeywordsField, rsaSections } from "./search-ads";

export const GOOGLE_GOALS: Option[] = [
  { value: "SALES", label: "Sales", description: "Drive sales online, in app, by phone or in store.", icon: "ShoppingBag" },
  { value: "LEADS", label: "Leads", description: "Get leads and other conversions by encouraging customers to take action.", icon: "Filter" },
  { value: "WEBSITE_TRAFFIC", label: "Website traffic", description: "Get the right people to visit your website.", icon: "MousePointerClick" },
  { value: "YOUTUBE_REACH", label: "YouTube reach, views and engagements", description: "Reach a broad audience and build interest in your products.", icon: "MonitorPlay" },
  { value: "APP_PROMOTION", label: "App promotion", description: "Get more installs, engagement and pre-registration for your app.", icon: "Smartphone" },
  { value: "LOCAL_STORE_VISITS", label: "Local store visits and promotions", description: "Drive visits to local stores, restaurants and dealerships.", icon: "MapPin" },
  { value: "NONE", label: "Create a campaign without guidance", description: "Choose a campaign type next, without a goal recommendation.", icon: "Settings2" },
];

const TYPE_INFO: Record<string, SetupOption> = {
  PERFORMANCE_MAX: { value: "PERFORMANCE_MAX", label: "Performance Max", description: "Reach audiences across all of Google with a single campaign.", icon: "Sparkles", badge: "Recommended" },
  SEARCH: { value: "SEARCH", label: "Search", description: "Text ads on Google search results.", icon: "Search" },
  DISPLAY: { value: "DISPLAY", label: "Display", description: "Image ads across 3 million websites and apps.", icon: "LayoutGrid" },
  DEMAND_GEN: { value: "DEMAND_GEN", label: "Demand Gen", description: "Image and video ads on YouTube (in-stream, in-feed, Shorts), Discover and Gmail.", icon: "MonitorPlay" },
  SHOPPING: { value: "SHOPPING", label: "Shopping", description: "Product listings from your Merchant Center feed.", icon: "ShoppingCart" },
  VIDEO: {
    value: "VIDEO",
    label: "Video",
    description: "Skippable, non-skippable and bumper ads on YouTube.",
    icon: "Film",
    disabled: true,
    disabledReason: "Google doesn't allow Video campaigns to be created through its API. Use Demand Gen to run YouTube in-stream, in-feed and Shorts ads from here.",
  },
  APP: { value: "APP", label: "App", description: "Promote your app on Search, Google Play, YouTube and more.", icon: "Smartphone" },
};

const TYPES_BY_GOAL: Record<string, string[]> = {
  SALES: ["PERFORMANCE_MAX", "SEARCH", "DISPLAY", "DEMAND_GEN", "SHOPPING", "VIDEO"],
  LEADS: ["PERFORMANCE_MAX", "SEARCH", "DISPLAY", "DEMAND_GEN", "SHOPPING", "VIDEO"],
  WEBSITE_TRAFFIC: ["SEARCH", "DISPLAY", "DEMAND_GEN", "SHOPPING", "VIDEO"],
  YOUTUBE_REACH: ["DEMAND_GEN", "DISPLAY", "VIDEO"],
  APP_PROMOTION: ["APP"],
  LOCAL_STORE_VISITS: ["PERFORMANCE_MAX"],
  NONE: ["SEARCH", "PERFORMANCE_MAX", "DISPLAY", "DEMAND_GEN", "SHOPPING", "VIDEO", "APP"],
};

export const googleCampaignTypes = (goal: string) => (TYPES_BY_GOAL[goal] ?? TYPES_BY_GOAL.NONE!).map((t) => TYPE_INFO[t]!);

const type = (...t: string[]) => setupIs("campaignType", ...t);

const BIDDING: Record<string, [string, string, string?][]> = {
  SEARCH: [
    ["CONVERSIONS", "Conversions", "Maximize conversions; optionally set a target cost per action."],
    ["CONVERSION_VALUE", "Conversion value", "Maximize conversion value; optionally set a target ROAS."],
    ["CLICKS", "Clicks", "Get as many clicks as possible."],
    ["IMPRESSION_SHARE", "Impression share", "Show at the top of results a set share of the time."],
    ["MANUAL_CPC", "Manual CPC", "Set your own maximum cost per click."],
  ],
  PERFORMANCE_MAX: [
    ["CONVERSIONS", "Conversions", "Maximize conversions; optionally set a target CPA."],
    ["CONVERSION_VALUE", "Conversion value", "Maximize conversion value; optionally set a target ROAS."],
  ],
  DISPLAY: [
    ["CONVERSIONS", "Conversions"],
    ["CONVERSION_VALUE", "Conversion value"],
    ["CLICKS", "Clicks"],
    ["VIEWABLE_IMPRESSIONS", "Viewable impressions", "Pay per 1,000 viewable impressions (vCPM)."],
    ["MANUAL_CPC", "Manual CPC"],
  ],
  DEMAND_GEN: [
    ["CONVERSIONS", "Conversions"],
    ["CONVERSION_VALUE", "Conversion value"],
    ["CLICKS", "Clicks"],
  ],
  SHOPPING: [
    ["CONVERSION_VALUE", "Conversion value", "Maximize value; optionally set a target ROAS."],
    ["CLICKS", "Clicks", "Maximize clicks."],
    ["MANUAL_CPC", "Manual CPC"],
  ],
  APP: [
    ["INSTALLS", "Install volume", "Get as many installs as possible; optionally set a target cost per install."],
    ["IN_APP_ACTIONS", "In-app actions", "Find users likely to complete an in-app action."],
    ["IN_APP_VALUE", "In-app action value", "Find users likely to bring the most value."],
  ],
};
const biddingFor = (ctx: FieldContext) => opts(BIDDING[String(ctx.setup.campaignType)] ?? BIDDING.SEARCH!);
const bid = (...b: string[]) => campaignIs("bidding", ...b);

export const GOOGLE_CTAS = ["LEARN_MORE", "SHOP_NOW", "BUY_NOW", "SIGN_UP", "SUBSCRIBE", "GET_QUOTE", "APPLY_NOW", "CONTACT_US", "BOOK_NOW", "ORDER_NOW", "DOWNLOAD", "SEE_MORE", "START_NOW", "VISIT_SITE", "WATCH_NOW", "PLAY_NOW", "DONATE_NOW"];
const googleCtaOptions = () => [{ value: "AUTOMATED", label: "Automated", description: "Google picks the best call to action." }, ...ctaOptions(GOOGLE_CTAS)];

const YT_RE = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;

const youtubeVideos = (opts: { key?: string; min: number; max: number; required?: boolean; help?: string }): Field => ({
  key: opts.key ?? "youtubeVideos",
  type: "textList",
  label: "YouTube videos",
  itemLabel: "YouTube video URL",
  min: opts.min,
  max: opts.max,
  initial: Math.max(1, opts.min),
  maxLength: 200,
  required: opts.required,
  help: opts.help ?? "Paste public or unlisted YouTube links. Google serves video ads from YouTube.",
});

const campaign: LevelSpec = {
  label: "Campaign",
  sections: [
    {
      id: "details",
      title: "Campaign settings",
      fields: [
        nameField("Campaign name", "Festive Sale – Search – India", 255),
        {
          key: "conversionGoals",
          type: "accountOption",
          source: "conversionActions",
          label: "Conversion goals",
          multiple: true,
          help: "Which conversions this campaign optimizes for. Leave empty to use your account defaults.",
          showIf: (ctx) => !["YOUTUBE_REACH", "WEBSITE_TRAFFIC"].includes(String(ctx.setup.goal)) && ctx.setup.campaignType !== "APP",
        },
        {
          key: "appStore",
          type: "segmented",
          label: "App platform",
          options: opts([["GOOGLE_APP_STORE", "Android (Google Play)"], ["APPLE_APP_STORE", "iOS (App Store)"]]),
          default: "GOOGLE_APP_STORE",
          showIf: type("APP"),
        },
        { key: "appId", type: "text", label: "App ID", required: true, placeholder: "com.yourcompany.app or 1234567890", maxLength: 200, showIf: type("APP"), help: "Android package name, or the numeric App Store ID." },
        {
          key: "appSubtype",
          type: "radio",
          label: "Campaign subtype",
          showIf: type("APP"),
          options: opts([
            ["APP_CAMPAIGN", "App installs", "Get new people to install your app."],
            ["APP_CAMPAIGN_FOR_ENGAGEMENT", "App engagement", "Get existing users to take actions in your app."],
            ["APP_CAMPAIGN_FOR_PRE_REGISTRATION", "App pre-registration (Android)", "Build interest before launch."],
          ]),
          default: "APP_CAMPAIGN",
        },
        { key: "merchantId", type: "accountOption", source: "merchantCenters", label: "Merchant Center account", required: true, showIf: type("SHOPPING"), autoSelect: true },
        { key: "feedLabel", type: "text", label: "Feed label", placeholder: "IN", maxLength: 20, showIf: type("SHOPPING"), width: "half", help: "Usually the country of sale." },
        {
          key: "shoppingPriority",
          type: "segmented",
          label: "Campaign priority",
          options: opts([["0", "Low"], ["1", "Medium"], ["2", "High"]]),
          default: "0",
          showIf: type("SHOPPING"),
          advanced: true,
        },
      ],
    },
    {
      id: "bidding",
      title: "Bidding",
      fields: [
        {
          key: "bidding",
          type: "radio",
          label: "What do you want to focus on?",
          options: biddingFor,
          // Google recommends clicks for traffic goals, conversions otherwise.
          default: (ctx) => {
            const list = biddingFor(ctx).map((o) => o.value);
            return ["WEBSITE_TRAFFIC", "YOUTUBE_REACH"].includes(String(ctx.setup.goal)) && list.includes("CLICKS") ? "CLICKS" : list[0]!;
          },
        },
        { key: "targetCpa", type: "money", label: "Target cost per action (optional)", min: 0.01, showIf: bid("CONVERSIONS", "INSTALLS", "IN_APP_ACTIONS"), width: "half" },
        { key: "targetRoas", type: "percent", label: "Target ROAS % (optional)", min: 1, max: 100000, showIf: bid("CONVERSION_VALUE", "IN_APP_VALUE"), width: "half", help: "e.g. 400% = ₹4 back for every ₹1." },
        { key: "maxCpc", type: "money", label: "Maximum CPC bid limit (optional)", min: 0.01, showIf: bid("CLICKS", "IMPRESSION_SHARE"), width: "half" },
        {
          key: "impressionShareLocation",
          type: "select",
          label: "Where do you want your ads to appear?",
          options: opts([["ANYWHERE_ON_PAGE", "Anywhere on results page"], ["TOP_OF_PAGE", "Top of results page"], ["ABSOLUTE_TOP_OF_PAGE", "Absolute top of results page"]]),
          default: "TOP_OF_PAGE",
          showIf: bid("IMPRESSION_SHARE"),
          width: "half",
        },
        { key: "impressionShareTarget", type: "percent", label: "Percent (%) impression share to target", min: 1, max: 100, default: 70, showIf: bid("IMPRESSION_SHARE"), width: "half" },
        {
          key: "customerAcquisition",
          type: "radio",
          label: "Customer acquisition",
          options: opts([
            ["BID_EQUALLY", "Bid equally for new and existing customers"],
            ["BID_HIGHER", "Bid higher for new customers than for existing customers"],
            ["ONLY_NEW", "Only bid for new customers"],
          ]),
          default: "BID_EQUALLY",
          showIf: type("SEARCH", "PERFORMANCE_MAX", "SHOPPING"),
          advanced: true,
        },
      ],
    },
    {
      id: "budget",
      title: "Budget",
      fields: [
        {
          key: "budgetType",
          type: "segmented",
          label: "Budget type",
          options: [
            { value: "DAILY", label: "Average daily budget", description: "Google may spend up to 2× on some days but stays within daily budget × 30.4 a month." },
            { value: "TOTAL", label: "Campaign total budget", description: "One budget for the whole schedule; needs start and end dates." },
          ],
          default: "DAILY",
          showIf: type("SEARCH", "PERFORMANCE_MAX", "DEMAND_GEN", "SHOPPING"),
        },
        ...budgetFields({ lifetime: false }),
      ],
    },
    {
      id: "networks",
      title: "Networks",
      showIf: type("SEARCH"),
      fields: [
        { key: "searchPartners", type: "toggle", label: "Google search partners", description: "Ads can appear on Google search partner sites.", default: true },
        { key: "displayExpansion", type: "toggle", label: "Google Display Network", description: "Easily reach customers browsing sites, videos and apps across the internet.", default: false },
        {
          key: "aiMax",
          type: "toggle",
          label: "AI Max for Search campaigns",
          description: "Search term matching beyond your keywords, text customization and final URL expansion.",
          default: false,
        },
        { key: "textCustomization", type: "toggle", label: "Text customization", description: "Google writes extra headlines from your landing page and ads.", default: true, showIf: campaignIs("aiMax", "true"), advanced: true },
        { key: "urlExpansion", type: "toggle", label: "Final URL expansion", description: "Send people to the most relevant page on your site.", default: true, showIf: campaignIs("aiMax", "true"), advanced: true },
      ],
    },
    {
      id: "targeting",
      title: "Locations and languages",
      fields: [
        locationsField(),
        {
          key: "locationOption",
          type: "radio",
          label: "Location options",
          options: opts([
            ["PRESENCE_OR_INTEREST", "Presence or interest", "People in, regularly in, or who've shown interest in your locations. Recommended."],
            ["PRESENCE", "Presence", "People in or regularly in your locations."],
          ]),
          default: "PRESENCE_OR_INTEREST",
          advanced: true,
        },
        {
          key: "languages",
          type: "multiSelect",
          label: "Languages",
          options: LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
          default: ["en"],
          help: "The languages your customers speak. Leave empty for all languages.",
        },
        { key: "audienceSegments", type: "targeting", kind: "interest", label: "Audience segments (observation)", help: "Get reporting and bid insights for these audiences without narrowing reach.", showIf: type("SEARCH", "SHOPPING"), advanced: true },
        {
          key: "euPolitical",
          type: "radio",
          label: "Does your campaign have European Union political ads?",
          options: opts([["NO", "No, this campaign doesn't have EU political ads"], ["YES", "Yes, this campaign has EU political ads"]]),
          default: "NO",
          required: true,
        },
      ],
    },
    {
      id: "brand",
      title: "Brand guidelines",
      description: "Your business name and logos are used across every asset group.",
      showIf: type("PERFORMANCE_MAX"),
      fields: [
        { key: "businessName", type: "text", label: "Business name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
        { key: "logos", type: "media", label: "Logos", accept: ["IMAGE"], min: 1, max: 5, required: true, ratios: ["1:1", "4:1"], specs: "1:1 (1200×1200, min 128×128) and optionally 4:1 (1200×300)." },
        { key: "finalUrlExpansion", type: "toggle", label: "Final URL expansion", description: "Google may send traffic to the most relevant page on your site.", default: true },
      ],
    },
    {
      id: "more",
      title: "More settings",
      fields: [
        ...scheduleFields({ endRequired: campaignIs("budgetType", "TOTAL") }),
        { key: "adSchedule", type: "adSchedule", label: "Ad schedule", help: "Show ads only on certain days and hours.", advanced: true },
        {
          key: "devices",
          type: "checkboxes",
          label: "Devices",
          options: opts([["DESKTOP", "Computers"], ["MOBILE", "Mobile phones"], ["TABLET", "Tablets"], ["CONNECTED_TV", "TV screens"]]),
          default: ["DESKTOP", "MOBILE", "TABLET", "CONNECTED_TV"],
          showIf: type("DISPLAY", "DEMAND_GEN", "PERFORMANCE_MAX"),
          advanced: true,
        },
        { key: "trackingTemplate", type: "text", label: "Tracking template", placeholder: "{lpurl}?utm_source=google&utm_medium=cpc", maxLength: 2048, advanced: true },
        { key: "finalUrlSuffix", type: "text", label: "Final URL suffix", placeholder: "utm_campaign={campaignid}", maxLength: 2048, advanced: true },
      ],
    },
    launchSection(),
  ],
};

const AGE_RANGES = opts([
  ["AGE_RANGE_18_24", "18–24"], ["AGE_RANGE_25_34", "25–34"], ["AGE_RANGE_35_44", "35–44"], ["AGE_RANGE_45_54", "45–54"], ["AGE_RANGE_55_64", "55–64"], ["AGE_RANGE_65_UP", "65+"], ["AGE_RANGE_UNDETERMINED", "Unknown"],
]);

const adGroup: LevelSpec = {
  label: "Ad group",
  sections: [
    {
      id: "search",
      title: "Ad group",
      showIf: type("SEARCH"),
      fields: [
        nameField("Ad group name", "Kurtas for women"),
        { key: "defaultBid", type: "money", label: "Default max. CPC", required: true, min: 0.01, showIf: campaignIs("bidding", "MANUAL_CPC"), width: "half" },
        keywordsField(),
        negativeKeywordsField(),
      ],
    },
    {
      id: "display",
      title: "Ad group",
      showIf: type("DISPLAY"),
      fields: [
        nameField("Ad group name", "In-market: apparel"),
        { key: "defaultBid", type: "money", label: "Default max. CPC", required: true, min: 0.01, showIf: campaignIs("bidding", "MANUAL_CPC"), width: "half" },
        { key: "optimizedTargeting", type: "toggle", label: "Optimized targeting", description: "Google finds more people likely to convert, beyond your segments.", default: true },
        { key: "audiences", type: "targeting", kind: "interest", label: "Audience segments", help: "Affinity, in-market and custom segments.", ai: { purpose: "Google in-market and affinity audiences" } },
        { key: "ageRanges", type: "checkboxes", label: "Age", options: AGE_RANGES, help: "Leave unchecked for all ages." },
        { key: "genders", type: "checkboxes", label: "Gender", options: opts([["FEMALE", "Female"], ["MALE", "Male"], ["UNDETERMINED", "Unknown"]]), help: "Leave unchecked for all." },
        { key: "contentKeywords", type: "textList", label: "Content keywords", itemLabel: "Keyword", min: 0, max: 50, initial: 0, maxLength: 80, advanced: true, help: "Show ads on pages about these topics." },
        { key: "placementUrls", type: "textList", label: "Placements", itemLabel: "Website, app or YouTube channel", min: 0, max: 50, initial: 0, maxLength: 200, advanced: true },
      ],
    },
    {
      id: "demandgen",
      title: "Ad group",
      showIf: type("DEMAND_GEN"),
      fields: [
        nameField("Ad group name", "Lookalike – recent buyers"),
        { key: "audiences", type: "targeting", kind: "interest", label: "Audience", help: "Interests, custom segments and lookalikes.", ai: { purpose: "Google interest audiences" } },
        { key: "optimizedTargeting", type: "toggle", label: "Optimized targeting", description: "Reach people beyond your audience who are likely to convert.", default: true },
        {
          key: "channels",
          type: "placements",
          label: "Channels",
          autoLabel: "All Google channels",
          autoDescription: "YouTube, Discover, Gmail, Display and Maps. Recommended.",
          groups: [
            {
              id: "youtube",
              label: "YouTube",
              items: [
                { value: "youtube_in_stream", label: "YouTube in-stream" },
                { value: "youtube_in_feed", label: "YouTube in-feed" },
                { value: "youtube_shorts", label: "YouTube Shorts" },
              ],
            },
            {
              id: "google",
              label: "Google",
              items: [
                { value: "discover", label: "Discover" },
                { value: "gmail", label: "Gmail" },
                { value: "display", label: "Display" },
                { value: "maps", label: "Maps" },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "pmax",
      title: "Asset group",
      description: "Google combines these assets into ads for Search, YouTube, Display, Discover, Gmail and Maps.",
      showIf: type("PERFORMANCE_MAX"),
      fields: [
        nameField("Asset group name", "Festive collection"),
        urlField({ key: "finalUrl", label: "Final URL" }),
        { key: "path1", type: "text", label: "Display path 1", placeholder: "sale", maxLength: 15, width: "half" },
        { key: "path2", type: "text", label: "Display path 2", placeholder: "festive", maxLength: 15, width: "half" },
        { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 3, max: 15, initial: 5, maxLength: 30, required: true, help: "Add at least one under 15 characters.", ai: { purpose: "Performance Max headlines; include one under 15 characters" } },
        { key: "longHeadlines", type: "textList", label: "Long headlines", itemLabel: "Long headline", min: 1, max: 5, initial: 2, maxLength: 90, required: true, ai: { purpose: "long headlines" } },
        { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 2, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, help: "Add at least one under 60 characters.", ai: { purpose: "descriptions; one under 60 characters" } },
        { key: "landscapeImages", type: "media", label: "Landscape images (1.91:1)", accept: ["IMAGE"], min: 1, max: 20, required: true, ratios: ["1.91:1"], requiredRatio: "1.91:1", specs: "1200×628 recommended, minimum 600×314." },
        { key: "squareImages", type: "media", label: "Square images (1:1)", accept: ["IMAGE"], min: 1, max: 20, required: true, ratios: ["1:1"], requiredRatio: "1:1", specs: "1200×1200 recommended, minimum 300×300." },
        { key: "portraitImages", type: "media", label: "Portrait images (4:5)", accept: ["IMAGE"], min: 0, max: 20, ratios: ["4:5"], requiredRatio: "4:5" },
        youtubeVideos({ min: 0, max: 15, help: "Optional. Without videos Google may make one from your images." }),
        { key: "cta", type: "select", label: "Call to action", options: googleCtaOptions(), default: "AUTOMATED", width: "half" },
        { key: "searchThemes", type: "textList", label: "Search themes", itemLabel: "Search theme", min: 0, max: 25, initial: 0, maxLength: 80, help: "What your customers search for. Helps Google reach new searches.", ai: { purpose: "search themes" } },
        { key: "audienceSignals", type: "targeting", kind: "interest", label: "Audience signal", help: "Interests and custom segments that hint at your ideal customers.", advanced: true },
      ],
    },
    {
      id: "shopping",
      title: "Ad group",
      showIf: type("SHOPPING"),
      fields: [
        nameField("Ad group name", "All products"),
        { key: "defaultBid", type: "money", label: "Default max. CPC", required: true, min: 0.01, width: "half" },
        infoField("productAds", "Product ads are automatic", "Shopping ads are built from your Merchant Center products; there's nothing to write.", "info"),
      ],
    },
    {
      id: "app",
      title: "Ad group",
      showIf: type("APP"),
      fields: [nameField("Ad group name", "Ad group 1")],
    },
  ],
};

const displayAd: LevelSpec = {
  label: "Ad",
  sections: [
    {
      id: "ad",
      title: "Responsive display ad",
      description: "Google adjusts size, appearance and format to fit available ad spaces.",
      fields: [
        urlField({ key: "finalUrl", label: "Final URL" }),
        { key: "landscapeImages", type: "media", label: "Landscape images (1.91:1)", accept: ["IMAGE"], min: 1, max: 15, required: true, ratios: ["1.91:1"], requiredRatio: "1.91:1", specs: "1200×628 recommended." },
        { key: "squareImages", type: "media", label: "Square images (1:1)", accept: ["IMAGE"], min: 1, max: 15, required: true, ratios: ["1:1"], requiredRatio: "1:1", specs: "1200×1200 recommended." },
        { key: "logos", type: "media", label: "Logos", accept: ["IMAGE"], min: 0, max: 5, ratios: ["1:1", "4:1"] },
        { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 1, max: 5, initial: 3, maxLength: 30, required: true, ai: { purpose: "short display headlines" } },
        { key: "longHeadline", type: "text", label: "Long headline", placeholder: "Festive sale: up to 50% off home decor, this week only", required: true, maxLength: 90, ai: { purpose: "long display headline" } },
        { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 1, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, ai: { purpose: "display descriptions" } },
        { key: "businessName", type: "text", label: "Business name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
        { key: "cta", type: "select", label: "Call to action", options: googleCtaOptions(), default: "AUTOMATED", width: "half" },
        { key: "mainColor", type: "text", label: "Main colour", placeholder: "#1A73E8", maxLength: 7, advanced: true, width: "half" },
        { key: "accentColor", type: "text", label: "Accent colour", placeholder: "#FFFFFF", maxLength: 7, advanced: true, width: "half" },
      ],
    },
  ],
};

const demandGenAd: LevelSpec = {
  label: "Ad",
  sections: [
    {
      id: "format",
      title: "Ad",
      fields: [
        nameField("Ad name", "Festive video · 15s"),
        {
          key: "format",
          type: "cards",
          label: "Ad type",
          options: [
            { value: "IMAGE", label: "Single image ad", description: "Images in Discover, Gmail, YouTube and Display.", icon: "Image" },
            { value: "VIDEO", label: "Video ad", description: "YouTube in-stream, in-feed and Shorts.", icon: "Film" },
            { value: "CAROUSEL", label: "Carousel ad", description: "2–10 swipeable image cards.", icon: "GalleryHorizontal" },
          ],
          default: (ctx) => (ctx.setup.goal === "YOUTUBE_REACH" ? "VIDEO" : "IMAGE"),
        },
      ],
    },
    {
      id: "assets",
      title: "Assets",
      fields: [
        { key: "images", type: "media", label: "Images", accept: ["IMAGE"], min: 1, max: 20, required: true, ratios: ["1.91:1", "1:1", "4:5", "9:16"], showIf: (ctx) => ctx.ad.format === "IMAGE", specs: "Landscape 1.91:1, square 1:1, portrait 4:5 or 9:16. Up to 20 combined." },
        { ...youtubeVideos({ min: 1, max: 5, required: true }), showIf: (ctx) => ctx.ad.format === "VIDEO" },
        {
          key: "cards",
          type: "repeater",
          label: "Carousel cards",
          itemLabel: "Card",
          min: 2,
          max: 10,
          required: true,
          showIf: (ctx) => ctx.ad.format === "CAROUSEL",
          fields: [
            { key: "image", type: "media", label: "Card image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["1:1", "1.91:1", "4:5"], help: "Every card must use the same aspect ratio." },
            { key: "headline", type: "text", label: "Card headline", placeholder: "Shop the edit", required: true, maxLength: 40 },
          ],
        },
        { key: "logos", type: "media", label: "Logo", accept: ["IMAGE"], min: 1, max: 5, required: true, ratios: ["1:1"], requiredRatio: "1:1" },
        { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 1, max: 5, initial: 2, maxLength: 40, required: true, ai: { purpose: "Demand Gen headlines" } },
        { key: "longHeadlines", type: "textList", label: "Long headlines", itemLabel: "Long headline", min: 1, max: 5, initial: 1, maxLength: 90, required: true, showIf: (ctx) => ctx.ad.format === "VIDEO", ai: { purpose: "long headlines" } },
        { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 1, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, ai: { purpose: "descriptions" } },
        { key: "businessName", type: "text", label: "Business name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
        { key: "cta", type: "select", label: "Call to action", options: googleCtaOptions(), default: "AUTOMATED", width: "half" },
        urlField({ key: "finalUrl", label: "Final URL" }),
      ],
    },
  ],
};

const appAd: LevelSpec = {
  label: "Ad",
  sections: [
    {
      id: "assets",
      title: "App ad assets",
      description: "Google combines these into ads on Search, Google Play, YouTube, Discover and Display.",
      fields: [
        { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 1, max: 5, initial: 2, maxLength: 30, required: true, ai: { purpose: "app ad headlines" } },
        { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 1, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, ai: { purpose: "app ad descriptions" } },
        { key: "images", type: "media", label: "Images", accept: ["IMAGE"], min: 0, max: 20, ratios: ["1.91:1", "1:1", "4:5"] },
        youtubeVideos({ min: 0, max: 20 }),
      ],
    },
  ],
};

export const googleSpec: PlatformBuilderSpec = {
  platform: "GOOGLE",
  setup: [
    { key: "goal", label: "Objective", description: "Choose your objective to get a campaign built for it.", options: GOOGLE_GOALS },
    { key: "campaignType", label: "Campaign type", description: "Where do you want your ads to show?", showIf: (s) => Boolean(s.goal), options: (s) => googleCampaignTypes(String(s.goal ?? "NONE")) },
  ],
  campaign,
  adGroup,
  ad: (setup) => {
    switch (setup.campaignType) {
      case "SEARCH":
        return { label: "Ad", sections: rsaSections({ platformName: "Google" }) };
      case "DISPLAY":
        return displayAd;
      case "DEMAND_GEN":
        return demandGenAd;
      case "APP":
        return appAd;
      default:
        return null;
    }
  },
  maxAdGroups: 20,
  maxAds: 3,
  previews: (ctx) => {
    switch (ctx.setup.campaignType) {
      case "SEARCH":
        return ["google_search_mobile", "google_search_desktop"];
      case "DISPLAY":
        return ["google_display", "google_display_native", "gmail"];
      case "DEMAND_GEN": {
        const c = ctx.adGroup.channels as { mode: string; items: string[] } | undefined;
        const on = (v: string) => !c || c.mode !== "MANUAL" || c.items.includes(v);
        const out: PlacementPreview[] = [];
        if (ctx.ad.format === "VIDEO") {
          if (on("youtube_in_stream")) out.push("youtube_instream");
          if (on("youtube_in_feed")) out.push("youtube_infeed");
          if (on("youtube_shorts")) out.push("youtube_shorts");
        } else {
          if (on("discover")) out.push("discover");
          if (on("gmail")) out.push("gmail");
          if (on("youtube_in_feed")) out.push("youtube_infeed");
          if (on("display")) out.push("google_display_native");
        }
        return out.length ? out : ["discover"];
      }
      case "PERFORMANCE_MAX":
        return ["google_search_mobile", "google_display", "youtube_instream", "discover", "gmail"];
      case "SHOPPING":
        return ["google_shopping"];
      case "APP":
        return ["google_display_native", "youtube_infeed"];
      default:
        return ["google_search_mobile"];
    }
  },
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const checkVideos = (list: unknown, where: Omit<BuilderIssue, "message">) => {
      const bad = (Array.isArray(list) ? list : []).map(String).filter((u) => u.trim() && !YT_RE.test(u.trim()));
      if (bad.length) issues.push({ ...where, message: `“${bad[0]!.slice(0, 40)}” isn't a YouTube link.` });
    };
    if (draft.setup.campaignType === "VIDEO") {
      issues.push({ level: "setup", field: "campaignType", message: "Video campaigns can't be created through the Google Ads API. Choose Demand Gen for YouTube ads." });
    }
    for (const g of draft.adGroups) {
      checkVideos(g.values.youtubeVideos, { level: "adGroup", nodeKey: g.key, field: "youtubeVideos" });
      if (draft.setup.campaignType === "PERFORMANCE_MAX") {
        const d = (g.values.descriptions as string[] | undefined)?.filter(Boolean) ?? [];
        if (d.length >= 2 && !d.some((x) => x.length <= 60)) issues.push({ level: "adGroup", nodeKey: g.key, field: "descriptions", message: "Add at least one description of 60 characters or less." });
      }
      for (const a of g.ads) checkVideos(a.values.youtubeVideos, { level: "ad", nodeKey: a.key, field: "youtubeVideos" });
    }
    return issues;
  },
};
