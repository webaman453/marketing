/** Taboola: campaign (objective, budget, country, device) → item (title, description, image, URL). */
import { budgetFields, launchSection, locationsField, nameField, opts, scheduleFields, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const taboolaSpec: PlatformBuilderSpec = {
  platform: "TABOOLA",
  setup: [
    {
      key: "objective",
      label: "Campaign objective",
      description: "What should this campaign do?",
      options: opts([
        ["TRAFFIC", "Traffic", "Send people to your site."],
        ["LEADS", "Leads", "Collect sign-ups and enquiries."],
        ["AWARENESS", "Awareness", "Get your brand in front of more people."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive edit – native"), { key: "brand", type: "text", label: "Brand name", placeholder: "Ashniva", required: true, maxLength: 25 }] },
      { id: "budget", title: "Budget", fields: budgetFields({}) },
      { id: "targeting", title: "Where it runs", fields: [locationsField(), { key: "devices", type: "checkboxes", label: "Devices", options: opts([["DESK", "Desktop"], ["PHON", "Phone"], ["TBLT", "Tablet"]]) }] },
      { id: "schedule", title: "Schedule", fields: [...scheduleFields(), ...launchSection().fields] },
    ],
  },
  adGroup: {
    label: "Targeting",
    sections: [{ id: "details", title: "Group", fields: [nameField("Group name", "India · all devices")] }],
  },
  ad: () => ({
    label: "Item",
    sections: [
      {
        id: "item",
        title: "Sponsored item",
        fields: [
          nameField("Item name", "Festive collection"),
          { key: "title", type: "text", label: "Headline", placeholder: "The festive edit is here", required: true, maxLength: 60, ai: { purpose: "Taboola native headline, under 60 characters" } },
          { key: "description", type: "textarea", label: "Description", placeholder: "Handcrafted ethnic wear, delivered in 48 hours.", maxLength: 250, rows: 2, ai: { purpose: "Short native description" } },
          urlField({ label: "Landing URL" }),
          { key: "imageUrl", type: "url", label: "Thumbnail URL", placeholder: "https://cdn.example.com/thumb.jpg", required: true, help: "A public image Taboola can fetch. 600×400 or larger." },
          { key: "image", type: "media", label: "Or upload a thumbnail", accept: ["IMAGE"], min: 0, max: 1, help: "Used when Thumbnail URL is empty and Taboola accepts the upload." },
        ],
      },
    ],
  }),
  maxAdGroups: 5,
  maxAds: 20,
  previews: () => ["google_display_native", "discover"],
};
