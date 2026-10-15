/**
 * Pinterest Ads flow: Campaign → Ad group → Ad (a promoted Pin; API v5).
 */
import { adGroupIs, adIs, budgetFields, campaignIs, ctaOptions, launchSection, locationsField, languagesField, nameField, not, opts, scheduleFields, setupIs, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const PINTEREST_OBJECTIVES = opts([
  ["AWARENESS", "Brand awareness", "Get people to discover your brand."],
  ["VIDEO_COMPLETION", "Video views", "Get people to watch your video to the end."],
  ["CONSIDERATION", "Consideration", "Drive clicks to your website."],
  ["WEB_CONVERSION", "Conversions", "Drive sign-ups, checkouts and other actions on your site."],
  ["CATALOG_SALES", "Catalog sales", "Promote products from your catalog."],
]);

export const PINTEREST_CTAS = [
  "LEARN_MORE", "SHOP_NOW", "SIGN_UP", "BUY_NOW", "BOOK_NOW", "GET_OFFER", "GET_QUOTE", "CONTACT_US", "VISIT_SITE", "APPLY_NOW", "REQUEST_DEMO", "REGISTER_NOW",
  "ORDER_NOW", "WATCH_NOW", "READ_MORE", "DOWNLOAD", "SUBSCRIBE", "ADD_TO_CART",
];

const isObjective = (...o: string[]) => setupIs("objective", ...o);
const cbo = campaignIs("cbo", "true");

export const pinterestSpec: PlatformBuilderSpec = {
  platform: "PINTEREST",
  setup: [
    {
      key: "objective",
      label: "Campaign objective",
      description: "What do you want to achieve?",
      options: PINTEREST_OBJECTIVES.map((o) =>
        o.value === "CATALOG_SALES" ? { ...o, disabled: true, disabledReason: "Needs a product catalog; set it up in Pinterest Ads Manager." } : o,
      ),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign details", fields: [nameField("Campaign name", "Festive Collection – Consideration")] },
      {
        id: "budget",
        title: "Budget",
        fields: [
          { key: "cbo", type: "toggle", label: "Campaign budget optimization", description: "Pinterest shares one campaign budget across your ad groups.", default: false },
          ...budgetFields({ showIf: cbo }),
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      { id: "details", title: "Ad group", fields: [nameField("Ad group name", "Home decor lovers · India")] },
      {
        id: "targeting",
        title: "Targeting",
        fields: [
          {
            key: "targetingStrategy",
            type: "radio",
            label: "Targeting strategy",
            options: opts([
              ["CHOOSE_YOUR_OWN", "Choose your own", "Pick interests, keywords and demographics."],
              ["FIND_NEW_CUSTOMERS", "Find new customers", "Reach people similar to your customers."],
            ]),
            default: "CHOOSE_YOUR_OWN",
          },
          { key: "expandedTargeting", type: "toggle", label: "Expanded targeting", description: "Pinterest finds more people based on your Pins.", default: true },
          { key: "interests", type: "targeting", kind: "interest", label: "Interests", ai: { purpose: "Pinterest interests" } },
          { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD", "PHRASE", "EXACT"], max: 25000, help: "Show your Pin when people search for these.", ai: { purpose: "Pinterest search keywords" } },
          locationsField(),
          languagesField(),
          { key: "gender", type: "segmented", label: "Gender", options: opts([["ALL", "All"], ["female", "Female"], ["male", "Male"]]), default: "ALL" },
          {
            key: "ageBuckets",
            type: "checkboxes",
            label: "Age",
            help: "Leave unchecked for all ages.",
            options: opts([["18-24", "18–24"], ["25-34", "25–34"], ["35-44", "35–44"], ["45-49", "45–49"], ["50-54", "50–54"], ["55-64", "55–64"], ["65+", "65+"]]),
          },
          { key: "devices", type: "checkboxes", label: "Devices", options: opts([["iphone", "iPhone"], ["ipad", "iPad"], ["android_mobile", "Android phone"], ["android_tablet", "Android tablet"], ["web", "Computer"], ["web_mobile", "Mobile web"]]), advanced: true },
        ],
      },
      {
        id: "placements",
        title: "Placements",
        fields: [
          {
            key: "placementGroup",
            type: "radio",
            label: "Placements",
            options: opts([
              ["ALL", "All", "Home feed, search and related Pins. Recommended."],
              ["BROWSE", "Browse", "Home feed and related Pins."],
              ["SEARCH", "Search", "Search results and related Pins in search."],
            ]),
            default: "ALL",
          },
        ],
      },
      {
        id: "budget",
        title: "Budget & schedule",
        fields: [...budgetFields({ showIf: not(cbo) }), ...scheduleFields({ endRequired: adGroupIs("budgetType", "LIFETIME") })],
      },
      {
        id: "optimization",
        title: "Optimization & delivery",
        fields: [
          { key: "conversionTagId", type: "accountOption", source: "pixels", label: "Pinterest tag", required: true, showIf: isObjective("WEB_CONVERSION"), autoSelect: true },
          {
            key: "conversionEvent",
            type: "select",
            label: "Conversion event",
            showIf: isObjective("WEB_CONVERSION"),
            options: opts([["CHECKOUT", "Checkout"], ["ADD_TO_CART", "Add to cart"], ["SIGNUP", "Sign up"], ["LEAD", "Lead"], ["PAGE_VISIT", "Page visit"]]),
            default: "CHECKOUT",
          },
          {
            key: "bidStrategy",
            type: "radio",
            label: "Bid strategy",
            options: (ctx) =>
              ctx.setup.objective === "VIDEO_COMPLETION"
                ? opts([["AUTOMATIC_BID", "Automatic", "Pinterest sets bids to get the most results."]])
                : opts([
                    ["AUTOMATIC_BID", "Automatic", "Pinterest sets bids to get the most results. Recommended."],
                    ["MAX_BID", "Custom bid", "Set the most you'll pay per result."],
                    ["TARGET_AVG", "Target average cost", "Keep the average cost near an amount."],
                  ]),
            default: "AUTOMATIC_BID",
          },
          { key: "bidAmount", type: "money", label: "Bid amount", required: true, min: 0.01, showIf: adGroupIs("bidStrategy", "MAX_BID", "TARGET_AVG"), width: "half" },
          { key: "pacing", type: "segmented", label: "Pacing", options: opts([["STANDARD", "Standard"], ["ACCELERATED", "Accelerated"]]), default: "STANDARD", advanced: true },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "pin",
        title: "Pin",
        fields: [
          nameField("Ad name", "Festive decor · Standard pin"),
          {
            key: "format",
            type: "cards",
            label: "Format",
            options: (ctx) =>
              [
                { value: "REGULAR", label: "Standard", description: "A single image Pin.", icon: "Image" },
                { value: "VIDEO", label: "Video", description: "A video Pin.", icon: "Film" },
                { value: "CAROUSEL", label: "Carousel", description: "2–5 swipeable images.", icon: "GalleryHorizontal" },
              ].filter((o) => ctx.setup.objective !== "VIDEO_COMPLETION" || o.value === "VIDEO"),
            default: (ctx) => (ctx.setup.objective === "VIDEO_COMPLETION" ? "VIDEO" : "REGULAR"),
          },
          { key: "image", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["2:3", "1:1"], showIf: adIs("format", "REGULAR"), specs: "2:3 recommended (1000×1500 px). Taller images get cropped." },
          { key: "video", type: "media", label: "Video", accept: ["VIDEO"], min: 1, max: 1, required: true, ratios: ["2:3", "9:16", "1:1", "4:5"], showIf: adIs("format", "VIDEO"), specs: "4 seconds to 15 minutes; 6–15 seconds works best." },
          { key: "images", type: "media", label: "Carousel images", accept: ["IMAGE"], min: 2, max: 5, required: true, ratios: ["1:1", "2:3"], showIf: adIs("format", "CAROUSEL"), specs: "2–5 images, all the same aspect ratio." },
          { key: "title", type: "text", label: "Title", placeholder: "Festive home decor ideas", required: true, maxLength: 100, recommendedLength: 40, ai: { purpose: "Pin title; first 40 characters show in the feed" } },
          { key: "description", type: "textarea", label: "Description", placeholder: "Easy festive decor ideas for your living room, from lights to cushions.", maxLength: 500, recommendedLength: 50, rows: 3, ai: { purpose: "Pin description with searchable keywords; first 50 characters matter most" } },
          urlField({ label: "Destination URL" }),
          { key: "cta", type: "select", label: "Call to action", options: ctaOptions(PINTEREST_CTAS), default: (ctx) => (["CATALOG_SALES", "WEB_CONVERSION"].includes(String(ctx.setup.objective)) ? "SHOP_NOW" : "LEARN_MORE"), help: "Shown on some placements only.", width: "half" },
          { key: "altText", type: "text", label: "Alt text", placeholder: "A living room decorated with lamps and marigold garlands", maxLength: 500, advanced: true, help: "Describes the image for people using screen readers." },
          { key: "boardId", type: "accountOption", source: "boards", label: "Board", advanced: true, help: "Ad-only Pins are saved to a secret board. Leave empty to use one we create." },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 20,
  previews: () => ["pinterest_grid", "pinterest_closeup"],
};
