/**
 * Report engine: turns a saved report config into rows, totals and a series.
 * Used for the in-app view, CSV/PDF exports, shared links and scheduled emails.
 */
import { num, prisma, type Prisma, type Report } from "@ashniva/db";
import {
  BRAND,
  DIMENSION_LABELS,
  METRIC_FORMATS,
  PLATFORM_INFO,
  deriveMetrics,
  eachDay,
  emptyTotals,
  previousPeriod,
  reportConfigSchema,
  resolveReportPreset,
  type MetricTotals,
  type Platform,
  type ReportConfig,
  type ReportMetric,
  type ReportResult,
  type ReportRow,
} from "@ashniva/shared";

const SUM = { impressions: true, clicks: true, spend: true, conversions: true, conversionValue: true, videoViews: true } as const;
const MAX_ROWS = 200;

type Sums = Partial<Record<keyof typeof SUM, number | Prisma.Decimal | null>>;

const totalsOf = (s: Sums | null | undefined): MetricTotals => ({
  impressions: num(s?.impressions as number),
  clicks: num(s?.clicks as number),
  spend: num(s?.spend as Prisma.Decimal),
  conversions: num(s?.conversions as Prisma.Decimal),
  conversionValue: num(s?.conversionValue as Prisma.Decimal),
  videoViews: num(s?.videoViews as number),
});

const pick = (t: MetricTotals): Record<ReportMetric, number | null> => {
  const d = deriveMetrics(t);
  return {
    spend: d.spend,
    impressions: d.impressions,
    clicks: d.clicks,
    ctr: d.ctr,
    cpc: d.cpc,
    cpm: d.cpm,
    conversions: d.conversions,
    conversionValue: d.conversionValue,
    cpa: d.cpa,
    roas: d.roas,
    conversionRate: d.conversionRate,
    videoViews: d.videoViews,
  };
};

