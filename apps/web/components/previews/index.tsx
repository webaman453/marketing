"use client";

import type { AdPreviewData, PlacementPreview } from "@ashniva/shared";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DisplayRectangle, GmailAd, NativeCard, SearchAd, ShoppingAd, YouTubeInFeed, YouTubeInStream, YouTubeShorts } from "./google";
import { FacebookFeed, FacebookRightColumn, InstagramFeed, VerticalMeta } from "./meta";
import { normalizeAd, type NormalizedAd } from "./normalize";
import { LinkedInFeed, LinkedInMessage, LinkedInTextAd, PinterestCloseup, PinterestGrid, SnapStory, TikTokFeed } from "./social";

export { fallbackPreview, normalizeAd } from "./normalize";

export const PLACEMENT_LABEL: Record<PlacementPreview, string> = {
  fb_feed: "Facebook Feed",
  ig_feed: "Instagram feed",
  ig_story: "Instagram Stories",
  ig_reels: "Instagram Reels",
  fb_reels: "Facebook Reels",
  fb_right_column: "Facebook right column",
  messenger_inbox: "Messenger",
  google_search_mobile: "Google Search · mobile",
  google_search_desktop: "Google Search · desktop",
  google_display: "Display network",
  google_display_native: "Apps (native)",
  gmail: "Gmail",
  discover: "Discover",
  youtube_instream: "YouTube in-stream",
  youtube_infeed: "YouTube in-feed",
  youtube_shorts: "YouTube Shorts",
  youtube_bumper: "YouTube bumper",
  google_shopping: "Google Shopping",
  tiktok_feed: "TikTok For You feed",
  linkedin_feed: "LinkedIn feed",
  linkedin_text: "LinkedIn right rail",
  linkedin_message: "LinkedIn inbox",
  bing_search: "Bing search",
  bing_audience: "Microsoft Audience Network",
  snap_story: "Snapchat",
  pinterest_grid: "Pinterest home feed",
  pinterest_closeup: "Pinterest close-up",
};

const SEARCH: PlacementPreview[] = ["google_search_mobile", "google_search_desktop", "bing_search"];

export function AdPlacement({ ad, placement, combo = 0, device = "mobile" }: { ad: NormalizedAd; placement: PlacementPreview; combo?: number; device?: "mobile" | "desktop" }) {
  switch (placement) {
    case "fb_feed":
    case "messenger_inbox":
      return <FacebookFeed ad={ad} />;
    case "ig_feed":
      return <InstagramFeed ad={ad} />;
    case "ig_story":
    case "ig_reels":
    case "fb_reels":
      return <VerticalMeta ad={ad} kind={placement} />;
    case "fb_right_column":
      return <FacebookRightColumn ad={ad} />;
    case "google_search_mobile":
      return <SearchAd ad={ad} combo={combo} device="mobile" engine="google" />;
    case "google_search_desktop":
      return <SearchAd ad={ad} combo={combo} device="desktop" engine="google" />;
    case "bing_search":
      return <SearchAd ad={ad} combo={combo} device={device} engine="bing" />;
    case "google_display":
      return <DisplayRectangle ad={ad} />;
    case "google_display_native":
      return <NativeCard ad={ad} surface="native" />;
    case "discover":
      return <NativeCard ad={ad} surface="discover" />;
    case "bing_audience":
      return <NativeCard ad={ad} surface="audience" />;
    case "gmail":
      return <GmailAd ad={ad} />;
    case "youtube_instream":
    case "youtube_bumper":
      return <YouTubeInStream ad={ad} />;
    case "youtube_infeed":
      return <YouTubeInFeed ad={ad} />;
    case "youtube_shorts":
      return <YouTubeShorts ad={ad} />;
    case "google_shopping":
      return <ShoppingAd ad={ad} />;
    case "tiktok_feed":
      return <TikTokFeed ad={ad} />;
    case "linkedin_feed":
      return <LinkedInFeed ad={ad} />;
    case "linkedin_text":
      return <LinkedInTextAd ad={ad} />;
    case "linkedin_message":
      return <LinkedInMessage ad={ad} />;
    case "snap_story":
      return <SnapStory ad={ad} />;
    case "pinterest_grid":
      return <PinterestGrid ad={ad} />;
    case "pinterest_closeup":
      return <PinterestCloseup ad={ad} />;
  }
}

/** Placement switcher + live mockup, used in the builder and on campaign pages. */
export function PreviewPanel({ data, placements, className, compact }: { data: AdPreviewData; placements: PlacementPreview[]; className?: string; compact?: boolean }) {
  const [chosen, setChosen] = useState<PlacementPreview | null>(null);
  const [combo, setCombo] = useState(0);
  const [device, setDevice] = useState<"mobile" | "desktop">("mobile");
  const placement = chosen && placements.includes(chosen) ? chosen : placements[0]!;
  const ad = useMemo(() => normalizeAd(data), [data]);
  const isSearch = SEARCH.includes(placement);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap gap-1.5">
        {placements.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setChosen(p)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              p === placement ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {PLACEMENT_LABEL[p]}
          </button>
        ))}
      </div>
      <div className={cn("flex justify-center rounded-xl bg-muted/50 py-5", compact ? "px-2" : "px-4")}>
        <div className={cn("w-full", compact && "origin-top scale-[0.85]")}>
          <AdPlacement ad={ad} placement={placement} combo={combo} device={device} />
        </div>
      </div>
      {isSearch && (
        <div className="flex items-center justify-between gap-2">
          {placement === "bing_search" ? (
            <div className="inline-flex rounded-md border p-0.5 text-[11px]">
              {(["mobile", "desktop"] as const).map((d) => (
                <button key={d} type="button" onClick={() => setDevice(d)} className={cn("rounded px-2 py-0.5 capitalize", device === d && "bg-muted font-medium")}>
                  {d}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <Button size="sm" variant="ghost" onClick={() => setCombo((c) => c + 1)}>
            <RefreshCw /> Another combination
          </Button>
        </div>
      )}
      <p className="text-center text-[11px] text-muted-foreground">Previews are approximate; each platform decides the final layout.</p>
    </div>
  );
}
