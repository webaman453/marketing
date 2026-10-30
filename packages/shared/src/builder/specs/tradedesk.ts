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
          ["VIDEO", "Video", "A VAST tag or VAST URL."],
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
      {
        id: "budget",
        title: "Budget",
        // The connector sends no end date, so a lifetime budget would have no end.
        fields: budgetFields({ lifetime: false, help: "Daily budget for the campaign. It's split evenly across its ad groups." }),
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "group",
        title: "Ad group",
        // The connector doesn't apply geo or device targeting to the ad group yet, so both say so.
        fields: [
          nameField("Ad group name", "India · mobile"),
          locationsField({ allowExclude: false, help: "Saved with the draft. Not applied to the ad group yet: set geo targeting on The Trade Desk after publishing." }),
          {
            key: "devices",
            type: "checkboxes",
            label: "Devices",
            options: opts([["PC", "Computer"], ["MOBILE", "Mobile"], ["TABLET", "Tablet"], ["CONNECTED_TV", "Connected TV"]]),
            help: "Saved with the draft. Not applied yet: set device targeting on The Trade Desk after publishing.",
          },
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
          { key: "headline", type: "text", label: "Headline", required: true, maxLength: 90, showIf: format("NATIVE"), ai: { purpose: "Native ad headline" } },
          { key: "description", type: "textarea", label: "Description", required: true, maxLength: 200, rows: 2, showIf: format("NATIVE"), ai: { purpose: "Native ad description" } },
          urlField({ label: "Click URL" }),
          {
            key: "imageUrl",
            type: "url",
            label: "Hosted image URL",
            showIf: format("DISPLAY", "NATIVE"),
            required: (ctx) => ctx.setup.format === "NATIVE" || !String(ctx.ad.tag ?? "").trim(),
            help: "A public image The Trade Desk can fetch. Display ads can use a third-party tag instead.",
          },
          // Same key for both: the connector reads `tag`.
          { key: "tag", type: "textarea", label: "Third-party tag", rows: 4, showIf: format("DISPLAY"), help: "An ad tag. Optional when a hosted image URL is set." },
          { key: "tag", type: "textarea", label: "VAST tag or URL", rows: 4, required: true, showIf: format("VIDEO"), help: "The VAST tag or VAST URL for the video." },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 15,
  previews: (ctx) => (ctx.setup.format === "VIDEO" ? ["video_instream"] : ctx.setup.format === "NATIVE" ? ["native_feed"] : ["display_banner"]),
};
