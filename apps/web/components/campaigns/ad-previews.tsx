"use client";

import { BUILDER_SPECS, type AdPreviewData, type AdRowDTO, type CampaignRowDTO, type PlacementPreview, type Platform } from "@ashniva/shared";
import { Eye } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/app/states";
import { fallbackPreview, PreviewPanel } from "@/components/previews";
import { StatusDot } from "@/components/metrics";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdMediaViewer } from "@/components/campaigns/ad-media";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Placements to show for ads that weren't made in the builder. */
function defaultPlacements(platform: Platform, objective: string | null): PlacementPreview[] {
  const o = (objective ?? "").toUpperCase();
  switch (platform) {
    case "META":
      return ["fb_feed", "ig_feed", "ig_story", "ig_reels"];
    case "GOOGLE":
      if (o.includes("VIDEO") || o.includes("DEMAND")) return ["youtube_instream", "youtube_infeed", "youtube_shorts"];
      if (o.includes("DISPLAY")) return ["google_display", "google_display_native"];
      if (o.includes("SHOPPING")) return ["google_shopping"];
      if (o.includes("PERFORMANCE")) return ["google_search_mobile", "google_display", "youtube_instream", "discover"];
      return ["google_search_mobile", "google_search_desktop"];
    case "MICROSOFT":
      return ["bing_search", "bing_audience"];
    case "TIKTOK":
      return ["tiktok_feed"];
    case "LINKEDIN":
      return ["linkedin_feed"];
    case "SNAPCHAT":
      return ["snap_story"];
    case "PINTEREST":
      return ["pinterest_grid", "pinterest_closeup"];
    case "AMAZON":
      return o.includes("BRAND") || o.includes("DISPLAY") ? ["google_display", "google_shopping"] : ["google_search_mobile", "google_shopping"];
    case "X":
      return ["linkedin_feed", "tiktok_feed"];
    case "APPLE":
      return ["google_search_mobile"];
    case "SPOTIFY":
      return o.includes("DISPLAY") ? ["google_display"] : ["youtube_instream", "google_display"];
    case "CRITEO":
      return ["google_display", "google_display_native"];
    case "TABOOLA":
    case "OUTBRAIN":
      return ["google_display_native", "discover"];
    case "TRADEDESK":
    case "YAHOO":
      return o.includes("VIDEO") ? ["youtube_instream"] : o.includes("NATIVE") ? ["google_display_native"] : ["google_display"];
    case "SHOPIFY":
    case "SWIGGY":
    case "ZEPTO":
      return ["google_display"];
    case "NAUKRI":
      return ["linkedin_feed"];
  }
}

export function previewOf(ad: AdRowDTO, campaign: CampaignRowDTO, brand: string): { data: AdPreviewData; placements: PlacementPreview[] } {
  if (ad.preview) {
    const spec = BUILDER_SPECS[ad.preview.platform];
    const placements = spec.previews({ setup: ad.preview.setup, campaign: ad.preview.campaign, adGroup: ad.preview.adGroup, ad: ad.preview.ad });
    return { data: ad.preview, placements: placements.length ? placements : defaultPlacements(campaign.platform, campaign.objective) };
  }
  return { data: fallbackPreview(campaign.platform, ad, brand), placements: defaultPlacements(campaign.platform, campaign.objective) };
}

/** "How it looks": every ad in the campaign, previewed in each placement it can run in. */
export function AdPreviews({ ads, campaign, brand, workspaceId, selected, onSelect }: { ads: AdRowDTO[]; campaign: CampaignRowDTO; brand: string; workspaceId: string; selected: string | null; onSelect: (id: string) => void }) {
  const current = ads.find((a) => a.id === selected) ?? ads[0];
  const preview = useMemo(() => (current ? previewOf(current, campaign, brand) : null), [current, campaign, brand]);
  if (!current || !preview) {
    return (
      <Card>
        <EmptyState icon={Eye} title="No ads yet" description="Ads in this campaign will be previewed here." />
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <Card className="gap-0 self-start overflow-hidden py-0">
        <ul className="max-h-[640px] divide-y overflow-y-auto">
          {ads.map((a) => (
            <li key={a.id}>
              <button type="button" onClick={() => onSelect(a.id)} className={cn("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors", a.id === current.id ? "bg-accent" : "hover:bg-muted/50")}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{a.name}</div>
                  {a.headline && <div className="truncate text-xs text-muted-foreground">“{a.headline}”</div>}
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <StatusDot status={a.status} /> · {money(a.metrics.spend, campaign.currency)} spent
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-4">
        <Tabs defaultValue="placements">
          <TabsList>
            <TabsTrigger value="placements">Placements</TabsTrigger>
            <TabsTrigger value="files">Creative files</TabsTrigger>
          </TabsList>
          <TabsContent value="placements">
            <PreviewPanel key={current.id} data={preview.data} placements={preview.placements} />
            {!current.preview && <p className="text-center text-[11px] text-muted-foreground">Built from the ad&apos;s synced text; images appear once the platform shares them.</p>}
          </TabsContent>
          <TabsContent value="files">
            <AdMediaViewer key={current.id} workspaceId={workspaceId} adId={current.id} adName={current.name} />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
