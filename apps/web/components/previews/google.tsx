"use client";

import { ChevronRight, MoreVertical, Search, SkipForward, Star, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, DesktopFrame, MediaView, PhoneFrame, aspectOf, placeholderText } from "./frame";
import { youtubeThumb, type NormalizedAd } from "./normalize";

/** Picks headlines/descriptions for one rotation, honouring pinned positions. */
export function searchCombo(ad: NormalizedAd, combo: number) {
  const pick = (list: { text: string; pin: string | null }[], slots: string[], fallback: string[]) => {
    const free = list.filter((x) => !x.pin).map((x) => x.text);
    const rotated = free.length ? [...free.slice(combo % free.length), ...free.slice(0, combo % free.length)] : [];
    const out: string[] = [];
    for (const slot of slots) {
      const pinnedHere = list.filter((x) => x.pin === slot);
      out.push(pinnedHere.length ? pinnedHere[combo % pinnedHere.length]!.text : (rotated.shift() ?? ""));
    }
    const filled = out.filter(Boolean);
    return filled.length ? filled : fallback;
  };
  return {
    headlines: pick(ad.headlines, ["H1", "H2", "H3"], ["Your headline 1", "Headline 2", "Headline 3"]),
    descriptions: pick(ad.descriptions, ["D1", "D2"], ["Your description appears here. Add benefits, offers and a call to action."]),
  };
}

