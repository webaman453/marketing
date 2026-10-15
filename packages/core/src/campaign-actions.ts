/**
 * Campaign changes shared by the API (people) and the worker (automation
 * rules): apply on the ad platform first, then mirror locally and audit.
 */
import { num, prisma, type Prisma } from "@ashniva/db";
import { PLATFORM_INFO } from "@ashniva/shared";
import { audit } from "./audit";
import { connectors } from "./connectors";
import { getAccessToken } from "./tokens";

export const campaignWithConnection = {
  adAccount: { include: { connection: true } },
} satisfies Prisma.CampaignInclude;

export type CampaignWithConnection = Prisma.CampaignGetPayload<{ include: typeof campaignWithConnection }>;

export interface Actor {
  orgId: string;
  workspaceId: string | null;
  userId: string | null;
  ip?: string | null;
  /** Shown in the activity log for automated changes, e.g. "Rule: Pause poor ROAS" */
  via?: string;
}

async function connectorFor(campaign: CampaignWithConnection) {
  const { connection } = campaign.adAccount;
  return {
    connector: connectors().get(campaign.platform, connection.mode),
    auth: { accessToken: await getAccessToken(connection) },
    account: {
      externalId: campaign.adAccount.externalId,
      currency: campaign.adAccount.currency,
      meta: campaign.adAccount.meta as Record<string, unknown> | null,
    },
    ref: { externalId: campaign.externalId, raw: campaign.raw as Record<string, unknown> | null },
  };
}

const label = (c: CampaignWithConnection) => `${c.name} (${PLATFORM_INFO[c.platform].name})`;

export async function changeCampaignStatus(campaign: CampaignWithConnection, status: "ACTIVE" | "PAUSED", actor: Actor) {
  if (campaign.status === status) return false;
  const { connector, auth, account, ref } = await connectorFor(campaign);
  await connector.setCampaignStatus(auth, account, ref, status);
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status } });
  await audit({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    action: status === "PAUSED" ? "campaign.paused" : "campaign.activated",
    entityType: "campaign",
    entityId: campaign.id,
    entityName: label(campaign),
    changes: { status: { from: campaign.status, to: status }, ...(actor.via ? { via: { from: null, to: actor.via } } : {}) },
    ip: actor.ip,
  });
  return true;
}

export async function changeCampaignBudget(campaign: CampaignWithConnection, dailyBudget: number, actor: Actor) {
  const { connector, auth, account, ref } = await connectorFor(campaign);
  await connector.setCampaignDailyBudget(auth, account, ref, dailyBudget);
  const previous = campaign.dailyBudget == null ? null : num(campaign.dailyBudget);
  // Keep Meta's raw daily_budget in step so later edits pass its budget-level check.
  const raw = { ...((campaign.raw as Record<string, unknown> | null) ?? {}) };
  if ("daily_budget" in raw) raw.daily_budget = String(dailyBudget);
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { dailyBudget, raw: raw as Prisma.InputJsonValue },
  });
  await audit({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    action: "campaign.budget_changed",
    entityType: "campaign",
    entityId: campaign.id,
    entityName: label(campaign),
    changes: { dailyBudget: { from: previous, to: dailyBudget }, ...(actor.via ? { via: { from: null, to: actor.via } } : {}) },
    ip: actor.ip,
  });
}
