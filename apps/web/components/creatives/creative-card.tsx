import type { CreativeDTO } from "@ashniva/shared";
import { Film } from "lucide-react";
import { cn } from "@/lib/utils";

/** Common ad formats by aspect ratio, so people can see where an asset fits. */
export function formatLabel(c: Pick<CreativeDTO, "width" | "height">) {
  if (!c.width || !c.height) return null;
  const r = c.width / c.height;
  const near = (x: number) => Math.abs(r - x) < 0.03;
  if (near(1)) return "1:1 · Feed";
  if (near(4 / 5)) return "4:5 · Feed";
  if (near(9 / 16)) return "9:16 · Stories/Reels";
  if (near(1.91)) return "1.91:1 · Link";
  if (near(16 / 9)) return "16:9 · Video/Display";
  return `${c.width}×${c.height}`;
}

export const fileSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function CreativeThumb({ creative, className }: { creative: CreativeDTO; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-muted bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[size:16px_16px]", className)}>
      {creative.type === "IMAGE" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={creative.url} alt={creative.name} className="h-full w-full object-contain" loading="lazy" />
      ) : (
        <>
          <video src={creative.url} className="h-full w-full object-contain" muted preload="metadata" />
          <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
            <Film className="size-3" /> Video
          </span>
        </>
      )}
    </div>
  );
}
