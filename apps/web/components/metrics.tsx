import { LOWER_IS_BETTER, METRIC_FORMATS, percentChange, type EntityStatus, type MetricFormat, type MetricKey } from "@ashniva/shared";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MetricDef extends MetricFormat {
  key: MetricKey;
}

export const METRICS: Record<string, MetricDef> = Object.fromEntries(
  Object.entries(METRIC_FORMATS).map(([key, f]) => [key, { ...f, key: key as MetricKey }]),
);

/** "+12.4%" pill colored by whether the change is good for this metric. */
export function TrendBadge({
  metric,
  current,
  previous,
  className,
}: {
  metric: MetricKey;
  current: number | null;
  previous: number | null;
  className?: string;
}) {
  const change = percentChange(current, previous);
  if (change == null || !Number.isFinite(change)) {
    return (
      <span className={cn("inline-flex items-center gap-0.5 text-xs text-muted-foreground", className)}>
        <Minus className="size-3" /> n/a
      </span>
    );
  }
  const flat = Math.abs(change) < 0.0005;
  const up = change > 0;
  const good = flat ? null : LOWER_IS_BETTER.has(metric) ? !up : up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium tabular",
        good === null && "bg-muted text-muted-foreground",
        good === true && "bg-success/10 text-success",
        good === false && "bg-destructive/10 text-destructive",
        className,
      )}
    >
      <Icon className="size-3.5" />
      {Math.abs(change * 100).toFixed(1)}%
    </span>
  );
}

const STATUS_STYLE: Record<EntityStatus, { label: string; dot: string; text: string }> = {
  ACTIVE: { label: "Active", dot: "bg-success", text: "text-foreground" },
  PAUSED: { label: "Paused", dot: "bg-muted-foreground/50", text: "text-muted-foreground" },
  ARCHIVED: { label: "Archived", dot: "bg-muted-foreground/30", text: "text-muted-foreground" },
  REMOVED: { label: "Removed", dot: "bg-destructive/60", text: "text-muted-foreground" },
};

export function StatusDot({ status, className }: { status: EntityStatus; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", s.text, className)}>
      <span className="relative flex size-1.5">
        {status === "ACTIVE" && <span className="absolute inset-0 rounded-full bg-success animate-pulse-dot" />}
        <span className={cn("relative size-1.5 rounded-full", s.dot)} />
      </span>
      {s.label}
    </span>
  );
}
