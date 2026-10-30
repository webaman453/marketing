import { addTotals, changeCampaignBudget, changeCampaignStatus, fxContext, roundMoney, scaleMoney, type Actor } from "@ashniva/core";
import { num, prisma, type Prisma } from "@ashniva/db";
import {
  bulkCampaignActionSchema,
  campaignListQuery,
  dateRangeQuery,
  deriveMetrics,
  emptyTotals,
  previousPeriod,
  updateCampaignBudgetSchema,
  updateCampaignStatusSchema,
  type AdGroupRowDTO,
  type AdPreviewData,
  type AdRowDTO,
  type CampaignDetailResponse,
  type CampaignListResponse,
  type MetricTotals,
  type OverviewResponse,
  type PlatformBreakdown,
} from "@ashniva/shared";
import { Router, type Request } from "express";
import { notFound, parse } from "../lib/errors";
import { aiRouter } from "./ai.routes";
import { adMediaRouter } from "./ad-media.routes";
import { builderRouter } from "./builder.routes";
import { creativesRouter } from "./creatives.routes";
import { leadsRouter } from "./leads.routes";
import { reportsRouter } from "./reports.routes";
import { rulesRouter } from "./rules.routes";
import { spendRouter } from "./spend.routes";
import { toAuditDTO } from "../lib/serialize";
import { loadWorkspace, requireActivePlanForWrites, requirePermission } from "../middleware/auth";
import {
  convertedByEntity,
  convertedDaily,
  dateFilter,
  metricsByEntity,
  seriesOf,
  sumMetrics,
  sumRows,
  timeseries,
  toCampaignRow,
  workspaceAccountIds,
  workspaceAccounts,
} from "./analytics.service";

export const workspacesRouter = Router({ mergeParams: true });
workspacesRouter.use(loadWorkspace, requireActivePlanForWrites);
workspacesRouter.use(creativesRouter, adMediaRouter, leadsRouter, builderRouter, reportsRouter, rulesRouter, aiRouter, spendRouter);

const campaignInclude = { adAccount: { select: { id: true, name: true, currency: true } } } as const;

// ───────── Overview dashboard ─────────

workspacesRouter.get("/overview", async (req, res) => {
  const range = parse(dateRangeQuery, req.query);
  const compareRange = previousPeriod(range.from, range.to);
  const accounts = await workspaceAccounts(req.workspace!.id);
  const accountIds = accounts.map((a) => a.id);
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform]));
  // One rates load covers both periods; every amount below is in the workspace currency.
  const fx = await fxContext(req.workspace!.currency, accounts, { from: compareRange.from, to: range.to });

  const base = { adAccountId: { in: accountIds }, level: "CAMPAIGN" as const };
  const current = { ...base, date: dateFilter(range) };

  const [currentRows, previousRows, byCampaign, connections] = await Promise.all([
    convertedDaily(current, fx),
    convertedDaily({ ...base, date: dateFilter(compareRange) }, fx),
    convertedByEntity(current, fx, accountIds),
    prisma.platformConnection.findMany({
      where: { adAccounts: { some: { id: { in: accountIds } } } },
      select: { status: true, syncStatus: true, lastSyncedAt: true },
    }),
  ]);

  const platformTotals = new Map<string, { totals: MetricTotals }[]>();
  for (const r of currentRows) {
    const p = platformOf.get(r.adAccountId)!;
    const list = platformTotals.get(p);
    if (list) list.push(r);
    else platformTotals.set(p, [r]);
  }
  const byPlatform: PlatformBreakdown[] = [...platformTotals.entries()]
    .map(([platform, rows]) => ({ platform: platform as PlatformBreakdown["platform"], metrics: deriveMetrics(sumRows(rows)) }))
    .sort((a, b) => b.metrics.spend - a.metrics.spend);

  // Ranked by spend in the workspace currency, so a ₹ account can't outrank a $ one on raw digits.
  const topIds = [...byCampaign.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, 6)
    .map(([id]) => id);
  const top = await prisma.campaign.findMany({ where: { id: { in: topIds } }, include: campaignInclude });
  const topCampaigns = topIds
    .map((id) => top.find((c) => c.id === id))
    .filter((c) => c !== undefined)
    .map((c) => ({
      ...toCampaignRow(c, deriveMetrics(byCampaign.get(c.id)!)),
      currency: fx.converts(c.adAccountId) || c.adAccount.currency === fx.currency ? fx.currency : c.adAccount.currency,
    }));

  const lastSyncedAt = connections
    .map((c) => c.lastSyncedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const body: OverviewResponse = {
    range,
    compareRange,
    currency: req.workspace!.currency,
    totals: deriveMetrics(sumRows(currentRows)),
    previous: deriveMetrics(sumRows(previousRows)),
    timeseries: seriesOf(currentRows, range),
    byPlatform,
    topCampaigns,
    accounts: {
      total: accountIds.length,
      connections: connections.length,
      failing: connections.filter((c) => c.status !== "ACTIVE" || c.syncStatus === "FAILED").length,
    },
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
    fx: fx.info,
  };
  res.json(body);
});

