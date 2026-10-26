export const PLATFORMS = [
  "META",
  "GOOGLE",
  "TIKTOK",
  "LINKEDIN",
  "MICROSOFT",
  "SNAPCHAT",
  "PINTEREST",
  "AMAZON",
  "X",
  "APPLE",
  "SPOTIFY",
  "CRITEO",
  "TABOOLA",
  "OUTBRAIN",
  "TRADEDESK",
  "YAHOO",
  "SHOPIFY",
  "SWIGGY",
  "ZEPTO",
  "NAUKRI",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export type PlatformAvailability = "live" | "coming_soon";

export interface PlatformInfo {
  id: Platform;
  name: string;
  /** Short description shown on the integrations page. */
  description: string;
  /** Sub-channels covered by this connection, e.g. Google covers YouTube. */
  channels: string[];
  /** Brand color used for chart series and badges. */
  color: string;
  availability: PlatformAvailability;
  /** Platform naming for each level of the hierarchy. */
  terms: { campaign: string; adGroup: string; ad: string };
}

export const PLATFORM_INFO: Record<Platform, PlatformInfo> = {
  META: {
    id: "META",
    name: "Meta Ads",
    description: "Facebook, Instagram, Messenger and Audience Network campaigns.",
    channels: ["Facebook", "Instagram", "Messenger", "Audience Network"],
    color: "#0866FF",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad set", ad: "Ad" },
  },
  GOOGLE: {
    id: "GOOGLE",
    name: "Google Ads",
    description: "Search, Display, Shopping, Performance Max and YouTube video campaigns.",
    channels: ["Search", "Display", "YouTube", "Shopping", "Performance Max"],
    color: "#34A853",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  TIKTOK: {
    id: "TIKTOK",
    name: "TikTok Ads",
    description: "In-feed, TopView and Spark Ads campaigns.",
    channels: ["TikTok", "Pangle"],
    color: "#FE2C55",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  LINKEDIN: {
    id: "LINKEDIN",
    name: "LinkedIn Ads",
    description: "Sponsored content, message ads and lead gen forms.",
    channels: ["Sponsored Content", "Message Ads", "Text Ads"],
    color: "#0A66C2",
    availability: "live",
    terms: { campaign: "Campaign group", adGroup: "Campaign", ad: "Creative" },
  },
  MICROSOFT: {
    id: "MICROSOFT",
    name: "Microsoft Ads",
    description: "Bing search and Microsoft Audience Network campaigns.",
    channels: ["Bing", "Audience Network"],
    color: "#00A4EF",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  SNAPCHAT: {
    id: "SNAPCHAT",
    name: "Snapchat Ads",
    description: "Snap ads, story ads and collection ads.",
    channels: ["Snapchat"],
    color: "#F7C600",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad squad", ad: "Ad" },
  },
  PINTEREST: {
    id: "PINTEREST",
    name: "Pinterest Ads",
    description: "Promoted pins, video pins and shopping ads.",
    channels: ["Pinterest"],
    color: "#E60023",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Pin" },
  },
  AMAZON: {
    id: "AMAZON",
    name: "Amazon Ads",
    description: "Sponsored Products, Sponsored Brands and Sponsored Display.",
    channels: ["Sponsored Products", "Sponsored Brands", "Sponsored Display"],
    color: "#FF9900",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  X: {
    id: "X",
    name: "X Ads",
    description: "Promoted posts on X for reach, clicks, video and app installs.",
    channels: ["Timeline", "Search", "Profiles"],
    color: "#111111",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  APPLE: {
    id: "APPLE",
    name: "Apple Ads",
    description: "Apple Search Ads for App Store search results and product pages.",
    channels: ["Search results", "Search tab", "Product pages"],
    color: "#111111",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Ad" },
  },
  SPOTIFY: {
    id: "SPOTIFY",
    name: "Spotify Ads",
    description: "Audio, video and display ads in Spotify.",
    channels: ["Audio", "Video", "Display"],
    color: "#1DB954",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad set", ad: "Ad" },
  },
  CRITEO: {
    id: "CRITEO",
    name: "Criteo",
    description: "Commerce retargeting and prospecting display and native ads.",
    channels: ["Display", "Native"],
    color: "#FE5000",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad set", ad: "Ad" },
  },
  TABOOLA: {
    id: "TABOOLA",
    name: "Taboola",
    description: "Native sponsored content on news and publisher sites.",
    channels: ["Native"],
    color: "#0057FF",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Targeting", ad: "Item" },
  },
  OUTBRAIN: {
    id: "OUTBRAIN",
    name: "Outbrain",
    description: "Native promoted links across the Outbrain network.",
    channels: ["Native"],
    color: "#EE6513",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Targeting", ad: "Promoted link" },
  },
  TRADEDESK: {
    id: "TRADEDESK",
    name: "The Trade Desk",
    description: "Programmatic display, video and native on The Trade Desk.",
    channels: ["Display", "Video", "Native"],
    color: "#00B140",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Ad group", ad: "Creative" },
  },
  YAHOO: {
    id: "YAHOO",
    name: "Yahoo DSP",
    description: "Display, native and video on Yahoo DSP.",
    channels: ["Display", "Native", "Video"],
    color: "#6001D2",
    availability: "live",
    terms: { campaign: "Campaign", adGroup: "Line", ad: "Ad" },
  },
  SHOPIFY: {
    id: "SHOPIFY",
    name: "Shopify",
    description: "Connect a store and record its marketing campaign, budget and UTM tags. Shopify does not serve the ad.",
    channels: ["Store", "UTM tracking"],
    color: "#008060",
    availability: "live",
    terms: { campaign: "Marketing event", adGroup: "Tracking", ad: "Landing page" },
  },
  SWIGGY: {
    id: "SWIGGY",
    name: "Swiggy Ads",
    description: "Food, Instamart and Dineout ads use the Swiggy partner portal. Swiggy has no public ads API, so this cannot connect or publish.",
    channels: ["Food", "Instamart", "Dineout"],
    color: "#FC8019",
    availability: "coming_soon",
    terms: { campaign: "Campaign", adGroup: "City", ad: "Products" },
  },
  ZEPTO: {
    id: "ZEPTO",
    name: "Zepto Ads",
    description: "Sponsored products for brands that already sell on Zepto. Zepto has no public ads API, so this cannot connect or publish.",
    channels: ["Sponsored products"],
    color: "#6C0BA9",
    availability: "coming_soon",
    terms: { campaign: "Campaign", adGroup: "Targeting", ad: "SKU" },
  },
  NAUKRI: {
    id: "NAUKRI",
    name: "Naukri.com",
    description: "Hot vacancy and classified job posts. Naukri's job API is partner-only and not open to publish from here.",
    channels: ["Hot vacancy", "Classified"],
    color: "#1B4F9C",
    availability: "coming_soon",
    terms: { campaign: "Job", adGroup: "Location", ad: "Posting" },
  },
};

export const isPlatform = (value: unknown): value is Platform =>
  typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);

/** Still implemented, but not listed in the app. */
const HIDDEN_PLATFORMS = new Set<Platform>(["TIKTOK", "SWIGGY", "ZEPTO", "NAUKRI"]);

export const isPlatformShown = (platform: Platform) => !HIDDEN_PLATFORMS.has(platform);

export const VISIBLE_PLATFORMS = PLATFORMS.filter(isPlatformShown);
