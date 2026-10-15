import { num, prisma, type Campaign, type Prisma } from "@ashniva/db";
import {
  deriveMetrics,
  eachDay,
  emptyTotals,
  type CampaignRowDTO,
  type DateRange,
  type MetricSet,
  type MetricTotals,
  type TimeseriesPoint,
} from "@ashniva/shared";

type Sums = {
  impressions: number | null;
  clicks: number | null;
  spend: Prisma.Decimal | null;
  conversions: Prisma.Decimal | null;
  conversionValue: Prisma.Decimal | null;
  videoViews: number | null;
};

export const SUM_FIELDS = {
  impressions: true,
  clicks: true,
  spend: true,
  conversions: true,
  conversionValue: true,
  videoViews: true,
} as const;

export const toTotals = (s: Partial<Sums> | null | undefined): MetricTotals => ({
  impressions: s?.impressions ?? 0,
  clicks: s?.clicks ?? 0,
  spend: num(s?.spend),
  conversions: num(s?.conversions),
  conversionValue: num(s?.conversionValue),
  videoViews: s?.videoViews ?? 0,
});

export const dateFilter = (r: DateRange) => ({
  gte: new Date(`${r.from}T00:00:00Z`),
  lte: new Date(`${r.to}T00:00:00Z`),
});

/** Ad accounts that feed a workspace's numbers. */
export async function workspaceAccountIds(workspaceId: string) {
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId, connection: { status: { not: "REVOKED" } } },
    select: { id: true },
  });
  return accounts.map((a) => a.id);
}

export async function sumMetrics(where: Prisma.MetricDailyWhereInput): Promise<MetricSet> {
  const agg = await prisma.metricDaily.aggregate({ where, _sum: SUM_FIELDS });
  return deriveMetrics(toTotals(agg._sum));
}

/** Daily series with zero-filled gaps so charts have a point for every day. */
export async function timeseries(where: Prisma.MetricDailyWhereInput, range: DateRange): Promise<TimeseriesPoint[]> {
  const rows = await prisma.metricDaily.groupBy({ by: ["date"], where, _sum: SUM_FIELDS, orderBy: { date: "asc" } });
  const byDate = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), toTotals(r._sum)]));
  return eachDay(range.from, range.to).map((date) => ({ date, ...(byDate.get(date) ?? emptyTotals()) }));
}

/** Metrics per entity id for one level, e.g. every campaign in a set of accounts. */
export async function metricsByEntity(where: Prisma.MetricDailyWhereInput) {
  const rows = await prisma.metricDaily.groupBy({ by: ["entityId"], where, _sum: SUM_FIELDS });
  return new Map(rows.map((r) => [r.entityId, deriveMetrics(toTotals(r._sum))]));
}

export function toCampaignRow(
  c: Campaign & { adAccount: { id: string; name: string; currency: string } },
  metrics: MetricSet | undefined,
): CampaignRowDTO {
  return {
    id: c.id,
    platform: c.platform,
    externalId: c.externalId,
    name: c.name,
    status: c.status,
    deliveryStatus: c.deliveryStatus,
    objective: c.objective,
    dailyBudget: c.dailyBudget == null ? null : num(c.dailyBudget),
    lifetimeBudget: c.lifetimeBudget == null ? null : num(c.lifetimeBudget),
    currency: c.adAccount.currency,
    adAccount: { id: c.adAccount.id, name: c.adAccount.name },
    startDate: c.startDate ? c.startDate.toISOString().slice(0, 10) : null,
    endDate: c.endDate ? c.endDate.toISOString().slice(0, 10) : null,
    metrics: metrics ?? deriveMetrics(emptyTotals()),
  };
}
