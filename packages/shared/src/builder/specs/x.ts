/** X Ads: objective, line-item bid, then the post (text, link or app). */
import { budgetFields, launchSection, nameField, opts, urlField } from "../common";
import type { PlatformBuilderSpec } from "../types";

export const xSpec: PlatformBuilderSpec = {
  platform: "X",
  setup: [
    {
      key: "objective",
      label: "Objective",
      description: "What should this campaign optimize for?",
      options: opts([
        ["REACH", "Reach", "Show the post to as many people as possible."],
        ["ENGAGEMENTS", "Engagements", "Likes, reposts and replies."],
        ["WEBSITE_CLICKS", "Website clicks", "Send people to a URL."],
        ["VIDEO_VIEWS", "Video views", "Get people to watch."],
        ["APP_INSTALLS", "App installs", "Send people to an app store."],
        ["FOLLOWERS", "Followers", "Grow the account."],
      ]),
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive reach"), { key: "fundingInstrumentId", type: "text", label: "Funding instrument id", required: true, help: "From the X Ads account. The API will not create a campaign without it." }] },
      { id: "budget", title: "Budget", fields: budgetFields({}) },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "bid",
        title: "Ad group",
        fields: [nameField("Ad group name", "India · timeline"), { key: "bidAmount", type: "money", label: "Bid", min: 0, help: "Leave 0 to let X bid automatically.", width: "half" }],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "post",
        title: "Post",
        fields: [
          nameField("Ad name", "Festive post"),
          { key: "text", type: "textarea", label: "Post text", placeholder: "The festive edit is live.", required: true, maxLength: 280, rows: 3, ai: { purpose: "Short X post under 280 characters" } },
          urlField({ label: "Website URL", required: false }),
          { key: "appId", type: "text", label: "App id", placeholder: "123456789", help: "For app install campaigns." },
          { key: "video", type: "media", label: "Image or video", accept: ["IMAGE", "VIDEO"], min: 0, max: 1 },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 10,
  previews: () => ["linkedin_feed", "tiktok_feed"],
};
