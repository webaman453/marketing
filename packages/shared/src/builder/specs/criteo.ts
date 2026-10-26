/** Criteo: retargeting or prospecting, then a display or native creative. */
import { budgetFields, launchSection, locationsField, nameField, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const criteoSpec: PlatformBuilderSpec = {
  platform: "CRITEO",
  setup: [
    {
      key: "goal",
      label: "Goal",
      description: "Who should see the ads?",
      options: opts([
        ["RETARGETING", "Retargeting", "People who already visited or bought."],
        ["PROSPECTING", "Prospecting", "New shoppers similar to your customers."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Site retargeting")] },
      { id: "budget", title: "Budget", fields: [...budgetFields({}), locationsField()] },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad set",
    sections: [{ id: "details", title: "Ad set", fields: [nameField("Ad set name", "All visitors · 30 days")] }],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "creative",
        title: "Creative",
        fields: [
          nameField("Ad name", "Homepage banner"),
          { key: "format", type: "cards", label: "Format", options: opts([["DISPLAY", "Display", "A banner image."], ["NATIVE", "Native", "Headline and image in a publisher layout."]]), default: "DISPLAY" },
          { key: "headline", type: "text", label: "Headline", required: true, maxLength: 40 },
          { key: "description", type: "textarea", label: "Description", maxLength: 120, rows: 2 },
          urlField(),
          { key: "imageUrl", type: "url", label: "Image URL", required: true, help: "A public image Criteo can fetch." },
        ],
      },
    ],
  }),
  maxAdGroups: 8,
  maxAds: 15,
  previews: () => ["google_display", "google_display_native"],
};
