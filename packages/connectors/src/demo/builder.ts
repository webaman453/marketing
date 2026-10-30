/**
 * Builder support for sample accounts: account assets, targeting search and
 * local campaign creation. Nothing is sent to an ad platform.
 */
import {
  BUILDER_SPECS,
  COUNTRIES,
  listTexts,
  type BuilderDraft,
  type BuilderOptions,
  type Platform,
  type TargetingKind,
  type TargetingSearchResult,
  type Values,
} from "@ashniva/shared";
import { randomBytes } from "node:crypto";
import { budgetOf, dayIn, dayOf, repeater, str } from "../builder-values";
import type { AccountStructure, ExternalAd } from "../types";

const item = (id: string, name: string, detail?: string) => ({ id, name, detail });

const PAGE_NAMES: Partial<Record<Platform, string>> = {
  META: "Ashniva Retail",
  LINKEDIN: "Ashniva Technologies",
  SNAPCHAT: "Ashniva Retail",
  TIKTOK: "ashniva.retail",
};

export function demoBuilderOptions(platform: Platform): BuilderOptions {
  const brand = PAGE_NAMES[platform] ?? "Ashniva Retail";
  return {
    pages: [item("sample-page-1", `${brand} (sample page)`, "Facebook Page"), item("sample-page-2", "Ashniva Outlet (sample page)", "Facebook Page")],
    instagramAccounts: [item("sample-ig-1", "@ashniva.retail (sample)", "Instagram business account")],
    pixels: [item("sample-pixel-1", "Ashniva Website (sample)", platform === "META" ? "Dataset / pixel" : "Website tag")],
    conversionActions: [
      item("sample-conv-purchase", "Purchase (sample)", "Website · Primary"),
      item("sample-conv-lead", "Lead form submit (sample)", "Website · Primary"),
      item("sample-conv-signup", "Sign-up (sample)", "Website · Secondary"),
    ],
    leadForms: [item("sample-form-1", "Free consultation form (sample)", "5 questions"), item("sample-form-2", "Catalog download (sample)", "3 questions")],
    identities: [item("sample-tt-1", "@ashniva.retail (sample)", "TikTok account")],
    organizations: [item("sample-org-1", "Ashniva Technologies (sample)", "LinkedIn Page")],
    profiles: [item("sample-profile-1", platform === "LINKEDIN" ? "Priya Sharma (sample)" : "Ashniva Retail (sample)", platform === "LINKEDIN" ? "Head of Growth" : "Public profile")],
    apps: [item("sample-app-android", "Ashniva Shop (sample)", "Android · com.ashniva.shop"), item("sample-app-ios", "Ashniva Shop (sample)", "iOS · id1234567890")],
    catalogs: [item("sample-catalog-1", "Ashniva product catalog (sample)", "1,240 products")],
    merchantCenters: [item("sample-mc-1", "Ashniva Store (sample)", "Merchant Center · IN")],
    audiences: [
      item("sample-aud-visitors", "Website visitors – 30 days (sample)", "≈ 48,000 people"),
      item("sample-aud-buyers", "Purchasers – 180 days (sample)", "≈ 9,200 people"),
      item("sample-aud-lal", "Lookalike 1% – Purchasers (sample)", "≈ 1.1M people"),
    ],
    boards: [item("sample-board-1", "Ashniva Ads (secret board, sample)")],
    youtubeChannels: [item("sample-yt-1", "Ashniva Retail (sample)", "YouTube channel")],
  };
}

const CITIES: TargetingSearchResult[] = [
  ["Mumbai", "Maharashtra"], ["Delhi", "Delhi"], ["Bengaluru", "Karnataka"], ["Hyderabad", "Telangana"], ["Chennai", "Tamil Nadu"], ["Kolkata", "West Bengal"],
  ["Pune", "Maharashtra"], ["Ahmedabad", "Gujarat"], ["Jaipur", "Rajasthan"], ["Lucknow", "Uttar Pradesh"], ["Chandigarh", "Chandigarh"], ["Indore", "Madhya Pradesh"],
  ["Surat", "Gujarat"], ["Kochi", "Kerala"], ["Noida", "Uttar Pradesh"], ["Gurugram", "Haryana"],
].map(([city, state]) => ({ id: `IN-city-${city!.toLowerCase()}`, name: city!, type: "city", countryCode: "IN", detail: `City · ${state}, India` }));

const REGIONS: TargetingSearchResult[] = ["Maharashtra", "Karnataka", "Delhi", "Tamil Nadu", "Gujarat", "Uttar Pradesh", "West Bengal", "Telangana", "Kerala", "Rajasthan", "Punjab", "Haryana"].map(
  (r) => ({ id: `IN-region-${r.toLowerCase().replace(/\s+/g, "-")}`, name: r, type: "region", countryCode: "IN", detail: "State · India" }),
);

