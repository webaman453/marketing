/**
 * Pulls form leads from a platform and stores them. Lead access is a separate
 * permission, so a failure here never fails the rest of a sync.
 */
import type { ExternalLead } from "@ashniva/connectors";
import { prisma, type PlatformConnection, type Prisma } from "@ashniva/db";
import { connectors } from "./connectors";

const OVERLAP_MS = 24 * 3600_000;

const first = (fields: Record<string, string[]>, keys: string[]) => {
  for (const k of keys) {
    const v = fields[k]?.[0]?.trim();
    if (v) return v;
  }
  return null;
};

/** Pulls name, email and phone out of the form's answers, whatever the questions were called. */
export function contactOf(fields: Record<string, string[]>) {
  const full = first(fields, ["full_name", "name"]);
  const joined = [first(fields, ["first_name"]), first(fields, ["last_name"])].filter(Boolean).join(" ");
  return {
    name: full ?? (joined || null),
    email: first(fields, ["email", "work_email"]),
    phone: first(fields, ["phone_number", "phone", "work_phone_number"]),
  };
}

export async function syncLeads(connection: PlatformConnection, token: string): Promise<number> {
  const connector = connectors().get(connection.platform, connection.mode);
  if (!connector.fetchLeads) return 0;

  const accounts = await prisma.adAccount.findMany({
    where: { connectionId: connection.id, workspaceId: { not: null } },
    select: { id: true, workspaceId: true },
  });
  if (accounts.length === 0) return 0;

  const latest = await prisma.lead.findFirst({
    where: { connectionId: connection.id },
    orderBy: { createdTime: "desc" },
    select: { createdTime: true },
  });
  const since = latest ? new Date(latest.createdTime.getTime() - OVERLAP_MS) : null;
  const leads = await connector.fetchLeads({ accessToken: token }, { since });
  if (leads.length === 0) return 0;

  const accountIds = accounts.map((a) => a.id);
  const [ads, adGroups, campaigns] = await Promise.all([
    prisma.ad.findMany({ where: { adAccountId: { in: accountIds } }, select: { id: true, externalId: true, adGroupId: true, campaignId: true, adAccountId: true } }),
    prisma.adGroup.findMany({ where: { adAccountId: { in: accountIds } }, select: { id: true, externalId: true } }),
    prisma.campaign.findMany({ where: { adAccountId: { in: accountIds } }, select: { id: true, externalId: true, adAccountId: true } }),
  ]);
  const adBy = new Map(ads.map((a) => [a.externalId, a]));
  const groupBy = new Map(adGroups.map((g) => [g.externalId, g.id]));
  const campaignBy = new Map(campaigns.map((c) => [c.externalId, c]));
  const workspaceOf = new Map(accounts.map((a) => [a.id, a.workspaceId!]));
  const fallbackWorkspace = accounts[0]!.workspaceId!;

  const rows = leads.map((l: ExternalLead): Prisma.LeadCreateManyInput => {
    const ad = l.externalAdId ? adBy.get(l.externalAdId) : undefined;
    const campaign = l.externalCampaignId ? campaignBy.get(l.externalCampaignId) : undefined;
    const accountId = ad?.adAccountId ?? campaign?.adAccountId;
    return {
      orgId: connection.orgId,
      workspaceId: (accountId && workspaceOf.get(accountId)) || fallbackWorkspace,
      connectionId: connection.id,
      platform: connection.platform,
      externalId: l.externalId,
      source: l.source,
      isOrganic: l.isOrganic,
      formId: l.formId,
      formName: l.formName,
      pageId: l.pageId,
      campaignId: ad?.campaignId ?? campaign?.id ?? null,
      adGroupId: ad?.adGroupId ?? (l.externalAdGroupId ? groupBy.get(l.externalAdGroupId) : undefined) ?? null,
      adId: ad?.id ?? null,
      externalAdId: l.externalAdId,
      campaignName: l.campaignName,
      adGroupName: l.adGroupName,
      adName: l.adName,
      ...contactOf(l.fields),
      fields: l.fields as Prisma.InputJsonValue,
      createdTime: l.createdTime,
    };
  });

  // New leads only; a lead's answers never change after submission.
  const res = await prisma.lead.createMany({ data: rows, skipDuplicates: true });
  return res.count;
}
