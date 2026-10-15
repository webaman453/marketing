export const PLATFORMS = [
  "META",
  "GOOGLE",
  "TIKTOK",
  "LINKEDIN",
  "MICROSOFT",
  "SNAPCHAT",
  "PINTEREST",
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
};

export const isPlatform = (value: unknown): value is Platform =>
  typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
