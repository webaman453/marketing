/**
 * TikTok Ads Manager flow: Campaign → Ad group → Ad (API for Business v1.3).
 */
import { adGroupIs, adIs, all, any, budgetFields, campaignIs, ctaOptions, infoField, launchSection, locationsField, languagesField, nameField, not, opts, scheduleFields, setupIs, urlField, urlParamsField } from "../common";
import type { BuilderIssue, FieldContext, Option, PlatformBuilderSpec } from "../types";

export const TIKTOK_OBJECTIVES = opts([
  ["REACH", "Reach", "Show your ad to the maximum number of people."],
  ["TRAFFIC", "Traffic", "Drive people to your website or app."],
  ["VIDEO_VIEWS", "Video views", "Get more people to watch your videos."],
  ["ENGAGEMENT", "Community interaction", "Get more followers and profile visits."],
  ["APP_PROMOTION", "App promotion", "Get people to install or re-open your app."],
  ["LEAD_GENERATION", "Lead generation", "Collect leads with an instant form or your website."],
  ["WEB_CONVERSIONS", "Website conversions", "Drive valuable actions on your website."],
  ["PRODUCT_SALES", "Product sales", "Sell products from your catalog or website."],
]);

const GOALS: Record<string, Option[]> = {
  REACH: opts([["REACH", "Reach", "Billed per 1,000 impressions (CPM)"]]),
  TRAFFIC: opts([
    ["CLICK", "Clicks", "Billed per click (CPC)"],
    ["TRAFFIC_LANDING_PAGE_VIEW", "Landing page views", "People who load your page (oCPM)"],
  ]),
  VIDEO_VIEWS: opts([
    ["ENGAGED_VIEW", "6-second focused views", "Billed per view (CPV)"],
    ["ENGAGED_VIEW_FIFTEEN", "15-second focused views", "Billed per view (CPV)"],
  ]),
  ENGAGEMENT: opts([
    ["FOLLOWERS", "Followers"],
    ["PROFILE_VIEWS", "Profile visits"],
  ]),
  APP_PROMOTION: opts([
    ["INSTALL", "Install"],
    ["IN_APP_EVENT", "In-app event"],
    ["VALUE", "Value"],
    ["CLICK", "Click"],
  ]),
  LEAD_GENERATION: opts([
    ["LEAD_GENERATION", "Leads", "Instant form submissions"],
    ["CONVERT", "Website form", "Form submits on your website (pixel)"],
    ["CLICK", "Clicks"],
  ]),
  WEB_CONVERSIONS: opts([
    ["CONVERT", "Conversion", "People who complete your pixel event"],
    ["VALUE", "Value", "Highest purchase value"],
    ["TRAFFIC_LANDING_PAGE_VIEW", "Landing page view"],
    ["CLICK", "Click"],
  ]),
  PRODUCT_SALES: opts([
    ["CONVERT", "Conversion"],
    ["VALUE", "Value"],
    ["CLICK", "Click"],
  ]),
};

export const tiktokGoals = (ctx: FieldContext) => GOALS[String(ctx.setup.objective)] ?? GOALS.TRAFFIC!;

/** Billing event TikTok uses for each optimization goal. */
export const TIKTOK_BILLING: Record<string, string> = {
  REACH: "CPM",
  CLICK: "CPC",
  TRAFFIC_LANDING_PAGE_VIEW: "OCPM",
  ENGAGED_VIEW: "CPV",
  ENGAGED_VIEW_FIFTEEN: "CPV",
  FOLLOWERS: "OCPM",
  PROFILE_VIEWS: "OCPM",
  INSTALL: "OCPM",
  IN_APP_EVENT: "OCPM",
  VALUE: "OCPM",
  CONVERT: "OCPM",
  LEAD_GENERATION: "OCPM",
};

export const TIKTOK_EVENTS = opts([
  ["COMPLETE_PAYMENT", "Complete payment"],
  ["ON_WEB_ORDER", "Place an order"],
  ["INITIATE_ORDER", "Initiate checkout"],
  ["ADD_TO_CART", "Add to cart"],
  ["FORM", "Submit form"],
  ["ON_WEB_REGISTER", "Complete registration"],
  ["ON_WEB_DETAIL", "View content"],
  ["BUTTON", "Click button"],
  ["CONTACT", "Contact"],
  ["SUBSCRIBE", "Subscribe"],
]);

