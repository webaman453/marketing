/**
 * Creative files for one ad: fetched fresh from the platform (media URLs
 * expire), with the synced thumbnail as the fallback for platforms or sample
 * data that cannot provide files.
 */
import { prisma, type Prisma } from "@ashniva/db";
import type { AdMedia } from "@ashniva/connectors";
import { connectors } from "./connectors";
import { getAccessToken } from "./tokens";

export const adWithConnection = {
  adAccount: { include: { connection: true } },
} satisfies Prisma.AdInclude;

export type AdWithConnection = Prisma.AdGetPayload<{ include: typeof adWithConnection }>;

function syncedFallback(ad: AdWithConnection): AdMedia {
  return {
    format: ad.thumbnailUrl ? "IMAGE" : "UNKNOWN",
    headline: ad.headline,
    body: ad.body,
    callToAction: null,
    link: ad.finalUrl,
    items: ad.thumbnailUrl
      ? [{ type: "IMAGE", url: ad.thumbnailUrl, posterUrl: ad.thumbnailUrl, title: ad.headline, description: null, link: ad.finalUrl, durationSec: null, permalink: null }]
      : [],
  };
}

export async function getAdMedia(ad: AdWithConnection): Promise<AdMedia & { live: boolean }> {
  const { connection } = ad.adAccount;
  const connector = connectors().get(ad.adAccount.platform, connection.mode);
  if (!connector.fetchAdMedia) return { ...syncedFallback(ad), live: false };
  try {
    const media = await connector.fetchAdMedia(
      { accessToken: await getAccessToken(connection) },
      { externalId: ad.adAccount.externalId, currency: ad.adAccount.currency, meta: ad.adAccount.meta as Record<string, unknown> | null },
      { externalId: ad.externalId },
    );
    // A creative we could not read still has its synced thumbnail.
    if (media.items.length === 0) return { ...syncedFallback(ad), live: false };
    return { ...media, live: true };
  } catch {
    return { ...syncedFallback(ad), live: false };
  }
}
