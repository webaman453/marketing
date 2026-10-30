/**
 * Pulls ad accounts, campaign structure and daily metrics from an ad platform
 * into PostgreSQL. Runs inside the worker; the API only enqueues jobs.
 */
import {
  isConnectorError,
  removalAllowed,
  type AccountStructure,
  type ConnectorAuth,
  type ExternalMetricRow,
} from "@ashniva/connectors";
import { prisma, Prisma, type AdAccount, type PlatformConnection } from "@ashniva/db";
import { PLATFORM_INFO, addDays, toISODate } from "@ashniva/shared";
import { syncLeads } from "./leads";
import { refreshConnectionBilling } from "./spend";
import { connectionAlertTarget, notify } from "./notifications";
import { connectors } from "./connectors";
import type { SyncTrigger } from "./queue";
import { getConnectorAuth } from "./tokens";

/** Platforms restate recent days as attribution settles, so re-fetch this many days every sync. */
const RESTATEMENT_DAYS = 7;
const BATCH = 2000;

export interface SyncStats {
  accounts: number;
  campaigns: number;
  adGroups: number;
  ads: number;
  metricRows: number;
  leads?: number;
  /** Why leads could not be read, when everything else synced fine. */
  leadsError?: string;
  /** Non-fatal problems, e.g. a removal pass skipped by the safety net. */
  warnings?: string[];
}

export async function syncConnection(connectionId: string, trigger: SyncTrigger): Promise<SyncStats> {
  const connection = await prisma.platformConnection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new Error(`Connection ${connectionId} not found`);
  if (connection.status === "REVOKED") return emptyStats();

  const run = await prisma.syncRun.create({ data: { connectionId, trigger, status: "RUNNING" } });
  await prisma.platformConnection.update({ where: { id: connectionId }, data: { syncStatus: "RUNNING" } });

  const stats = emptyStats();
  try {
    const auth = await getConnectorAuth(connection);
    await refreshAdAccounts(connection, auth);

    // Only accounts assigned to a workspace are synced, which keeps API quota for what people use.
    const accounts = await prisma.adAccount.findMany({
      where: { connectionId, workspaceId: { not: null } },
    });
    for (const account of accounts) {
      const s = await syncAdAccount(connection, account, auth);
      stats.accounts++;
      stats.campaigns += s.campaigns;
      stats.adGroups += s.adGroups;
      stats.ads += s.ads;
      stats.metricRows += s.metricRows;
      if (s.warning) (stats.warnings ??= []).push(s.warning);
    }

    try {
      stats.leads = await syncLeads(connection, auth);
    } catch (err) {
      stats.leadsError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    }

    // Spend cap, balance and payment state, for platforms that report them. Never fails the sync.
    await refreshConnectionBilling(connection, auth).catch((err: unknown) => {
      (stats.warnings ??= []).push(`Billing: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    });

    const now = new Date();
    await prisma.$transaction([
      prisma.platformConnection.update({
        where: { id: connectionId },
        data: { syncStatus: "SUCCESS", lastSyncedAt: now, lastSyncError: null, status: "ACTIVE" },
      }),
      prisma.syncRun.update({
        where: { id: run.id },
        data: { status: "SUCCESS", finishedAt: now, stats: stats as unknown as Prisma.InputJsonValue },
      }),
    ]);
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const expired = isConnectorError(err) && err.code === "AUTH_EXPIRED";
    if (expired && connection.status === "ACTIVE") {
      // Tell admins once, when access first lapses.
      await connectionAlertTarget(connection)
        .then((target) =>
          notify({
            orgId: connection.orgId,
            ...target,
            type: "integration.expired",
            title: `${PLATFORM_INFO[connection.platform].name} access expired`,
            body: `${connection.externalUserName ?? "A connected login"} needs to be reconnected. Data from its ad accounts has stopped syncing.`,
            ctaLabel: "Reconnect",
            roles: ["OWNER", "ADMIN"],
            email: true,
            emailPref: "syncFailures",
          }),
        )
        .catch(() => undefined);
    } else if (!expired && !connection.lastSyncError && connection.mode === "LIVE") {
      // First failure since the last good sync; retries and later failures stay quiet.
      await connectionAlertTarget(connection)
        .then((target) =>
          notify({
            orgId: connection.orgId,
            ...target,
            type: "integration.sync_failed",
            title: `${PLATFORM_INFO[connection.platform].name} sync failed`,
            body: `${connection.externalUserName ?? "A connected login"} couldn't sync: ${message.slice(0, 300)}`,
            ctaLabel: "View integrations",
            roles: ["OWNER", "ADMIN"],
            email: true,
            emailPref: "syncFailures",
          }),
        )
        .catch(() => undefined);
    }
    await prisma.$transaction([
      prisma.platformConnection.update({
        where: { id: connectionId },
        data: {
          syncStatus: "FAILED",
          lastSyncError: message.slice(0, 500),
          ...(expired ? { status: "EXPIRED" as const } : {}),
        },
      }),
      prisma.syncRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), error: message.slice(0, 2000) },
      }),
    ]);
    throw err;
  }
}

