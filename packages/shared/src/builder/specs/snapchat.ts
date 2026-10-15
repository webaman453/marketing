/**
 * Snapchat Ads Manager flow: Campaign → Ad squad → Ad (Marketing API v1).
 */
import { adGroupIs, adIs, budgetFields, ctaOptions, launchSection, locationsField, languagesField, nameField, not, opts, scheduleFields, urlField } from "../common";
import type { FieldContext, Option, PlatformBuilderSpec } from "../types";

export const SNAP_OBJECTIVES = opts([
  ["AWARENESS_AND_ENGAGEMENT", "Awareness & engagement", "Reach Snapchatters and build interest in your brand."],
  ["TRAFFIC", "Traffic", "Send Snapchatters to your website or app."],
  ["APP_PROMOTION", "App promotion", "Get installs and re-engage app users."],
  ["LEADS", "Leads", "Collect leads with an instant form or your website."],
  ["SALES", "Sales", "Drive purchases on your website or app."],
]);

const GOALS: Record<string, Option[]> = {
  AWARENESS_AND_ENGAGEMENT: opts([["IMPRESSIONS", "Impressions"], ["SWIPES", "Swipe ups"], ["VIDEO_VIEWS", "Video views (2s)"], ["VIDEO_VIEWS_15_SEC", "15-second video views"], ["STORY_OPENS", "Story opens"]]),
  TRAFFIC: opts([["SWIPES", "Swipe ups"], ["LANDING_PAGE_VIEW", "Landing page views"], ["PIXEL_PAGE_VIEW", "Page views (pixel)"]]),
  APP_PROMOTION: opts([["APP_INSTALLS", "App installs"], ["APP_PURCHASE", "App purchases"], ["APP_SIGNUP", "App sign-ups"], ["APP_REENGAGE_OPEN", "App opens"], ["SWIPES", "Swipe ups"]]),
  LEADS: opts([["LEAD_FORM_SUBMISSIONS", "Lead form submissions"], ["PIXEL_SIGNUP", "Sign-ups (pixel)"], ["LANDING_PAGE_VIEW", "Landing page views"]]),
  SALES: opts([["PIXEL_PURCHASE", "Purchases"], ["PIXEL_ADD_TO_CART", "Add to cart"], ["PIXEL_PAGE_VIEW", "Page views"], ["PIXEL_SIGNUP", "Sign-ups"], ["LANDING_PAGE_VIEW", "Landing page views"]]),
};
const snapGoals = (ctx: FieldContext) => GOALS[String(ctx.setup.objective)] ?? GOALS.TRAFFIC!;

export const SNAP_WEB_CTAS = ["MORE", "SHOP_NOW", "SIGN_UP", "ORDER_NOW", "APPLY_NOW", "BOOK_NOW", "GET_NOW", "VIEW", "WATCH", "READ", "DOWNLOAD", "LISTEN", "TRY", "BUY_TICKETS", "VIEW_MENU", "PLAY_GAME", "DONATE", "VOTE"];
export const SNAP_APP_CTAS = ["INSTALL_NOW", "DOWNLOAD", "PLAY", "SHOP_NOW", "SIGN_UP", "GET_NOW", "TRY", "USE_APP", "ORDER_NOW", "BOOK_NOW", "PLAY_GAME"];
export const SNAP_LEAD_CTAS = ["SIGN_UP", "APPLY_NOW", "MORE", "BOOK_NOW", "GET_NOW", "REQUEST_QUOTE", "REQUEST_APPOINTMENT", "FREE_TRIAL", "GET_COUPON", "TEST_DRIVE"];

const pixelGoal = (ctx: FieldContext) => String(ctx.adGroup.optimizationGoal ?? "").startsWith("PIXEL_");