// ───────── Campaigns ─────────

workspacesRouter.get("/campaigns", async (req, res) => {
  const q = parse(campaignListQuery, req.query);
  const accounts = await workspaceAccounts(req.workspace!.id);
  const scoped = q.adAccountId ? accounts.filter((a) => a.id === q.adAccountId) : accounts;
  const scopedAccounts = scoped.map((a) => a.id);
  const fx = await fxContext(req.workspace!.currency, scoped, q);

  const where: Prisma.CampaignWhereInput = {
    adAccountId: { in: scopedAccounts },
    status: q.status ?? { not: "REMOVED" },
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
  };
  const campaigns = await prisma.campaign.findMany({ where, include: campaignInclude, orderBy: { name: "asc" } });
  const metricWhere: Prisma.MetricDailyWhereInput = {
    level: "CAMPAIGN",
    adAccountId: { in: scopedAccounts },
    entityId: { in: campaigns.map((c) => c.id) },
    date: dateFilter(q),
  };
  // Rows stay in each account's own currency; accounts in another currency also get a converted copy.
  const [metrics, converted] = await Promise.all([
    metricsByEntity(metricWhere),
    convertedByEntity(metricWhere, fx, scopedAccounts.filter((id) => fx.converts(id))),
  ]);

  const empty = deriveMetrics(emptyTotals());
  const rows = campaigns.map((c) => {
    const row = toCampaignRow(c, metrics.get(c.id));
    if (fx.converts(c.adAccountId)) row.converted = deriveMetrics(converted.get(c.id) ?? empty);
    return row;
  });
  const inWorkspace = (r: (typeof rows)[number]) => r.converted ?? r.metrics;
  const totals = rows.reduce<MetricTotals>((acc, r) => addTotals(acc, inWorkspace(r)), emptyTotals());

  const body: CampaignListResponse = {
    range: { from: q.from, to: q.to },
    currency: req.workspace!.currency,
    campaigns: rows.sort((a, b) => inWorkspace(b).spend - inWorkspace(a).spend),
    totals: deriveMetrics(roundMoney(totals)),
    fx: fx.info,
  };
  res.json(body);
});

async function findCampaign(req: Request) {
  const accountIds = await workspaceAccountIds(req.workspace!.id);
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.campaignId as string, adAccountId: { in: accountIds } },
    include: { adAccount: { include: { connection: true } } },
  });
  if (!campaign) throw notFound("Campaign");
  return campaign;
}

