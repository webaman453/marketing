"use client";

import { Bookmark, ChevronUp, Globe, Heart, MessageCircle, MoreHorizontal, Music2, Repeat2, Send, Share2, ThumbsUp } from "lucide-react";
import { Avatar, Clamp, DesktopFrame, MediaView, PhoneFrame, VerticalMedia, aspectOf, placeholderText } from "./frame";
import type { NormalizedAd } from "./normalize";

export function TikTokFeed({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0] ?? ad.cards[0]?.media;
  const carousel = ad.format === "CAROUSEL_ADS";
  return (
    <PhoneFrame dark>
      <VerticalMedia media={media} />
      <div className="absolute inset-x-0 top-9 z-10 flex justify-center gap-4 text-[13px] font-semibold drop-shadow">
        <span className="opacity-70">Following</span>
        <span className="border-b-2 border-white pb-0.5">For You</span>
      </div>
      {carousel && (
        <div className="absolute inset-x-0 bottom-36 z-10 flex justify-center gap-1">
          {Array.from({ length: Math.max(2, ad.media.length) }).map((_, i) => <span key={i} className={i === 0 ? "size-1.5 rounded-full bg-white" : "size-1.5 rounded-full bg-white/40"} />)}
        </div>
      )}
      <div className="absolute right-2.5 bottom-32 z-10 flex flex-col items-center gap-4 text-[10px] font-semibold">
        <Avatar name={ad.brand} media={ad.logo} className="size-10 border-2 border-white text-sm" />
        <span className="flex flex-col items-center"><Heart className="size-7 fill-white" />24.5K</span>
        <span className="flex flex-col items-center"><MessageCircle className="size-7 fill-white" />318</span>
        <span className="flex flex-col items-center"><Bookmark className="size-7 fill-white" />1.2K</span>
        <span className="flex flex-col items-center"><Share2 className="size-7" />Share</span>
      </div>
      <div className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent px-3 pt-16 pb-5">
        <div className="pr-14">
          <div className="text-[14px] font-semibold">{ad.brand}</div>
          <div className="mb-1 text-[11px] opacity-80">Sponsored</div>
          <Clamp text={placeholderText(ad.primaryText, "Your ad text")} max={100} className="text-[13px] leading-snug" />
          <div className="mt-2 flex items-center gap-1.5 text-[11px] opacity-90"><Music2 className="size-3" /> Promoted music</div>
        </div>
        {ad.cta && <div className="mt-3 rounded-md bg-[#fe2c55] py-2 text-center text-[13px] font-semibold">{ad.cta}</div>}
      </div>
    </PhoneFrame>
  );
}

