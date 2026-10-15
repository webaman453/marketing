/** Shared pieces for ad placement mockups: device frames, media and avatars. */
"use client";

import type { PreviewMedia } from "@ashniva/shared";
import { ImageIcon, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export function PhoneFrame({ children, dark, className }: { children: React.ReactNode; dark?: boolean; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[300px] rounded-[2.2rem] border-[6px] border-zinc-900 bg-zinc-900 shadow-xl", className)}>
      <div className={cn("relative h-[600px] overflow-hidden rounded-[1.7rem]", dark ? "bg-black text-white" : "bg-white text-zinc-900")}>
        <div className="absolute top-1.5 left-1/2 z-30 h-5 w-20 -translate-x-1/2 rounded-full bg-zinc-900" />
        {children}
      </div>
    </div>
  );
}

export function DesktopFrame({ children, url = "www.example.com", className }: { children: React.ReactNode; url?: string; className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border bg-white text-zinc-900 shadow-lg", className)}>
      <div className="flex items-center gap-2 border-b bg-zinc-100 px-3 py-2">
        <span className="size-2.5 rounded-full bg-red-400" />
        <span className="size-2.5 rounded-full bg-amber-400" />
        <span className="size-2.5 rounded-full bg-green-400" />
        <span className="ml-2 flex-1 truncate rounded-md bg-white px-2 py-0.5 text-[11px] text-zinc-500">{url}</span>
      </div>
      {children}
    </div>
  );
}

/** An image or video from the creative library, or a placeholder until one is chosen. */
export function MediaView({
  media,
  className,
  fit = "cover",
  label = "Your image or video",
  autoPlay,
}: {
  media: PreviewMedia | null | undefined;
  className?: string;
  fit?: "cover" | "contain";
  label?: string;
  autoPlay?: boolean;
}) {
  if (!media) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-1.5 bg-zinc-200 text-zinc-500", className)}>
        <ImageIcon className="size-6" />
        <span className="text-[11px]">{label}</span>
      </div>
    );
  }
  if (media.type === "VIDEO") {
    return (
      <div className={cn("relative bg-black", className)}>
        <video src={media.url} className={cn("h-full w-full", fit === "cover" ? "object-cover" : "object-contain")} muted loop playsInline autoPlay={autoPlay} preload="metadata" />
        {!autoPlay && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white">
              <Play className="size-5 fill-current" />
            </span>
          </span>
        )}
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={media.url} alt="" className={cn("block bg-zinc-100", fit === "cover" ? "object-cover" : "object-contain", className)} />;
}

/** Full-screen vertical media: anything not 9:16 sits on a blurred copy of itself, like Stories and Reels do. */
export function VerticalMedia({ media }: { media: PreviewMedia | null | undefined }) {
  const tall = media?.width && media.height ? media.width / media.height < 0.7 : true;
  if (!media || tall) return <MediaView media={media} className="absolute inset-0 h-full w-full" autoPlay />;
  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {media.type === "IMAGE" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover opacity-70 blur-2xl" />
      )}
      <MediaView media={media} className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 bg-transparent" fit="contain" autoPlay />
    </div>
  );
}

export function Avatar({ name, media, className }: { name: string; media?: PreviewMedia | null; className?: string }) {
  if (media && media.type === "IMAGE") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={media.url} alt="" className={cn("rounded-full object-cover", className)} />;
  }
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-sky-500 font-semibold text-white", className)}>
      {(name.trim()[0] ?? "A").toUpperCase()}
    </span>
  );
}

/** Aspect-ratio box for media from its real dimensions, clamped like feeds do. */
export function aspectOf(media: PreviewMedia | null | undefined, opts: { min?: number; max?: number; fallback?: number } = {}) {
  const r = media?.width && media.height ? media.width / media.height : (opts.fallback ?? 1);
  return Math.min(opts.max ?? 1.91, Math.max(opts.min ?? 0.8, r));
}

/** Text clipped to `max` characters with a trailing "… more" like feeds show. */
export function Clamp({ text, max, more = "more", className }: { text: string; max: number; more?: string; className?: string }) {
  if (!text) return null;
  const long = text.length > max;
  return (
    <p className={cn("whitespace-pre-line break-words", className)}>
      {long ? text.slice(0, max).trimEnd() : text}
      {long && <span className="opacity-60">… {more}</span>}
    </p>
  );
}

export const placeholderText = (value: string, fallback: string) => value || fallback;
