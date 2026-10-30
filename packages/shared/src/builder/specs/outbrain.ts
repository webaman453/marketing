/** Outbrain: campaign budget and geo → promoted link (title, image URL, landing URL). */
import { budgetFields, campaignIs, launchSection, locationsField, nameField, not, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const outbrainSpec: PlatformBuilderSpec = {
  platform: "OUTBRAIN",
  setup: [
    {
      key: "objective",
      label: "Goal",
      description: "How Outbrain should spend.",
      options: opts([
        ["Traffic", "Traffic", "Pay for clicks to your site."],
        ["Awareness", "Awareness", "Pay for impressions."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive native")] },
      {
        id: "bid",
        title: "Bidding",
        fields: [
          { key: "bidType", type: "segmented", label: "Charge by", options: opts([["CPC", "CPC"], ["CPM", "CPM"]]), default: "CPC" },
          // Same key either way: the connector reads `cpc`.
          { key: "cpc", type: "money", label: "CPC bid", min: 0.01, required: true, width: "half", showIf: not(campaignIs("bidType", "CPM")), help: "Most you'll pay per click." },
          { key: "cpc", type: "money", label: "CPM bid", min: 0.01, required: true, width: "half", showIf: campaignIs("bidType", "CPM"), help: "Most you'll pay per 1,000 impressions." },
        ],
      },
      {
        id: "budget",
        title: "Budget",
        // The connector sends no schedule, so a lifetime budget would have no end date.
        fields: [...budgetFields({ lifetime: false, help: "Daily budget for the campaign." }), locationsField({ allowExclude: false, help: "Countries to show the promoted links in." })],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Targeting",
    sections: [{ id: "details", title: "Group", fields: [nameField("Group name", "India")] }],
  },
  ad: () => ({
    label: "Promoted link",
    sections: [
      {
        id: "link",
        title: "Promoted link",
        fields: [
          nameField("Name", "Festive story"),
          { key: "title", type: "text", label: "Title", placeholder: "5 festive looks to save", required: true, maxLength: 100, ai: { purpose: "Outbrain headline" } },
          urlField({ label: "Landing URL" }),
          { key: "imageUrl", type: "url", label: "Image URL", placeholder: "https://cdn.example.com/image.jpg", required: true, help: "A public image Outbrain can download." },
        ],
      },
    ],
  }),
  maxAdGroups: 5,
  maxAds: 20,
  previews: () => ["native_feed"],
};
