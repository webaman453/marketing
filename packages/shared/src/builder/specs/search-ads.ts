/** Responsive search ad and asset fields shared by Google Ads and Microsoft Advertising. */
import { urlField } from "../common";
import type { Field, Section } from "../types";

export const HEADLINE_PINS = { positions: ["H1", "H2", "H3"] };
export const DESCRIPTION_PINS = { positions: ["D1", "D2"] };

export const SNIPPET_HEADERS = [
  "Amenities", "Brands", "Courses", "Degree programs", "Destinations", "Featured hotels", "Insurance coverage", "Models", "Neighborhoods",
  "Service catalog", "Shows", "Styles", "Types",
];

export function rsaSections(opts: { platformName: string }): Section[] {
  return [
    {
      id: "ad",
      title: "Responsive search ad",
      description: `${opts.platformName} mixes your headlines and descriptions to show the best combination for each search.`,
      fields: [
        urlField({ key: "finalUrl", label: "Final URL", help: "Where people land after clicking your ad." }),
        { key: "path1", type: "text", label: "Display path 1", maxLength: 15, width: "half", placeholder: "sale", help: "Shown after your domain, e.g. yourstore.com/sale/dresses" },
        { key: "path2", type: "text", label: "Display path 2", maxLength: 15, width: "half", placeholder: "dresses", showIf: (ctx) => Boolean(String(ctx.ad.path1 ?? "").trim()) },
        {
          key: "headlines",
          type: "textList",
          label: "Headlines",
          itemLabel: "Headline",
          min: 3,
          max: 15,
          initial: 5,
          maxLength: 30,
          required: true,
          pinnable: HEADLINE_PINS,
          help: "Add at least 3, ideally 10 or more. Include your keywords, offer and brand.",
          ai: { purpose: "search ad headlines that include the main keywords; at least one with the brand, one with an offer, one with a call to action" },
        },
        {
          key: "descriptions",
          type: "textList",
          label: "Descriptions",
          itemLabel: "Description",
          min: 2,
          max: 4,
          initial: 2,
          maxLength: 90,
          required: true,
          pinnable: DESCRIPTION_PINS,
          multiline: true,
          ai: { purpose: "search ad descriptions with benefits and a call to action" },
        },
      ],
    },
    {
      id: "assets",
      title: "Assets",
      description: "Extra information that makes your ad bigger and more useful. Each one is optional.",
      fields: [
        {
          key: "sitelinks",
          type: "repeater",
          label: "Sitelinks",
          itemLabel: "Sitelink",
          min: 0,
          max: 8,
          help: "Links to other pages on your site. Add 4 or more for the best chance to show.",
          fields: [
            { key: "text", type: "text", label: "Sitelink text", placeholder: "Shop the sale", required: true, maxLength: 25, ai: { purpose: "sitelink text" } },
            { key: "description1", type: "text", label: "Description line 1", placeholder: "Up to 50% off", maxLength: 35 },
            { key: "description2", type: "text", label: "Description line 2", placeholder: "Free delivery over ₹999", maxLength: 35 },
            { key: "url", type: "url", label: "Final URL", placeholder: "https://yourstore.com/sale", required: true },
          ],
        },
        {
          key: "callouts",
          type: "textList",
          label: "Callouts",
          itemLabel: "Callout",
          min: 0,
          max: 10,
          initial: 0,
          maxLength: 25,
          help: "Short highlights like “Free delivery” or “24/7 support”.",
          ai: { purpose: "callout highlights such as free delivery, returns, support" },
        },
        {
          key: "snippetHeader",
          type: "select",
          label: "Structured snippet header",
          options: SNIPPET_HEADERS.map((h) => ({ value: h, label: h })),
          advanced: true,
          width: "half",
        },
        {
          key: "snippetValues",
          type: "textList",
          label: "Snippet values",
          itemLabel: "Value",
          min: 0,
          max: 10,
          initial: 0,
          maxLength: 25,
          advanced: true,
          showIf: (ctx) => Boolean(ctx.ad.snippetHeader),
          help: "3 to 10 values, e.g. Types: Kurtas, Sarees, Lehengas.",
        },
        { key: "phone", type: "text", label: "Call asset: phone number", placeholder: "+91 98765 43210", maxLength: 25, advanced: true, width: "half" },
      ],
    },
  ];
}

export const searchNetworkHelp = "Search partners show your ads on other sites that use the same search results.";

/** Google/Microsoft keyword match types with plain-language help. */
export const MATCH_TYPE_HELP =
  "Broad reaches related searches, “phrase” requires the meaning of the phrase, [exact] requires the same meaning as the keyword.";

export const keywordsField = (max = 1000): Field => ({
  key: "keywords",
  type: "keywords",
  label: "Keywords",
  matchTypes: ["BROAD", "PHRASE", "EXACT"],
  max,
  min: 1,
  required: true,
  help: MATCH_TYPE_HELP,
  ai: { purpose: "search keywords" },
});

export const negativeKeywordsField = (): Field => ({
  key: "negativeKeywords",
  type: "keywords",
  label: "Negative keywords",
  matchTypes: ["BROAD", "PHRASE", "EXACT"],
  max: 1000,
  negative: true,
  help: "Searches that should never show your ad, e.g. “free”, “jobs”.",
  advanced: true,
});
