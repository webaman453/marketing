"use client";

import { deriveMetrics, type TimeseriesPoint } from "@ashniva/shared";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { METRICS } from "@/components/metrics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { longDate, shortDate } from "@/lib/format";

type View = "spend_revenue" | "conversions" | "clicks" | "cpa";

const VIEWS: { id: View; label: string }[] = [
  { id: "spend_revenue", label: "Spend & revenue" },
  { id: "conversions", label: "Conversions" },
  { id: "clicks", label: "Clicks" },
  { id: "cpa", label: "Cost / conv." },
];

const config = {
  spend: { label: "Spend", color: "var(--chart-1)" },
  conversionValue: { label: "Revenue", color: "var(--chart-2)" },
  conversions: { label: "Conversions", color: "var(--chart-1)" },
  clicks: { label: "Clicks", color: "var(--chart-1)" },
  cpa: { label: "Cost / conv.", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function PerformanceChart({ series, currency }: { series: TimeseriesPoint[]; currency: string }) {
  const [view, setView] = useState<View>("spend_revenue");
  const data = useMemo(() => series.map((p) => ({ ...p, cpa: deriveMetrics(p).cpa })), [series]);
  const keys = view === "spend_revenue" ? (["spend", "conversionValue"] as const) : ([view] as const);
  const yFormat = (v: number) => METRICS[keys[0]]!.short(v, currency);
  const tickInterval = Math.max(0, Math.ceil(data.length / 8) - 1);

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-col gap-3">
        <div className="space-y-1">
          <CardTitle>Performance</CardTitle>
          <CardDescription>Daily totals across all connected platforms</CardDescription>
        </div>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && setView(v as View)}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
        >
          {VIEWS.map((v) => (
            <ToggleGroupItem key={v.id} value={v.id} className="px-2.5 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground">
              {v.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </CardHeader>
      <CardContent className="px-2 sm:px-4">
        <ChartContainer config={config} className="aspect-auto h-[300px] w-full">
          {view === "conversions" || view === "clicks" ? (
            <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} tickFormatter={shortDate} interval={tickInterval} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={yFormat} />
              <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.6 }} content={<ChartTip keys={keys} currency={currency} />} />
              <Bar dataKey={view} fill={`var(--color-${view})`} radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={500} />
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                {keys.map((k) => (
                  <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={`var(--color-${k})`} stopOpacity={0.24} />
                    <stop offset="100%" stopColor={`var(--color-${k})`} stopOpacity={0.01} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} tickFormatter={shortDate} interval={tickInterval} />
              <YAxis yAxisId="left" tickLine={false} axisLine={false} width={56} tickFormatter={yFormat} />
              {keys.length > 1 && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(v: number) => METRICS[keys[1]!]!.short(v, currency)}
                />
              )}
              <Tooltip cursor={{ stroke: "var(--border)" }} content={<ChartTip keys={keys} currency={currency} />} />
              {keys.map((k, i) => (
                <Area
                  key={k}
                  yAxisId={i === 0 ? "left" : "right"}
                  type="monotone"
                  dataKey={k}
                  stroke={`var(--color-${k})`}
                  strokeWidth={2}
                  fill={`url(#fill-${k})`}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                  animationDuration={600}
                  connectNulls
                />
              ))}
            </AreaChart>
          )}
        </ChartContainer>
        {view === "spend_revenue" && (
          <div className="mt-3 flex items-center justify-center gap-5 text-xs text-muted-foreground">
            {keys.map((k, i) => (
              <span key={k} className="inline-flex items-center gap-1.5">
                <span className="size-2.5 rounded-sm" style={{ background: config[k].color }} />
                {config[k].label}
                <span className="text-muted-foreground/60">({i === 0 ? "left" : "right"} axis)</span>
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChartTip({
  active,
  payload,
  label,
  keys,
  currency,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | null; color?: string }[];
  label?: string;
  keys: readonly string[];
  currency: string;
}) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="min-w-44 rounded-lg border bg-popover px-3 py-2.5 text-xs shadow-lg">
      <div className="mb-2 font-medium text-foreground">{longDate(label)}</div>
      <div className="space-y-1.5">
        {keys.map((k) => {
          const item = payload.find((p) => p.dataKey === k);
          return (
            <div key={k} className="flex items-center justify-between gap-4">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="size-2 rounded-full" style={{ background: `var(--color-${k})` }} />
                {METRICS[k]!.label}
              </span>
              <span className="font-medium tabular text-foreground">{METRICS[k]!.format(item?.value ?? null, currency)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
