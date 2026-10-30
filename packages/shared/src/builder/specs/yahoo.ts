/** Yahoo DSP: display, native or video line. */
import { budgetFields, launchSection, nameField, opts, setupIs, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

const format = (...values: string[]) => setupIs("format", ...values);

export const yahooSpec: PlatformBuilderSpec = {
  platform: "YAHOO",
  setup: [
    {
      key: "format",
      label: "Format",
      description: "The kind of line this campaign buys.",
      options: opts([
        ["DISPLAY", "Display", "Banner inventory."],
        ["NATIVE", "Native", "In-feed native."],
        ["VIDEO", "Video", "In-stream or out-stream video."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive display")] },
      {
        id: "budget",
        title: "Budget",
        // The connector sends no schedule, so a lifetime budget would have no end date.
        fields: budgetFields({ lifetime: false, help: "Daily budget for the campaign. It's split evenly across its lines." }),
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Line",
    sections: [{ id: "line", title: "Line", fields: [nameField("Line name", "India · desktop")] }],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "ad",
        title: "Ad",
        fields: [
          nameField("Ad name", "300×250"),
          { key: "headline", type: "text", label: "Headline", showIf: format("NATIVE", "VIDEO") },
          { key: "description", type: "textarea", label: "Description", rows: 2, showIf: format("NATIVE") },
          urlField(),
          {
            key: "size",
            type: "select",
            label: "Size",
            showIf: format("DISPLAY"),
            options: opts([["300x250", "300×250"], ["728x90", "728×90"], ["320x50", "320×50"], ["160x600", "160×600"]]),
            default: "300x250",
          },
          { key: "imageUrl", type: "url", label: "Image URL", required: true, showIf: format("DISPLAY", "NATIVE") },
          { key: "videoUrl", type: "url", label: "Video URL", required: true, showIf: format("VIDEO") },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 15,
  previews: (ctx) => (ctx.setup.format === "VIDEO" ? ["video_instream"] : ctx.setup.format === "NATIVE" ? ["native_feed"] : ["display_banner"]),
};
