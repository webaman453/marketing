import { PLATFORM_INFO, type Platform } from "@ashniva/shared";
import { cn } from "@/lib/utils";

const GLYPH: Record<Platform, string> = {
  META: "M",
  GOOGLE: "G",
  TIKTOK: "T",
  LINKEDIN: "in",
  MICROSOFT: "MS",
  SNAPCHAT: "S",
  PINTEREST: "P",
};

const SIZES = {
  xs: "size-4 rounded-[4px] text-[8px]",
  sm: "size-5 rounded-[5px] text-[9px]",
  md: "size-7 rounded-md text-[11px]",
  lg: "size-10 rounded-lg text-sm",
} as const;

/** Brand-colored monogram for an ad platform. */
export function PlatformIcon({
  platform,
  size = "sm",
  className,
}: {
  platform: Platform;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const info = PLATFORM_INFO[platform];
  // Snapchat yellow needs dark text for contrast.
  const dark = platform === "SNAPCHAT";
  return (
    <span
      title={info.name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-bold tracking-tight ring-1 ring-black/5 select-none",
        dark ? "text-neutral-900" : "text-white",
        SIZES[size],
        className,
      )}
      style={{ backgroundColor: info.color }}
    >
      {GLYPH[platform]}
    </span>
  );
}

export function PlatformLabel({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <PlatformIcon platform={platform} size="xs" />
      <span className="truncate">{PLATFORM_INFO[platform].name}</span>
    </span>
  );
}