const emptyStats = (): SyncStats => ({ accounts: 0, campaigns: 0, adGroups: 0, ads: 0, metricRows: 0 });

/** Upserts the ad accounts visible to this login. New accounts arrive unassigned. */
export async function refreshAdAccounts(connection: PlatformConnection, auth: ConnectorAuth, assignToWorkspaceId?: string) {
  const connector = connectors().get(connection.platform, connection.mode);
  const external = await connector.listAdAccounts(auth);
  for (const a of external) {
    await prisma.adAccount.upsert({
      where: {
        orgId_platform_externalId: { orgId: connection.orgId, platform: connection.platform, externalId: a.externalId },
      },
      create: {
        orgId: connection.orgId,
        connectionId: connection.id,
        workspaceId: assignToWorkspaceId ?? null,
        platform: connection.platform,
        externalId: a.externalId,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        status: a.status,
        meta: (a.meta ?? {}) as Prisma.InputJsonValue,
      },
      update: {
        connectionId: connection.id,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        status: a.status,
        meta: (a.meta ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
  return external.length;
}

async function syncAdAccount(connection: PlatformConnection, account: AdAccount, auth: ConnectorAuth) {
  const connector = connectors().get(connection.platform, connection.mode);
  const ref = { externalId: account.externalId, currency: account.currency, timezone: account.timezone, meta: account.meta as Record<string, unknown> | null };

  const structure = await connector.fetchStructure(auth, ref);
  const isDemo = connection.mode === "DEMO";
  const ids = await upsertStructure(account, structure, isDemo);
  // Sample accounts also hold campaigns made in the builder, which the generator doesn't know about.
  const warning = isDemo ? null : await markRemovedCampaigns(account, [...ids.campaigns.keys()]);

  const today = toISODate(new Date());
  const initialDays = Number(process.env.INITIAL_SYNC_DAYS ?? 90);
  const from = account.lastSyncedAt ? addDays(today, -RESTATEMENT_DAYS) : addDays(today, -initialDays + 1);
  const rows = await connector.fetchMetrics(auth, ref, { from, to: today });
  const metricRows = await upsertMetrics(account, rows, ids);

  await prisma.adAccount.update({ where: { id: account.id }, data: { lastSyncedAt: new Date() } });
  return {
    campaigns: structure.campaigns.length,
    adGroups: structure.adGroups.length,
    ads: structure.ads.length,
    metricRows,
    warning,
  };
}

/**
 * Campaigns that no longer come back from the platform were deleted there.
 * Only called with a full structure sync, never with a partial one (e.g. a
 * campaign just made in the builder). Safety net: an empty list for an account
 * that still has campaigns is far more likely a platform/API hiccup than every
 * campaign being deleted, so nothing is removed in that run.
 */
async function markRemovedCampaigns(account: AdAccount, seen: string[]): Promise<string | null> {
  const onRecord = seen.length ? 0 : await prisma.campaign.count({ where: { adAccountId: account.id, status: { not: "REMOVED" } } });
  if (!removalAllowed(seen.length, onRecord)) {
    const warning = `${account.name}: the platform returned no campaigns while ${onRecord} are on record; none were marked removed.`;
    console.warn(`[sync] ${warning} (adAccount ${account.id})`);
    return warning;
  }
  if (seen.length === 0) return null;
  await prisma.campaign.updateMany({
    where: { adAccountId: account.id, externalId: { notIn: seen }, status: { not: "REMOVED" } },
    data: { status: "REMOVED" },
  });
  return null;
}

interface IdMaps {
  campaigns: Map<string, string>;
  adGroups: Map<string, { id: string; campaignId: string }>;
  ads: Map<string, { id: string; campaignId: string }>;
}

const json = (v: unknown) => (v ?? Prisma.JsonNull) as Prisma.InputJsonValue;
const date = (v: string | null) => (v ? new Date(`${v}T00:00:00Z`) : null);

/**
 * Upserts campaigns → ad groups → ads and returns external→internal id maps.
 * For sample data, status and budget edits made in the app are preserved.
 * Never removes anything: `s` may be partial (the builder passes just the new
 * campaign); a full sync marks missing campaigns via markRemovedCampaigns.
 */
export async function upsertStructure(account: AdAccount, s: AccountStructure, keepLocalEdits: boolean): Promise<IdMaps> {
  const campaigns = new Map<string, string>();
  for (const chunk of chunks(s.campaigns, 100)) {
    const saved = await prisma.$transaction(
      chunk.map((c) => {
        const base = {
          name: c.name,
          deliveryStatus: c.deliveryStatus,
          objective: c.objective,
          lifetimeBudget: c.lifetimeBudget,
          startDate: date(c.startDate),
          endDate: date(c.endDate),
          raw: json(c.raw),
          platformUpdatedAt: c.updatedAt,
        };
        return prisma.campaign.upsert({
          where: { adAccountId_externalId: { adAccountId: account.id, externalId: c.externalId } },
          create: { ...base, adAccountId: account.id, platform: account.platform, externalId: c.externalId, status: c.status, dailyBudget: c.dailyBudget },
          update: keepLocalEdits ? base : { ...base, status: c.status, dailyBudget: c.dailyBudget },
          select: { id: true, externalId: true },
        });
      }),
    );
    for (const c of saved) campaigns.set(c.externalId, c.id);
  }

  const adGroups = new Map<string, { id: string; campaignId: string }>();
  const groupList = s.adGroups.filter((g) => campaigns.has(g.campaignExternalId));
  for (const chunk of chunks(groupList, 100)) {
    const saved = await prisma.$transaction(
      chunk.map((g) => {
        const campaignId = campaigns.get(g.campaignExternalId)!;
        const base = { campaignId, name: g.name, bidStrategy: g.bidStrategy, targeting: json(g.targeting), raw: json(g.raw) };
        return prisma.adGroup.upsert({
          where: { adAccountId_externalId: { adAccountId: account.id, externalId: g.externalId } },
          create: { ...base, adAccountId: account.id, externalId: g.externalId, status: g.status, dailyBudget: g.dailyBudget },
          update: keepLocalEdits ? base : { ...base, status: g.status, dailyBudget: g.dailyBudget },
          select: { id: true, externalId: true, campaignId: true },
        });
      }),
    );
    for (const g of saved) adGroups.set(g.externalId, { id: g.id, campaignId: g.campaignId });
  }

  const ads = new Map<string, { id: string; campaignId: string }>();
  const adList = s.ads.filter((a) => adGroups.has(a.adGroupExternalId));
  for (const chunk of chunks(adList, 100)) {
    const saved = await prisma.$transaction(
      chunk.map((a) => {
        const group = adGroups.get(a.adGroupExternalId)!;
        const base = {
          adGroupId: group.id,
          campaignId: group.campaignId,
          name: a.name,
          headline: a.headline,
          body: a.body,
          thumbnailUrl: a.thumbnailUrl,
          finalUrl: a.finalUrl,
          raw: json(a.raw),
        };
        return prisma.ad.upsert({
          where: { adAccountId_externalId: { adAccountId: account.id, externalId: a.externalId } },
          create: { ...base, adAccountId: account.id, externalId: a.externalId, status: a.status },
          update: keepLocalEdits ? base : { ...base, status: a.status },
          select: { id: true, externalId: true, campaignId: true },
        });
      }),
    );
    for (const a of saved) ads.set(a.externalId, { id: a.id, campaignId: a.campaignId });
  }

  return { campaigns, adGroups, ads };
}

/** Bulk upsert of daily metrics with INSERT … ON CONFLICT, in batches. */
async function upsertMetrics(account: AdAccount, rows: ExternalMetricRow[], ids: IdMaps): Promise<number> {
  const resolved = rows.flatMap((r) => {
    let entityId: string | undefined;
    let campaignId: string | undefined;
    if (r.level === "CAMPAIGN") entityId = campaignId = ids.campaigns.get(r.externalId);
    else {
      const hit = (r.level === "AD_GROUP" ? ids.adGroups : ids.ads).get(r.externalId);
      entityId = hit?.id;
      campaignId = hit?.campaignId;
    }
    // Skip rows for entities we do not track (e.g. deleted long ago).
    return entityId && campaignId ? [{ ...r, entityId, campaignId }] : [];
  });

  for (const chunk of chunks(resolved, BATCH)) {
    await prisma.$executeRaw`
      INSERT INTO metrics_daily
        (date, level, "entityId", "adAccountId", "campaignId", platform,
         impressions, clicks, spend, conversions, "conversionValue", "videoViews", "updatedAt")
      SELECT d, l::"MetricLevel", e, ${account.id}, c, ${account.platform}::"Platform",
             i, cl, s, cv, val, vv, NOW()
      FROM unnest(
        ${chunk.map((r) => r.date)}::date[],
        ${chunk.map((r) => r.level)}::text[],
        ${chunk.map((r) => r.entityId)}::text[],
        ${chunk.map((r) => r.campaignId)}::text[],
        ${chunk.map((r) => Math.round(r.impressions))}::int[],
        ${chunk.map((r) => Math.round(r.clicks))}::int[],
        ${chunk.map((r) => r.spend)}::numeric[],
        ${chunk.map((r) => r.conversions)}::numeric[],
        ${chunk.map((r) => r.conversionValue)}::numeric[],
        ${chunk.map((r) => Math.round(r.videoViews))}::int[]
      ) AS t(d, l, e, c, i, cl, s, cv, val, vv)
      ON CONFLICT (level, "entityId", date) DO UPDATE SET
        impressions = EXCLUDED.impressions,
        clicks = EXCLUDED.clicks,
        spend = EXCLUDED.spend,
        conversions = EXCLUDED.conversions,
        "conversionValue" = EXCLUDED."conversionValue",
        "videoViews" = EXCLUDED."videoViews",
        "campaignId" = EXCLUDED."campaignId",
        "updatedAt" = NOW()`;
  }
  return resolved.length;
}

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
