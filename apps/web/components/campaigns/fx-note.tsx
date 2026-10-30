import { fxNote, type FxInfo } from "@ashniva/shared";
import { AlertTriangle, ArrowLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Says when workspace totals were converted from other ad-account currencies, or warns
 * when no exchange rate was available and amounts are added up unconverted.
 */
export function FxNote({ fx, className }: { fx: FxInfo | null | undefined; className?: string }) {
  const text = fxNote(fx);
  if (!fx || !text) return null;
  const unavailable = fx.conversion === "unavailable";
  const Icon = unavailable ? AlertTriangle : ArrowLeftRight;
  return (
    <p
      role={unavailable ? "alert" : undefined}
      className={cn(
        "flex items-center gap-1.5 text-xs",
        unavailable ? "font-medium text-[color-mix(in_oklch,var(--warning),black_35%)] dark:text-warning" : "text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {text}
    </p>
  );
}
