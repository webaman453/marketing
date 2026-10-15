import { freeAiTokens } from "@ashniva/core";
import { prisma, type Prisma } from "@ashniva/db";
import { PRICING } from "@ashniva/shared";
import { uniqueSlug } from "./slug";

/** Slug for a new org; its first workspace shares it. */
export const newOrgSlug = (name: string) =>
  uniqueSlug(name, async (slug) => Boolean(await prisma.organization.findUnique({ where: { slug } })));

/**
 * Creates an org owned by `userId`, with a first workspace of the same name.
 * The free trial and free AI tokens come once per user: the first org gets
 * them and marks the user, later ones start with the trial already ended.
 */
export async function createOwnedOrg(tx: Prisma.TransactionClient, userId: string, name: string, slug: string) {
  const claimed = await tx.user.updateMany({ where: { id: userId, trialUsedAt: null }, data: { trialUsedAt: new Date() } });
  const trial = claimed.count === 1;
  return tx.organization.create({
    data: {
      name,
      slug,
      trialEndsAt: trial ? new Date(Date.now() + PRICING.trialDays * 86_400_000) : new Date(),
      ...(trial && {
        aiTokenBalance: freeAiTokens(),
        aiLedger: { create: { type: "FREE_GRANT", tokens: freeAiTokens(), balanceAfter: freeAiTokens(), note: "Free AI tokens" } },
      }),
      memberships: { create: { userId, role: "OWNER" } },
      workspaces: { create: { name, slug } },
    },
  });
}