/** Today's date in a timezone, as YYYY-MM-DD. */
export function todayIn(timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

const dateWhere = (r: { from: string; to: string }) => ({
  gte: new Date(`${r.from}T00:00:00Z`),
  lte: new Date(`${r.to}T00:00:00Z`),
});

async function grouped(
  config: ReportConfig,
  base: Prisma.MetricDailyWhereInput,
  range: { from: string; to: string },
): Promise<Map<string, { label: string; platform?: string; totals: MetricTotals }>> {
  const where = { ...base, date: dateWhere(range) };
  const out = new Map<string, { label: string; platform?: string; totals: MetricTotals }>();

  switch (config.dimension) {
    case "date": {
      const rows = await prisma.metricDaily.groupBy({ by: ["date"], where, _sum: SUM, orderBy: { date: "asc" } });
      for (const r of rows) {
        const d = r.date.toISOString().slice(0, 10);
        out.set(d, { label: d, totals: totalsOf(r._sum) });
      }
      break;
    }
    case "platform": {
      const rows = await prisma.metricDaily.groupBy({ by: ["platform"], where, _sum: SUM });
      for (const r of rows) out.set(r.platform, { label: PLATFORM_INFO[r.platform].name, platform: r.platform, totals: totalsOf(r._sum) });
      break;
    }
    case "campaign": {
      const rows = await prisma.metricDaily.groupBy({ by: ["entityId"], where, _sum: SUM, orderBy: { _sum: { spend: "desc" } }, take: MAX_ROWS });
      const campaigns = await prisma.campaign.findMany({
        where: { id: { in: rows.map((r) => r.entityId) } },
        select: { id: true, name: true, platform: true },
      });
      const byId = new Map(campaigns.map((c) => [c.id, c]));
      for (const r of rows) {
        const c = byId.get(r.entityId);
        if (c) out.set(c.id, { label: c.name, platform: c.platform, totals: totalsOf(r._sum) });
      }
      break;
    }
    case "adAccount": {
      const rows = await prisma.metricDaily.groupBy({ by: ["adAccountId"], where, _sum: SUM });
      const accounts = await prisma.adAccount.findMany({
        where: { id: { in: rows.map((r) => r.adAccountId) } },
        select: { id: true, name: true, platform: true },
      });
      const byId = new Map(accounts.map((a) => [a.id, a]));
      for (const r of rows) {
        const a = byId.get(r.adAccountId);
        if (a) out.set(a.id, { label: a.name, platform: a.platform, totals: totalsOf(r._sum) });
      }
      break;
    }
  }
  return out;
}

export interface RunReportOptions {
  range?: { from: string; to: string };
}

export async function runReport(report: Report, opts: RunReportOptions = {}): Promise<ReportResult> {
  const config = reportConfigSchema.parse(report.config);
  const [workspace, org] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: report.workspaceId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: report.orgId } }),
  ]);

  const range = opts.range ?? resolveReportPreset(config.datePreset, todayIn(workspace.timezone));
  const compareRange = config.compare ? previousPeriod(range.from, range.to) : null;

  const accounts = await prisma.adAccount.findMany({
    where: {
      workspaceId: workspace.id,
      ...(config.platforms.length ? { platform: { in: config.platforms as Platform[] } } : {}),
    },
    select: { id: true },
  });
  const base: Prisma.MetricDailyWhereInput = { adAccountId: { in: accounts.map((a) => a.id) }, level: "CAMPAIGN" };

  const [current, previous, totalAgg, prevAgg, daily] = await Promise.all([
    grouped(config, base, range),
    compareRange && config.dimension !== "date" ? grouped(config, base, compareRange) : Promise.resolve(null),
    prisma.metricDaily.aggregate({ where: { ...base, date: dateWhere(range) }, _sum: SUM }),
    compareRange ? prisma.metricDaily.aggregate({ where: { ...base, date: dateWhere(compareRange) }, _sum: SUM }) : Promise.resolve(null),
    prisma.metricDaily.groupBy({ by: ["date"], where: { ...base, date: dateWhere(range) }, _sum: SUM, orderBy: { date: "asc" } }),
  ]);

  const rows: ReportRow[] = [...current.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    platform: v.platform,
    values: pick(v.totals),
    previous: previous ? pick(previous.get(key)?.totals ?? emptyTotals()) : undefined,
  }));
  if (config.dimension !== "date") rows.sort((a, b) => (b.values.spend ?? 0) - (a.values.spend ?? 0));

  const byDate = new Map(daily.map((d) => [d.date.toISOString().slice(0, 10), totalsOf(d._sum)]));
  const chartMetric = config.chartMetric;
  const series = chartMetric
    ? eachDay(range.from, range.to).map((date) => ({ date, value: pick(byDate.get(date) ?? emptyTotals())[chartMetric] }))
    : [];

  return {
    name: report.name,
    range,
    compareRange,
    currency: workspace.currency,
    config,
    rows,
    totals: pick(totalsOf(totalAgg._sum)),
    previousTotals: prevAgg ? pick(totalsOf(prevAgg._sum)) : null,
    series,
    branding: {
      name: org.brandName || org.name || BRAND.name,
      color: org.brandColor || "#3b5bdb",
      logoUrl: org.brandLogoUrl,
      footer: org.reportFooter,
    },
    workspaceName: workspace.name,
    generatedAt: new Date().toISOString(),
  };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function reportToCsv(result: ReportResult): string {
  const metrics = result.config.metrics;
  const header = [DIMENSION_LABELS[result.config.dimension], ...(result.config.dimension === "campaign" ? ["Platform"] : []), ...metrics.map((m) => METRIC_FORMATS[m]!.label)];
  const raw = (v: number | null, m: ReportMetric) =>
    v == null ? "" : ["ctr", "conversionRate"].includes(m) ? (v * 100).toFixed(2) + "%" : m === "roas" ? v.toFixed(2) : String(Math.round(v * 100) / 100);
  const lines = [header.map(csvCell).join(",")];
  for (const r of result.rows) {
    lines.push(
      [r.label, ...(result.config.dimension === "campaign" ? [r.platform ? PLATFORM_INFO[r.platform as Platform].name : ""] : []), ...metrics.map((m) => raw(r.values[m], m))]
        .map(csvCell)
        .join(","),
    );
  }
  lines.push(["Total", ...(result.config.dimension === "campaign" ? [""] : []), ...metrics.map((m) => raw(result.totals[m], m))].map(csvCell).join(","));
  return lines.join("\n");
}

/** Next scheduled send time after `from`, in the workspace timezone at `hour`:00. */
export function nextRunAt(
  schedule: { frequency: "DAILY" | "WEEKLY" | "MONTHLY"; hour: number; dayOfWeek: number; dayOfMonth: number },
  timezone: string,
  from = new Date(),
): Date {
  // Find the UTC offset of the timezone at `from` (good enough; DST shifts settle on the next run).
  const local = new Date(from.toLocaleString("en-US", { timeZone: timezone }));
  const offsetMs = local.getTime() - from.getTime();
  const candidate = new Date(local);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(0);
  candidate.setHours(schedule.hour);

  const advance = () => {
    if (schedule.frequency === "DAILY") candidate.setDate(candidate.getDate() + 1);
    else if (schedule.frequency === "WEEKLY") candidate.setDate(candidate.getDate() + 7);
    else candidate.setMonth(candidate.getMonth() + 1);
  };
  if (schedule.frequency === "WEEKLY") {
    candidate.setDate(candidate.getDate() + ((schedule.dayOfWeek - candidate.getDay() + 7) % 7));
  } else if (schedule.frequency === "MONTHLY") {
    candidate.setDate(schedule.dayOfMonth);
  }
  if (candidate.getTime() <= local.getTime()) advance();
  return new Date(candidate.getTime() - offsetMs);
}
