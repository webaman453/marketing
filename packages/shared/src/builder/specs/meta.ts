/**
 * Meta Ads Manager flow (outcome-based objectives): Campaign → Ad set → Ad
 * (Marketing API).
 */
import { adGroupIs, adIs, all, any, budgetFields, campaignIs, ctaOptions, infoField, launchSection, locationsField, languagesField, nameField, not, opts, scheduleFields, setupIs, urlField, urlParamsField } from "../common";
import { COUNTRIES } from "../geo";
import type { BuilderIssue, FieldContext, Option, PlacementPreview, PlatformBuilderSpec, TargetingValue } from "../types";

export const META_OBJECTIVES: Option[] = [
  { value: "OUTCOME_AWARENESS", label: "Awareness", description: "Show your ads to people who are most likely to remember them.", icon: "Megaphone" },
  { value: "OUTCOME_TRAFFIC", label: "Traffic", description: "Send people to a destination, like your website, app or Instagram profile.", icon: "MousePointerClick" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement", description: "Get more messages, video views, post engagement or Page likes.", icon: "MessageCircle" },
  { value: "OUTCOME_LEADS", label: "Leads", description: "Collect leads with instant forms, messages, calls or your website.", icon: "Filter" },
  { value: "OUTCOME_APP_PROMOTION", label: "App promotion", description: "Find new people to install your app and keep using it.", icon: "Smartphone" },
  { value: "OUTCOME_SALES", label: "Sales", description: "Find people likely to purchase your product or service.", icon: "ShoppingBag" },
];

const LOCATIONS: Record<string, Option[]> = {
  OUTCOME_AWARENESS: [],
  OUTCOME_TRAFFIC: opts([
    ["WEBSITE", "Website", "Send traffic to your website."],
    ["APP", "App", "Send traffic to your app."],
    ["MESSAGING", "Messaging apps", "Messenger, Instagram and WhatsApp."],
    ["INSTAGRAM_PROFILE", "Instagram profile", "Send people to your Instagram profile."],
    ["PHONE_CALL", "Calls", "Get people to call your business."],
  ]),
  OUTCOME_ENGAGEMENT: opts([
    ["ON_AD", "On your ad", "Video views, post engagement or event responses."],
    ["MESSAGING", "Message destinations", "Messenger, Instagram and WhatsApp conversations."],
    ["ON_PAGE", "Facebook Page", "Get Page likes."],
    ["WEBSITE", "Website", "Engagement on your website (pixel events)."],
    ["PHONE_CALL", "Calls", "Get people to call your business."],
  ]),
  OUTCOME_LEADS: opts([
    ["WEBSITE", "Website", "Leads from your website (pixel)."],
    ["ON_AD", "Instant forms", "Forms that open inside Facebook and Instagram."],
    ["MESSAGING", "Messenger", "Leads through Messenger conversations."],
    ["PHONE_CALL", "Calls", "Get people to call your business."],
    ["APP", "App", "Leads inside your app."],
  ]),
  OUTCOME_APP_PROMOTION: [],
  OUTCOME_SALES: opts([
    ["WEBSITE", "Website", "Purchases on your website (pixel)."],
    ["APP", "App", "Purchases in your app."],
    ["WEBSITE_AND_APP", "Website and app", "Purchases on either."],
    ["MESSAGING", "Message destinations", "Sales through conversations."],
    ["PHONE_CALL", "Calls", "Get people to call your business."],
  ]),
};

export const metaLocations = (ctx: FieldContext) => LOCATIONS[String(ctx.setup.objective)] ?? [];

/** Performance goals Ads Manager offers for each objective + conversion location. */
export function metaGoals(ctx: FieldContext): Option[] {
  const o = String(ctx.setup.objective);
  const loc = String(ctx.adGroup.conversionLocation ?? "");
  if (o === "OUTCOME_AWARENESS")
    return opts([
      ["REACH", "Maximize reach of ads", "Show ads to as many people as possible."],
      ["IMPRESSIONS", "Maximize number of impressions", "Show ads as many times as possible."],
      ["AD_RECALL_LIFT", "Maximize ad recall lift", "People likely to remember your ad."],
      ["THRUPLAY", "Maximize ThruPlay views", "Video played to completion or 15 seconds."],
    ]);
  if (o === "OUTCOME_APP_PROMOTION")
    return opts([
      ["APP_INSTALLS", "Maximize number of app installs"],
      ["OFFSITE_CONVERSIONS", "Maximize number of app events"],
      ["VALUE", "Maximize value of conversions"],
      ["LINK_CLICKS", "Maximize number of link clicks"],
    ]);
  if (loc === "MESSAGING") return opts([["CONVERSATIONS", "Maximize number of conversations"], ["LINK_CLICKS", "Maximize number of link clicks"]]);
  if (loc === "PHONE_CALL") return opts([["QUALITY_CALL", "Maximize number of calls"]]);
  if (loc === "INSTAGRAM_PROFILE") return opts([["VISIT_INSTAGRAM_PROFILE", "Maximize number of Instagram profile visits"]]);
  if (loc === "ON_PAGE") return opts([["PAGE_LIKES", "Maximize number of Page likes"]]);
  if (o === "OUTCOME_ENGAGEMENT" && loc === "ON_AD")
    return opts([
      ["POST_ENGAGEMENT", "Maximize engagement with a post"],
      ["THRUPLAY", "Maximize ThruPlay views"],
      ["TWO_SECOND_CONTINUOUS_VIDEO_VIEWS", "Maximize 2-second continuous video plays"],
      ["EVENT_RESPONSES", "Maximize event responses"],
    ]);
  if (o === "OUTCOME_LEADS" && loc === "ON_AD")
    return opts([
      ["LEAD_GENERATION", "Maximize number of leads"],
      ["QUALITY_LEAD", "Maximize number of conversion leads", "Leads more likely to become customers (needs CRM events)."],
    ]);
  if (o === "OUTCOME_TRAFFIC")
    return opts([
      ["LANDING_PAGE_VIEWS", "Maximize number of landing page views", "People who load your website. Recommended."],
      ["LINK_CLICKS", "Maximize number of link clicks"],
      ["REACH", "Maximize daily unique reach"],
      ["IMPRESSIONS", "Maximize number of impressions"],
    ]);
  if (o === "OUTCOME_SALES")
    return opts([
      ["OFFSITE_CONVERSIONS", "Maximize number of conversions"],
      ["VALUE", "Maximize value of conversions", "Find people who spend more."],
      ["LANDING_PAGE_VIEWS", "Maximize number of landing page views"],
      ["LINK_CLICKS", "Maximize number of link clicks"],
      ["REACH", "Maximize daily unique reach"],
    ]);
  return opts([
    ["OFFSITE_CONVERSIONS", "Maximize number of conversions"],
    ["LANDING_PAGE_VIEWS", "Maximize number of landing page views"],
    ["LINK_CLICKS", "Maximize number of link clicks"],
  ]);
}

export const META_EVENTS = opts([
  ["PURCHASE", "Purchase"],
  ["ADD_TO_CART", "Add to cart"],
  ["INITIATED_CHECKOUT", "Initiate checkout"],
  ["ADD_PAYMENT_INFO", "Add payment info"],
  ["LEAD", "Lead"],
  ["COMPLETE_REGISTRATION", "Complete registration"],
  ["CONTACT", "Contact"],
  ["SUBMIT_APPLICATION", "Submit application"],
  ["SCHEDULE", "Schedule"],
  ["START_TRIAL", "Start trial"],
  ["SUBSCRIBE", "Subscribe"],
  ["CONTENT_VIEW", "View content"],
  ["SEARCH", "Search"],
  ["ADD_TO_WISHLIST", "Add to wishlist"],
]);

export const META_CTAS = [
  "LEARN_MORE", "SHOP_NOW", "BUY_NOW", "SIGN_UP", "SUBSCRIBE", "CONTACT_US", "APPLY_NOW", "BOOK_NOW", "DOWNLOAD", "GET_OFFER", "GET_QUOTE",
  "GET_STARTED", "ORDER_NOW", "BUY_TICKETS", "GET_SHOWTIMES", "LISTEN_NOW", "WATCH_MORE", "WATCH_NOW", "PLAY_GAME", "INSTALL_MOBILE_APP",
  "USE_MOBILE_APP", "REQUEST_TIME", "BOOK_A_CONSULTATION", "MAKE_AN_APPOINTMENT", "INQUIRE_NOW", "MESSAGE_PAGE", "WHATSAPP_MESSAGE",
  "CHAT_WITH_US", "CALL_NOW", "GET_DIRECTIONS", "DONATE_NOW", "GET_PROMOTIONS", "SEE_MORE", "VIEW_PRODUCT", "NO_BUTTON",
];

const META_CTA_LABELS: Record<string, string> = { NO_BUTTON: "No button", MESSAGE_PAGE: "Send message", USE_MOBILE_APP: "Use app", BOOK_A_CONSULTATION: "Book a consultation", MAKE_AN_APPOINTMENT: "Make an appointment" };
export const metaCtaOptions = () => ctaOptions(META_CTAS).map((o) => ({ ...o, label: META_CTA_LABELS[o.value] ?? o.label }));

/** Manual placements, grouped as in Ads Manager. Values are "<publisher>.<position>". */
export const META_PLACEMENT_GROUPS = [
  {
    id: "feeds",
    label: "Feeds",
    items: [
      { value: "facebook.feed", label: "Facebook Feed" },
      { value: "instagram.stream", label: "Instagram feed" },
      { value: "facebook.profile_feed", label: "Facebook profile feed" },
      { value: "instagram.profile_feed", label: "Instagram profile feed" },
      { value: "facebook.marketplace", label: "Facebook Marketplace" },
      { value: "facebook.right_hand_column", label: "Facebook right column" },
      { value: "instagram.explore_home", label: "Instagram Explore home" },
      { value: "facebook.notification", label: "Facebook Notifications" },
      { value: "threads.threads_stream", label: "Threads feed" },
    ],
  },
  {
    id: "stories",
    label: "Stories, Status, Reels",
    items: [
      { value: "instagram.story", label: "Instagram Stories" },
      { value: "facebook.story", label: "Facebook Stories" },
      { value: "instagram.reels", label: "Instagram Reels" },
      { value: "instagram.profile_reels", label: "Instagram profile reels" },
      { value: "facebook.facebook_reels", label: "Facebook Reels" },
      { value: "whatsapp.status", label: "WhatsApp Status" },
    ],
  },
  {
    id: "overlays",
    label: "In-stream ads for videos and reels",
    items: [
      { value: "facebook.instream_video", label: "Facebook in-stream videos" },
      { value: "facebook.facebook_reels_overlay", label: "Ads on Facebook Reels" },
    ],
  },
  {
    id: "search",
    label: "Search results",
    items: [
      { value: "facebook.search", label: "Facebook search results" },
      { value: "instagram.ig_search", label: "Instagram search results" },
    ],
  },
  {
    id: "messages",
    label: "Messages",
    items: [
      { value: "messenger.sponsored_messages", label: "Messenger sponsored messages" },
    ],
  },
  {
    id: "apps",
    label: "Apps and sites",
    items: [
      { value: "audience_network.classic", label: "Audience Network native, banner and interstitial" },
      { value: "audience_network.rewarded_video", label: "Audience Network rewarded videos" },
    ],
  },
];

export const META_SPECIAL_CATEGORIES = opts([
  ["FINANCIAL_PRODUCTS_SERVICES", "Financial products and services", "Credit cards, loans, insurance and similar offers."],
  ["EMPLOYMENT", "Employment", "Job offers, internships, certification programs."],
  ["HOUSING", "Housing", "Listings, home insurance, mortgages."],
  ["ISSUES_ELECTIONS_POLITICS", "Social issues, elections or politics", "Needs authorization and a 'Paid for by' disclaimer. Not allowed in the EU."],
  ["ONLINE_GAMBLING_AND_GAMING", "Online gambling and gaming", "Real-money gambling and games; needs Meta's written permission."],
]);

/** EU member states: ad sets reaching them need DSA beneficiary and payer details. */
export const EU_COUNTRIES = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const targetsEu = (ctx: FieldContext) =>
  ((ctx.adGroup.locations as TargetingValue[] | undefined) ?? []).some(
    (l) => !l.exclude && EU_COUNTRIES.includes((l.countryCode ?? ((l.type ?? "country") === "country" ? l.id : "")).toUpperCase()),
  );

const isObjective = (...o: string[]) => setupIs("objective", ...o);
const cbo = campaignIs("cbo", "true");
const pixelNeeded = all(
  any(adGroupIs("conversionLocation", "WEBSITE", "WEBSITE_AND_APP"), isObjective("OUTCOME_SALES")),
  adGroupIs("optimizationGoal", "OFFSITE_CONVERSIONS", "VALUE"),
);
const appNeeded = any(isObjective("OUTCOME_APP_PROMOTION"), adGroupIs("conversionLocation", "APP", "WEBSITE_AND_APP"));
const bidNeedsAmount = (where: "campaign" | "adGroup") => (ctx: FieldContext) =>
  ["COST_CAP", "LOWEST_COST_WITH_BID_CAP"].includes(String(ctx[where].bidStrategy));
const bidNeedsRoas = (where: "campaign" | "adGroup") => (ctx: FieldContext) => ctx[where].bidStrategy === "LOWEST_COST_WITH_MIN_ROAS";

const bidStrategyField = (where: "campaign" | "adGroup") => ({
  key: "bidStrategy",
  type: "radio" as const,
  label: "Bid strategy",
  options: (ctx: FieldContext) =>
    opts([
      ["LOWEST_COST_WITHOUT_CAP", "Highest volume", "Get the most results for your budget. Recommended."],
      ["COST_CAP", "Cost per result goal", "Keep the average cost per result around an amount."],
      ["LOWEST_COST_WITH_BID_CAP", "Bid cap", "Set the highest bid in each auction."],
      ...(ctx.setup.objective === "OUTCOME_SALES" ? ([["LOWEST_COST_WITH_MIN_ROAS", "ROAS goal", "Aim for a minimum return on ad spend."]] as [string, string, string][]) : []),
    ]),
  default: "LOWEST_COST_WITHOUT_CAP",
  showIf: where === "campaign" ? cbo : not(cbo),
});

export const metaSpec: PlatformBuilderSpec = {
  platform: "META",
  setup: [{ key: "objective", label: "Campaign objective", description: "Your objective is the business goal you hope to achieve by running your ads.", options: META_OBJECTIVES }],
  campaign: {
    label: "Campaign",
    sections: [
      {
        id: "details",
        title: "Campaign details",
        fields: [
          nameField("Campaign name", "Festive Sale 2026 – Sales", 400),
          {
            key: "buyingType",
            type: "segmented",
            label: "Buying type",
            options: opts([["AUCTION", "Auction"]]),
            default: "AUCTION",
            help: "Reservation (reach and frequency) campaigns are booked in Ads Manager.",
            advanced: true,
          },
        ],
      },
      {
        id: "special",
        title: "Special Ad Categories",
        description: "Declare if your ads are about financial products, employment, housing or social issues, elections or politics.",
        fields: [
          { key: "specialAdCategories", type: "checkboxes", label: "Categories", options: META_SPECIAL_CATEGORIES },
          {
            key: "specialCountries",
            type: "multiSelect",
            label: "Countries",
            help: "Where these ads will run.",
            options: COUNTRIES.map((c) => ({ value: c.code, label: c.name })),
            required: true,
            showIf: (ctx) => Array.isArray(ctx.campaign.specialAdCategories) && ctx.campaign.specialAdCategories.length > 0,
          },
          infoField("specialInfo", "Targeting is limited", "Meta restricts age, gender and detailed targeting for these categories.", "warning", (ctx) => Array.isArray(ctx.campaign.specialAdCategories) && ctx.campaign.specialAdCategories.length > 0),
        ],
      },
      {
        id: "budget",
        title: "Budget",
        fields: [
          {
            key: "cbo",
            type: "toggle",
            label: "Advantage+ campaign budget",
            description: "Meta distributes one campaign budget across ad sets to get more results.",
            default: true,
          },
          ...budgetFields({ showIf: cbo }),
          bidStrategyField("campaign"),
          { key: "bidAmount", type: "money", label: "Amount", required: true, min: 0.01, showIf: all(cbo, bidNeedsAmount("campaign")), width: "half" },
          { key: "roasGoal", type: "number", label: "Minimum ROAS", required: true, min: 0.01, step: 0.01, suffix: "×", showIf: all(cbo, bidNeedsRoas("campaign")), width: "half" },
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad set",
    sections: [
      { id: "details", title: "Ad set", fields: [nameField("Ad set name", "India · 18–45 · Advantage+ audience", 400)] },
      {
        id: "conversion",
        title: "Conversion",
        showIf: (ctx) => metaLocations(ctx).length > 0 || ctx.setup.objective === "OUTCOME_APP_PROMOTION",
        fields: [
          { key: "conversionLocation", type: "radio", label: "Conversion location", options: metaLocations, default: (ctx) => metaLocations(ctx)[0]?.value ?? "", showIf: (ctx) => metaLocations(ctx).length > 0 },
          { key: "appId", type: "accountOption", source: "apps", label: "App", required: true, showIf: appNeeded, autoSelect: true },
          { key: "leadFormId", type: "accountOption", source: "leadForms", label: "Instant form", showIf: all(isObjective("OUTCOME_LEADS"), adGroupIs("conversionLocation", "ON_AD")), help: "Choose a form, or leave empty to create one in Ads Manager before going live." },
          {
            key: "messagingApps",
            type: "checkboxes",
            label: "Message destinations",
            showIf: adGroupIs("conversionLocation", "MESSAGING"),
            options: opts([["MESSENGER", "Messenger"], ["INSTAGRAM_DIRECT", "Instagram"], ["WHATSAPP", "WhatsApp"]]),
            default: ["MESSENGER", "INSTAGRAM_DIRECT", "WHATSAPP"],
            required: true,
          },
        ],
      },
      {
        id: "performance",
        title: "Performance goal",
        fields: [
          {
            key: "optimizationGoal",
            type: "radio",
            label: "Performance goal",
            options: metaGoals,
            // On a new ad set the conversion location isn't in ctx yet: use the default it is about to get.
            default: (ctx) =>
              metaGoals({ ...ctx, adGroup: { ...ctx.adGroup, conversionLocation: ctx.adGroup.conversionLocation ?? metaLocations(ctx)[0]?.value ?? "" } })[0]!.value,
          },
          { key: "pixelId", type: "accountOption", source: "pixels", label: "Dataset (pixel)", required: true, showIf: pixelNeeded, autoSelect: true },
          {
            key: "conversionEvent",
            type: "select",
            label: "Conversion event",
            required: true,
            showIf: pixelNeeded,
            options: META_EVENTS,
            default: (ctx) => (ctx.setup.objective === "OUTCOME_LEADS" ? "LEAD" : "PURCHASE"),
          },
          {
            key: "attribution",
            type: "select",
            label: "Attribution setting",
            showIf: pixelNeeded,
            options: opts([
              ["7d_click_1d_view", "7-day click or 1-day view"],
              ["7d_click", "7-day click"],
              ["1d_click", "1-day click"],
              ["1d_click_1d_view", "1-day click or 1-day view"],
            ]),
            default: "7d_click_1d_view",
            advanced: true,
          },
          { key: "frequencyCap", type: "number", label: "Frequency cap (impressions every 7 days)", min: 1, max: 90, default: 2, showIf: adGroupIs("optimizationGoal", "REACH"), advanced: true, width: "half" },
        ],
      },
      {
        id: "budget",
        title: "Budget & schedule",
        fields: [
          infoField("cboInfo", "Using Advantage+ campaign budget", "The campaign budget is shared across ad sets.", "info", cbo),
          ...budgetFields({ showIf: not(cbo) }),
          bidStrategyField("adGroup"),
          { key: "bidAmount", type: "money", label: "Amount", required: true, min: 0.01, showIf: all(not(cbo), bidNeedsAmount("adGroup")), width: "half" },
          { key: "roasGoal", type: "number", label: "Minimum ROAS", required: true, min: 0.01, step: 0.01, suffix: "×", showIf: all(not(cbo), bidNeedsRoas("adGroup")), width: "half" },
          { key: "minSpend", type: "money", label: "Ad set spend limit: minimum", min: 0, showIf: cbo, advanced: true, width: "half" },
          { key: "maxSpend", type: "money", label: "Ad set spend limit: maximum", min: 0, showIf: cbo, advanced: true, width: "half" },
          ...scheduleFields({ datetime: true, endRequired: (ctx) => ctx.campaign.budgetType === "LIFETIME" || ctx.adGroup.budgetType === "LIFETIME" }),
          { key: "dayparting", type: "adSchedule", label: "Ad scheduling", help: "Run ads only at certain times. Available with lifetime budgets.", advanced: true, showIf: (ctx) => ctx.campaign.budgetType === "LIFETIME" || ctx.adGroup.budgetType === "LIFETIME" },
        ],
      },
      {
        id: "audience",
        title: "Audience",
        description: "Define who you want to see your ads.",
        fields: [
          {
            key: "advantageAudience",
            type: "toggle",
            label: "Advantage+ audience",
            description: "Meta's AI finds your audience; the settings below become suggestions. Recommended.",
            default: true,
          },
          locationsField(),
          { key: "age", type: "ageRange", label: "Age", min: 18, max: 65, openEnded: true, default: { min: 18, max: 65 } },
          { key: "gender", type: "segmented", label: "Gender", options: opts([["ALL", "All"], ["MALE", "Men"], ["FEMALE", "Women"]]), default: "ALL" },
          { key: "interests", type: "targeting", kind: "interest", label: "Detailed targeting", help: "Interests, behaviors and demographics.", max: 200, ai: { purpose: "Meta detailed-targeting interests" } },
          { key: "customAudiences", type: "accountOption", source: "audiences", label: "Custom audiences", multiple: true, help: "Website visitors, customer lists and lookalikes.", advanced: true },
          { key: "excludedAudiences", type: "accountOption", source: "audiences", label: "Exclude audiences", multiple: true, advanced: true },
          languagesField({ help: "Leave empty unless the audience uses a language that isn't common in the location." }),
          { key: "dsaBeneficiary", type: "text", label: "Beneficiary (EU)", placeholder: "Your company name", required: true, maxLength: 512, showIf: targetsEu, help: "Who benefits from ads shown in the EU (Digital Services Act).", width: "half" },
          { key: "dsaPayer", type: "text", label: "Payer (EU)", placeholder: "Your company name", required: true, maxLength: 512, showIf: targetsEu, help: "Who pays for these ads.", width: "half" },
        ],
      },
      {
        id: "placements",
        title: "Placements",
        description: "Choose where your ads appear across Meta technologies.",
        fields: [
          {
            key: "placements",
            type: "placements",
            label: "Placements",
            autoLabel: "Advantage+ placements",
            autoDescription: "Maximize your budget and help show your ads to more people. Recommended.",
            groups: META_PLACEMENT_GROUPS,
          },
          { key: "devices", type: "segmented", label: "Devices", options: opts([["ALL", "All devices"], ["mobile", "Mobile only"], ["desktop", "Desktop only"]]), default: "ALL", advanced: true },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      { id: "details", title: "Ad", fields: [nameField("Ad name", "Festive edit · Carousel", 400)] },
      {
        id: "identity",
        title: "Identity",
        fields: [
          { key: "pageId", type: "accountOption", source: "pages", label: "Facebook Page", required: true, autoSelect: true },
          { key: "instagramId", type: "accountOption", source: "instagramAccounts", label: "Instagram account", autoSelect: true, help: "Leave empty to use your Facebook Page on Instagram." },
        ],
      },
      {
        id: "setup",
        title: "Ad setup",
        fields: [
          {
            key: "format",
            type: "cards",
            label: "Format",
            options: [
              { value: "SINGLE", label: "Single image or video", description: "One image or video, or a slideshow.", icon: "Image" },
              { value: "CAROUSEL", label: "Carousel", description: "2 or more scrollable images or videos.", icon: "GalleryHorizontal" },
            ],
            default: "SINGLE",
          },
        ],
      },
      {
        id: "creative",
        title: "Ad creative",
        fields: [
          { key: "media", type: "media", label: "Media", accept: ["IMAGE", "VIDEO"], min: 1, max: 1, required: true, ratios: ["1:1", "4:5", "1.91:1"], showIf: adIs("format", "SINGLE"), specs: "Feeds: 1:1 or 4:5, at least 1080×1080 px. Video up to 241 minutes; 15 seconds or less works best." },
          { key: "storyMedia", type: "media", label: "Stories and Reels version (optional)", accept: ["IMAGE", "VIDEO"], min: 0, max: 1, ratios: ["9:16"], requiredRatio: "9:16", showIf: adIs("format", "SINGLE"), help: "A 9:16 version used in Stories and Reels.", advanced: true },
          {
            key: "cards",
            type: "repeater",
            label: "Carousel cards",
            itemLabel: "Card",
            min: 2,
            max: 10,
            required: true,
            showIf: adIs("format", "CAROUSEL"),
            fields: [
              { key: "media", type: "media", label: "Card media", accept: ["IMAGE", "VIDEO"], min: 1, max: 1, required: true, ratios: ["1:1"], specs: "1:1, 1080×1080 px" },
              { key: "headline", type: "text", label: "Headline", placeholder: "Shop the edit", maxLength: 255, recommendedLength: 32, ai: { purpose: "carousel card headline" } },
              { key: "description", type: "text", label: "Description", placeholder: "Up to 50% off", maxLength: 255, recommendedLength: 18 },
              { key: "url", type: "url", label: "Website URL", placeholder: "https://yourstore.com/product", required: true },
            ],
          },
          {
            key: "primaryTexts",
            type: "textList",
            label: "Primary text",
            itemLabel: "Primary text",
            min: 1,
            max: 5,
            initial: 1,
            maxLength: 1024,
            recommendedLength: 125,
            multiline: true,
            required: true,
            help: "Add up to 5 options; Meta shows the one each person is most likely to respond to.",
            ai: { purpose: "Meta primary text: hook in the first 125 characters, benefit, call to action" },
          },
          {
            key: "headlines",
            type: "textList",
            label: "Headline",
            itemLabel: "Headline",
            min: 0,
            max: 5,
            initial: 1,
            maxLength: 255,
            recommendedLength: 40,
            showIf: adIs("format", "SINGLE"),
            ai: { purpose: "Meta headline under the image" },
          },
          {
            key: "descriptions",
            type: "textList",
            label: "Description",
            itemLabel: "Description",
            min: 0,
            max: 5,
            initial: 1,
            maxLength: 255,
            recommendedLength: 25,
            showIf: adIs("format", "SINGLE"),
            ai: { purpose: "short description shown below the headline" },
          },
          { key: "cta", type: "select", label: "Call to action", options: metaCtaOptions, default: (ctx) => (ctx.setup.objective === "OUTCOME_SALES" ? "SHOP_NOW" : ctx.setup.objective === "OUTCOME_LEADS" ? "SIGN_UP" : ctx.setup.objective === "OUTCOME_APP_PROMOTION" ? "INSTALL_MOBILE_APP" : "LEARN_MORE") },
          {
            key: "enhancements",
            type: "toggle",
            label: "Advantage+ creative enhancements",
            description: "Let Meta adjust brightness, add music and pick the best text per person.",
            default: false,
            advanced: true,
          },
        ],
      },
      {
        id: "destination",
        title: "Destination",
        showIf: (ctx) =>
          ctx.setup.objective !== "OUTCOME_APP_PROMOTION" &&
          (!["ON_AD", "ON_PAGE", "MESSAGING", "PHONE_CALL", "INSTAGRAM_PROFILE", "APP"].includes(String(ctx.adGroup.conversionLocation ?? "")) || ctx.setup.objective === "OUTCOME_AWARENESS"),
        fields: [
          urlField({ required: (ctx) => ctx.setup.objective !== "OUTCOME_AWARENESS" && ctx.ad.format !== "CAROUSEL", showIf: (ctx) => ctx.ad.format !== "CAROUSEL" }),
          { key: "displayLink", type: "text", label: "Display link", placeholder: "yourstore.com", maxLength: 100, advanced: true, help: "A short link shown instead of the full URL." },
          urlParamsField(),
        ],
      },
      {
        id: "call",
        title: "Call",
        showIf: adGroupIs("conversionLocation", "PHONE_CALL"),
        fields: [{ key: "phone", type: "text", label: "Phone number", required: true, placeholder: "+91 98765 43210", maxLength: 30 }],
      },
      {
        id: "message",
        title: "Message template",
        showIf: adGroupIs("conversionLocation", "MESSAGING"),
        fields: [
          { key: "greeting", type: "textarea", label: "Greeting", maxLength: 300, rows: 2, placeholder: "Hi! Thanks for reaching out. How can we help?", ai: { purpose: "friendly chat greeting" } },
          { key: "quickReplies", type: "textList", label: "Frequently asked questions", itemLabel: "Question", min: 0, max: 5, initial: 3, maxLength: 80, ai: { purpose: "questions a customer might tap" } },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 50,
  previews: (ctx) => {
    const p = ctx.adGroup.placements as { mode: string; items: string[] } | undefined;
    const has = (v: string) => !p || p.mode !== "MANUAL" || p.items.includes(v);
    const out: PlacementPreview[] = [];
    if (has("facebook.feed")) out.push("fb_feed");
    if (has("instagram.stream")) out.push("ig_feed");
    if (has("instagram.story")) out.push("ig_story");
    if (has("instagram.reels")) out.push("ig_reels");
    if (has("facebook.facebook_reels")) out.push("fb_reels");
    if (has("facebook.right_hand_column")) out.push("fb_right_column");
    return out.length ? out : ["fb_feed"];
  },
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const special = (draft.campaign.specialAdCategories as string[] | undefined) ?? [];
    if (!draft.campaign.cbo && draft.adGroups.length === 0) issues.push({ level: "campaign", message: "Add an ad set." });
    for (const g of draft.adGroups) {
      if (special.length) {
        const age = g.values.age as { min: number; max: number } | undefined;
        if (age && (age.min !== 18 || age.max !== 65)) {
          issues.push({ level: "adGroup", nodeKey: g.key, field: "age", message: "Special Ad Categories must target ages 18–65+." });
        }
        if (g.values.gender && g.values.gender !== "ALL") issues.push({ level: "adGroup", nodeKey: g.key, field: "gender", message: "Special Ad Categories must target all genders." });
      }
      for (const a of g.ads) {
        if (a.values.cta === "CALL_NOW" && g.values.conversionLocation !== "PHONE_CALL" && !a.values.phone) {
          issues.push({ level: "ad", nodeKey: a.key, field: "cta", message: "“Call now” needs the Calls conversion location and a phone number." });
        }
      }
    }
    return issues;
  },
};
