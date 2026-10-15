"use client";

import type { AdMediaDTO, AdMediaItemDTO } from "@ashniva/shared";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdMedia } from "@/lib/queries";
import { cn } from "@/lib/utils";

const duration = (s: number | null) => (s == null ? null : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

function Stage({ item }: { item: AdMediaItemDTO }) {
  if (item.type === "VIDEO" && item.url) {
    return (
      // key restarts playback when switching cards
      <video key={item.url} src={item.url} poster={item.posterUrl ?? undefined} controls playsInline preload="metadata" className="max-h-[520px] w-full rounded-lg bg-black object-contain" />
    );
  }
  const src = item.type === "VIDEO" ? item.posterUrl : item.url ?? item.posterUrl;
  if (!src) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg bg-muted text-sm text-muted-foreground">
        <ImageOff className="size-6" /> No preview available
      </div>
    );
  }
  return (
    <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={item.title ?? "Ad creative"} className="max-h-[520px] w-full rounded-lg bg-muted object-contain" />
      {item.type === "VIDEO" && (
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-12 place-items-center rounded-full bg-black/60 text-white"><Play className="size-5" /></span>
        </div>
      )}
    </div>
  );
}

/** Creative files of one ad: play video, flip through carousel cards, download each file. */
export function AdMediaViewer({ workspaceId, adId, adName }: { workspaceId: string; adId: string; adName: string }) {
  const media = useAdMedia(workspaceId, adId);
  const [index, setIndex] = useState(0);

  if (media.isLoading) return <Skeleton className="h-80 w-full rounded-lg" />;
  if (media.isError || !media.data) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Couldn&apos;t load this ad&apos;s files. Try again in a moment.</p>;
  }
  const data: AdMediaDTO = media.data;
  const items = data.items;
  const i = Math.min(index, Math.max(items.length - 1, 0));
  const item = items[i];
  if (!item) return <p className="py-10 text-center text-sm text-muted-foreground">This ad has no image or video to show.</p>;

  const downloadHref = `/api/workspaces/${workspaceId}/ads/${adId}/media/${i}/download`;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Stage item={item} />
        {items.length > 1 && (
          <>
            <Button type="button" size="icon-sm" variant="secondary" aria-label="Previous card" className="absolute top-1/2 left-2 -translate-y-1/2" disabled={i === 0} onClick={() => setIndex(i - 1)}>
              <ChevronLeft />
            </Button>
            <Button type="button" size="icon-sm" variant="secondary" aria-label="Next card" className="absolute top-1/2 right-2 -translate-y-1/2" disabled={i === items.length - 1} onClick={() => setIndex(i + 1)}>
              <ChevronRight />
            </Button>
          </>
        )}
      </div>

      {items.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {items.map((it, n) => (
            <button key={n} type="button" onClick={() => setIndex(n)} className={cn("relative size-16 shrink-0 overflow-hidden rounded-md border bg-muted", n === i && "ring-2 ring-primary")} aria-label={`Card ${n + 1}`}>
              {(it.posterUrl ?? it.url) && /* eslint-disable-next-line @next/next/no-img-element */ <img src={(it.posterUrl ?? it.url)!} alt="" className="size-full object-cover" />}
              {it.type === "VIDEO" && <Play className="absolute right-1 bottom-1 size-3 text-white drop-shadow" />}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {data.format === "CAROUSEL" ? `Card ${i + 1} of ${items.length}` : data.format === "VIDEO" ? "Video" : "Image"}
        </span>
        {duration(item.durationSec) && <span className="text-muted-foreground">· {duration(item.durationSec)}</span>}
        <div className="ml-auto flex gap-2">
          {item.type === "VIDEO" && !item.url && item.permalink && (
            <Button asChild variant="outline" size="sm">
              <a href={item.permalink} target="_blank" rel="noreferrer"><ExternalLink /> Watch on Facebook</a>
            </Button>
          )}
          {item.url ? (
            <Button asChild variant="outline" size="sm">
              <a href={downloadHref} download aria-label={`Download ${adName}`}><Download /> Download {item.type === "VIDEO" ? "video" : "image"}</a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled><Download /> Download unavailable</Button>
          )}
        </div>
      </div>

      {(item.title || item.description || data.headline || data.body) && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          {(item.title ?? data.headline) && <div className="font-medium">{item.title ?? data.headline}</div>}
          {(item.description ?? data.body) && <p className="mt-1 whitespace-pre-line text-muted-foreground">{item.description ?? data.body}</p>}
          {data.callToAction && <div className="mt-2 text-xs uppercase tracking-wide text-muted-foreground">Button: {data.callToAction.replaceAll("_", " ")}</div>}
        </div>
      )}

      {!data.live && <p className="text-center text-[11px] text-muted-foreground">Showing the synced thumbnail. The platform didn&apos;t share the full files for this ad.</p>}
      {data.live && item.type === "VIDEO" && !item.url && <p className="text-center text-[11px] text-muted-foreground">Meta didn&apos;t share this video file with the connected login, so it can only be watched on Facebook.</p>}
    </div>
  );
}
