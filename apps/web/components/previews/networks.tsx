/** Mockups for the newer networks: X, App Store, Amazon, Spotify, and neutral publisher placements. */
"use client";

import { BarChart2, Heart, MessageCircle, MoreHorizontal, Pause, Repeat2, Search, Share, SkipBack, SkipForward, Star, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, Clamp, DesktopFrame, MediaView, PhoneFrame, aspectOf, placeholderText } from "./frame";
import type { NormalizedAd } from "./normalize";

const handleOf = (brand: string) => "@" + (brand.toLowerCase().replace(/[^a-z0-9_]/g, "") || "yourbrand");

export function XFeed({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  const hasLink = Boolean(ad.url);
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto bg-white pt-9 [scrollbar-width:none]">
        <div className="flex justify-center gap-10 border-b pb-2 text-[13px] font-semibold">
          <span className="border-b-2 border-[#1d9bf0] pb-1.5">For you</span>
          <span className="text-zinc-500">Following</span>
        </div>
        <div className="flex gap-2.5 border-b px-3 py-3">
          <Avatar name={ad.brand} media={ad.logo} className="size-9 text-sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-[13px] leading-tight">
              <span className="truncate font-bold">{ad.brand}</span>
              <span className="truncate text-zinc-500">{handleOf(ad.brand)}</span>
              <MoreHorizontal className="ml-auto size-4 shrink-0 text-zinc-500" />
            </div>
            <Clamp text={placeholderText(ad.primaryText, "Your post text appears here.")} max={280} className="mt-1 text-[13px] leading-snug" />
            {hasLink && !media && <div className="mt-1 truncate text-[13px] text-[#1d9bf0]">{ad.url}</div>}
            {(media || hasLink) && (
              <div className="mt-2 overflow-hidden rounded-2xl border">
                {media && (
                  <div style={{ aspectRatio: aspectOf(media, { min: 0.8, max: 1.91, fallback: 1.91 }) }}>
                    <MediaView media={media} className="h-full w-full" />
                  </div>
                )}
                {hasLink && <div className="truncate border-t px-3 py-1.5 text-[11px] text-zinc-500">From {ad.domain}</div>}
              </div>
            )}
            <div className="mt-2 flex justify-between pr-4 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1"><MessageCircle className="size-3.5" />24</span>
              <span className="flex items-center gap-1"><Repeat2 className="size-3.5" />18</span>
              <span className="flex items-center gap-1"><Heart className="size-3.5" />312</span>
              <span className="flex items-center gap-1"><BarChart2 className="size-3.5" />9K</span>
              <Share className="size-3.5" />
            </div>
            <div className="mt-1.5 text-[11px] text-zinc-500">Ad</div>
          </div>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-2.5 border-b px-3 py-3 opacity-50">
            <span className="size-9 shrink-0 rounded-full bg-zinc-200" />
            <div className="flex-1 space-y-1.5"><div className="h-3 w-32 rounded bg-zinc-200" /><div className="h-3 rounded bg-zinc-100" /><div className="h-3 w-2/3 rounded bg-zinc-100" /></div>
          </div>
        ))}
      </div>
    </PhoneFrame>
  );
}

export function AppStoreSearch({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame>
      <div className="h-full space-y-3 bg-white px-4 pt-10">
        <div className="text-[26px] font-bold">Search</div>
        <div className="flex items-center gap-2 rounded-xl bg-zinc-100 px-3 py-2 text-[13px] text-zinc-600">
          <Search className="size-4" /> {ad.keyword || "your keyword"}
        </div>
        <div className="rounded-2xl bg-sky-50/70 p-3">
          <div className="flex items-center gap-3">
            {ad.logo ? <Avatar name={ad.brand} media={ad.logo} className="size-14 rounded-2xl" /> : <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 text-xl font-semibold text-white">{(ad.brand.trim()[0] ?? "A").toUpperCase()}</span>}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-[#0a84ff] px-1 text-[9px] font-bold text-white">Ad</span>
                <span className="truncate text-[14px] font-semibold">{ad.brand}</span>
              </div>
              <div className="truncate text-[12px] text-zinc-500">{placeholderText(ad.headline, "Your app's subtitle")}</div>
              <div className="mt-0.5 flex items-center gap-0.5 text-[10px] text-zinc-400">
                {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="size-2.5 fill-current" />)} <span className="ml-1">12K</span>
              </div>
            </div>
            <span className="rounded-full bg-zinc-200 px-4 py-1 text-[13px] font-bold text-[#0a84ff]">Get</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="aspect-[9/19] rounded-lg bg-gradient-to-b from-zinc-200 to-zinc-100" />)}
          </div>
        </div>
        <p className="text-center text-[11px] text-zinc-500">Name, icon and screenshots come from the app&apos;s App Store product page.</p>
      </div>
    </PhoneFrame>
  );
}

