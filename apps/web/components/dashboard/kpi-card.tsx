"use client";

import { deriveMetrics, type MetricKey, type MetricSet, type TimeseriesPoint } from "@ashniva/shared";
import { useId, useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { AnimatedNumber } from "@/components/animated-number";
import { METRICS, TrendBadge } from "@/components/metrics";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function KpiCard({
  metric,
  totals,
  previous,
  series,
  currency,
  hint,
  className,
  style,
}: {
  metric: MetricKey;
  totals: MetricSet;
  previous: MetricSet;
  series: TimeseriesPoint[];
  currency: string;
  hint?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const def = METRICS[metric]!;
  const value = totals[metric] as number | null;
  const gradientId = useId().replace(/:/g, "");
  const spark = useMemo(
    () => series.map((p) => ({ date: p.date, v: (deriveMetrics(p)[metric] as number | null) ?? 0 })),
    [series, metric],
  );

  return (
    <Card className={cn("gap-0 overflow-hidden p-0 animate-fade-up", className)} style={style}>
      <div className="px-4 pt-4">
        <div className="flex items-center justify-between gap-2">
          {hint ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-[13px] font-medium text-muted-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-4">
                  {def.label}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-56">{hint}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-[13px] font-medium text-muted-foreground">{def.label}</span>
          )}
          <TrendBadge metric={metric} current={value} previous={previous[metric] as number | null} />
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">
          {value == null ? "—" : <AnimatedNumber value={value} format={(v) => def.short(v, currency)} />}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          vs {def.short(previous[metric] as number | null, currency)} previous period
        </div>
      </div>
      <div className="mt-3 h-12">
        {/* A non-zero first size avoids recharts warning before the container is measured. */}
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 240, height: 48 }}>
          <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke="var(--chart-1)"
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

export function KpiCardSkeleton() {
  return (
    <Card className="gap-0 p-4">
      <div className="flex justify-between">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="mt-3 h-7 w-28" />
      <Skeleton className="mt-2 h-3 w-32" />
      <Skeleton className="mt-4 h-10 w-full" />
    </Card>
  );
}
