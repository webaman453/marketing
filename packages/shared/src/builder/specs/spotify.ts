/** Spotify Ads: awareness, traffic or conversions, then audio, video or display. */
import { adIs, budgetFields, launchSection, locationsField, nameField, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const spotifySpec: PlatformBuilderSpec = {
  platform: "SPOTIFY",
  setup: [
    {
      key: "objective",
      label: "Objective",
      description: "What should Spotify optimize for?",
      options: opts([
        ["REACH", "Awareness", "Reach listeners."],
        ["CLICKS", "Traffic", "Send people to a site."],
        ["CONVERSIONS", "Conversions", "Drive a specific action."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive audio")] },
      { id: "budget", title: "Budget", fields: budgetFields({}) },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad set",
    sections: [{ id: "where", title: "Ad set", fields: [nameField("Ad set name", "India · music"), locationsField()] }],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "creative",
        title: "Creative",
        fields: [
          nameField("Ad name", "30s audio"),
          {
            key: "format",
            type: "cards",
            label: "Format",
            options: opts([
              ["AUDIO", "Audio", "An audio spot plus a companion image."],
              ["VIDEO", "Video", "A video with a thumbnail."],
              ["DISPLAY", "Display", "A clickable image."],
            ]),
            default: "AUDIO",
          },
          { key: "headline", type: "text", label: "Headline", maxLength: 40 },
          { key: "tagline", type: "text", label: "Tagline", maxLength: 80 },
          urlField({ label: "Click URL", required: false }),
          { key: "audioUrl", type: "url", label: "Audio file URL", required: true, showIf: adIs("format", "AUDIO"), help: "A public audio file Spotify can fetch." },
          { key: "companionUrl", type: "url", label: "Companion image URL", required: true, showIf: adIs("format", "AUDIO"), help: "Shown while the audio plays." },
          { key: "videoUrl", type: "url", label: "Video file URL", required: true, showIf: adIs("format", "VIDEO") },
          { key: "thumbnailUrl", type: "url", label: "Thumbnail URL", required: true, showIf: adIs("format", "VIDEO") },
          { key: "imageUrl", type: "url", label: "Image URL", required: true, showIf: adIs("format", "DISPLAY") },
        ],
      },
    ],
  }),
  maxAdGroups: 8,
  maxAds: 10,
  previews: (ctx) => (ctx.ad.format === "DISPLAY" ? ["google_display"] : ["youtube_instream", "google_display"]),
};
