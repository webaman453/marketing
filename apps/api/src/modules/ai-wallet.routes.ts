/**
 * AI token wallet: balance, usage history and token-pack purchases.
 * Mounted under /api/orgs/:orgId after loadOrg.
 */
import { audit, creditAiOrder } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import { AI_TOKEN_PACKS, PRICING, aiPackById, withGst, type AiLedgerEntryDTO, type AiWalletDTO } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { aiAvailable } from "../lib/ai";
import { badRequest, forbidden, notFound, parse } from "../lib/errors";
import { createOrder, razorpayConfigured, verifyOrderSignature } from "../lib/razorpay";
import { requirePermission } from "../middleware/auth";

export const aiWalletRouter = Router({ mergeParams: true });

aiWalletRouter.get("/ai/wallet", async (req, res) => {
  // Clients are external: they don't see the agency's spend or staff names.
  if (req.membership!.role === "CLIENT") throw forbidden();
  const org = req.org!;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [fresh, ledger, used, purchased] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { aiTokenBalance: true } }),
    prisma.aiTokenLedger.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.aiTokenLedger.aggregate({ where: { orgId: org.id, type: "USAGE", createdAt: { gte: monthStart } }, _sum: { tokens: true } }),
    prisma.aiTokenLedger.aggregate({ where: { orgId: org.id, type: "PURCHASE" }, _sum: { tokens: true } }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(ledger.map((l) => l.userId).filter((x): x is string => !!x))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const body: AiWalletDTO = {
    available: aiAvailable(),
    balance: fresh.aiTokenBalance,
    canUse: aiAvailable() && fresh.aiTokenBalance >= PRICING.aiMinBalance,
    usedThisMonth: -(used._sum.tokens ?? 0),
    purchasedTotal: purchased._sum.tokens ?? 0,
    ledger: ledger.map(
      (l): AiLedgerEntryDTO => ({
        id: l.id,
        type: l.type,
        tokens: l.tokens,
        balanceAfter: l.balanceAfter,
        feature: l.feature,
        note: l.note,
        user: l.userId ? (nameOf.get(l.userId) ?? null) : null,
        createdAt: l.createdAt.toISOString(),
      }),
    ),
    checkoutEnabled: razorpayConfigured(),
    razorpayKeyId: razorpayConfigured() ? (process.env.RAZORPAY_KEY_ID ?? null) : null,
  };
  res.json(body);
});

aiWalletRouter.get("/ai/packs", (_req, res) => {
  res.json({ packs: AI_TOKEN_PACKS, gstPercent: PRICING.gstPercent });
});

aiWalletRouter.post("/ai/packs/checkout", requirePermission("billing:manage"), async (req, res) => {
  const { packId } = parse(z.object({ packId: z.string() }), req.body);
  const pack = aiPackById(packId);
  if (!pack) throw notFound("Token pack");
  const org = req.org!;
  const order = await prisma.aiTokenOrder.create({
    data: { orgId: org.id, packId: pack.id, tokens: pack.tokens, amount: withGst(pack.price) * 100, createdById: req.userId },
  });
  try {
    const rp = await createOrder(order.amount, order.id, { orgId: org.id, packId: pack.id, kind: "ai_tokens" });
    await prisma.aiTokenOrder.update({ where: { id: order.id }, data: { providerOrderId: rp.id } });
    res.json({ orderId: order.id, razorpayOrderId: rp.id, amount: order.amount, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    await prisma.aiTokenOrder.update({ where: { id: order.id }, data: { status: "FAILED" } });
    throw err;
  }
});

/** Called by the checkout success handler so tokens arrive without waiting for the webhook. */
aiWalletRouter.post("/ai/packs/verify", requirePermission("billing:manage"), async (req, res) => {
  const body = parse(
    z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }),
    req.body,
  );
  const order = await prisma.aiTokenOrder.findFirst({ where: { providerOrderId: body.razorpay_order_id, orgId: req.org!.id } });
  if (!order) throw badRequest("This payment doesn't match your checkout.");
  if (!verifyOrderSignature(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
    throw badRequest("Payment verification failed.");
  }
  const credited = await creditAiOrder(order.id, body.razorpay_payment_id);
  if (credited) {
    await audit({
      orgId: req.org!.id,
      userId: req.userId,
      action: "ai_tokens.purchased",
      entityType: "organization",
      entityId: req.org!.id,
      entityName: `${order.tokens.toLocaleString("en-IN")} AI tokens`,
    });
  }
  const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: req.org!.id }, select: { aiTokenBalance: true } });
  res.json({ balance: fresh.aiTokenBalance });
});
