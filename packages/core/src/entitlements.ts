import { prisma, type Organization } from "@ashniva/db";
import { PLANS, minimumPlanFor, planHasFeature, type Feature, type PlanId } from "@ashniva/shared";

export class EntitlementError extends Error {
  constructor(
    public readonly code: "PLAN_LIMIT" | "FEATURE_LOCKED" | "ORG_LOCKED" | "AI_TOKENS_EXHAUSTED",
    message: string,
  ) {
    super(message);
    this.name = "EntitlementError";
  }
}

type OrgBilling = Pick<Organization, "plan" | "trialEndsAt" | "subscriptionStatus" | "currentPeriodEnd">;

/**
 * An org is locked (read-only) when its trial has ended without a paid plan,
 * or a paid subscription was cancelled/expired and its period is over.
 */
export function isOrgLocked(org: OrgBilling, now = new Date()): boolean {
  // A trial with no end date was never granted: the organization must choose a plan.
  if (org.plan === "TRIAL") return !org.trialEndsAt || org.trialEndsAt < now;
  if (org.subscriptionStatus === "ACTIVE" || org.subscriptionStatus === "PAST_DUE") return false;
  if (org.subscriptionStatus === "CANCELLED" && org.currentPeriodEnd && org.currentPeriodEnd > now) return false;
  return org.subscriptionStatus === "CANCELLED" || org.subscriptionStatus === "EXPIRED";
}

export function assertNotLocked(org: OrgBilling) {
  if (isOrgLocked(org)) {
    throw new EntitlementError(
      "ORG_LOCKED",
      org.plan === "TRIAL"
        ? org.trialEndsAt
          ? "Your free trial has ended. Choose a plan to keep making changes."
          : "Choose a plan to start using this workspace."
        : "Your subscription is inactive. Update billing to keep making changes.",
    );
  }
}

export function assertFeature(org: OrgBilling, feature: Feature) {
  assertNotLocked(org);
  if (!planHasFeature(org.plan as PlanId, feature)) {
    const plan = PLANS[minimumPlanFor(feature)];
    throw new EntitlementError("FEATURE_LOCKED", `This feature is available on the ${plan.name} plan and above.`);
  }
}

export async function orgUsage(orgId: string) {
  const [workspaces, adAccounts, members, invites] = await Promise.all([
    prisma.workspace.count({ where: { orgId, archivedAt: null } }),
    prisma.adAccount.count({ where: { orgId, workspaceId: { not: null }, connection: { mode: "LIVE" } } }),
    prisma.membership.count({ where: { orgId } }),
    prisma.invitation.count({ where: { orgId, acceptedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  return { workspaces, adAccounts, members: members + invites };
}

/** Throws when adding one more of `resource` would exceed the plan. Sample-data accounts don't count. */
export async function assertWithinLimit(org: OrgBilling & { id: string }, resource: "workspaces" | "adAccounts" | "members") {
  assertNotLocked(org);
  const limit = PLANS[org.plan as PlanId].limits[resource];
  if (!Number.isFinite(limit)) return;
  const usage = await orgUsage(org.id);
  if (usage[resource] >= limit) {
    const label = { workspaces: "workspaces", adAccounts: "connected ad accounts", members: "team members" }[resource];
    throw new EntitlementError(
      "PLAN_LIMIT",
      `Your ${PLANS[org.plan as PlanId].name} plan includes up to ${limit} ${label}. Upgrade to add more.`,
    );
  }
}
