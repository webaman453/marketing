/** Apple Search Ads: app campaign, keyword ad group, search-results or product-page creative. */
import { adIs, budgetFields, launchSection, locationsField, nameField, opts, scheduleFields } from "../common";
import type { BuilderIssue, PlatformBuilderSpec } from "../types";

export const appleSpec: PlatformBuilderSpec = {
  platform: "APPLE",
  setup: [
    {
      key: "channel",
      label: "Placement",
      description: "Apple Search Ads runs on the App Store.",
      options: opts([["SEARCH", "Search results", "Show the app when people search."]]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "app", title: "App", fields: [nameField("Campaign name", "Brand search – India"), { key: "adamId", type: "text", label: "App Store adam ID", placeholder: "1234567890", required: true, maxLength: 12, help: "The numeric id of the app, from its App Store URL (…/id1234567890)." }] },
      { id: "where", title: "Storefronts", fields: [locationsField({ allowExclude: false, help: "Countries whose App Store should show the ad." })] },
      { id: "budget", title: "Budget", fields: budgetFields({ lifetime: false }) },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "bid",
        title: "Ad group",
        fields: [
          nameField("Ad group name", "Brand keywords"),
          { key: "searchMatch", type: "toggle", label: "Search Match", description: "Let Apple match related searches.", default: true },
          { key: "cpt", type: "money", label: "Max CPT", required: true, min: 0.01, width: "half", help: "Most you'll pay per tap." },
          { key: "cpa", type: "money", label: "CPA goal", min: 0.01, width: "half" },
          { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD", "EXACT"], max: 5000, help: "Apple treats phrase match as broad." },
        ],
      },
      {
        id: "schedule",
        title: "Schedule",
        // Apple schedules ad groups (startTime/endTime), not campaigns.
        fields: scheduleFields({ datetime: true }).map((f) => (f.key === "startDate" ? { ...f, help: "Leave empty to start as soon as it's published." } : { ...f, help: "Optional. Leave empty to run until you pause it." })),
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
          nameField("Ad name", "Search results"),
          {
            key: "creativeType",
            type: "cards",
            label: "Creative",
            options: opts([
              ["SEARCH_RESULTS", "Search results", "Uses the app's default product page."],
              ["CUSTOM_PRODUCT_PAGE", "Custom product page", "A product page you made in App Store Connect."],
            ]),
            default: "SEARCH_RESULTS",
          },
          {
            key: "productPageId",
            type: "text",
            label: "Product page id",
            placeholder: "45812c9b-c296-43d3-c6a0-c5a02f74bf6e",
            required: true,
            maxLength: 64,
            showIf: adIs("creativeType", "CUSTOM_PRODUCT_PAGE"),
            help: "The custom product page id from App Store Connect.",
          },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 5,
  previews: () => ["app_store_search"],
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const adamId = typeof draft.campaign.adamId === "string" ? draft.campaign.adamId.trim() : String(draft.campaign.adamId ?? "");
    if (adamId && !/^\d+$/.test(adamId)) issues.push({ level: "campaign", field: "adamId", message: "App Store adam ID must be digits only, e.g. 1234567890." });
    return issues;
  },
};
