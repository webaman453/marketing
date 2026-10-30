/** X Ads: objective, line-item bid and goal, then the post (text, link, image or video). Posts are promoted-only. */
import { budgetFields, launchSection, nameField, opts, urlField } from "../common";
import type { BuilderIssue, FieldContext, Option, PlatformBuilderSpec } from "../types";

/** X counts every link as 23 characters (t.co), plus the line break before it. */
const LINK_CHARS = 24;
const POST_LIMIT = 280;

/** Line-item goals X accepts for each objective. */
const GOALS: Record<string, [string, string, string?][]> = {
  REACH: [["MAX_REACH", "Reach", "Show the post to as many people as possible."]],
  ENGAGEMENTS: [["ENGAGEMENT", "Engagements", "Pay for likes, reposts and replies."]],
  WEBSITE_CLICKS: [
    ["LINK_CLICKS", "Link clicks", "Pay for clicks to the URL."],
    ["SITE_VISITS", "Site visits", "Optimize for landing page loads."],
  ],
  VIDEO_VIEWS: [
    ["VIDEO_VIEW", "Video views", "2 seconds at 50% in view."],
    ["VIEW_3S_100PCT", "3-second views", "3 seconds fully in view."],
    ["VIEW_6S", "6-second views"],
    ["VIEW_15S", "15-second views"],
  ],
  APP_INSTALLS: [
    ["APP_INSTALLS", "App installs"],
    ["APP_CLICKS", "App clicks"],
  ],
  FOLLOWERS: [["FOLLOWERS", "Followers", "Pay for new followers."]],
};

const goalOptions = (ctx: FieldContext): Option[] => opts(GOALS[String(ctx.setup.objective)] ?? GOALS.WEBSITE_CLICKS!);

export const xSpec: PlatformBuilderSpec = {
  platform: "X",
  setup: [
    {
      key: "objective",
      label: "Objective",
      description: "What should this campaign optimize for?",
      options: [
        ...opts([
          ["REACH", "Reach", "Show the post to as many people as possible."],
          ["ENGAGEMENTS", "Engagements", "Likes, reposts and replies."],
          ["WEBSITE_CLICKS", "Website clicks", "Send people to a URL."],
        ]),
        ...opts([["VIDEO_VIEWS", "Video views", "Get people to watch. Each post needs a video."]]),
        { value: "APP_INSTALLS", label: "App installs", description: "Send people to an app store.", disabled: true, disabledReason: "App cards can't be attached from this form yet." },
        ...opts([["FOLLOWERS", "Followers", "Grow the account."]]),
      ],
    },
  ],
  campaign: {
    label: "Campaign",
    sections: [
      { id: "details", title: "Campaign", fields: [nameField("Campaign name", "Festive reach"), { key: "fundingInstrumentId", type: "text", label: "Funding instrument id", required: true, help: "From the X Ads account. The API will not create a campaign without it." }] },
      {
        id: "budget",
        title: "Budget",
        // The connector sends no schedule, so a lifetime (total) budget would have no end date.
        fields: budgetFields({ lifetime: false, help: "Daily budget for the campaign." }),
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Ad group",
    sections: [
      {
        id: "bid",
        title: "Ad group",
        fields: [
          nameField("Ad group name", "India · timeline"),
          { key: "goal", type: "select", label: "Goal", options: goalOptions, default: (ctx) => goalOptions(ctx)[0]!.value, help: "What X charges for and optimizes toward." },
          { key: "bidAmount", type: "money", label: "Bid", min: 0, help: "Leave 0 to let X bid automatically.", width: "half" },
        ],
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
          {
            key: "text",
            type: "textarea",
            label: "Post text",
            placeholder: "The festive edit is live.",
            required: true,
            maxLength: POST_LIMIT,
            rows: 3,
            help: `Up to ${POST_LIMIT - LINK_CHARS} characters when you add a website URL: the link uses ${LINK_CHARS - 1} plus a line break.`,
            ai: { purpose: `Short X post under ${POST_LIMIT - LINK_CHARS} characters` },
          },
          urlField({ label: "Website URL", required: false, help: "Added to the end of the post." }),
          // App installs stay disabled above; the app card isn't sent, so this only lives in the draft.
          { key: "appId", type: "text", label: "App id (draft only)", placeholder: "123456789", showIf: (ctx) => ctx.setup.objective === "APP_INSTALLS", help: "Saved with the draft. Not sent to X yet: add the app card on X." },
          // Key kept as "video" so existing drafts keep their media.
          {
            key: "video",
            type: "media",
            label: "Image or video",
            accept: ["IMAGE", "VIDEO"],
            min: 0,
            max: 1,
            help: "Uploaded to the ad account's Media Library and attached to the post.",
          },
        ],
      },
    ],
  }),
  maxAdGroups: 10,
  maxAds: 10,
  previews: () => ["x_feed"],
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const goals = (GOALS[String(draft.setup.objective)] ?? []).map(([value]) => value);
    for (const g of draft.adGroups) {
      if (g.values.goal && goals.length && !goals.includes(String(g.values.goal))) {
        issues.push({ level: "adGroup", nodeKey: g.key, field: "goal", message: "Choose a goal that fits the campaign objective." });
      }
      for (const a of g.ads) {
        if (draft.setup.objective === "VIDEO_VIEWS" && !(Array.isArray(a.values.video) && a.values.video.length)) {
          issues.push({ level: "ad", nodeKey: a.key, field: "video", message: "Add a video: a video views campaign promotes video posts." });
        }
        const text = typeof a.values.text === "string" ? a.values.text.trim() : "";
        const url = typeof a.values.url === "string" ? a.values.url.trim() : "";
        const used = text.length + (url ? LINK_CHARS : 0);
        // Without a URL the field's own 280 limit applies.
        if (text && url && used > POST_LIMIT) {
          issues.push({
            level: "ad",
            nodeKey: a.key,
            field: "text",
            message: `Post text and link need ${used} of ${POST_LIMIT} characters. Keep the text to ${POST_LIMIT - LINK_CHARS} with a URL.`,
          });
        }
      }
    }
    return issues;
  },
};
