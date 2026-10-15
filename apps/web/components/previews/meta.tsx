"use client";

import { Bookmark, ChevronRight, Globe, Heart, MessageCircle, MoreHorizontal, Music2, Send, Share2, ThumbsUp, X } from "lucide-react";
import { Avatar, Clamp, DesktopFrame, MediaView, PhoneFrame, VerticalMedia, aspectOf, placeholderText } from "./frame";
import type { NormalizedAd } from "./normalize";

const handle = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9.]+/g, "") || "yourbrand";

function Carousel({ ad, square = true, cta }: { ad: NormalizedAd; square?: boolean; cta?: boolean }) {
  const cards = ad.cards.length ? ad.cards : [{ media: null, headline: "Card headline", description: "", url: "" }, { media: null, headline: "Card headline", description: "", url: "" }];
  return (
    <div className="flex snap-x gap-2 overflow-x-auto px-3 pb-2 [scrollbar-width:none]">
      {cards.map((c, i) => (
        <div key={i} className="w-[210px] shrink-0 snap-start overflow-hidden rounded-md border border-zinc-200">
          <MediaView media={c.media} className={square ? "aspect-square w-full" : "aspect-[4/5] w-full"} />
          <div className="flex items-center gap-2 bg-zinc-50 p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold">{placeholderText(c.headline, "Headline")}</div>
              {c.description && <div className="truncate text-[11px] text-zinc-500">{c.description}</div>}
            </div>
            {cta && ad.cta && <span className="shrink-0 rounded bg-zinc-200 px-2 py-1 text-[11px] font-semibold">{ad.cta}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function FacebookFeed({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto pt-8 [scrollbar-width:none]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Avatar name={ad.brand} media={ad.logo} className="size-9 text-sm" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">{ad.brand}</div>
            <div className="flex items-center gap-1 text-[11px] text-zinc-500">Sponsored · <Globe className="size-3" /></div>
          </div>
          <MoreHorizontal className="size-4 text-zinc-500" />
          <X className="size-4 text-zinc-500" />
        </div>
        <Clamp text={placeholderText(ad.primaryText, "Your primary text appears here.")} max={125} more="See more" className="px-3 pb-2 text-[13px] leading-snug" />
        {ad.format === "CAROUSEL" ? (
          <Carousel ad={ad} cta />
        ) : (
          <>
            <div style={{ aspectRatio: aspectOf(media, { min: 0.8, max: 1.91 }) }} className="w-full">
              <MediaView media={media} className="h-full w-full" />
            </div>
            <div className="flex items-center gap-3 bg-zinc-100 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[10px] text-zinc-500 uppercase">{ad.domain}</div>
                <div className="line-clamp-2 text-[13px] leading-tight font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
                {ad.description && <div className="truncate text-[11px] text-zinc-500">{ad.description}</div>}
              </div>
              {ad.cta && <span className="shrink-0 rounded-md bg-zinc-200 px-3 py-1.5 text-[12px] font-semibold">{ad.cta}</span>}
            </div>
          </>
        )}
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-zinc-500">
          <span>👍❤️ 1.2K</span>
          <span>84 comments · 31 shares</span>
        </div>
        <div className="mx-3 flex justify-around border-t py-2 text-[12px] font-medium text-zinc-600">
          <span className="flex items-center gap-1"><ThumbsUp className="size-4" /> Like</span>
          <span className="flex items-center gap-1"><MessageCircle className="size-4" /> Comment</span>
          <span className="flex items-center gap-1"><Share2 className="size-4" /> Share</span>
        </div>
        <div className="mt-2 h-24 bg-zinc-100" />
      </div>
    </PhoneFrame>
  );
}

export function InstagramFeed({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto pt-8 [scrollbar-width:none]">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 p-[2px]">
            <Avatar name={ad.brand} media={ad.logo} className="size-7 border-2 border-white text-[11px]" />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[12px] font-semibold">{handle(ad.brand)}</div>
            <div className="text-[10px]">Sponsored</div>
          </div>
          <MoreHorizontal className="size-4" />
        </div>
        {ad.format === "CAROUSEL" ? (
          <Carousel ad={ad} />
        ) : (
          <div style={{ aspectRatio: aspectOf(media, { min: 0.8, max: 1.91 }) }} className="w-full">
            <MediaView media={media} className="h-full w-full" />
          </div>
        )}
        {ad.cta && (
          <div className="flex items-center justify-between border-b bg-sky-600 px-3 py-2 text-[12px] font-semibold text-white">
            {ad.cta} <ChevronRight className="size-4" />
          </div>
        )}
        <div className="flex items-center gap-3.5 px-3 py-2.5">
          <Heart className="size-5" /> <MessageCircle className="size-5" /> <Send className="size-5" />
          <Bookmark className="ml-auto size-5" />
        </div>
        <div className="px-3 text-[12px]">
          <span className="font-semibold">2,184 likes</span>
          <Clamp text={`${handle(ad.brand)} ${placeholderText(ad.primaryText, "Your primary text appears here.")}`} max={110} className="mt-0.5 leading-snug" />
        </div>
      </div>
    </PhoneFrame>
  );
}

/** Instagram / Facebook Stories and Reels: full-screen vertical. */
export function VerticalMeta({ ad, kind }: { ad: NormalizedAd; kind: "ig_story" | "ig_reels" | "fb_reels" }) {
  const media = ad.storyMedia ?? ad.cards[0]?.media ?? ad.media[0];
  const reels = kind !== "ig_story";
  return (
    <PhoneFrame dark>
      <VerticalMedia media={media} />
      {!reels && (
        <div className="absolute inset-x-3 top-8 z-10 flex gap-1">
          <span className="h-0.5 flex-1 rounded bg-white" />
          <span className="h-0.5 flex-1 rounded bg-white/40" />
        </div>
      )}
      <div className="absolute inset-x-3 top-11 z-10 flex items-center gap-2">
        <Avatar name={ad.brand} media={ad.logo} className="size-8 border border-white/60 text-[11px]" />
        <div className="leading-tight drop-shadow">
          <div className="text-[12px] font-semibold">{kind === "fb_reels" ? ad.brand : handle(ad.brand)}</div>
          <div className="text-[10px] opacity-90">Sponsored</div>
        </div>
        <MoreHorizontal className="ml-auto size-4" />
      </div>
      {reels && (
        <div className="absolute right-3 bottom-28 z-10 flex flex-col items-center gap-4 text-[10px]">
          <span className="flex flex-col items-center"><Heart className="size-6" />12K</span>
          <span className="flex flex-col items-center"><MessageCircle className="size-6" />231</span>
          <span className="flex flex-col items-center"><Send className="size-6" /></span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-3 pt-16 pb-5">
        {reels && <Clamp text={placeholderText(ad.primaryText, "Your primary text")} max={60} className="mb-2 pr-10 text-[12px] leading-snug" />}
        {reels && (
          <div className="mb-3 flex items-center gap-1.5 text-[11px] opacity-90">
            <Music2 className="size-3" /> {ad.brand} · Original audio
          </div>
        )}
        {ad.cta && (
          <div className={reels ? "rounded-md bg-white/20 py-2 text-center text-[13px] font-semibold backdrop-blur" : "mx-auto w-max rounded-full bg-white px-5 py-2 text-[13px] font-semibold text-zinc-900"}>
            {reels ? ad.cta : `⌃ ${ad.cta}`}
          </div>
        )}
      </div>
    </PhoneFrame>
  );
}

export function FacebookRightColumn({ ad }: { ad: NormalizedAd }) {
  return (
    <DesktopFrame url="facebook.com">
      <div className="grid grid-cols-[1fr_200px] gap-4 bg-zinc-100 p-4">
        <div className="space-y-3">
          <div className="h-28 rounded-lg bg-white" />
          <div className="h-40 rounded-lg bg-white" />
        </div>
        <div>
          <div className="mb-2 text-[12px] font-semibold text-zinc-500">Sponsored</div>
          <div className="flex gap-2">
            <MediaView media={ad.media[0] ?? ad.cards[0]?.media} className="size-20 shrink-0 rounded-md" />
            <div className="min-w-0">
              <div className="line-clamp-2 text-[12px] leading-tight font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
              <div className="truncate text-[11px] text-zinc-500">{ad.domain}</div>
            </div>
          </div>
        </div>
      </div>
    </DesktopFrame>
  );
}
