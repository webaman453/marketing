import type { AccountStructure, EntityStatus } from "./types";

export function accountTree(args: {
  campaign: { id: string; name: string; status: EntityStatus; objective: string | null; daily: number | null; lifetime?: number | null; start?: string | null; end?: string | null; raw?: Record<string, unknown> };
  groups: { id: string; name: string; status: EntityStatus; daily?: number | null; bid?: string | null; key?: string }[];
  ads: { id: string; groupId: string; name: string; status: EntityStatus; headline?: string | null; body?: string | null; url?: string | null; key?: string }[];
}): AccountStructure {
  const c = args.campaign;
  return {
    campaigns: [
      {
        externalId: c.id,
        name: c.name,
        status: c.status,
        deliveryStatus: null,
        objective: c.objective,
        dailyBudget: c.daily,
        lifetimeBudget: c.lifetime ?? null,
        startDate: c.start ?? null,
        endDate: c.end ?? null,
        updatedAt: new Date(),
        raw: c.raw ?? {},
      },
    ],
    adGroups: args.groups.map((g) => ({
      externalId: g.id,
      campaignExternalId: c.id,
      name: g.name,
      status: g.status,
      dailyBudget: g.daily ?? null,
      bidStrategy: g.bid ?? null,
      targeting: null,
      raw: {},
      sourceKey: g.key,
    })),
    ads: args.ads.map((a) => ({
      externalId: a.id,
      adGroupExternalId: a.groupId,
      campaignExternalId: c.id,
      name: a.name,
      status: a.status,
      headline: a.headline ?? null,
      body: a.body ?? null,
      thumbnailUrl: null,
      finalUrl: a.url ?? null,
      raw: {},
      sourceKey: a.key,
    })),
  };
}

/**
 * Sync safety net: whether campaigns missing from a structure sync may be marked
 * removed. An empty list for an account with campaigns on record is far more
 * likely an API hiccup than everything being deleted, so that run removes nothing.
 */
export function removalAllowed(returned: number, onRecord: number) {
  return returned > 0 || onRecord === 0;
}
