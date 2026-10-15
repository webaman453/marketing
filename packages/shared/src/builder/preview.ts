/** What an ad preview needs, stored on ads created by the builder (ads.preview). */
import type { Platform } from "../platforms";
import type { Values } from "./types";

export interface PreviewMedia {
  id: string;
  url: string;
  type: "IMAGE" | "VIDEO";
  width: number | null;
  height: number | null;
  name?: string;
}

export interface AdPreviewData {
  platform: Platform;
  setup: Values;
  campaign: Values;
  adGroup: Values;
  ad: Values;
  /** Creative-library files referenced by the ad, by id */
  media: Record<string, PreviewMedia>;
  /** Page / profile / business shown on the ad */
  identity: { name: string; avatarUrl?: string | null };
}

/** Domain shown on ads, e.g. "yourstore.com". */
export function displayDomain(url: unknown) {
  const host = /^https?:\/\/([^/?#:]+)/i.exec(String(url ?? "").trim())?.[1];
  return host ? host.replace(/^www\./, "").toLowerCase() : "yourstore.com";
}