export const snapchatSpec: PlatformBuilderSpec = {
  platform: "SNAPCHAT",
  setup: [{ key: "objective", label: "Objective", description: "What's the goal of this campaign?", options: SNAP_OBJECTIVES }],
  campaign: {
    label: "Campaign",
    sections: [
      {
        id: "details",
        title: "Campaign details",
        fields: [
          nameField("Campaign name", "Festive Sale – Snap Ads", 375),
          ...scheduleFields(),
          { key: "spendCap", type: "money", label: "Campaign spend cap (optional)", min: 20, help: "Total the campaign may spend across all ad squads. Minimum about USD 20.", width: "half", advanced: true },
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad squad",
    sections: [
      { id: "details", title: "Ad squad", fields: [nameField("Ad squad name", "India · 18–34 · Auto placements", 375)] },
      {
        id: "placements",
        title: "Placements",
        fields: [
          {
            key: "placements",
            type: "placements",
            label: "Placements",
            autoLabel: "Automatic placements",
            autoDescription: "Snapchat shows your ads wherever they perform best. Recommended.",
            groups: [
              {
                id: "content",
                label: "Content",
                items: [
                  { value: "INTERSTITIAL_USER", label: "Between Friends' Stories" },
                  { value: "INTERSTITIAL_CONTENT", label: "Between Publisher & Creator Stories" },
                  { value: "INSTREAM", label: "Within Publisher & Creator Stories" },
                  { value: "INTERSTITIAL_SPOTLIGHT", label: "Spotlight" },
                  { value: "FEED", label: "Discover feed" },
                  { value: "CAMERA", label: "AR Lenses" },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "audience",
        title: "Audience",
        fields: [
          locationsField(),
          { key: "age", type: "ageRange", label: "Age", min: 13, max: 50, openEnded: true, default: { min: 18, max: 50 } },
          { key: "gender", type: "segmented", label: "Gender", options: opts([["ALL", "All"], ["FEMALE", "Female"], ["MALE", "Male"]]), default: "ALL" },
          languagesField({ help: "Required by Snapchat when you target more than one country." }),
          { key: "interests", type: "targeting", kind: "interest", label: "Snap Lifestyle Categories", help: "Interests based on what people watch and do on Snapchat.", ai: { purpose: "Snapchat lifestyle categories" } },
          { key: "operatingSystems", type: "checkboxes", label: "Device OS", options: opts([["iOS", "iOS"], ["ANDROID", "Android"]]), help: "Leave unchecked for both.", advanced: true },
          { key: "connectionType", type: "segmented", label: "Connection", options: opts([["ALL", "All"], ["WIFI", "Wi-Fi only"], ["CELL", "Cellular only"]]), default: "ALL", advanced: true },
          { key: "audienceExpansion", type: "toggle", label: "Expand audience", description: "Let Snapchat find more people likely to respond.", default: true },
        ],
      },
      {
        id: "budget",
        title: "Budget & goal",
        fields: [
          ...budgetFields({ min: 1, help: "Snapchat's minimum is about USD 5 per day per ad squad. Ad squads run on the campaign's dates." }),
          { key: "optimizationGoal", type: "radio", label: "Goal", options: snapGoals, default: (ctx) => snapGoals(ctx)[0]!.value },
          { key: "pixelId", type: "accountOption", source: "pixels", label: "Snap Pixel", required: true, showIf: pixelGoal, autoSelect: true },
          {
            key: "bidStrategy",
            type: "radio",
            label: "Bid strategy",
            options: opts([
              ["AUTO_BID", "Auto-bid", "Get the most results for your budget. Recommended."],
              ["LOWEST_COST_WITH_MAX_BID", "Max bid", "Never bid more than an amount."],
              ["TARGET_COST", "Target cost", "Keep the average cost near an amount."],
            ]),
            default: "AUTO_BID",
          },
          { key: "bidAmount", type: "money", label: "Bid amount", required: true, min: 0.01, showIf: adGroupIs("bidStrategy", "LOWEST_COST_WITH_MAX_BID", "TARGET_COST"), width: "half" },
          {
            key: "attribution",
            type: "select",
            label: "Attribution window",
            options: opts([["SWIPE_28DAY_VIEW_1DAY", "28-day swipe, 1-day view"], ["SWIPE_7DAY", "7-day swipe"]]),
            default: "SWIPE_28DAY_VIEW_1DAY",
            advanced: true,
            showIf: pixelGoal,
          },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "identity",
        title: "Ad details",
        fields: [
          nameField("Ad name", "Festive drop · Video", 375),
          { key: "profileId", type: "accountOption", source: "profiles", label: "Public profile", required: true, autoSelect: true, help: "The brand profile your ad runs from." },
          { key: "brandName", type: "text", label: "Brand name", placeholder: "Your brand", required: true, maxLength: 25, width: "half" },
          { key: "headline", type: "text", label: "Headline", placeholder: "Festive sale is live", required: true, maxLength: 34, width: "half", ai: { purpose: "short Snapchat headline" } },
        ],
      },
      {
        id: "creative",
        title: "Creative",
        fields: [
          {
            key: "format",
            type: "cards",
            label: "Ad type",
            options: [
              { value: "SINGLE", label: "Single image or video", description: "A full-screen vertical Snap.", icon: "Smartphone" },
              { value: "STORY", label: "Story ad", description: "A branded tile in Discover that opens 3–20 Snaps.", icon: "Layers" },
            ],
            default: "SINGLE",
          },
          { key: "media", type: "media", label: "Top Snap", accept: ["IMAGE", "VIDEO"], min: 1, max: 1, required: true, ratios: ["9:16"], requiredRatio: "9:16", showIf: adIs("format", "SINGLE"), specs: "1080×1920 px (9:16). Video 3–180 seconds, MP4 or MOV. Keep the top 150 px and bottom 340 px clear." },
          { key: "storySnaps", type: "media", label: "Story Snaps", accept: ["IMAGE", "VIDEO"], min: 3, max: 20, required: true, ratios: ["9:16"], requiredRatio: "9:16", showIf: adIs("format", "STORY") },
          { key: "tileImage", type: "media", label: "Story tile image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["3:5"], showIf: adIs("format", "STORY"), specs: "360×600 px" },
          { key: "tileHeadline", type: "text", label: "Tile headline", placeholder: "Festive sale: up to 50% off", required: true, maxLength: 55, showIf: adIs("format", "STORY") },
          {
            key: "attachment",
            type: "radio",
            label: "Attachment",
            options: (ctx) =>
              ctx.setup.objective === "APP_PROMOTION"
                ? opts([["APP_INSTALL", "App install"], ["DEEP_LINK", "Deep link"]])
                : ctx.setup.objective === "LEADS"
                  ? opts([["LEAD_GENERATION", "Instant form"], ["WEB_VIEW", "Website"]])
                  : opts([["WEB_VIEW", "Website"], ["NONE", "None"]]),
            default: (ctx) => (ctx.setup.objective === "APP_PROMOTION" ? "APP_INSTALL" : ctx.setup.objective === "LEADS" ? "LEAD_GENERATION" : "WEB_VIEW"),
          },
          urlField({ showIf: adIs("attachment", "WEB_VIEW") }),
          { key: "appId", type: "text", label: "App", required: true, maxLength: 300, placeholder: "com.yourcompany.app or 1234567890", help: "Android package name or iOS App Store ID.", showIf: adIs("attachment", "APP_INSTALL", "DEEP_LINK") },
          { key: "deeplink", type: "url", label: "Deep link URL", placeholder: "yourapp://sale", required: true, showIf: adIs("attachment", "DEEP_LINK") },
          { key: "leadFormId", type: "accountOption", source: "leadForms", label: "Instant form", required: true, showIf: adIs("attachment", "LEAD_GENERATION") },
          {
            key: "cta",
            type: "select",
            label: "Call to action",
            showIf: not(adIs("attachment", "NONE")),
            options: (ctx) => ctaOptions(ctx.ad.attachment === "APP_INSTALL" || ctx.ad.attachment === "DEEP_LINK" ? SNAP_APP_CTAS : ctx.ad.attachment === "LEAD_GENERATION" ? SNAP_LEAD_CTAS : SNAP_WEB_CTAS),
            default: (ctx) => (ctx.setup.objective === "APP_PROMOTION" ? "INSTALL_NOW" : ctx.setup.objective === "LEADS" ? "SIGN_UP" : ctx.setup.objective === "SALES" ? "SHOP_NOW" : "MORE"),
          },
          { key: "shareable", type: "toggle", label: "Allow sharing", description: "Snapchatters can share your ad with friends.", default: true, advanced: true },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 20,
  previews: () => ["snap_story"],
  validate: (draft) => [
    ...(draft.adGroups.some((g) => g.values.budgetType === "LIFETIME") && !draft.campaign.endDate
      ? [{ level: "campaign" as const, field: "endDate", message: "Lifetime budgets need an end date on the campaign." }]
      : []),
    ...draft.adGroups.flatMap((g) => {
      const age = g.values.age as { min: number; max: number } | undefined;
      return age && age.min < 18 && ["SALES", "LEADS"].includes(String(draft.setup.objective))
        ? [{ level: "adGroup" as const, nodeKey: g.key, field: "age", message: "Sales and lead campaigns must target 18 and over." }]
        : [];
    }),
  ],
};
