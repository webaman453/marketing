/** Criteo: retargeting or prospecting, then a display or native creative. */
import { adIs, budgetFields, launchSection, locationsField, nameField, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

const native = adIs("format", "NATIVE");

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
      {
        id: "budget",
        title: "Budget",
        // The connector sends no schedule, so a lifetime budget would have no end date.
        fields: [...budgetFields({ lifetime: false, help: "Daily budget for the ad set." }), locationsField({ allowExclude: false, help: "Countries to show the ads in." })],
      },
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
          { key: "headline", type: "text", label: "Headline", required: native, showIf: native, maxLength: 40, ai: { purpose: "Criteo native headline under 40 characters" } },
          { key: "description", type: "textarea", label: "Description", maxLength: 120, rows: 2, showIf: native },
          urlField(),
          { key: "imageUrl", type: "url", label: "Image URL", required: true, help: "A public image Criteo can fetch." },
        ],
      },
    ],
  }),
  // Criteo creates one ad set per campaign here.
  maxAdGroups: 1,
  maxAds: 15,
  previews: (ctx) => (ctx.ad.format === "NATIVE" ? ["native_feed"] : ["display_banner"]),
};
