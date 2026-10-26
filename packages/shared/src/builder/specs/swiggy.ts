/** Swiggy Self Serve Ads: Food, Instamart or Dineout. Prepared here; Swiggy has no public ads API. */
import { budgetFields, infoField, launchSection, nameField, opts } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const swiggySpec: PlatformBuilderSpec = {
  platform: "SWIGGY",
  setup: [
    {
      key: "surface",
      label: "Where it runs",
      description: "The Swiggy business this campaign belongs to.",
      options: opts([
        ["FOOD", "Food", "Restaurant ads in the food app."],
        ["INSTAMART", "Instamart", "Product ads in Instamart."],
        ["DINEOUT", "Dineout", "Offers for dining out."],
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
          nameField("Campaign name", "Weekend biryani"),
          { key: "cities", type: "text", label: "Cities", placeholder: "Bengaluru, Mumbai", required: true, help: "Cities this campaign should run in." },
          { key: "days", type: "number", label: "Days", required: true, min: 1, max: 90, width: "half", help: "How many days it should stay up." },
          infoField("swiggyNote", "Publish in the Swiggy portal", "Swiggy has no public ads API. This form matches Self Serve Ads, and the campaign has to be created there.", "warning"),
        ],
      },
      { id: "budget", title: "Budget", fields: budgetFields({}) },
      launchSection(),
    ],
  },
  adGroup: {
    label: "City",
    sections: [{ id: "details", title: "City group", fields: [nameField("City group name", "Bengaluru")] }],
  },
  ad: () => ({
    label: "Products",
    sections: [
      {
        id: "products",
        title: "Products",
        fields: [
          nameField("Ad name", "Featured dishes"),
          { key: "products", type: "textarea", label: "Products", required: true, rows: 4, maxLength: 2000, help: "One product or dish per line, as it appears on Swiggy." },
        ],
      },
    ],
  }),
  maxAdGroups: 8,
  maxAds: 20,
  previews: () => ["google_display"],
};