const CATALOG: Record<Exclude<TargetingKind, "location" | "language">, string[]> = {
  interest: [
    "Online shopping", "Fashion", "Ethnic wear", "Clothing", "Shoes", "Jewellery", "Beauty", "Skin care", "Makeup", "Home decor", "Interior design",
    "Fitness and wellness", "Yoga", "Running", "Travel", "Luxury goods", "Electronics", "Smartphones", "Gaming", "Cooking", "Food and drink",
    "Parenting", "Weddings", "Festivals", "Bollywood", "Cricket", "Small business", "Entrepreneurship", "Real estate", "Personal finance", "Investing",
    "Technology", "Software", "Online education", "Cars", "Pets", "Photography", "Music", "Movies", "Books",
  ],
  behavior: ["Engaged shoppers", "Frequent travellers", "Small business owners", "Recently moved", "Early technology adopters", "Watched fashion videos", "Liked beauty videos", "Shared food videos"],
  jobTitle: ["Marketing Manager", "Chief Marketing Officer", "Founder", "Chief Executive Officer", "Head of Growth", "Digital Marketing Manager", "Brand Manager", "Sales Director", "Chief Technology Officer", "Product Manager", "HR Manager", "Procurement Manager", "Operations Manager", "Finance Manager"],
  industry: ["Retail", "Software Development", "IT Services and IT Consulting", "Financial Services", "Advertising Services", "Hospitals and Health Care", "Education", "Manufacturing", "Real Estate", "Telecommunications", "Consumer Goods", "Travel Arrangements"],
  skill: ["Digital Marketing", "Performance Marketing", "Google Ads", "Social Media Marketing", "SEO", "Data Analysis", "Project Management", "Sales", "Brand Management", "E-commerce"],
  company: ["Tata Consultancy Services", "Infosys", "Reliance Industries", "HDFC Bank", "Flipkart", "Zomato", "Swiggy", "Wipro", "Accenture", "Deloitte"],
};

export function demoSearchTargeting(kind: TargetingKind, query: string): TargetingSearchResult[] {
  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  if (kind === "location") {
    const countries: TargetingSearchResult[] = COUNTRIES.filter((c) => match(c.name) || c.code.toLowerCase() === q).map((c) => ({ id: c.code, name: c.name, type: "country", detail: "Country" }));
    return [...countries, ...REGIONS.filter((r) => match(r.name)), ...CITIES.filter((c) => match(c.name))].slice(0, 25);
  }
  if (kind === "language") return [];
  return CATALOG[kind]
    .filter(match)
    .slice(0, 25)
    .map((name, i) => ({ id: `sample-${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, detail: kind === "interest" || kind === "behavior" ? `≈ ${((name.length * 7 + i * 3) % 90) + 10}M people` : undefined }));
}

/** First non-empty text among the given keys. */
function firstText(v: Values, keys: string[]) {
  for (const k of keys) {
    const t = Array.isArray(v[k]) ? listTexts(v[k]).find(Boolean) : str(v, k);
    if (t) return t;
  }
  return null;
}

const HEADLINE_KEYS = ["headlines", "headline", "title", "textHeadline", "subject", "tileHeadline", "longHeadline", "longHeadlines"];
const BODY_KEYS = ["primaryTexts", "introText", "adText", "descriptions", "description", "textDescription", "messageBody"];
const URL_KEYS = ["url", "finalUrl"];

/** `timeZone` is the ad account's: a campaign with no start date starts today there. */
export function demoCreateCampaign(accountExternalId: string, draft: BuilderDraft, timeZone = "UTC"): AccountStructure {
  const spec = BUILDER_SPECS[draft.platform];
  const id = `${accountExternalId}-new-${randomBytes(4).toString("hex")}`;
  const status = draft.campaign.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const campaignBudget = budgetOf(draft.campaign);
  const objective = String(draft.setup.objective ?? draft.setup.goal ?? draft.setup.campaignType ?? "");
  const start = dayOf(draft.campaign, "startDate") ?? dayOf(draft.adGroups[0]?.values ?? {}, "startDate");
  const end = dayOf(draft.campaign, "endDate") ?? dayOf(draft.adGroups[0]?.values ?? {}, "endDate");

  const structure: AccountStructure = {
    campaigns: [
      {
        externalId: id,
        name: str(draft.campaign, "name"),
        status,
        deliveryStatus: status === "ACTIVE" ? "LEARNING" : "CAMPAIGN_PAUSED",
        objective: draft.setup.campaignType ? `${draft.setup.campaignType}` : objective,
        dailyBudget: campaignBudget && !campaignBudget.lifetime ? campaignBudget.amount : null,
        lifetimeBudget: campaignBudget?.lifetime ? campaignBudget.amount : null,
        startDate: start ?? dayIn(new Date(), timeZone),
        endDate: end,
        updatedAt: new Date(),
        raw: { sample: true, builder: true, setup: draft.setup, daily_budget: campaignBudget?.amount ?? null },
      },
    ],
    adGroups: [],
    ads: [],
  };

  draft.adGroups.forEach((g, gi) => {
    const groupId = `${id}-g${gi}`;
    const budget = budgetOf(g.values);
    structure.adGroups.push({
      externalId: groupId,
      campaignExternalId: id,
      name: str(g.values, "name") || `${spec.adGroup.label} ${gi + 1}`,
      status,
      dailyBudget: budget && !budget.lifetime ? budget.amount : null,
      bidStrategy: str(g.values, "bidStrategy") || str(draft.campaign, "bidStrategy") || str(draft.campaign, "bidding") || null,
      targeting: g.values,
      raw: { sample: true },
      sourceKey: g.key,
    });
    // Asset-group platforms (Performance Max) have no separate ads: the group itself is the ad.
    const nodes = g.ads.length ? g.ads : [{ key: g.key, values: g.values }];
    nodes.forEach((a, ai) => {
      const v = a.values;
      const ad: ExternalAd = {
        externalId: `${groupId}-a${ai}`,
        adGroupExternalId: groupId,
        campaignExternalId: id,
        name: str(v, "name") || firstText(v, HEADLINE_KEYS) || `Ad ${ai + 1}`,
        status,
        headline: firstText(v, HEADLINE_KEYS),
        body: firstText(v, BODY_KEYS),
        thumbnailUrl: null,
        finalUrl: firstText(v, URL_KEYS) ?? (str(repeater(v, "cards")[0] ?? {}, "url") || null),
        raw: { sample: true },
        sourceKey: a.key,
      };
      structure.ads.push(ad);
    });
  });
  return structure;
}