export function AmazonShopping({ ad }: { ad: NormalizedAd }) {
  const brands = ad.variant === "SPONSORED_BRANDS";
  const products = (ad.asins.length ? ad.asins : ["B0XXXXXXXX"]).slice(0, brands ? 3 : 1);
  const tile = (asin: string, i: number, sponsored: boolean) => (
    <div key={`${asin}-${i}`} className="overflow-hidden rounded-md border bg-white">
      {i === 0 && !brands ? <MediaView media={ad.media[0]} className="aspect-square w-full" label="Image from the listing" /> : <div className="aspect-square bg-gradient-to-br from-zinc-100 to-zinc-200" />}
      <div className="space-y-0.5 p-2">
        {sponsored && <div className="text-[10px] text-zinc-500">Sponsored</div>}
        <div className="line-clamp-2 text-[12px] leading-tight">{!brands && i === 0 ? placeholderText(ad.headline, `Product ${asin}`) : `Product ${asin}`}</div>
        <div className="flex items-center gap-0.5 text-[10px] text-amber-500">{Array.from({ length: 5 }).map((_, s) => <Star key={s} className="size-2.5 fill-current" />)}</div>
        <div className="text-[13px] font-semibold">₹{(1499 + i * 700).toLocaleString("en-IN")}</div>
      </div>
    </div>
  );
  return (
    <PhoneFrame>
      <div className="h-full space-y-3 overflow-y-auto bg-zinc-50 p-3 pt-10 [scrollbar-width:none]">
        <div className="flex items-center gap-2 rounded-md border-2 border-[#febd69] bg-white px-3 py-1.5 text-[13px] text-zinc-600">
          <Search className="size-4" /> {ad.keyword || `${ad.brand.toLowerCase()} kurta`}
        </div>
        {brands && (
          <div className="rounded-md border bg-white p-3">
            <div className="flex items-center gap-2">
              <Avatar name={ad.brand} media={ad.logo} className="size-9 rounded-md text-sm" />
              <div className="min-w-0 leading-tight">
                <div className="line-clamp-2 text-[13px] font-semibold">{placeholderText(ad.headline, "Your Sponsored Brands headline")}</div>
                <div className="text-[11px] text-[#007185]">Shop {ad.brand} ›</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1.5">{products.map((a, i) => tile(a, i, false))}</div>
            <div className="mt-1 text-right text-[10px] text-zinc-500">Sponsored</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {!brands && products.map((a, i) => tile(a, i, true))}
          {Array.from({ length: brands ? 2 : 3 }).map((_, i) => (
            <div key={i} className="overflow-hidden rounded-md border bg-white opacity-50">
              <div className="aspect-square bg-zinc-200" />
              <div className="space-y-1 p-2"><div className="h-3 rounded bg-zinc-200" /><div className="h-3 w-1/2 rounded bg-zinc-100" /></div>
            </div>
          ))}
        </div>
        <p className="text-center text-[11px] text-zinc-500">Titles, prices and images come from the product listings.</p>
      </div>
    </PhoneFrame>
  );
}

export function SpotifyNowPlaying({ ad }: { ad: NormalizedAd }) {
  const video = ad.format === "VIDEO";
  return (
    <PhoneFrame dark>
      <div className="flex h-full flex-col bg-gradient-to-b from-zinc-700 to-black px-5 pt-12 pb-6">
        <div className="text-center text-[11px] tracking-wide uppercase opacity-80">Advertisement</div>
        <div className="mt-6">
          <MediaView media={ad.media[0]} className={cn("w-full rounded-md", video ? "aspect-video" : "aspect-square")} label={video ? "Your video thumbnail" : "Your companion image"} />
        </div>
        <div className="mt-6 flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[16px] font-bold">{placeholderText(ad.headline, ad.brand)}</div>
            <div className="truncate text-[12px] opacity-70">{placeholderText(ad.description, "Your tagline")}</div>
          </div>
          {ad.url && <span className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[12px] font-semibold text-black">{ad.cta ?? "Learn more"}</span>}
        </div>
        <div className="mt-5 h-1 rounded-full bg-white/30"><div className="h-full w-1/3 rounded-full bg-white" /></div>
        <div className="mt-1 flex justify-between text-[10px] opacity-60"><span>0:10</span><span>0:30</span></div>
        <div className="mt-4 flex items-center justify-center gap-8">
          <SkipBack className="size-6 opacity-40" />
          <span className="flex size-14 items-center justify-center rounded-full bg-white text-black"><Pause className="size-6 fill-current" /></span>
          <SkipForward className="size-6 opacity-40" />
        </div>
        <div className="mt-auto flex items-center gap-2 text-[11px] opacity-60"><Volume2 className="size-3.5" /> Your music continues after this ad</div>
      </div>
    </PhoneFrame>
  );
}

/** Sponsored link in a publisher's recommendation widget (Taboola, Outbrain, DSP native). */
export function NativeFeed({ ad }: { ad: NormalizedAd }) {
  const filler = ["Ten habits of people who sleep well", "The city guide locals swear by", "What to cook this weekend"];
  return (
    <DesktopFrame url="news.example.com/article">
      <div className="space-y-4 p-4">
        <div className="space-y-2">
          <div className="h-5 w-3/4 rounded bg-zinc-200" />
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-3 rounded bg-zinc-100" />)}
        </div>
        <div>
          <div className="mb-2 flex justify-between border-b pb-1 text-[11px] font-semibold text-zinc-500">
            <span>You may like</span>
            <span className="font-normal">Sponsored links</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <MediaView media={ad.media[0]} className="aspect-[3/2] w-full rounded" label="Your thumbnail" />
              <div className="mt-1.5 line-clamp-2 text-[13px] leading-tight font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
              {ad.description && <div className="mt-0.5 line-clamp-2 text-[11px] text-zinc-600">{ad.description}</div>}
              <div className="mt-0.5 truncate text-[10px] text-zinc-500">{ad.brand} · Sponsored</div>
            </div>
            {filler.slice(0, 1).map((t) => (
              <div key={t} className="opacity-50">
                <div className="aspect-[3/2] w-full rounded bg-zinc-200" />
                <div className="mt-1.5 text-[13px] leading-tight font-semibold">{t}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Partner · Sponsored</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DesktopFrame>
  );
}

const BANNER_SIZES: Record<string, [number, number]> = { "300x250": [300, 250], "728x90": [468, 58], "320x50": [320, 50], "160x600": [120, 450] };

/** A plain image banner on a publisher page. */
export function DisplayBanner({ ad }: { ad: NormalizedAd }) {
  const [w, h] = BANNER_SIZES[ad.size] ?? BANNER_SIZES["300x250"]!;
  const wide = w > h * 3;
  return (
    <DesktopFrame url="news.example.com">
      <div className={cn("gap-4 p-4", wide ? "space-y-3" : "grid grid-cols-[1fr_auto]")}>
        {wide && (
          <div className="flex justify-center">
            <Banner ad={ad} w={w} h={h} />
          </div>
        )}
        <div className="space-y-2">
          <div className="h-5 w-3/4 rounded bg-zinc-200" />
          {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-3 rounded bg-zinc-100" />)}
        </div>
        {!wide && <Banner ad={ad} w={w} h={h} />}
      </div>
    </DesktopFrame>
  );
}

function Banner({ ad, w, h }: { ad: NormalizedAd; w: number; h: number }) {
  return (
    <div className="relative shrink-0 overflow-hidden border bg-white" style={{ width: w, height: h }}>
      <MediaView media={ad.media[0]} className="h-full w-full" label="Your banner" />
      <span className="absolute top-0 right-0 bg-white/80 px-1 text-[9px] text-zinc-500">Ad</span>
    </div>
  );
}

/** A skippable pre-roll in a generic publisher video player. */
export function VideoInStream({ ad }: { ad: NormalizedAd }) {
  return (
    <DesktopFrame url="video.example.com/watch">
      <div className="space-y-3 p-4">
        <div className="relative aspect-video overflow-hidden rounded bg-black">
          <MediaView media={ad.media[0]} className="h-full w-full" label="Your video (from the VAST tag)" />
          <div className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">Ad · 0:15</div>
          <div className="absolute right-0 bottom-4 flex items-center gap-1 border border-white/30 bg-black/70 px-2.5 py-1.5 text-[11px] text-white">
            Skip ad <SkipForward className="size-3.5" />
          </div>
          {ad.url && <div className="absolute bottom-4 left-2 rounded bg-white/90 px-2 py-1 text-[11px] font-medium text-zinc-900">{ad.domain}</div>}
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/30"><div className="h-full w-1/4 bg-amber-400" /></div>
        </div>
        <div className="truncate text-[13px] font-semibold">{placeholderText(ad.headline, ad.brand)}</div>
        <div className="space-y-1.5 opacity-50"><div className="h-3 w-2/3 rounded bg-zinc-200" /><div className="h-3 w-1/2 rounded bg-zinc-100" /></div>
      </div>
    </DesktopFrame>
  );
}
