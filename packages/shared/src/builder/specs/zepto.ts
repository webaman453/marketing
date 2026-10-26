/** Zepto Jarvis sponsored products: keyword or category, bid, cities and SKU. */
import { budgetFields, infoField, launchSection, nameField, opts, setupIs } from "../common";
import type { PlatformBuilderSpec } from "../types";

const keyword = setupIs("targeting", "KEYWORD");
const category = setupIs("targeting", "CATEGORY");

export const zeptoSpec: PlatformBuilderSpec = {
  platform: "ZEPTO",
  setup: [
    {
      key: "targeting",
      label: "Targeting",
      description: "Sponsored products on Zepto are keyword or category.",
      options: opts([
        ["KEYWORD", "Keyword", "Bid on search keywords."],
        ["CATEGORY", "Category", "Show in a product category."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      {
        id: "details",
        title: "Campaign",
        fields: [
          nameField("Campaign name", "Brand search"),
          { key: "cities", type: "text", label: "Cities", placeholder: "Delhi, Mumbai", required: true },
          infoField("zeptoNote", "Publish in Zepto Jarvis", "Zepto has no public ads API. Homepage banners and packages are sold by Zepto's brand team, not created here.", "warning"),
        ],
      },
      { id: "budget", title: "Budget", fields: [...budgetFields({ lifetime: false, help: "Daily budget in Jarvis." }), { key: "bid", type: "money", label: "Bid", required: true, min: 0.1, max: 100000, width: "half", help: "CPC bid for this keyword or category." }] },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Targeting",
    sections: [
      {
        id: "target",
        title: "Targeting",
        fields: [
          nameField("Ad group name", "Brand keywords"),
          { key: "keyword", type: "text", label: "Keyword", required: true, showIf: keyword, help: "The search term to bid on." },
          { key: "categoryName", type: "text", label: "Category", required: true, showIf: category, help: "The Zepto category name." },
        ],
      },
    ],
  },
  ad: () => ({
    label: "SKU",
    sections: [
      {
        id: "sku",
        title: "Product",
        fields: [
          nameField("Ad name", "Bestseller SKU"),
          { key: "sku", type: "text", label: "SKU", required: true, help: "The product SKU already listed on Zepto." },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 20,
  previews: () => ["google_display"],
};