export function SearchAd({ ad, combo, device, engine }: { ad: NormalizedAd; combo: number; device: "mobile" | "desktop"; engine: "google" | "bing" }) {
  const { headlines, descriptions } = searchCombo(ad, combo);
  const shownHeadlines = device === "mobile" ? headlines.slice(0, 2) : headlines;
  const display = [ad.domain, ...ad.paths].join(" › ");
  const body = (
    <div className={cn("space-y-4 p-4", device === "mobile" && "pt-10")}>
      <div className="flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] text-zinc-600 shadow-sm">
        <Search className="size-4" /> {ad.headlines[0]?.text?.toLowerCase() ?? "your keyword"}
      </div>
      <div className="space-y-1">
        <div className="text-[12px] font-bold text-zinc-900">{engine === "google" ? "Sponsored" : "Ad"}</div>
        <div className="flex items-center gap-2">
          <Avatar name={ad.brand} media={ad.logo} className="size-7 text-[11px]" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] text-zinc-900">{ad.brand}</div>
            <div className="truncate text-[12px] text-zinc-600">{display}</div>
          </div>
          <MoreVertical className="ml-auto size-4 text-zinc-500" />
        </div>
        <div className={cn("leading-snug", engine === "google" ? "text-[18px] text-[#1a0dab]" : "text-[17px] text-[#1a0dab]")}>{shownHeadlines.join(" | ")}</div>
        <div className="text-[13px] leading-snug text-zinc-700">{descriptions.join(" ")}</div>
        {ad.callouts.length > 0 && <div className="text-[13px] text-zinc-700">{ad.callouts.slice(0, 4).join(" · ")}</div>}
        {ad.sitelinks.length > 0 &&
          (device === "mobile" ? (
            <div className="mt-2 divide-y border-t">
              {ad.sitelinks.slice(0, 4).map((s) => (
                <div key={s.text} className="flex items-center justify-between py-2 text-[14px] text-[#1a0dab]">
                  {s.text} <ChevronRight className="size-4 text-zinc-400" />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2">
              {ad.sitelinks.slice(0, 4).map((s) => (
                <div key={s.text}>
                  <div className="text-[14px] text-[#1a0dab]">{s.text}</div>
                  {s.description1 && <div className="text-[12px] text-zinc-600">{s.description1} {s.description2}</div>}
                </div>
              ))}
            </div>
          ))}
      </div>
      <div className="space-y-2 opacity-50">
        <div className="h-3 w-40 rounded bg-zinc-200" />
        <div className="h-4 w-64 rounded bg-zinc-200" />
        <div className="h-3 w-full rounded bg-zinc-100" />
        <div className="h-3 w-5/6 rounded bg-zinc-100" />
      </div>
    </div>
  );
  return device === "mobile" ? <PhoneFrame>{body}</PhoneFrame> : <DesktopFrame url={engine === "google" ? "google.com/search" : "bing.com/search"}>{body}</DesktopFrame>;
}

/** Responsive display ad as a 300×250 medium rectangle on a publisher page. */
export function DisplayRectangle({ ad }: { ad: NormalizedAd }) {
  const image = ad.media.find((m) => aspectOf(m, { min: 0.3, max: 3 }) > 1.4) ?? ad.media[0];
  return (
    <DesktopFrame url="news.example.com">
      <div className="grid grid-cols-[1fr_300px] gap-4 p-4">
        <div className="space-y-2">
          <div className="h-5 w-3/4 rounded bg-zinc-200" />
          {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-3 rounded bg-zinc-100" />)}
        </div>
        <div className="h-[250px] w-[300px] overflow-hidden border bg-white">
          <MediaView media={image} className="h-[140px] w-full" />
          <div className="flex h-[110px] flex-col justify-between p-3">
            <div className="flex items-start gap-2">
              {ad.logo && <Avatar name={ad.brand} media={ad.logo} className="size-7 rounded-md" />}
              <div className="min-w-0">
                <div className="line-clamp-2 text-[14px] leading-tight font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
                <div className="truncate text-[11px] text-zinc-500">{ad.brand}</div>
              </div>
            </div>
            <div className="flex justify-end">
              <span className="rounded-full bg-[#1a73e8] px-3 py-1 text-[12px] font-medium text-white">{ad.cta ?? "Open"}</span>
            </div>
          </div>
        </div>
      </div>
    </DesktopFrame>
  );
}

/** Native in-feed format used on apps and Discover-like surfaces. */
export function NativeCard({ ad, surface }: { ad: NormalizedAd; surface: "native" | "discover" | "audience" }) {
  const image = ad.media.find((m) => aspectOf(m, { min: 0.3, max: 3 }) > 1.4) ?? ad.media[0] ?? ad.cards[0]?.media;
  const thumb = !image && ad.youtube[0] ? youtubeThumb(ad.youtube[0]) : null;
  return (
    <PhoneFrame>
      <div className="h-full space-y-3 overflow-y-auto bg-zinc-100 p-3 pt-10 [scrollbar-width:none]">
        <div className="h-24 rounded-xl bg-white" />
        <div className="overflow-hidden rounded-xl bg-white shadow-sm">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="aspect-[1.91/1] w-full object-cover" />
          ) : (
            <MediaView media={image} className="aspect-[1.91/1] w-full" />
          )}
          <div className="space-y-1.5 p-3">
            <div className="line-clamp-2 text-[15px] leading-tight font-semibold">{placeholderText(ad.longHeadline || ad.headline, "Your long headline")}</div>
            {surface !== "discover" && <div className="line-clamp-2 text-[12px] text-zinc-600">{placeholderText(ad.description, "Your description")}</div>}
            <div className="flex items-center gap-2 pt-1 text-[11px] text-zinc-500">
              <Avatar name={ad.brand} media={ad.logo} className="size-5 text-[9px]" />
              <span className="font-medium text-zinc-700">{ad.brand}</span> · {surface === "audience" ? "Ad" : "Sponsored"}
              {ad.cta && <span className="ml-auto rounded-full border px-2.5 py-0.5 font-medium text-[#1a73e8]">{ad.cta}</span>}
            </div>
          </div>
        </div>
        <div className="h-40 rounded-xl bg-white" />
      </div>
    </PhoneFrame>
  );
}

export function GmailAd({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame>
      <div className="h-full bg-white pt-10">
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-full bg-zinc-100 px-4 py-2 text-[13px] text-zinc-500">
          <Search className="size-4" /> Search in mail
        </div>
        <div className="px-4 py-1 text-[11px] font-medium text-zinc-500">Promotions</div>
        <div className="flex gap-3 bg-sky-50/60 px-4 py-3">
          <Avatar name={ad.brand} media={ad.logo} className="size-9 text-sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px]">
              <span className="rounded border border-zinc-400 px-1 text-[9px] font-bold">Ad</span>
              <span className="truncate font-semibold">{ad.brand}</span>
            </div>
            <div className="truncate text-[13px] font-medium">{placeholderText(ad.headline, "Your headline")}</div>
            <div className="truncate text-[12px] text-zinc-500">{placeholderText(ad.description, "Your description")}</div>
          </div>
          <Star className="size-4 text-zinc-400" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3 px-4 py-3 opacity-50">
            <span className="size-9 rounded-full bg-zinc-200" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 w-28 rounded bg-zinc-200" />
              <div className="h-3 w-full rounded bg-zinc-100" />
            </div>
          </div>
        ))}
      </div>
    </PhoneFrame>
  );
}

function videoPoster(ad: NormalizedAd) {
  const yt = ad.youtube[0] ? youtubeThumb(ad.youtube[0]) : null;
  if (yt) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={yt} alt="" className="h-full w-full object-cover" />;
  }
  return <MediaView media={ad.media[0]} className="h-full w-full" label="Your YouTube video" />;
}