workspacesRouter.get("/campaigns/:campaignId", async (req, res) => {
  const range = parse(dateRangeQuery, req.query);
  const campaign = await findCampaign(req);
  const date = dateFilter(range);

  const [totals, series, groups, ads, groupMetrics, adMetrics, logs] = await Promise.all([
    sumMetrics({ level: "CAMPAIGN", entityId: campaign.id, date }),
    timeseries({ level: "CAMPAIGN", entityId: campaign.id, date }, range),
    prisma.adGroup.findMany({ where: { campaignId: campaign.id }, include: { _count: { select: { ads: true } } } }),
    prisma.ad.findMany({ where: { campaignId: campaign.id } }),
    metricsByEntity({ level: "AD_GROUP", campaignId: campaign.id, date }),
    metricsByEntity({ level: "AD", campaignId: campaign.id, date }),
    prisma.auditLog.findMany({
      where: { entityId: campaign.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { id: true, name: true } } },
    }),
  ]);

  const empty = deriveMetrics(emptyTotals());
  const bySpend = <T extends { metrics: { spend: number } }>(a: T, b: T) => b.metrics.spend - a.metrics.spend;

  // The campaign is shown in what its account bills in, with the workspace-currency equivalent alongside.
  const row = toCampaignRow(campaign, totals);
  const fx = await fxContext(req.workspace!.currency, [campaign.adAccount], range);
  if (fx.converts(campaign.adAccountId)) {
    const sum = series.reduce<MetricTotals>((acc, p) => addTotals(acc, scaleMoney(p, fx.factor(campaign.adAccount.currency, p.date))), emptyTotals());
    row.converted = deriveMetrics(roundMoney(sum));
  }

  const body: CampaignDetailResponse = {
    fx: fx.info,
    campaign: row,
    timeseries: series,
    adGroups: groups
      .map(
        (g): AdGroupRowDTO => ({
          id: g.id,
          externalId: g.externalId,
          name: g.name,
          status: g.status,
          dailyBudget: g.dailyBudget == null ? null : num(g.dailyBudget),
          adCount: g._count.ads,
          metrics: groupMetrics.get(g.id) ?? empty,
        }),
      )
      .sort(bySpend),
    ads: ads
      .map(
        (a): AdRowDTO => ({
          id: a.id,
          externalId: a.externalId,
          adGroupId: a.adGroupId,
          name: a.name,
          status: a.status,
          headline: a.headline,
          body: a.body,
          finalUrl: a.finalUrl,
          thumbnailUrl: a.thumbnailUrl,
          preview: (a.preview as AdPreviewData | null) ?? null,
          metrics: adMetrics.get(a.id) ?? empty,
        }),
      )
      .sort(bySpend),
    activity: logs.map(toAuditDTO),
  };
  res.json(body);
});

const actorOf = (req: Request): Actor => ({
  orgId: req.org!.id,
  workspaceId: req.workspace!.id,
  userId: req.userId!,
  ip: req.ip,
});

workspacesRouter.patch("/campaigns/:campaignId/status", requirePermission("campaigns:edit"), async (req, res) => {
  const { status } = parse(updateCampaignStatusSchema, req.body);
  const campaign = await findCampaign(req);
  await changeCampaignStatus(campaign, status, actorOf(req));
  res.json({ id: campaign.id, status });
});

workspacesRouter.patch("/campaigns/:campaignId/budget", requirePermission("campaigns:edit"), async (req, res) => {
  const { dailyBudget } = parse(updateCampaignBudgetSchema, req.body);
  const campaign = await findCampaign(req);
  await changeCampaignBudget(campaign, dailyBudget, actorOf(req));
  res.json({ id: campaign.id, dailyBudget });
});

workspacesRouter.post("/campaigns/bulk-status", requirePermission("campaigns:edit"), async (req, res) => {
  const { campaignIds, status } = parse(bulkCampaignActionSchema, req.body);
  const accountIds = await workspaceAccountIds(req.workspace!.id);
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: campaignIds }, adAccountId: { in: accountIds } },
    include: { adAccount: { include: { connection: true } } },
  });

  // Platforms are independent, so one failure should not block the rest.
  const results = await Promise.allSettled(campaigns.map((c) => changeCampaignStatus(c, status, actorOf(req))));
  const failed = results.flatMap((r, i) =>
    r.status === "rejected"
      ? [{ id: campaigns[i]!.id, name: campaigns[i]!.name, error: r.reason instanceof Error ? r.reason.message : "Failed" }]
      : [],
  );
  res.json({ updated: campaigns.length - failed.length, failed });
});

workspacesRouter.get("/ad-accounts", async (req, res) => {
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId: req.workspace!.id },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
    select: { id: true, name: true, externalId: true, platform: true, currency: true, timezone: true, lastSyncedAt: true, connection: { select: { mode: true, status: true } } },
  });
  res.json(accounts.map(({ connection, ...a }) => ({ ...a, sample: connection.mode === "DEMO", connected: connection.status !== "REVOKED" })));
});
