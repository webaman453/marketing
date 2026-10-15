/**
 * Turns platform-specific builder values into one shape the placement
 * mockups can render: texts, media, CTA and links.
 */
import { ctaLabel, displayDomain, listTexts, type AdPreviewData, type PreviewMedia, type Values } from "@ashniva/shared";

export interface PreviewCard {
  media: PreviewMedia | null;
  headline: string;
  description: string;
  url: string;
}

export interface NormalizedAd {
  brand: string;
  primaryText: string;
  headline: string;
  headlines: { text: string; pin: string | null }[];
  descriptions: { text: string; pin: string | null }[];
  description: string;
  longHeadline: string;
  cta: string | null;
  url: string;
  domain: string;
  paths: string[];
  media: PreviewMedia[];
  storyMedia: PreviewMedia | null;
  logo: PreviewMedia | null;
  cards: PreviewCard[];
  youtube: string[];
  sitelinks: { text: string; description1: string; description2: string }[];
  callouts: string[];
  format: string;
}

const str = (v: Values, k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : "");
const items = (v: Values, k: string) =>
  (Array.isArray(v[k]) ? (v[k] as unknown[]) : [])
    .map((x) => (typeof x === "string" ? { text: x.trim(), pin: null } : { text: String((x as { text?: string }).text ?? "").trim(), pin: (x as { pin?: string | null }).pin ?? null }))
    .filter((x) => x.text);
const first = (v: Values, keys: string[]) => {
  for (const k of keys) {
    const t = Array.isArray(v[k]) ? listTexts(v[k]).find(Boolean) : str(v, k);
    if (t) return t;
  }
  return "";
};

export const youtubeThumb = (url: string) => {
  const id = /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/.exec(url)?.[1];
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
};

export function normalizeAd(data: AdPreviewData): NormalizedAd {
  const { ad, adGroup, campaign } = data;
  // Asset-group platforms keep the creative on the ad group (and brand assets on the campaign).
  const v: Values = { ...campaign, ...adGroup, ...ad };
  const mediaIds = (key: string) => (Array.isArray(v[key]) ? (v[key] as string[]) : []).map((id) => data.media[id]).filter((m): m is PreviewMedia => Boolean(m));
  const media = ["media", "video", "images", "image", "landscapeImages", "squareImages", "portraitImages", "storySnaps", "textImage", "banner"].flatMap(mediaIds);
  const logo = mediaIds("logos")[0] ?? mediaIds("avatar")[0] ?? null;
  const cards = (Array.isArray(v.cards) ? (v.cards as Values[]) : []).map((c) => ({
    media: (Array.isArray(c.media) ? (c.media as string[]) : Array.isArray(c.image) ? (c.image as string[]) : []).map((id) => data.media[id]).find(Boolean) ?? null,
    headline: str(c, "headline"),
    description: str(c, "description"),
    url: str(c, "url"),
  }));
  const url = first(v, ["url", "finalUrl"]) || cards[0]?.url || "";
  const ctaValue = str(v, "cta");
  const brand = str(v, "displayName") || str(v, "brandName") || str(v, "businessName") || data.identity.name;

  return {
    brand,
    primaryText: first(v, ["primaryTexts", "introText", "adText", "messageBody", "description"]),
    headline: first(v, ["headlines", "headline", "title", "textHeadline", "subject", "tileHeadline", "longHeadline", "longHeadlines"]),
    headlines: items(v, "headlines"),
    descriptions: items(v, "descriptions"),
    description: first(v, ["descriptions", "textDescription", "description"]),
    longHeadline: first(v, ["longHeadline", "longHeadlines"]),
    cta: ctaValue === "NO_BUTTON" ? null : ctaValue === "AUTOMATED" || !ctaValue ? (str(v, "buttonLabel") || "Learn more") : ctaValue === "BOOK_TRAVEL" ? "Book now" : ctaLabel(ctaValue),
    url,
    domain: str(v, "displayLink") || displayDomain(url),
    paths: [str(v, "path1"), str(v, "path2")].filter(Boolean),
    media,
    storyMedia: mediaIds("storyMedia")[0] ?? null,
    logo,
    cards,
    youtube: listTexts(v.youtubeVideos).filter(Boolean),
    sitelinks: (Array.isArray(v.sitelinks) ? (v.sitelinks as Values[]) : []).filter((s) => str(s, "text")).map((s) => ({ text: str(s, "text"), description1: str(s, "description1"), description2: str(s, "description2") })),
    callouts: listTexts(v.callouts).filter(Boolean),
    format: str(v, "format"),
  };
}

/** Builds preview data for ads that weren't made in the builder (synced or sample ads). */
export function fallbackPreview(platform: AdPreviewData["platform"], ad: { name: string; headline: string | null; body: string | null; finalUrl: string | null; thumbnailUrl: string | null }, brand: string): AdPreviewData {
  const media: Record<string, PreviewMedia> = ad.thumbnailUrl ? { thumb: { id: "thumb", url: ad.thumbnailUrl, type: "IMAGE", width: null, height: null } } : {};
  return {
    platform,
    setup: {},
    campaign: {},
    adGroup: {},
    ad: {
      headlines: ad.headline ? [ad.headline] : [],
      primaryTexts: ad.body ? [ad.body] : [],
      descriptions: ad.body ? [ad.body] : [],
      adText: ad.body ?? "",
      introText: ad.body ?? "",
      title: ad.headline ?? "",
      headline: ad.headline ?? "",
      url: ad.finalUrl ?? "",
      finalUrl: ad.finalUrl ?? "",
      media: ad.thumbnailUrl ? ["thumb"] : [],
    },
    media,
    identity: { name: brand },
  };
}
