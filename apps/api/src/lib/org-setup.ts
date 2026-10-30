import { freeAiTokens } from "@ashniva/core";
import { prisma, type Prisma } from "@ashniva/db";
import { uniqueSlug } from "./slug";

/** Slug for a new org; its first workspace shares it. */
export const newOrgSlug = (name: string) =>
  uniqueSlug(name, async (slug) => Boolean(await prisma.organization.findUnique({ where: { slug } })));

/** `unpaid` stays read-only until the customer buys a plan. `complimentary` is full access with no invoice. */
export type OrgGrant = "unpaid" | "complimentary";

/**
 * Creates an org owned by `userId`, with a first workspace of the same name.
 * Public sign-up is unpaid. A super admin's own org, and an account an admin
 * marks free, is complimentary.
 */
export async function createOwnedOrg(
  tx: Prisma.TransactionClient,
  userId: string,
  name: string,
  slug: string,
  grant: OrgGrant = "unpaid",
) {
  if (grant === "complimentary") {
    const tokens = freeAiTokens();
    return tx.organization.create({
      data: {
        name,
        slug,
        plan: "AGENCY",
        subscriptionStatus: "ACTIVE",
        trialEndsAt: null,
        aiTokenBalance: tokens,
        aiLedger: { create: { type: "FREE_GRANT", tokens, balanceAfter: tokens, note: "Free AI tokens" } },
        memberships: { create: { userId, role: "OWNER" } },
        workspaces: { create: { name, slug } },
      },
    });
  }
  return tx.organization.create({
    data: {
      name,
      slug,
      plan: "TRIAL",
      subscriptionStatus: "EXPIRED",
      trialEndsAt: null,
      memberships: { create: { userId, role: "OWNER" } },
      workspaces: { create: { name, slug } },
    },
  });
}

/**
 * Called once an operator (SUPER_ADMIN_EMAILS) verifies their email: the org they signed up
 * with was created unpaid, so it gets the complimentary access it would have had. Only orgs
 * they own that are still in the untouched unpaid state, so nothing billed is changed.
 */
export async function grantOperatorOrgs(tx: Prisma.TransactionClient, userId: string) {
  const orgs = await tx.organization.findMany({
    where: {
      plan: "TRIAL",
      subscriptionStatus: "EXPIRED",
      trialEndsAt: null,
      billingSubscriptionId: null,
      memberships: { some: { userId, role: "OWNER" } },
    },
  });
  const tokens = freeAiTokens();
  for (const org of orgs) {
    await tx.organization.update({
      where: { id: org.id },
      data: {
        plan: "AGENCY",
        subscriptionStatus: "ACTIVE",
        aiTokenBalance: { increment: tokens },
        aiLedger: { create: { type: "FREE_GRANT", tokens, balanceAfter: org.aiTokenBalance + tokens, note: "Free AI tokens" } },
      },
    });
  }
  return orgs;
}
