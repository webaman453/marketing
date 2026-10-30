import { DEMO_PLATFORMS } from "@ashniva/connectors";
import { isPlatformShown } from "@ashniva/shared";
import { prisma } from "@ashniva/db";
import { refreshAdAccounts } from "./sync";

/**
 * Creates a sample connection for every shown demo platform and assigns its ad
 * account to the given workspace. Returns connection ids so the caller can sync
 * them; syncConnection then pulls campaigns, metrics and (for the sample lead-gen
 * campaigns on Meta and LinkedIn) form leads.
 */
export async function createSampleConnections(orgId: string, workspaceId: string, userId: string | null) {
  const ids: string[] = [];
  // Hidden platforms aren't seeded: their numbers would show in totals but not in lists.
  for (const platform of DEMO_PLATFORMS.filter(isPlatformShown)) {
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
    await refreshAdAccounts(connection, { accessToken: "sample" }, workspaceId);
    // Re-attach accounts in case they were moved or unassigned earlier.
    await prisma.adAccount.updateMany({ where: { connectionId: connection.id, workspaceId: null }, data: { workspaceId } });
    ids.push(connection.id);
  }
  return ids;
}

/** Removes every sample connection (and, by cascade, its accounts, campaigns, metrics and leads). */
export async function removeSampleConnections(orgId: string) {
  const { count } = await prisma.platformConnection.deleteMany({ where: { orgId, mode: "DEMO" } });
  return count;
}
