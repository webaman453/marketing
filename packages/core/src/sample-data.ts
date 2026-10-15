import { DEMO_PLATFORMS } from "@ashniva/connectors";
import { prisma } from "@ashniva/db";
import { refreshAdAccounts } from "./sync";

/**
 * Creates sample connections (Meta, Google, TikTok, LinkedIn) for an org and
 * assigns their ad accounts to the given workspace. Returns connection ids so
 * the caller can sync them.
 */
export async function createSampleConnections(orgId: string, workspaceId: string, userId: string | null) {
  const ids: string[] = [];
  for (const platform of DEMO_PLATFORMS) {
    const connection = await prisma.platformConnection.upsert({
      where: { orgId_platform_externalUserId: { orgId, platform, externalUserId: `sample-${platform.toLowerCase()}` } },
      create: {
        orgId,
        platform,
        mode: "DEMO",
        externalUserId: `sample-${platform.toLowerCase()}`,
        externalUserName: "Sample data",
        scopes: [],
        createdById: userId,
      },
      update: { status: "ACTIVE" },
    });
    await refreshAdAccounts(connection, "sample", workspaceId);
    // Re-attach accounts in case they were moved or unassigned earlier.
    await prisma.adAccount.updateMany({ where: { connectionId: connection.id, workspaceId: null }, data: { workspaceId } });
    ids.push(connection.id);
  }
  return ids;
}

/** Removes every sample connection (and, by cascade, its accounts, campaigns and metrics). */
export async function removeSampleConnections(orgId: string) {
  const { count } = await prisma.platformConnection.deleteMany({ where: { orgId, mode: "DEMO" } });
  return count;
}
