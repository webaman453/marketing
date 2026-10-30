/** Shopify store marketing event. Records the campaign and UTM tags. It does not buy media. */
import { budgetFields, infoField, launchSection, nameField, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const shopifySpec: PlatformBuilderSpec = {
  platform: "SHOPIFY",
  setup: [
    {
      key: "channel",
      label: "Marketing channel",
      description: "Where the traffic comes from. Shopify stores this on the marketing event.",
      options: opts([
        ["social", "Social", "Paid or organic social."],
        ["search", "Search", "Search ads or organic search."],
        ["email", "Email", "A newsletter or lifecycle email."],
        ["display", "Display", "Banner or programmatic display."],
      ]),
    },
  ],
  campaign: {
    label: "Marketing event",
    sections: [
      {
        id: "details",
        title: "Campaign",
        fields: [
          nameField("Campaign name", "Festive store sale"),
          { key: "utmSource", type: "text", label: "UTM source", placeholder: "facebook", required: true, maxLength: 80, width: "half" },
          { key: "utmMedium", type: "text", label: "UTM medium", placeholder: "cpc", required: true, maxLength: 80, width: "half" },
          infoField("shopifyNote", "Recorded on the store", "Shopify saves this as a marketing event. It does not serve the ad or spend the budget."),
        ],
      },
      // The marketing event gets no end date from here, so only a daily budget is offered.
      { id: "budget", title: "Budget", fields: budgetFields({ lifetime: false, help: "Daily budget, stored on the marketing event. Shopify does not spend it." }) },
      launchSection({
        paused: { label: "Record as ended", description: "Saves the marketing event with an end time now, for tracking only." },
        active: { label: "Record as running", description: "Saves the marketing event on the store as running from today." },
      }),
    ],
  },
  adGroup: {
    label: "Tracking",
    sections: [{ id: "details", title: "Tracking", fields: [nameField("Tracking name", "Store visit")] }],
  },
  ad: () => ({
    label: "Landing page",
    sections: [
      {
        id: "page",
        title: "Landing page",
        fields: [
          nameField("Name", "Homepage"),
          { key: "description", type: "textarea", label: "Description", maxLength: 500, rows: 3 },
          urlField({ label: "Store URL", help: "The page this campaign should open." }),
        ],
      },
    ],
  }),
  maxAdGroups: 1,
  maxAds: 1,
  previews: () => ["google_display"],
};
