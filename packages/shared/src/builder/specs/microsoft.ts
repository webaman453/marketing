/**
 * Microsoft Advertising flow: Campaign → Ad group (or asset group) → Ads
 * (Campaign Management API v13).
 */
import { budgetFields, campaignIs, ctaOptions, infoField, launchSection, locationsField, nameField, opts, scheduleFields, setupIs, urlField } from "../common";
import { LANGUAGES } from "../geo";
import type { Field, LevelSpec, PlatformBuilderSpec } from "../types";
import { keywordsField, negativeKeywordsField, rsaSections } from "./search-ads";

const type = (...t: string[]) => setupIs("campaignType", ...t);

export const MICROSOFT_CTAS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "CONTACT_US", "BOOK_NOW", "GET_QUOTE", "APPLY_NOW", "DOWNLOAD", "SUBSCRIBE", "ORDER_NOW", "REGISTER_NOW", "VISIT_SITE",
];

const BID_OPTIONS: Record<string, [string, string, string?][]> = {
  SEARCH: [
    ["MaxConversions", "Maximize conversions", "Get the most conversions for your budget."],
    ["MaxConversionValue", "Maximize conversion value", "Get the most revenue for your budget."],
    ["MaxClicks", "Maximize clicks", "Get as many clicks as possible."],
    ["TargetImpressionShare", "Target impression share", "Show at the top of results a set share of the time."],
    ["EnhancedCpc", "Enhanced CPC", "Your bids, adjusted for each search."],
  ],
  PERFORMANCE_MAX: [
    ["MaxConversions", "Maximize conversions"],
    ["MaxConversionValue", "Maximize conversion value"],
  ],
  AUDIENCE: [
    ["MaxConversions", "Maximize conversions"],
    ["MaxClicks", "Maximize clicks"],
    ["EnhancedCpc", "Enhanced CPC"],
    ["ManualCpc", "Manual CPC"],
  ],
};

const bidIs = (...b: string[]) => campaignIs("bidStrategy", ...b);

const campaign: LevelSpec = {
  label: "Campaign",
  sections: [
    {
      id: "details",
      title: "Campaign settings",
      fields: [
        nameField("Campaign name", "Brand – Search – India", 128),
        { key: "conversionGoals", type: "accountOption", source: "conversionActions", label: "Conversion goals", multiple: true, help: "Which UET conversion goals this campaign optimizes for." },
      ],
    },
    {
      id: "budget",
      title: "Budget & bidding",
      fields: [
        ...budgetFields({ lifetime: false, min: 1, help: "Microsoft may spend up to twice your daily budget on some days, but never more than daily budget × 30.4 in a month." }),
        { key: "bidStrategy", type: "radio", label: "Bid strategy", options: (ctx) => opts(BID_OPTIONS[String(ctx.setup.campaignType)] ?? BID_OPTIONS.SEARCH!), default: (ctx) => (BID_OPTIONS[String(ctx.setup.campaignType)] ?? BID_OPTIONS.SEARCH!)[0]![0] },
        infoField(
          "conversionTip",
          "Needs conversion tracking",
          "Conversion bidding learns from your UET conversion goals. Pick one above, or use Maximize clicks until tracking is set up.",
          "warning",
          (ctx) => bidIs("MaxConversions", "MaxConversionValue")(ctx) && !(Array.isArray(ctx.campaign.conversionGoals) && ctx.campaign.conversionGoals.length > 0),
        ),
        { key: "targetCpa", type: "money", label: "Target CPA (optional)", min: 0.01, showIf: bidIs("MaxConversions"), width: "half" },
        { key: "targetRoas", type: "percent", label: "Target ROAS % (optional)", min: 1, max: 100000, showIf: bidIs("MaxConversionValue"), width: "half" },
        { key: "maxCpc", type: "money", label: "Maximum CPC bid limit", min: 0.01, showIf: bidIs("MaxClicks", "TargetImpressionShare"), width: "half" },
        {
          key: "impressionSharePosition",
          type: "select",
          label: "Where your ad appears",
          options: opts([["TopPage", "Top of page"], ["Absolute1", "Absolute top of page"], ["Anywhere", "Anywhere on results page"]]),
          default: "TopPage",
          showIf: bidIs("TargetImpressionShare"),
          width: "half",
        },
        { key: "impressionShareTarget", type: "percent", label: "Impression share target %", min: 1, max: 100, default: 70, showIf: bidIs("TargetImpressionShare"), width: "half" },
      ],
    },
    {
      id: "targeting",
      title: "Locations, languages and devices",
      fields: [
        locationsField(),
        {
          key: "locationIntent",
          type: "radio",
          label: "Location options",
          options: opts([
            ["PeopleInOrSearchingForOrViewingPages", "People in, or who show interest in, your locations", "Recommended."],
            ["PeopleIn", "People in your locations"],
          ]),
          default: "PeopleInOrSearchingForOrViewingPages",
          advanced: true,
        },
        {
          key: "languages",
          type: "multiSelect",
          label: "Ad languages",
          options: LANGUAGES.filter((l) => ["en", "fr", "de", "es", "pt", "it", "nl", "sv", "da", "no", "fi", "pl", "ja", "zh", "hi", "ar", "ko"].includes(l.code)).map((l) => ({ value: l.code, label: l.name })),
          default: ["en"],
          required: true,
          showIf: (ctx) => ctx.setup.campaignType !== "AUDIENCE",
        },
        infoField("audienceLanguage", "All languages", "Audience campaigns always target all languages.", "info", type("AUDIENCE")),
        { key: "devices", type: "checkboxes", label: "Devices", options: opts([["Computers", "Computers"], ["Smartphones", "Smartphones"], ["Tablets", "Tablets"]]), default: ["Computers", "Smartphones", "Tablets"], advanced: true },
        { key: "adSchedule", type: "adSchedule", label: "Ad schedule", help: "Only show ads on certain days and hours.", advanced: true },
        ...scheduleFields({ showIf: type("AUDIENCE") }),
      ],
    },
    {
      id: "tracking",
      title: "Tracking",
      fields: [
        { key: "trackingTemplate", type: "text", label: "Tracking template", placeholder: "{lpurl}?utm_source=bing&utm_medium=cpc", maxLength: 2048, advanced: true },
        { key: "finalUrlSuffix", type: "text", label: "Final URL suffix", placeholder: "utm_campaign={CampaignId}", maxLength: 2048, advanced: true },
        {
          key: "pmaxUrlExpansion",
          type: "toggle",
          label: "Final URL expansion",
          description: "Let Microsoft send traffic to the most relevant page on your site.",
          default: true,
          showIf: type("PERFORMANCE_MAX"),
        },
      ],
    },
    launchSection(),
  ],
};

