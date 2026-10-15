/**
 * AI token wallet: free allowance, purchases and per-call usage, all recorded
 * in ai_token_ledger next to a running balance on the organization.
 */
import { prisma, type Prisma } from "@ashniva/db";
import { AI_LOW_BALANCE, PRICING, type AiFeatureKey } from "@ashniva/shared";
import { EntitlementError } from "./entitlements";
import { notify } from "./notifications";

/** Free tokens for a new organization, from the owner's price list (AI_FREE_TOKENS in .env until one is saved). */
export const freeAiTokens = () => PRICING.aiFreeTokens;

/** Throws a 402 the UI turns into a "Buy tokens" prompt. */
export async function assertAiTokens(orgId: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { aiTokenBalance: true } });
  if (org.aiTokenBalance < PRICING.aiMinBalance) {
    throw new EntitlementError(
      "AI_TOKENS_EXHAUSTED",
      org.aiTokenBalance <= 0
        ? "Your organization has used all its AI tokens. Buy a token pack to keep using AI."
        : "Your AI token balance is too low for this action. Buy a token pack to keep using AI.",
    );
  }
  return org.aiTokenBalance;
}

async function applyLedger(orgId: string, tokens: number, data: Omit<Prisma.AiTokenLedgerUncheckedCreateInput, "orgId" | "tokens" | "balanceAfter">) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.update({
      where: { id: orgId },
      data: { aiTokenBalance: { increment: tokens } },
      select: { aiTokenBalance: true },
    });
    await tx.aiTokenLedger.create({ data: { ...data, orgId, tokens, balanceAfter: org.aiTokenBalance } });
    return org.aiTokenBalance;
  });
}

export async function chargeAiUsage(opts: {
  orgId: string;
  feature: AiFeatureKey;
  model: string;
  inputTokens: number;
  outputTokens: number;
  userId?: string | null;
  workspaceId?: string | null;
}) {
  const used = Math.max(0, Math.round(opts.inputTokens + opts.outputTokens));
  if (used === 0) return null;
  const balance = await applyLedger(opts.orgId, -used, {
    type: "USAGE",
    feature: opts.feature,
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    userId: opts.userId ?? null,
    workspaceId: opts.workspaceId ?? null,
  });
  // Alert once, on the call that crosses the threshold.
  if (balance < AI_LOW_BALANCE && balance + used >= AI_LOW_BALANCE) {
    await notifyLowAiBalance(opts.orgId, balance, opts.workspaceId).catch((err) => console.error("[ai] low balance alert failed", err));
  }
  return balance;
}

async function notifyLowAiBalance(orgId: string, balance: number, workspaceId?: string | null) {
  const ws = workspaceId
    ? { id: workspaceId }
    : await prisma.workspace.findFirst({ where: { orgId, archivedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const left = Math.max(0, balance).toLocaleString("en-IN");
  await notify({
    orgId,
    type: "ai.low_balance",
    title: `AI tokens running low: ${left} left`,
    body: `Your organization has ${left} AI tokens left. Buy a token pack so AI features keep working for your team.`,
    link: ws ? `/w/${ws.id}/settings/ai` : undefined,
    roles: ["OWNER", "ADMIN"],
    email: true,
    emailPref: "lowAiBalance",
  });
}

/** Manual grant or correction from the admin panel (negative to remove). */
export async function adjustAiTokens(orgId: string, tokens: number, note: string, userId: string | null) {
  return applyLedger(orgId, Math.round(tokens), { type: "ADJUSTMENT", note, userId });
}

/** Credits a paid token-pack order once, however many times payment confirmations arrive. */
export async function creditAiOrder(orderId: string, paymentId: string) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.aiTokenOrder.updateMany({
      where: { id: orderId, status: "CREATED" },
      data: { status: "PAID", paymentId, paidAt: new Date() },
    });
    if (claimed.count === 0) return false;
    const order = await tx.aiTokenOrder.findUniqueOrThrow({ where: { id: orderId } });
    const org = await tx.organization.update({
      where: { id: order.orgId },
      data: { aiTokenBalance: { increment: order.tokens } },
      select: { aiTokenBalance: true },
    });
    await tx.aiTokenLedger.create({
      data: {
        orgId: order.orgId,
        type: "PURCHASE",
        tokens: order.tokens,
        balanceAfter: org.aiTokenBalance,
        orderId: order.id,
        userId: order.createdById,
        note: `Token pack · ₹${(order.amount / 100).toLocaleString("en-IN")}`,
      },
    });
    return true;
  });
}
