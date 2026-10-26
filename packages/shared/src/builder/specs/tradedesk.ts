/** The Trade Desk: display, video or native. CTV and audio stay disabled until a later release. */
import { budgetFields, launchSection, locationsField, nameField, opts, setupIs, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

const format = (...values: string[]) => setupIs("format", ...values);

export const tradeDeskSpec: PlatformBuilderSpec = {
  platform: "TRADEDESK",
  setup: [
    {
      key: "format",
      label: "Creative type",
      description: "What will this campaign serve?",
      options: [
        ...opts([
          ["DISPLAY", "Display", "A hosted image or a third-party tag."],
          ["VIDEO", "Video", "A hosted video or a VAST tag."],
          ["NATIVE", "Native", "Headline, description and image."],
        ]),
        { value: "CTV", label: "CTV", description: "Connected TV.", disabled: true, disabledReason: "CTV setup is not in this release." },
        { value: "AUDIO", label: "Audio", description: "Streaming audio.", disabled: true, disabledReason: "Audio setup is not in this release." },
      ],
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Prospecting display")] },
      { id: "budget", title: "Budget", fields: budgetFields({}) },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "group",
        title: "Ad group",
        fields: [
          nameField("Ad group name", "India · mobile"),
          locationsField(),
          { key: "devices", type: "checkboxes", label: "Devices", options: opts([["PC", "Computer"], ["MOBILE", "Mobile"], ["TABLET", "Tablet"], ["CONNECTED_TV", "Connected TV"]]) },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Creative",
    sections: [
      {
        id: "creative",
        title: "Creative",
        fields: [
          nameField("Creative name", "300×250 festive"),
          { key: "description", type: "textarea", label: "Description", rows: 2, showIf: format("NATIVE") },
          urlField({ label: "Click URL" }),
          { key: "imageUrl", type: "url", label: "Hosted image URL", showIf: format("DISPLAY", "NATIVE"), help: "Leave empty if you paste a third-party tag instead." },
          { key: "tag", type: "textarea", label: "Third-party tag", rows: 4, showIf: format("DISPLAY", "VIDEO"), help: "An ad tag or VAST URL. Optional when a hosted file URL is set." },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 15,
  previews: (ctx) => (ctx.setup.format === "VIDEO" ? ["youtube_instream"] : ctx.setup.format === "NATIVE" ? ["google_display_native"] : ["google_display"]),
};