const searchAdGroup: Field[] = [
  nameField("Ad group name", "Ethnic wear – Women", 256),
  {
    key: "network",
    type: "radio",
    label: "Networks",
    options: opts([
      ["OwnedAndOperatedAndSyndicatedSearch", "Bing, AOL, Yahoo and syndicated partners", "Recommended."],
      ["OwnedAndOperatedOnly", "Bing, AOL and Yahoo only"],
      ["SyndicatedSearchOnly", "Syndicated search partners only"],
    ]),
    default: "OwnedAndOperatedAndSyndicatedSearch",
    advanced: true,
  },
  { key: "defaultBid", type: "money", label: "Default keyword bid", min: 0.01, help: "Used by Enhanced CPC; other strategies set bids automatically.", width: "half", showIf: (ctx) => ["EnhancedCpc", "ManualCpc"].includes(String(ctx.campaign.bidStrategy)) },
  keywordsField(),
  negativeKeywordsField(),
  {
    key: "rotation",
    type: "segmented",
    label: "Ad rotation",
    options: opts([["OptimizeForClicks", "Optimize"], ["RotateAdsEvenly", "Rotate evenly"]]),
    default: "OptimizeForClicks",
    advanced: true,
  },
];

const pmaxAssetGroup: Field[] = [
  nameField("Asset group name", "Festive collection", 256),
  urlField({ key: "finalUrl", label: "Final URL" }),
  { key: "businessName", type: "text", label: "Business name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
  { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 3, max: 15, initial: 5, maxLength: 30, required: true, ai: { purpose: "short headlines" } },
  { key: "longHeadlines", type: "textList", label: "Long headlines", itemLabel: "Long headline", min: 1, max: 5, initial: 1, maxLength: 90, required: true, ai: { purpose: "long headlines" } },
  { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 2, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, ai: { purpose: "descriptions" } },
  { key: "landscapeImages", type: "media", label: "Landscape images", accept: ["IMAGE"], min: 1, max: 20, required: true, ratios: ["1.91:1"], requiredRatio: "1.91:1", specs: "1.91:1, at least 1200×628 px." },
  { key: "squareImages", type: "media", label: "Square images", accept: ["IMAGE"], min: 1, max: 20, required: true, ratios: ["1:1"], requiredRatio: "1:1", specs: "1:1, at least 1200×1200 px." },
  { key: "logos", type: "media", label: "Logos", accept: ["IMAGE"], min: 1, max: 5, required: true, ratios: ["1:1", "4:1"], specs: "1:1 (1200×1200) or 4:1 (1200×300)." },
  { key: "cta", type: "select", label: "Call to action", options: ctaOptions(MICROSOFT_CTAS), default: "LEARN_MORE", width: "half" },
  { key: "searchThemes", type: "textList", label: "Search themes", itemLabel: "Search theme", min: 0, max: 25, initial: 0, maxLength: 80, help: "Topics people search for that fit this asset group.", ai: { purpose: "search themes" } },
  { key: "audienceSignals", type: "targeting", kind: "interest", label: "Audience signals", help: "In-market audiences that hint at who converts.", advanced: true },
];

const audienceAdGroup: Field[] = [
  nameField("Ad group name", "In-market · Fashion", 256),
  { key: "ageRanges", type: "checkboxes", label: "Age", options: opts([["EighteenToTwentyFour", "18–24"], ["TwentyFiveToThirtyFour", "25–34"], ["ThirtyFiveToFortyNine", "35–49"], ["FiftyToSixtyFour", "50–64"], ["SixtyFiveAndAbove", "65+"]]) },
  { key: "gender", type: "segmented", label: "Gender", options: opts([["ALL", "All"], ["Female", "Female"], ["Male", "Male"]]), default: "ALL" },
  { key: "audiences", type: "targeting", kind: "interest", label: "Audiences", help: "In-market and custom audiences.", ai: { purpose: "in-market audiences" } },
  { key: "defaultBid", type: "money", label: "Default bid", min: 0.01, width: "half", showIf: (ctx) => ["EnhancedCpc", "ManualCpc"].includes(String(ctx.campaign.bidStrategy)) },
];

const audienceAd: LevelSpec = {
  label: "Ad",
  sections: [
    {
      id: "ad",
      title: "Responsive ad",
      description: "Shown across the Microsoft Audience Network: MSN, Outlook, Microsoft Edge and partner sites.",
      fields: [
        urlField({ key: "finalUrl", label: "Final URL" }),
        { key: "businessName", type: "text", label: "Business name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
        { key: "headlines", type: "textList", label: "Short headlines", itemLabel: "Headline", min: 1, max: 15, initial: 3, maxLength: 30, required: true, ai: { purpose: "short headlines" } },
        { key: "longHeadlines", type: "textList", label: "Long headlines", itemLabel: "Long headline", min: 1, max: 5, initial: 1, maxLength: 90, required: true, ai: { purpose: "long headlines" } },
        { key: "descriptions", type: "textList", label: "Descriptions", itemLabel: "Description", min: 1, max: 5, initial: 2, maxLength: 90, required: true, multiline: true, ai: { purpose: "descriptions" } },
        { key: "landscapeImages", type: "media", label: "Landscape images", accept: ["IMAGE"], min: 1, max: 16, required: true, ratios: ["1.91:1"], requiredRatio: "1.91:1", specs: "1.91:1, at least 1200×628 px." },
        { key: "squareImages", type: "media", label: "Square images", accept: ["IMAGE"], min: 0, max: 16, ratios: ["1:1"], requiredRatio: "1:1" },
        { key: "logos", type: "media", label: "Logo", accept: ["IMAGE"], min: 0, max: 5, ratios: ["1:1", "4:1"] },
        { key: "cta", type: "select", label: "Call to action", options: ctaOptions(MICROSOFT_CTAS), default: "LEARN_MORE", width: "half" },
      ],
    },
  ],
};

export const microsoftSpec: PlatformBuilderSpec = {
  platform: "MICROSOFT",
  setup: [
    {
      key: "campaignType",
      label: "Campaign type",
      description: "Choose where your ads appear on the Microsoft network.",
      options: [
        { value: "SEARCH", label: "Search", description: "Text ads on Bing, Yahoo and AOL search results.", icon: "Search" },
        { value: "PERFORMANCE_MAX", label: "Performance Max", description: "One campaign across search and the Microsoft Audience Network.", icon: "Sparkles" },
        { value: "AUDIENCE", label: "Audience", description: "Image ads on MSN, Outlook, Edge and partner sites.", icon: "LayoutGrid" },
        { value: "SHOPPING", label: "Shopping", description: "Product ads from your Merchant Center store.", icon: "ShoppingBag", disabled: true, disabledReason: "Needs a Merchant Center store; create it in Microsoft Advertising." },
      ],
    },
  ],
  campaign,
  adGroup: {
    label: "Ad group",
    sections: [
      { id: "search", title: "Ad group", showIf: type("SEARCH"), fields: searchAdGroup },
      { id: "pmax", title: "Asset group", description: "Microsoft combines these assets into ads for each placement.", showIf: type("PERFORMANCE_MAX"), fields: pmaxAssetGroup },
      { id: "audience", title: "Ad group", showIf: type("AUDIENCE"), fields: audienceAdGroup },
    ],
  },
  ad: (setup) => {
    if (setup.campaignType === "PERFORMANCE_MAX") return null;
    if (setup.campaignType === "AUDIENCE") return audienceAd;
    return { label: "Ad", sections: rsaSections({ platformName: "Microsoft" }) };
  },
  maxAdGroups: 20,
  maxAds: 3,
  previews: (ctx) => (ctx.setup.campaignType === "AUDIENCE" ? ["bing_audience"] : ctx.setup.campaignType === "PERFORMANCE_MAX" ? ["bing_search", "bing_audience"] : ["bing_search"]),
};
