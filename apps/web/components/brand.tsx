import { BRAND } from "@ashniva/shared";
import { cn } from "@/lib/utils";

/** Square brand mark: three rising bars, one per tier of the ads hierarchy. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[oklch(0.56_0.2_266)] to-[oklch(0.45_0.2_280)] shadow-sm ring-1 ring-black/5",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="size-[58%]" fill="none">
        <rect x="3.5" y="13" width="4" height="7.5" rx="1.4" fill="white" fillOpacity="0.55" />
        <rect x="10" y="8.5" width="4" height="12" rx="1.4" fill="white" fillOpacity="0.8" />
        <rect x="16.5" y="3.5" width="4" height="17" rx="1.4" fill="white" />
      </svg>
    </span>
  );
}

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  const [first, ...rest] = BRAND.name.split(" ");
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark />
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-foreground">
          {first}
          {rest.length > 0 && <span className="font-normal text-muted-foreground"> {rest.join(" ")}</span>}
        </span>
      )}
    </span>
  );
}
