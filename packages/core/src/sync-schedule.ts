import { prisma } from "@ashniva/db";
import { isOrgLocked } from "./entitlements";

/**
 * Connections worth syncing more often than the all-accounts schedule: live logins with an ad account
 * in a workspace that has at least one running campaign, in an organization on an active plan. Those
 * are the ones whose numbers rules, spend budgets and anomaly alerts act on.
 * Connections synced less than `minAgeMinutes` ago are skipped, so overlapping schedules don't double up.
 */
export async function activeSyncConnectionIds(now = new Date(), minAgeMinutes = 20): Promise<string[]> {
  const cutoff = new Date(now.getTime() - minAgeMinutes * 60_000);
  const connections = await prisma.platformConnection.findMany({
    where: {
      status: "ACTIVE",
      mode: "LIVE",
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }],
      adAccounts: { some: { workspaceId: { not: null }, workspace: { archivedAt: null }, campaigns: { some: { status: "ACTIVE" } } } },
    },
    select: { id: true, org: { select: { plan: true, trialEndsAt: true, subscriptionStatus: true, currentPeriodEnd: true } } },
  });
  return connections.filter((c) => !isOrgLocked(c.org, now)).map((c) => c.id);
}
