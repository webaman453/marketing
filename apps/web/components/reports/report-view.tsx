"use client";

import {
  DIMENSION_LABELS,
  LOWER_IS_BETTER,
  METRIC_FORMATS,
  percentChange,
  type MetricKey,
  type Platform,
  type ReportResult,
} from "@ashniva/shared";
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { PlatformIcon } from "@/components/platform-icon";
import { Card } from "@/components/ui/card";
import { ChartContainer } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { longDate, shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Renders a report result: KPI tiles, trend chart and breakdown table. */
export function ReportView({ result, className }: { result: ReportResult; className?: string }) {
  const { config, currency } = result;
  const metrics = config.metrics;
  const chart = config.chartMetric;
  const color = result.branding.color;

  return (
    <div className={cn("space-y-5", className)}>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3 xl:grid-cols-6">
        {metrics.slice(0, 6).map((m) => {
          const change = result.previousTotals ? percentChange(result.totals[m], result.previousTotals[m]) : null;
          const good = change == null ? null : LOWER_IS_BETTER.has(m as MetricKey) ? change < 0 : change > 0;
          return (
            <div key={m} className="bg-card px-4 py-3">
              <div className="text-xs font-medium text-muted-foreground">{METRIC_FORMATS[m]!.label}</div>
              <div className="mt-1 text-lg font-semibold tracking-tight tabular">{METRIC_FORMATS[m]!.short(result.totals[m], currency)}</div>
              {change != null && Number.isFinite(change) && (
                <div className={cn("text-xs font-medium tabular", Math.abs(change) < 0.0005 ? "text-muted-foreground" : good ? "text-success" : "text-destructive")}>
                  {change > 0 ? "▲" : "▼"} {Math.abs(change * 100).toFixed(1)}%
                </div>
              )}
            </div>
          );
        })}
      </div>

      {chart && result.series.length > 1 && (
        <Card className="gap-3 px-4 py-4">
          <div className="text-sm font-medium">{METRIC_FORMATS[chart]!.label} by day</div>
          <ChartContainer config={{ v: { label: METRIC_FORMATS[chart]!.label, color } }} className="aspect-auto h-[220px] w-full">
            <AreaChart data={result.series} margin={{ left: 4, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="report-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={shortDate} interval={Math.max(0, Math.ceil(result.series.length / 8) - 1)} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => METRIC_FORMATS[chart]!.short(v, currency)} />
              <Tooltip
                cursor={{ stroke: "var(--border)" }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
                      <div className="font-medium">{longDate(String(label))}</div>
                      <div className="mt-1 tabular">{METRIC_FORMATS[chart]!.format(payload[0]!.value as number, currency)}</div>
                    </div>
                  ) : null
                }
              />
              <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill="url(#report-fill)" animationDuration={500} />
            </AreaChart>
          </ChartContainer>
        </Card>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">{DIMENSION_LABELS[config.dimension]}</TableHead>
                {metrics.map((m) => (
                  <TableHead key={m} className="text-right whitespace-nowrap last:pr-4">{METRIC_FORMATS[m]!.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={metrics.length + 1} className="py-10 text-center text-sm text-muted-foreground">
                    No data for this period.
                  </TableCell>
                </TableRow>
              ) : (
                result.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="max-w-[360px] pl-4">
                      <span className="flex items-center gap-2">
                        {r.platform && <PlatformIcon platform={r.platform as Platform} size="xs" />}
                        <span className="truncate font-medium">{config.dimension === "date" ? longDate(r.label) : r.label}</span>
                      </span>
                    </TableCell>
                    {metrics.map((m) => (
                      <TableCell key={m} className="text-right whitespace-nowrap tabular last:pr-4">
                        {METRIC_FORMATS[m]!.format(r.values[m], currency)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
            {result.rows.length > 0 && (
              <TableFooter className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableCell className="pl-4 font-semibold">Total</TableCell>
                  {metrics.map((m) => (
                    <TableCell key={m} className="text-right font-semibold whitespace-nowrap tabular last:pr-4">
                      {METRIC_FORMATS[m]!.format(result.totals[m], currency)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </Card>
    </div>
  );
}