export function LinkedInFeed({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto bg-zinc-100 pt-8 [scrollbar-width:none]">
        <div className="bg-white">
          <div className="flex items-start gap-2 px-3 pt-3">
            <Avatar name={ad.brand} media={ad.logo} className="size-10 rounded-md text-sm" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-semibold">{ad.brand}</div>
              <div className="text-[11px] text-zinc-500">12,480 followers</div>
              <div className="flex items-center gap-1 text-[11px] text-zinc-500">Promoted · <Globe className="size-3" /></div>
            </div>
            <MoreHorizontal className="size-4 text-zinc-500" />
          </div>
          <Clamp text={placeholderText(ad.primaryText, "Your introductory text appears here.")} max={150} more="see more" className="px-3 py-2 text-[13px] leading-snug" />
          {ad.cards.length > 0 ? (
            <div className="flex gap-2 overflow-x-auto px-3 pb-3 [scrollbar-width:none]">
              {ad.cards.map((c, i) => (
                <div key={i} className="w-[200px] shrink-0 overflow-hidden rounded-md border">
                  <MediaView media={c.media} className="aspect-square w-full" />
                  <div className="truncate p-2 text-[12px] font-semibold">{placeholderText(c.headline, "Card headline")}</div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{ aspectRatio: aspectOf(media, { min: 0.8, max: 1.91, fallback: 1.91 }) }}>
                <MediaView media={media} className="h-full w-full" />
              </div>
              <div className="flex items-center gap-3 bg-zinc-50 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-[13px] leading-tight font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
                  <div className="truncate text-[11px] text-zinc-500">{ad.domain}</div>
                </div>
                {ad.cta && <span className="shrink-0 rounded-full border border-[#0a66c2] px-3 py-1 text-[12px] font-semibold text-[#0a66c2]">{ad.cta}</span>}
              </div>
            </>
          )}
          <div className="flex justify-around border-t px-2 py-2 text-[11px] font-medium text-zinc-600">
            <span className="flex flex-col items-center"><ThumbsUp className="size-4" />Like</span>
            <span className="flex flex-col items-center"><MessageCircle className="size-4" />Comment</span>
            <span className="flex flex-col items-center"><Repeat2 className="size-4" />Repost</span>
            <span className="flex flex-col items-center"><Send className="size-4" />Send</span>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}

export function LinkedInTextAd({ ad }: { ad: NormalizedAd }) {
  return (
    <DesktopFrame url="linkedin.com/feed">
      <div className="grid grid-cols-[1fr_220px] gap-4 bg-zinc-100 p-4">
        <div className="space-y-3">
          <div className="h-32 rounded-lg bg-white" />
          <div className="h-44 rounded-lg bg-white" />
        </div>
        <div className="rounded-lg bg-white p-3">
          <div className="mb-2 flex justify-between text-[11px] text-zinc-500"><span>Ad</span><MoreHorizontal className="size-3.5" /></div>
          <div className="flex gap-2">
            <MediaView media={ad.media[0]} className="size-[64px] shrink-0 rounded" label="" />
            <div className="min-w-0">
              <div className="text-[13px] leading-tight font-semibold text-[#0a66c2]">{placeholderText(ad.headline, "Your headline")}</div>
              <div className="mt-1 text-[11px] leading-snug text-zinc-600">{placeholderText(ad.description, "Your description")}</div>
            </div>
          </div>
        </div>
      </div>
    </DesktopFrame>
  );
}

export function LinkedInMessage({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame>
      <div className="flex h-full flex-col pt-8">
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Avatar name={ad.brand} className="size-9 text-sm" />
          <div className="leading-tight">
            <div className="text-[13px] font-semibold">{ad.brand}</div>
            <div className="text-[11px] text-zinc-500">Sponsored</div>
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-3">
          <div className="text-[14px] font-semibold">{placeholderText(ad.headline, "Your subject line")}</div>
          <p className="text-[13px] leading-relaxed whitespace-pre-line text-zinc-700">{placeholderText(ad.primaryText, "Hi {first name}, your message appears here.")}</p>
          <div className="rounded-full bg-[#0a66c2] py-2 text-center text-[13px] font-semibold text-white">{ad.cta ?? "Learn more"}</div>
          {ad.media[0] && <MediaView media={ad.media[0]} className="aspect-[6/5] w-full rounded-md" />}
        </div>
      </div>
    </PhoneFrame>
  );
}

export function SnapStory({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  return (
    <PhoneFrame dark>
      <VerticalMedia media={media} />
      <div className="absolute inset-x-3 top-9 z-10 flex items-center gap-2 drop-shadow">
        <Avatar name={ad.brand} media={ad.logo} className="size-8 text-xs" />
        <div className="leading-tight">
          <div className="text-[13px] font-semibold">{ad.brand}</div>
          <div className="text-[11px] opacity-90">{placeholderText(ad.headline, "Your headline")}</div>
        </div>
        <span className="ml-auto rounded bg-black/40 px-1.5 py-0.5 text-[10px] font-semibold">Ad</span>
      </div>
      {ad.cta && (
        <div className="absolute inset-x-0 bottom-6 z-10 flex flex-col items-center gap-1">
          <ChevronUp className="size-5 animate-bounce" />
          <span className="rounded-full bg-white px-6 py-2 text-[13px] font-semibold text-zinc-900">{ad.cta}</span>
        </div>
      )}
    </PhoneFrame>
  );
}

export function PinterestGrid({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  const heights = ["h-40", "h-56", "h-48", "h-36", "h-52"];
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto px-2 pt-10 [scrollbar-width:none]">
        <div className="columns-2 gap-2">
          <div className="mb-3 break-inside-avoid">
            <div style={{ aspectRatio: aspectOf(media, { min: 0.5, max: 1.5, fallback: 2 / 3 }) }} className="overflow-hidden rounded-2xl">
              <MediaView media={media} className="h-full w-full" />
            </div>
            <div className="mt-1 px-1">
              <div className="line-clamp-2 text-[12px] leading-tight font-semibold">{placeholderText(ad.headline, "Your pin title")}</div>
              <div className="truncate text-[10px] text-zinc-500">Promoted by <span className="font-semibold text-zinc-800">{ad.brand}</span></div>
            </div>
          </div>
          {heights.map((h, i) => <div key={i} className={`mb-3 break-inside-avoid rounded-2xl bg-zinc-200 ${h}`} />)}
        </div>
      </div>
    </PhoneFrame>
  );
}

export function PinterestCloseup({ ad }: { ad: NormalizedAd }) {
  const media = ad.media[0];
  return (
    <PhoneFrame>
      <div className="h-full overflow-y-auto pt-8 [scrollbar-width:none]">
        <div style={{ aspectRatio: aspectOf(media, { min: 0.6, max: 1.5, fallback: 2 / 3 }) }} className="mx-2 overflow-hidden rounded-3xl">
          <MediaView media={media} className="h-full w-full" />
        </div>
        <div className="space-y-2 p-4">
          <div className="flex items-center gap-3">
            <Heart className="size-5" /> <MessageCircle className="size-5" /> <Share2 className="size-5" />
            <span className="ml-auto rounded-full bg-[#e60023] px-4 py-2 text-[13px] font-semibold text-white">{ad.cta ?? "Visit site"}</span>
          </div>
          <div className="text-[11px] text-zinc-500">{ad.domain}</div>
          <div className="text-[17px] leading-tight font-semibold">{placeholderText(ad.headline, "Your pin title")}</div>
          <Clamp text={placeholderText(ad.description || ad.primaryText, "Your description")} max={140} className="text-[13px] text-zinc-700" />
          <div className="flex items-center gap-2 pt-1 text-[12px]">
            <Avatar name={ad.brand} media={ad.logo} className="size-7 text-[10px]" />
            <span className="font-semibold">{ad.brand}</span>
            <span className="text-zinc-500">· Promoted</span>
          </div>
        </div>
      </div>
    </PhoneFrame>
  );
}
