import { addTotals, roundMoney, scaleMoney, type FxContext } from "@ashniva/core";
import { num, prisma, type Campaign, type Prisma } from "@ashniva/db";
import {
  VISIBLE_PLATFORMS,
  deriveMetrics,
  eachDay,
  emptyTotals,
  type CampaignRowDTO,
  type DateRange,
  type MetricSet,
  type MetricTotals,
  type Platform,
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

export interface WorkspaceAccount {
  id: string;
  currency: string;
  platform: Platform;
}

/** Ad accounts that feed a workspace's numbers, with the currency each one bills in. */
export async function workspaceAccounts(workspaceId: string): Promise<WorkspaceAccount[]> {
  return prisma.adAccount.findMany({
    // Hidden platforms (TikTok, Swiggy…) stay out of every total, matching the lists.
    where: { workspaceId, platform: { in: [...VISIBLE_PLATFORMS] }, connection: { status: { not: "REVOKED" } } },
    select: { id: true, currency: true, platform: true },
  });
}

/** Ad accounts that feed a workspace's numbers. */
export async function workspaceAccountIds(workspaceId: string) {
  return (await workspaceAccounts(workspaceId)).map((a) => a.id);
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

// ───────── Workspace-currency aggregates ─────────
// MetricDaily is stored in each ad account's own currency, so anything summed across
// accounts is grouped per account and day, converted at that day's rate, then added up.

export interface DailyRow {
  adAccountId: string;
  date: string;
  /** Already in the workspace currency */
  totals: MetricTotals;
}

/** Sums per (ad account, day), converted into the context currency. */
export async function convertedDaily(where: Prisma.MetricDailyWhereInput, fx: FxContext): Promise<DailyRow[]> {
  const rows = await prisma.metricDaily.groupBy({ by: ["adAccountId", "date"], where, _sum: SUM_FIELDS });
  return rows.map((r) => ({
    adAccountId: r.adAccountId,
    date: r.date.toISOString().slice(0, 10),
    totals: scaleMoney(toTotals(r._sum), fx.accountFactor(r.adAccountId, r.date)),
  }));
}

export const sumRows = (rows: { totals: MetricTotals }[]): MetricTotals =>
  roundMoney(rows.reduce((acc, r) => addTotals(acc, r.totals), emptyTotals()));

/** Zero-filled daily series from converted rows. */
export function seriesOf(rows: DailyRow[], range: DateRange): TimeseriesPoint[] {
  const byDate = new Map<string, MetricTotals>();
  for (const r of rows) byDate.set(r.date, addTotals(byDate.get(r.date) ?? emptyTotals(), r.totals));
  return eachDay(range.from, range.to).map((date) => ({ date, ...roundMoney(byDate.get(date) ?? emptyTotals()) }));
}

/**
 * Totals per entity in the context currency, for entities in `accountIds`. Accounts already
 * in that currency are summed in the database; the others are converted day by day.
 */
export async function convertedByEntity(
  where: Prisma.MetricDailyWhereInput,
  fx: FxContext,
  accountIds: string[],
): Promise<Map<string, MetricTotals>> {
  const converting = accountIds.filter((id) => fx.converts(id));
  const plain = accountIds.filter((id) => !fx.converts(id));
  const [plainRows, dailyRows] = await Promise.all([
    plain.length ? prisma.metricDaily.groupBy({ by: ["entityId"], where: { ...where, adAccountId: { in: plain } }, _sum: SUM_FIELDS }) : [],
    converting.length
      ? prisma.metricDaily.groupBy({ by: ["entityId", "adAccountId", "date"], where: { ...where, adAccountId: { in: converting } }, _sum: SUM_FIELDS })
      : [],
  ]);
  const out = new Map<string, MetricTotals>();
  for (const r of plainRows) out.set(r.entityId, toTotals(r._sum));
  for (const r of dailyRows) {
    const t = scaleMoney(toTotals(r._sum), fx.accountFactor(r.adAccountId, r.date));
    out.set(r.entityId, addTotals(out.get(r.entityId) ?? emptyTotals(), t));
  }
  for (const [k, v] of out) out.set(k, roundMoney(v));
  return out;
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
