/** Amazon Ads: Sponsored Products, Sponsored Brands, Sponsored Display. */
import { all, any, budgetFields, campaignIs, infoField, launchSection, nameField, opts, setupIs, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

const product = (...values: string[]) => setupIs("adProduct", ...values);

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
            options: opts([["T00020", "Audiences"], ["T00030", "Product targeting"]]),
            default: "T00020",
          },
        ],
      },
      { id: "budget", title: "Budget", fields: budgetFields({ lifetime: false, help: "Daily budget in the profile currency." }) },
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
          { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD", "PHRASE", "EXACT"], max: 1000, showIf: product("SPONSORED_PRODUCTS"), help: "Manual Sponsored Products keywords." },
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
          { key: "asin", type: "text", label: "ASIN", placeholder: "B0XXXXXXXX", showIf: any(product("SPONSORED_PRODUCTS"), all(product("SPONSORED_DISPLAY"), campaignIs("tactic", "T00030"))), help: "Amazon product id. Use ASIN or SKU." },
          { key: "sku", type: "text", label: "SKU", placeholder: "LEHENGA-RED-M", showIf: product("SPONSORED_PRODUCTS") },
          { key: "headline", type: "text", label: "Headline", required: true, maxLength: 50, showIf: product("SPONSORED_BRANDS", "SPONSORED_DISPLAY"), ai: { purpose: "Amazon headline under 50 characters" } },
          infoField("sdCreative", "Image", "Audience ads use an image from the Amazon Ads asset library. This form creates the campaign and ad group. Product targeting can attach an ASIN below.", "info", all(product("SPONSORED_DISPLAY"), campaignIs("tactic", "T00020"))),
          { key: "asins", type: "textarea", label: "Product ASINs", placeholder: "B0AAAAAAA\nB0BBBBBBB", showIf: product("SPONSORED_BRANDS"), help: "One ASIN per line, up to 3." },
          urlField({ label: "Landing page", showIf: product("SPONSORED_BRANDS"), required: false }),
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 20,
  previews: (ctx) => (ctx.setup.adProduct === "SPONSORED_PRODUCTS" ? ["google_search_mobile", "google_shopping"] : ["google_display", "google_shopping"]),
};