export const TIKTOK_CTAS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "DOWNLOAD_NOW", "INSTALL_NOW", "CONTACT_US", "APPLY_NOW", "BOOK_NOW", "ORDER_NOW", "PREORDER_NOW",
  "GET_QUOTE", "SUBSCRIBE", "WATCH_NOW", "LISTEN_NOW", "PLAY_GAME", "READ_MORE", "VIEW_NOW", "VISIT_STORE", "SEND_MESSAGE", "CALL_NOW",
  "CHECK_AVAILABILITY", "GET_TICKETS_NOW", "INTERESTED",
];

const isObjective = (...o: string[]) => setupIs("objective", ...o);
const cboOn = campaignIs("cbo", "true");
const needsPixel = all(any(isObjective("WEB_CONVERSIONS", "PRODUCT_SALES"), all(isObjective("LEAD_GENERATION"), adGroupIs("optimizationGoal", "CONVERT"))));
const isApp = isObjective("APP_PROMOTION");

export const tiktokSpec: PlatformBuilderSpec = {
  platform: "TIKTOK",
  setup: [
    { key: "objective", label: "Advertising objective", description: "What do you want people to do when they see your ads?", options: TIKTOK_OBJECTIVES },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      {
        id: "details",
        title: "Campaign details",
        fields: [
          nameField("Campaign name", "Festive Sale 2026 – Traffic", 512),
          {
            key: "appPromotionType",
            type: "radio",
            label: "App promotion type",
            showIf: isApp,
            options: opts([
              ["APP_INSTALL", "App install", "Get new users to install your app."],
              ["APP_RETARGETING", "App retargeting", "Re-engage people who already have your app."],
              ["APP_PREREGISTRATION", "Pre-registration", "Let people sign up before launch."],
            ]),
            default: "APP_INSTALL",
          },
          {
            key: "salesDestination",
            type: "radio",
            label: "Where do you sell?",
            showIf: isObjective("PRODUCT_SALES"),
            options: opts([
              ["WEBSITE", "Website", "Send shoppers to your online store."],
              ["APP", "App", "Send shoppers to your app."],
            ]),
            default: "WEBSITE",
          },
          {
            key: "specialIndustries",
            type: "checkboxes",
            label: "Special ad categories",
            help: "Declare housing, employment or credit ads. Some targeting options are restricted for these.",
            options: opts([["HOUSING", "Housing"], ["EMPLOYMENT", "Employment"], ["CREDIT", "Credit"]]),
            advanced: true,
          },
        ],
      },
      {
        id: "budget",
        title: "Budget",
        fields: [
          {
            key: "cbo",
            type: "toggle",
            label: "Campaign budget optimization",
            description: "Set one budget for the campaign; TikTok shares it across ad groups.",
            default: false,
          },
          ...budgetFields({ showIf: cboOn, help: "TikTok's minimum is about USD 50 (daily or lifetime) in your currency." }),
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      { id: "details", title: "Ad group", fields: [nameField("Ad group name", "India · 18–34 · Automatic placement", 512)] },
      {
        id: "location",
        title: "Optimization location",
        showIf: any(isObjective("TRAFFIC", "LEAD_GENERATION", "WEB_CONVERSIONS", "PRODUCT_SALES", "APP_PROMOTION")),
        fields: [
          {
            key: "promotionType",
            type: "radio",
            label: "Optimization location",
            options: (ctx) =>
              ctx.setup.objective === "APP_PROMOTION"
                ? opts([["APP_ANDROID", "Android app"], ["APP_IOS", "iOS app"]])
                : ctx.setup.objective === "LEAD_GENERATION"
                  ? opts([
                      ["LEAD_GENERATION", "Instant form", "A form that opens inside TikTok."],
                      ["WEBSITE", "Website", "Your own lead form page."],
                    ])
                  : opts([["WEBSITE", "Website"], ["APP_ANDROID", "Android app"], ["APP_IOS", "iOS app"]]),
            default: (ctx) => (ctx.setup.objective === "APP_PROMOTION" ? "APP_ANDROID" : ctx.setup.objective === "LEAD_GENERATION" ? "LEAD_GENERATION" : "WEBSITE"),
          },
          { key: "appId", type: "accountOption", source: "apps", label: "App", required: true, showIf: any(isApp, adGroupIs("promotionType", "APP_ANDROID", "APP_IOS")), autoSelect: true },
          { key: "leadFormId", type: "accountOption", source: "leadForms", label: "Instant form", showIf: all(isObjective("LEAD_GENERATION"), adGroupIs("promotionType", "LEAD_GENERATION")), help: "Leave empty to create the form in TikTok Ads Manager later." },
          { key: "pixelId", type: "accountOption", source: "pixels", label: "TikTok pixel", required: true, showIf: needsPixel, autoSelect: true },
          { key: "optimizationEvent", type: "select", label: "Optimization event", required: true, showIf: needsPixel, options: TIKTOK_EVENTS, default: (ctx) => (ctx.setup.objective === "LEAD_GENERATION" ? "FORM" : "COMPLETE_PAYMENT") },
        ],
      },
      {
        id: "placements",
        title: "Placements",
        fields: [
          {
            key: "placements",
            type: "placements",
            label: "Placements",
            autoLabel: "Automatic placement",
            autoDescription: "TikTok shows your ads where they're likely to perform best. Recommended.",
            groups: [
              {
                id: "apps",
                label: "Apps",
                items: [
                  { value: "PLACEMENT_TIKTOK", label: "TikTok", description: "For You feed and search results" },
                  { value: "PLACEMENT_PANGLE", label: "Pangle", description: "TikTok's audience network of partner apps" },
                  { value: "PLACEMENT_GLOBAL_APP_BUNDLE", label: "Global App Bundle", description: "CapCut, Fizzo and other TikTok apps" },
                ],
              },
            ],
          },
          { key: "allowComments", type: "toggle", label: "User comments", description: "Let people comment on your ads.", default: true },
          { key: "allowDownload", type: "toggle", label: "Video download", description: "Let people download your video ads.", default: false, advanced: true },
          { key: "allowShare", type: "toggle", label: "Video sharing", description: "Let people share your video ads.", default: true, advanced: true },
        ],
      },
      {
        id: "targeting",
        title: "Targeting",
        description: "Choose who sees your ads.",
        fields: [
          locationsField(),
          {
            key: "ageGroups",
            type: "checkboxes",
            label: "Age",
            help: "Leave all unchecked to reach every age (18+ in most regions).",
            options: opts([["AGE_18_24", "18–24"], ["AGE_25_34", "25–34"], ["AGE_35_44", "35–44"], ["AGE_45_54", "45–54"], ["AGE_55_100", "55+"]]),
          },
          { key: "gender", type: "segmented", label: "Gender", options: opts([["GENDER_UNLIMITED", "All"], ["GENDER_FEMALE", "Female"], ["GENDER_MALE", "Male"]]), default: "GENDER_UNLIMITED" },
          languagesField(),
          { key: "interests", type: "targeting", kind: "interest", label: "Interests", help: "Interest categories based on what people watch and engage with.", max: 50, ai: { purpose: "TikTok interest categories for the product" } },
          { key: "behaviors", type: "targeting", kind: "behavior", label: "Video interactions", help: "People who watched, liked, commented on or shared related videos.", max: 50, advanced: true },
          { key: "smartTargeting", type: "toggle", label: "Targeting expansion", description: "Let TikTok reach beyond your interests when it improves results.", default: true },
          { key: "operatingSystems", type: "checkboxes", label: "Operating system", options: opts([["ANDROID", "Android"], ["IOS", "iOS"]]), help: "Leave unchecked for both.", advanced: true },
          { key: "networkTypes", type: "checkboxes", label: "Connection type", options: opts([["WIFI", "Wi-Fi"], ["4G", "4G"], ["5G", "5G"], ["3G", "3G"]]), advanced: true },
          { key: "spendingPower", type: "segmented", label: "Spending power", options: opts([["ALL", "All"], ["HIGH", "High"]]), default: "ALL", advanced: true },
        ],
      },
      {
        id: "budget",
        title: "Budget & schedule",
        fields: [
          ...budgetFields({ showIf: not(cboOn), help: "TikTok's ad group minimum is about USD 20 per day in your currency." }),
          infoField("cboInfo", "Campaign budget optimization is on", "This ad group uses the campaign budget.", "info", cboOn),
          {
            key: "scheduleType",
            type: "radio",
            label: "Schedule",
            options: opts([
              ["SCHEDULE_FROM_NOW", "Run continuously", "Start after approval and keep running."],
              ["SCHEDULE_START_END", "Set a start and end time", "Required for lifetime budgets."],
            ]),
            default: "SCHEDULE_FROM_NOW",
          },
          ...scheduleFields({ datetime: true, endRequired: () => true, showIf: adGroupIs("scheduleType", "SCHEDULE_START_END") }),
          { key: "dayparting", type: "adSchedule", label: "Dayparting", help: "Only show ads at certain times of day (account time zone).", advanced: true },
          {
            key: "pacing",
            type: "segmented",
            label: "Budget pacing",
            options: opts([["PACING_MODE_SMOOTH", "Standard"], ["PACING_MODE_FAST", "Accelerated"]]),
            default: "PACING_MODE_SMOOTH",
            advanced: true,
          },
        ],
      },
      {
        id: "bidding",
        title: "Bidding & optimization",
        fields: [
          { key: "optimizationGoal", type: "radio", label: "Optimization goal", options: tiktokGoals, default: (ctx) => tiktokGoals(ctx)[0]!.value },
          {
            key: "bidStrategy",
            type: "radio",
            label: "Bid strategy",
            options: opts([
              ["BID_TYPE_NO_BID", "Maximum delivery", "Spend your budget to get the most results. Recommended."],
              ["BID_TYPE_CUSTOM", "Cost cap / bid cap", "Keep the average cost (or bid) at or below an amount."],
            ]),
            default: "BID_TYPE_NO_BID",
          },
          { key: "bidAmount", type: "money", label: "Cost or bid amount", required: true, min: 0.01, showIf: adGroupIs("bidStrategy", "BID_TYPE_CUSTOM"), width: "half" },
          {
            key: "frequencyCap",
            type: "number",
            label: "Frequency cap (impressions per 7 days)",
            min: 1,
            max: 30,
            default: 3,
            showIf: isObjective("REACH"),
            width: "half",
          },
          {
            key: "clickWindow",
            type: "select",
            label: "Click-through attribution window",
            options: opts([["ONE_DAY", "1 day"], ["SEVEN_DAYS", "7 days"], ["FOURTEEN_DAYS", "14 days"], ["TWENTY_EIGHT_DAYS", "28 days"]]),
            default: "SEVEN_DAYS",
            showIf: needsPixel,
            advanced: true,
            width: "half",
          },
          {
            key: "viewWindow",
            type: "select",
            label: "View-through attribution window",
            options: opts([["OFF", "Off"], ["ONE_DAY", "1 day"], ["SEVEN_DAYS", "7 days"]]),
            default: "ONE_DAY",
            showIf: needsPixel,
            advanced: true,
            width: "half",
          },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      { id: "details", title: "Ad details", fields: [nameField("Ad name", "Festive collection · 15s", 512)] },
      {
        id: "identity",
        title: "Identity",
        description: "The name and profile picture people see on your ad.",
        fields: [
          {
            key: "identityType",
            type: "radio",
            label: "Identity",
            options: opts([
              ["CUSTOMIZED_USER", "Custom identity", "A display name and picture just for ads."],
              ["TT_USER", "TikTok account", "Run ads from your linked TikTok account (Spark Ads)."],
            ]),
            default: "CUSTOMIZED_USER",
          },
          { key: "displayName", type: "text", label: "Display name", placeholder: "Your brand", required: true, maxLength: 40, showIf: adIs("identityType", "CUSTOMIZED_USER"), width: "half" },
          { key: "avatar", type: "media", label: "Profile image", accept: ["IMAGE"], min: 0, max: 1, ratios: ["1:1"], requiredRatio: "1:1", showIf: adIs("identityType", "CUSTOMIZED_USER"), specs: "Square, at least 98×98 px." },
          { key: "identityId", type: "accountOption", source: "identities", label: "TikTok account", required: true, showIf: adIs("identityType", "TT_USER"), autoSelect: true },
        ],
      },
      {
        id: "creative",
        title: "Ad creative",
        fields: [
          {
            key: "format",
            type: "cards",
            label: "Format",
            options: [
              { value: "SINGLE_VIDEO", label: "Single video", description: "Full-screen video in the For You feed.", icon: "Film" },
              { value: "CAROUSEL_ADS", label: "Carousel", description: "2–35 swipeable images with music.", icon: "GalleryHorizontal" },
              { value: "SINGLE_IMAGE", label: "Single image", description: "Pangle and Global App Bundle only.", icon: "Image" },
            ],
            default: "SINGLE_VIDEO",
          },
          { key: "video", type: "media", label: "Video", accept: ["VIDEO"], min: 1, max: 1, required: true, ratios: ["9:16", "1:1", "16:9"], showIf: adIs("format", "SINGLE_VIDEO"), specs: "9:16 recommended, 720×1280 px or larger, 5–60 seconds, with sound." },
          { key: "images", type: "media", label: "Images", accept: ["IMAGE"], min: 2, max: 35, required: true, ratios: ["9:16", "1:1"], showIf: adIs("format", "CAROUSEL_ADS"), specs: "2 to 35 images, same aspect ratio." },
          { key: "image", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["1.91:1", "1:1", "9:16"], showIf: adIs("format", "SINGLE_IMAGE"), specs: "1200×628, 640×640 or 720×1280 px." },
          { key: "adText", type: "textarea", label: "Ad text", required: true, maxLength: 100, rows: 2, placeholder: "Festive drops are here. Shop the edit before it's gone ✨", ai: { purpose: "TikTok caption, native and casual, one emoji at most" } },
          { key: "cta", type: "select", label: "Call to action", options: ctaOptions(TIKTOK_CTAS), default: (ctx) => ({ PRODUCT_SALES: "SHOP_NOW", WEB_CONVERSIONS: "SHOP_NOW", APP_PROMOTION: "DOWNLOAD_NOW", LEAD_GENERATION: "SIGN_UP" })[String(ctx.setup.objective)] ?? "LEARN_MORE" },
          urlField({ showIf: not(isApp) }),
          urlParamsField(),
          { key: "deeplink", type: "url", label: "Deep link", placeholder: "myapp://product/123", advanced: true, required: false, showIf: isApp },
        ],
      },
      {
        id: "tracking",
        title: "Tracking",
        fields: [
          { key: "trackingPixelId", type: "accountOption", source: "pixels", label: "Website events (pixel)", advanced: true, autoSelect: true },
          { key: "impressionTrackingUrl", type: "url", label: "Impression tracking URL", placeholder: "https://track.example.com/imp", required: false, advanced: true },
          { key: "clickTrackingUrl", type: "url", label: "Click tracking URL", placeholder: "https://track.example.com/click", required: false, advanced: true },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 20,
  previews: () => ["tiktok_feed"],
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    for (const g of draft.adGroups) {
      const p = g.values.placements as { mode: string; items: string[] } | undefined;
      const tiktokOnly = p?.mode === "MANUAL" && p.items.length === 1 && p.items[0] === "PLACEMENT_TIKTOK";
      for (const a of g.ads) {
        if (a.values.format === "SINGLE_IMAGE" && (p?.mode !== "MANUAL" || p.items.includes("PLACEMENT_TIKTOK"))) {
          issues.push({ level: "ad", nodeKey: a.key, field: "format", message: "Single image ads only run on Pangle and Global App Bundle. Choose those placements, or use video or carousel." });
        }
        if (a.values.format === "CAROUSEL_ADS" && p?.mode === "MANUAL" && !tiktokOnly && !p.items.includes("PLACEMENT_TIKTOK")) {
          issues.push({ level: "ad", nodeKey: a.key, field: "format", message: "Carousel ads need the TikTok placement." });
        }
      }
      if (!draft.campaign.cbo && g.values.budgetType === "LIFETIME" && g.values.scheduleType !== "SCHEDULE_START_END") {
        issues.push({ level: "adGroup", nodeKey: g.key, field: "scheduleType", message: "Lifetime budgets need a start and end time." });
      }
    }
    return issues;
  },
};
