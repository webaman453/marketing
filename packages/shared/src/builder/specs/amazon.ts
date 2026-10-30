/** Amazon Ads: Sponsored Products, Sponsored Brands, Sponsored Display. */
import { all, budgetFields, campaignIs, launchSection, nameField, opts, scheduleFields, setupIs, urlField } from "../common";
import type { BuilderIssue, PlatformBuilderSpec } from "../types";

const product = (...values: string[]) => setupIs("adProduct", ...values);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export const amazonSpec: PlatformBuilderSpec = {
  platform: "AMAZON",
  setup: [
    {
      key: "adProduct",
      label: "Ad product",
      description: "Amazon Ads has a different form for each product.",
      options: opts([
        ["SPONSORED_PRODUCTS", "Sponsored Products", "Promote individual products in search results."],
        ["SPONSORED_BRANDS", "Sponsored Brands", "Headline, logo and a set of products."],
        ["SPONSORED_DISPLAY", "Sponsored Display", "Image ads on and off Amazon."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive – Sponsored Products")] },
      {
        id: "targeting",
        title: "Targeting",
        fields: [
          {
            key: "targetingType",
            type: "segmented",
            label: "Targeting",
            showIf: product("SPONSORED_PRODUCTS"),
            options: opts([["MANUAL", "Manual"], ["AUTO", "Automatic"]]),
            default: "MANUAL",
          },
          {
            key: "tactic",
            type: "select",
            label: "Tactic",
            showIf: product("SPONSORED_DISPLAY"),
            // Amazon's codes: T00020 targets products and categories, T00030 targets audiences.
            options: opts([["T00020", "Product targeting"], ["T00030", "Audiences"]]),
            default: "T00020",
          },
        ],
      },
      { id: "budget", title: "Budget", fields: budgetFields({ lifetime: false, help: "Daily budget in the profile currency." }) },
      {
        id: "schedule",
        title: "Schedule",
        // Amazon campaigns take calendar days in the profile's time zone; with no start date they start today.
        fields: scheduleFields().map((f) => (f.key === "startDate" ? { ...f, help: "Leave empty to start today (profile time zone)." } : { ...f, help: "Optional. Leave empty to run until you pause it." })),
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "details",
        title: "Ad group",
        fields: [
          nameField("Ad group name", "Lehengas"),
          { key: "defaultBid", type: "money", label: "Default bid", required: true, min: 0.02, showIf: product("SPONSORED_PRODUCTS"), width: "half" },
          {
            key: "keywords",
            type: "keywords",
            label: "Keywords",
            matchTypes: ["BROAD", "PHRASE", "EXACT"],
            max: 1000,
            showIf: all(product("SPONSORED_PRODUCTS"), campaignIs("targetingType", "MANUAL")),
            help: "Manual targeting only. Automatic campaigns let Amazon pick the searches.",
          },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "creative",
        title: "Creative",
        fields: [
          nameField("Ad name", "SKU ad"),
          { key: "asin", type: "text", label: "ASIN", placeholder: "B0XXXXXXXX", required: (ctx) => !str(ctx.ad.sku), showIf: product("SPONSORED_PRODUCTS"), help: "Amazon product id. Use ASIN or SKU." },
          { key: "asin", type: "text", label: "ASIN", placeholder: "B0XXXXXXXX", required: true, showIf: product("SPONSORED_DISPLAY"), help: "The product this ad promotes." },
          { key: "sku", type: "text", label: "SKU", placeholder: "LEHENGA-RED-M", showIf: product("SPONSORED_PRODUCTS"), help: "Seller SKU. Use ASIN or SKU." },
          { key: "brandName", type: "text", label: "Brand name", placeholder: "Ashniva", required: true, maxLength: 30, showIf: product("SPONSORED_BRANDS") },
          { key: "brandLogo", type: "media", label: "Brand logo", accept: ["IMAGE"], min: 0, max: 1, ratios: ["1:1"], showIf: product("SPONSORED_BRANDS"), help: "Square logo, 400×400 or larger." },
          { key: "headline", type: "text", label: "Headline", required: true, maxLength: 50, showIf: product("SPONSORED_BRANDS"), ai: { purpose: "Amazon headline under 50 characters" } },
          {
            key: "headline",
            type: "text",
            label: "Headline",
            maxLength: 50,
            showIf: product("SPONSORED_DISPLAY"),
            help: "Optional. Used for the preview only: Amazon builds the Sponsored Display creative from the product listing.",
            ai: { purpose: "Amazon headline under 50 characters" },
          },
          { key: "asins", type: "textarea", label: "Product ASINs", placeholder: "B0AAAAAAA\nB0BBBBBBB", required: true, showIf: product("SPONSORED_BRANDS"), help: "One ASIN per line (or comma-separated), up to 3." },
          urlField({ label: "Landing page", showIf: product("SPONSORED_BRANDS"), required: false, help: "Leave empty to land on the products above." }),
        ],
      },
    ],
  }),
  // Sponsored Brands and Sponsored Display create one ad group with one ad (see validate).
  maxAdGroups: 10,
  maxAds: 20,
  previews: (ctx) => (ctx.setup.adProduct === "SPONSORED_DISPLAY" ? ["amazon_shopping", "display_banner"] : ["amazon_shopping"]),
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const adProduct = String(draft.setup.adProduct ?? "");
    const single = adProduct === "SPONSORED_BRANDS" || adProduct === "SPONSORED_DISPLAY";
    const label = adProduct === "SPONSORED_BRANDS" ? "Sponsored Brands" : "Sponsored Display";
    if (single && draft.adGroups.length > 1) issues.push({ level: "campaign", message: `${label} campaigns use one ad group.` });
    for (const g of draft.adGroups) {
      if (single && g.ads.length > 1) issues.push({ level: "adGroup", nodeKey: g.key, message: `${label} campaigns use one ad per ad group.` });
      for (const a of g.ads) {
        if (adProduct === "SPONSORED_BRANDS") {
          const asins = str(a.values.asins).split(/[\s,]+/).filter(Boolean);
          if (asins.length > 3) issues.push({ level: "ad", nodeKey: a.key, field: "asins", message: "Use at most 3 ASINs." });
        }
      }
    }
    return issues;
  },
};
