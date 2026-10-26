/** Outbrain: campaign budget and geo → promoted link (title, image URL, landing URL). */
import { budgetFields, launchSection, locationsField, nameField, opts, urlField } from "../common";
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
          { key: "cpc", type: "money", label: "CPC bid", min: 0.01, required: true, width: "half" },
        ],
      },
      { id: "budget", title: "Budget", fields: [...budgetFields({}), locationsField()] },
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
  previews: () => ["google_display_native", "discover"],
};
