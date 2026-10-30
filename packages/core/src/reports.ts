/**
 * Report engine: turns a saved report config into rows, totals and a series.
 * Used for the in-app view, CSV/PDF exports, shared links and scheduled emails.
 */
import { num, prisma, type Prisma, type Report } from "@ashniva/db";
import { addTotals, fxContext, roundMoney, scaleMoney, type FxContext } from "./fx";
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

type Account = { id: string; name: string; platform: Platform; currency: string };
type Group = { label: string; platform?: string; totals: MetricTotals };

/** Sums per (ad account, day), each converted into the workspace currency at that day's rate. */
async function dailyRows(where: Prisma.MetricDailyWhereInput, fx: FxContext) {
  const rows = await prisma.metricDaily.groupBy({ by: ["adAccountId", "date"], where, _sum: SUM });
  return rows.map((r) => ({
    adAccountId: r.adAccountId,
    date: r.date.toISOString().slice(0, 10),
    totals: scaleMoney(totalsOf(r._sum), fx.accountFactor(r.adAccountId, r.date)),
  }));
}

const add = (map: Map<string, Group>, key: string, init: Omit<Group, "totals">, t: MetricTotals) => {
  const g = map.get(key) ?? { ...init, totals: emptyTotals() };
  g.totals = addTotals(g.totals, t);
  map.set(key, g);
};

async function grouped(
  config: ReportConfig,
  base: Prisma.MetricDailyWhereInput,
  range: { from: string; to: string },
  accounts: Map<string, Account>,
  fx: FxContext,
): Promise<Map<string, Group>> {
  const where = { ...base, date: dateWhere(range) };
  const out = new Map<string, Group>();

  if (config.dimension === "campaign") {
    // Accounts in the workspace currency are summed in the database; others day by day.
    const ids = [...accounts.keys()];
    const plain = ids.filter((id) => !fx.converts(id));
    const converting = ids.filter((id) => fx.converts(id));
    const [plainRows, dayRows] = await Promise.all([
      plain.length ? prisma.metricDaily.groupBy({ by: ["entityId"], where: { ...where, adAccountId: { in: plain } }, _sum: SUM }) : [],
      converting.length
        ? prisma.metricDaily.groupBy({ by: ["entityId", "adAccountId", "date"], where: { ...where, adAccountId: { in: converting } }, _sum: SUM })
        : [],
    ]);
    const totals = new Map<string, MetricTotals>();
    for (const r of plainRows) totals.set(r.entityId, totalsOf(r._sum));
    for (const r of dayRows) {
      const t = scaleMoney(totalsOf(r._sum), fx.accountFactor(r.adAccountId, r.date));
      totals.set(r.entityId, addTotals(totals.get(r.entityId) ?? emptyTotals(), t));
    }
    const top = [...totals.entries()].sort((a, b) => b[1].spend - a[1].spend).slice(0, MAX_ROWS);
    const campaigns = await prisma.campaign.findMany({
      where: { id: { in: top.map(([id]) => id) } },
      select: { id: true, name: true, platform: true },
    });
    const byId = new Map(campaigns.map((c) => [c.id, c]));
    for (const [id, t] of top) {
      const c = byId.get(id);
      if (c) out.set(c.id, { label: c.name, platform: c.platform, totals: roundMoney(t) });
    }
    return out;
  }

  const rows = await dailyRows(where, fx);
  for (const r of rows) {
    const a = accounts.get(r.adAccountId);
    if (!a) continue;
    if (config.dimension === "date") add(out, r.date, { label: r.date }, r.totals);
    else if (config.dimension === "platform") add(out, a.platform, { label: PLATFORM_INFO[a.platform].name, platform: a.platform }, r.totals);
    else add(out, a.id, { label: a.name, platform: a.platform }, r.totals);
  }
  for (const g of out.values()) g.totals = roundMoney(g.totals);
  if (config.dimension === "date") return new Map([...out.entries()].sort((x, y) => x[0].localeCompare(y[0])));
  return out;
}

export interface RunReportOptions {
  range?: { from: string; to: string };
}