export function YouTubeInStream({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame>
      <div className="pt-8">
        <div className="relative aspect-video bg-black">
          {videoPoster(ad)}
          <div className="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">Sponsored · 0:05</div>
          <div className="absolute right-0 bottom-3 flex items-center gap-1 border border-white/30 bg-black/70 px-2.5 py-1.5 text-[11px] text-white">
            Skip <SkipForward className="size-3.5" />
          </div>
          <Volume2 className="absolute bottom-3 left-2 size-4 text-white" />
          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/30"><div className="h-full w-1/5 bg-amber-400" /></div>
        </div>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Avatar name={ad.brand} media={ad.logo} className="size-8 text-xs" />
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold">{placeholderText(ad.headline, "Your headline")}</div>
            <div className="truncate text-[11px] text-zinc-500">Sponsored · {ad.domain}</div>
          </div>
          <span className="shrink-0 rounded-full bg-[#065fd4] px-3 py-1.5 text-[12px] font-medium text-white">{ad.cta ?? "Visit site"}</span>
        </div>
        <div className="space-y-3 p-3 opacity-50">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex gap-2">
              <span className="aspect-video w-32 rounded bg-zinc-200" />
              <div className="flex-1 space-y-1.5"><div className="h-3 rounded bg-zinc-200" /><div className="h-3 w-2/3 rounded bg-zinc-100" /></div>
            </div>
          ))}
        </div>
      </div>
    </PhoneFrame>
  );
}

export function YouTubeInFeed({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame>
      <div className="space-y-4 pt-8">
        <div className="mx-3 flex items-center gap-2 rounded-full bg-zinc-100 px-4 py-2 text-[13px] text-zinc-500"><Search className="size-4" /> Search YouTube</div>
        <div>
          <div className="relative aspect-video bg-black">{videoPoster(ad)}</div>
          <div className="flex gap-2 px-3 py-2.5">
            <Avatar name={ad.brand} media={ad.logo} className="size-8 text-xs" />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[13px] leading-tight font-medium">{placeholderText(ad.longHeadline || ad.headline, "Your headline")}</div>
              <div className="mt-0.5 text-[11px] text-zinc-500"><span className="font-bold text-zinc-800">Sponsored</span> · {ad.brand}</div>
            </div>
            <MoreVertical className="size-4 text-zinc-500" />
          </div>
          {ad.cta && <div className="mx-3 rounded-full bg-zinc-100 py-2 text-center text-[13px] font-medium">{ad.cta}</div>}
        </div>
        <div className="aspect-video bg-zinc-200 opacity-50" />
      </div>
    </PhoneFrame>
  );
}

export function YouTubeShorts({ ad }: { ad: NormalizedAd }) {
  return (
    <PhoneFrame dark>
      <div className="absolute inset-0">{videoPoster(ad)}</div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pt-20 pb-5">
        <div className="mb-2 flex items-center gap-2 text-[12px]">
          <Avatar name={ad.brand} media={ad.logo} className="size-7 text-[10px]" />
          <span className="font-semibold">{ad.brand}</span>
          <span className="rounded bg-white/20 px-1.5 text-[10px]">Sponsored</span>
        </div>
        <div className="mb-3 line-clamp-2 text-[13px]">{placeholderText(ad.headline, "Your headline")}</div>
        <div className="rounded-full bg-white py-2 text-center text-[13px] font-semibold text-zinc-900">{ad.cta ?? "Learn more"}</div>
      </div>
    </PhoneFrame>
  );
}

export function ShoppingAd({ ad }: { ad: NormalizedAd }) {
  const products = ["Festive Kurta Set", "Silk Saree", "Embroidered Dupatta", "Men's Sherwani"];
  return (
    <PhoneFrame>
      <div className="space-y-3 p-3 pt-10">
        <div className="flex items-center gap-2 rounded-full border px-4 py-2 text-[13px] text-zinc-600"><Search className="size-4" /> {ad.brand.toLowerCase()} kurta</div>
        <div className="text-[12px] font-bold">Sponsored</div>
        <div className="grid grid-cols-2 gap-2">
          {products.map((p, i) => (
            <div key={p} className="overflow-hidden rounded-lg border">
              <div className="aspect-square bg-gradient-to-br from-zinc-100 to-zinc-200" />
              <div className="space-y-0.5 p-2">
                <div className="line-clamp-2 text-[12px] leading-tight">{p}</div>
                <div className="text-[13px] font-semibold">₹{(1499 + i * 700).toLocaleString("en-IN")}</div>
                <div className="truncate text-[11px] text-zinc-500">{ad.brand}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-center text-[11px] text-zinc-500">Products, prices and images come from your Merchant Center feed.</p>
      </div>
    </PhoneFrame>
  );
}

export function GoogleDisplayNative({ ad }: { ad: NormalizedAd }) {
  return <NativeCard ad={ad} surface="native" />;
}

