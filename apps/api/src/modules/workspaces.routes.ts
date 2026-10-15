import { changeCampaignBudget, changeCampaignStatus, type Actor } from "@ashniva/core";
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
import { toAuditDTO } from "../lib/serialize";
import { loadWorkspace, requireActivePlanForWrites, requirePermission } from "../middleware/auth";
import {
  SUM_FIELDS,
  dateFilter,
  metricsByEntity,
  sumMetrics,
  timeseries,
  toCampaignRow,
  toTotals,
  workspaceAccountIds,
} from "./analytics.service";

export const workspacesRouter = Router({ mergeParams: true });
workspacesRouter.use(loadWorkspace, requireActivePlanForWrites);
workspacesRouter.use(creativesRouter, adMediaRouter, leadsRouter, builderRouter, reportsRouter, rulesRouter, aiRouter);

const campaignInclude = { adAccount: { select: { id: true, name: true, currency: true } } } as const;

// ───────── Overview dashboard ─────────

workspacesRouter.get("/overview", async (req, res) => {
  const range = parse(dateRangeQuery, req.query);
  const compareRange = previousPeriod(range.from, range.to);
  const accountIds = await workspaceAccountIds(req.workspace!.id);

  const base = { adAccountId: { in: accountIds }, level: "CAMPAIGN" as const };
  const current = { ...base, date: dateFilter(range) };

  const [totals, previous, series, platformRows, campaignMetrics, connections] = await Promise.all([
    sumMetrics(current),
    sumMetrics({ ...base, date: dateFilter(compareRange) }),
    timeseries(current, range),
    prisma.metricDaily.groupBy({ by: ["platform"], where: current, _sum: SUM_FIELDS }),
    prisma.metricDaily.groupBy({
      by: ["entityId"],
      where: current,
      _sum: SUM_FIELDS,
      orderBy: { _sum: { spend: "desc" } },
      take: 6,
    }),
    prisma.platformConnection.findMany({
      where: { adAccounts: { some: { id: { in: accountIds } } } },
      select: { status: true, syncStatus: true, lastSyncedAt: true },
    }),
  ]);

  const byPlatform: PlatformBreakdown[] = platformRows
    .map((r) => ({ platform: r.platform, metrics: deriveMetrics(toTotals(r._sum)) }))
    .sort((a, b) => b.metrics.spend - a.metrics.spend);

  const top = await prisma.campaign.findMany({
    where: { id: { in: campaignMetrics.map((m) => m.entityId) } },
    include: campaignInclude,
  });
  const topMetrics = new Map(campaignMetrics.map((m) => [m.entityId, deriveMetrics(toTotals(m._sum))]));
  const topCampaigns = campaignMetrics
    .map((m) => top.find((c) => c.id === m.entityId))
    .filter((c) => c !== undefined)
    .map((c) => toCampaignRow(c, topMetrics.get(c.id)));

  const lastSyncedAt = connections
    .map((c) => c.lastSyncedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const body: OverviewResponse = {
    range,
    compareRange,
    currency: req.workspace!.currency,
    totals,
    previous,
    timeseries: series,
    byPlatform,
    topCampaigns,
    accounts: {
      total: accountIds.length,
      connections: connections.length,
      failing: connections.filter((c) => c.status !== "ACTIVE" || c.syncStatus === "FAILED").length,
    },
    lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
  };
  res.json(body);
});

// ───────── Campaigns ─────────

workspacesRouter.get("/campaigns", async (req, res) => {
  const q = parse(campaignListQuery, req.query);
  const accountIds = await workspaceAccountIds(req.workspace!.id);
  const scopedAccounts = q.adAccountId ? accountIds.filter((id) => id === q.adAccountId) : accountIds;

  const where: Prisma.CampaignWhereInput = {
    adAccountId: { in: scopedAccounts },
    status: q.status ?? { not: "REMOVED" },
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}),
  };
  const campaigns = await prisma.campaign.findMany({ where, include: campaignInclude, orderBy: { name: "asc" } });
  const metrics = await metricsByEntity({
    level: "CAMPAIGN",
    adAccountId: { in: scopedAccounts },
    entityId: { in: campaigns.map((c) => c.id) },
    date: dateFilter(q),
  });

  const rows = campaigns.map((c) => toCampaignRow(c, metrics.get(c.id)));
  const totals = rows.reduce(
    (acc, r) => ({
      impressions: acc.impressions + r.metrics.impressions,
      clicks: acc.clicks + r.metrics.clicks,
      spend: acc.spend + r.metrics.spend,
      conversions: acc.conversions + r.metrics.conversions,
      conversionValue: acc.conversionValue + r.metrics.conversionValue,
      videoViews: acc.videoViews + r.metrics.videoViews,
    }),
    emptyTotals(),
  );

  const body: CampaignListResponse = {
    range: { from: q.from, to: q.to },
    currency: req.workspace!.currency,
    campaigns: rows.sort((a, b) => b.metrics.spend - a.metrics.spend),
    totals: deriveMetrics(totals),
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

  const body: CampaignDetailResponse = {
    campaign: toCampaignRow(campaign, totals),
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
    select: { id: true, name: true, externalId: true, platform: true, currency: true, lastSyncedAt: true, connection: { select: { mode: true, status: true } } },
  });
  res.json(accounts.map(({ connection, ...a }) => ({ ...a, sample: connection.mode === "DEMO", connected: connection.status !== "REVOKED" })));
});