const sumAll = (rows: { totals: MetricTotals }[]) => roundMoney(rows.reduce((acc, r) => addTotals(acc, r.totals), emptyTotals()));

export async function runReport(report: Report, opts: RunReportOptions = {}): Promise<ReportResult> {
  const config = reportConfigSchema.parse(report.config);
  const [workspace, org] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: report.workspaceId } }),
    prisma.organization.findUniqueOrThrow({ where: { id: report.orgId } }),
  ]);

  const range = opts.range ?? resolveReportPreset(config.datePreset, todayIn(workspace.timezone));
  const compareRange = config.compare ? previousPeriod(range.from, range.to) : null;

  const accountList = await prisma.adAccount.findMany({
    where: {
      workspaceId: workspace.id,
      ...(config.platforms.length ? { platform: { in: config.platforms as Platform[] } } : {}),
    },
    select: { id: true, name: true, platform: true, currency: true },
  });
  const accounts = new Map(accountList.map((a) => [a.id, a]));
  // Every amount in the report is in the workspace currency; one rates load covers both periods.
  const fx = await fxContext(workspace.currency, accountList, { from: compareRange?.from ?? range.from, to: range.to });
  const base: Prisma.MetricDailyWhereInput = { adAccountId: { in: accountList.map((a) => a.id) }, level: "CAMPAIGN" };

  const [current, previous, daily, prevDaily] = await Promise.all([
    grouped(config, base, range, accounts, fx),
    compareRange && config.dimension !== "date" ? grouped(config, base, compareRange, accounts, fx) : Promise.resolve(null),
    dailyRows({ ...base, date: dateWhere(range) }, fx),
    compareRange ? dailyRows({ ...base, date: dateWhere(compareRange) }, fx) : Promise.resolve(null),
  ]);

  const rows: ReportRow[] = [...current.entries()].map(([key, v]) => ({
    key,
    label: v.label,
    platform: v.platform,
    values: pick(v.totals),
    previous: previous ? pick(previous.get(key)?.totals ?? emptyTotals()) : undefined,
  }));
  if (config.dimension !== "date") rows.sort((a, b) => (b.values.spend ?? 0) - (a.values.spend ?? 0));

  const byDate = new Map<string, MetricTotals>();
  for (const d of daily) byDate.set(d.date, addTotals(byDate.get(d.date) ?? emptyTotals(), d.totals));
  const chartMetric = config.chartMetric;
  const series = chartMetric
    ? eachDay(range.from, range.to).map((date) => ({ date, value: pick(roundMoney(byDate.get(date) ?? emptyTotals()))[chartMetric] }))
    : [];

  return {
    name: report.name,
    range,
    compareRange,
    currency: workspace.currency,
    config,
    rows,
    totals: pick(sumAll(daily)),
    previousTotals: prevDaily ? pick(sumAll(prevDaily)) : null,
    series,
    branding: {
      name: org.brandName || org.name || BRAND.name,
      color: org.brandColor || "#3b5bdb",
      logoUrl: org.brandLogoUrl,
      footer: org.reportFooter,
    },
    workspaceName: workspace.name,
    generatedAt: new Date().toISOString(),
    fx: fx.info,
  };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** Free-text cells (names typed by users or synced from platforms) must not start a spreadsheet formula (CSV injection). */
const textCell = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function reportToCsv(result: ReportResult): string {
  const metrics = result.config.metrics;
  const header = [DIMENSION_LABELS[result.config.dimension], ...(result.config.dimension === "campaign" ? ["Platform"] : []), ...metrics.map((m) => METRIC_FORMATS[m]!.label)];
  const raw = (v: number | null, m: ReportMetric) =>
    v == null ? "" : ["ctr", "conversionRate"].includes(m) ? (v * 100).toFixed(2) + "%" : m === "roas" ? v.toFixed(2) : String(Math.round(v * 100) / 100);
  const lines = [header.map(csvCell).join(",")];
  for (const r of result.rows) {
    lines.push(
      [textCell(r.label), ...(result.config.dimension === "campaign" ? [r.platform ? PLATFORM_INFO[r.platform as Platform].name : ""] : []), ...metrics.map((m) => raw(r.values[m], m))]
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
