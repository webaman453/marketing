import { audit, creditAiOrder, deleteInternalSetting, getInternalSetting, orgUsage, setInternalSetting } from "@ashniva/core";
import { prisma, type Organization } from "@ashniva/db";
import { PAID_PLANS, PLANS, type PlanId } from "@ashniva/shared";
import express, { Router } from "express";
import { z } from "zod";
import { badRequest, parse } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  BILLABLE_STATUSES,
  cancelSubscription,
  createSubscription,
  fetchSubscription,
  mapStatus,
  planFromRazorpayId,
  razorpayConfigured,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type RazorpaySubscription,
} from "../lib/razorpay";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/orgs/:orgId after loadOrg. */
export const billingRouter = Router({ mergeParams: true });

const limitValue = (n: number) => (Number.isFinite(n) ? n : null);

billingRouter.get("/billing", async (req, res) => {
  const org = req.org!;
  const usage = await orgUsage(org.id);
  const plan = PLANS[org.plan as PlanId];
  res.json({
    plan: org.plan,
    subscriptionStatus: org.subscriptionStatus,
    trialEndsAt: org.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
    provider: org.billingProvider,
    usage,
    limits: {
      workspaces: limitValue(plan.limits.workspaces),
      adAccounts: limitValue(plan.limits.adAccounts),
      members: limitValue(plan.limits.members),
    },
    checkoutEnabled: razorpayConfigured(),
    razorpayKeyId: razorpayConfigured() ? process.env.RAZORPAY_KEY_ID : null,
  });
});

async function applySubscription(org: Pick<Organization, "id">, sub: RazorpaySubscription) {
  const plan = await planFromRazorpayId(sub.plan_id, sub.notes);
  const status = mapStatus(sub.status);
  if (!plan || !status) return null;
  return prisma.organization.update({
    where: { id: org.id },
    data: {
      plan,
      subscriptionStatus: status,
      billingProvider: "razorpay",
      billingSubscriptionId: sub.id,
      billingCustomerId: sub.customer_id,
      currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : null,
    },
  });
}

/**
 * The checkout an ACTIVE organization without a subscription (complimentary or invoice-billed) has started.
 * It is kept off the organization until Razorpay confirms it: an ACTIVE org with billingSubscriptionId counts
 * as paying (admin MRR) and is treated as Razorpay-billed.
 */
const pendingKey = (orgId: string) => `pendingSubscription:${orgId}`;
const pendingSubscription = (orgId: string) => getInternalSetting<string>(pendingKey(orgId));

billingRouter.post("/billing/checkout", requirePermission("billing:manage"), async (req, res) => {
  const { plan } = parse(z.object({ plan: z.enum(PAID_PLANS as [string, ...string[]]) }), req.body);
  const org = req.org!;
  if (org.subscriptionStatus === "ACTIVE" && org.billingSubscriptionId) {
    throw badRequest("You already have an active subscription. Cancel it before switching plans, or contact support.");
  }
  const keepPending = org.subscriptionStatus === "ACTIVE";
  // A past-due (pending/halted), paused or abandoned earlier subscription can still charge the customer, and once
  // we point at the new one its webhooks would be ignored. End it before starting another.
  const previousId = org.billingSubscriptionId ?? (keepPending ? await pendingSubscription(org.id) : null);
  if (previousId) {
    const previous = await fetchSubscription(previousId);
    if (BILLABLE_STATUSES.includes(previous.status)) await cancelSubscription(previousId, { immediately: true });
  }
  const sub = await createSubscription(plan as (typeof PAID_PLANS)[number], { orgId: org.id, orgName: org.name });
  if (keepPending) await setInternalSetting(pendingKey(org.id), sub.id);
  else await prisma.organization.update({ where: { id: org.id }, data: { billingProvider: "razorpay", billingSubscriptionId: sub.id } });
  res.json({ subscriptionId: sub.id, keyId: process.env.RAZORPAY_KEY_ID, shortUrl: sub.short_url ?? null });
});

/** Called by the checkout success handler; activates immediately instead of waiting for the webhook. */
billingRouter.post("/billing/verify", requirePermission("billing:manage"), async (req, res) => {
  const body = parse(
    z.object({ razorpay_payment_id: z.string(), razorpay_subscription_id: z.string(), razorpay_signature: z.string() }),
    req.body,
  );
  const org = req.org!;
  const expected = org.billingSubscriptionId ?? (await pendingSubscription(org.id));
  if (!expected || body.razorpay_subscription_id !== expected) throw badRequest("This payment doesn't match your checkout.");
  if (!verifyCheckoutSignature(body.razorpay_payment_id, body.razorpay_subscription_id, body.razorpay_signature)) {
    throw badRequest("Payment verification failed.");
  }
  const sub = await fetchSubscription(body.razorpay_subscription_id);
  const updated = await applySubscription(org, sub);
  if (updated && !org.billingSubscriptionId) await deleteInternalSetting(pendingKey(org.id));
  await audit({ orgId: org.id, userId: req.userId, action: "billing.subscribed", entityType: "organization", entityId: org.id, entityName: updated?.plan ?? sub.plan_id });
  res.json({ plan: updated?.plan ?? org.plan, subscriptionStatus: updated?.subscriptionStatus ?? org.subscriptionStatus });
});

billingRouter.post("/billing/cancel", requirePermission("billing:manage"), async (req, res) => {
  const org = req.org!;
  if (!org.billingSubscriptionId) throw badRequest("There's no subscription to cancel.");
  const sub = await cancelSubscription(org.billingSubscriptionId);
  await prisma.organization.update({
    where: { id: org.id },
    data: { subscriptionStatus: "CANCELLED", currentPeriodEnd: sub.current_end ? new Date(sub.current_end * 1000) : org.currentPeriodEnd },
  });
  await audit({ orgId: org.id, userId: req.userId, action: "billing.cancelled", entityType: "organization", entityId: org.id, entityName: org.name });
  res.status(204).end();
});

// ───────── Webhook (raw body, signature-verified) ─────────

export const billingWebhookRouter = Router();

billingWebhookRouter.post("/razorpay", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const signature = req.get("x-razorpay-signature") ?? "";
  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, signature)) {
    res.status(400).json({ error: { code: "BAD_SIGNATURE", message: "Invalid signature." } });
    return;
  }
  const event = JSON.parse(req.body.toString("utf8")) as {
    event: string;
    payload?: {
      subscription?: { entity?: RazorpaySubscription };
      payment?: { entity?: { id: string; order_id?: string | null; status?: string } };
    };
  };
  // AI token packs are one-time orders.
  const payment = event.payload?.payment?.entity;
  if ((event.event === "order.paid" || event.event === "payment.captured") && payment?.order_id) {
    const order = await prisma.aiTokenOrder.findUnique({ where: { providerOrderId: payment.order_id } });
    if (order && (await creditAiOrder(order.id, payment.id))) {
      logger.info({ orgId: order.orgId, orderId: order.id }, "AI token pack credited");
    }
  }
  const sub = event.payload?.subscription?.entity;
  if (sub) {
    const org = await prisma.organization.findFirst({ where: { billingSubscriptionId: sub.id } });
    if (org) {
      await applySubscription(org, sub);
      logger.info({ orgId: org.id, event: event.event, status: sub.status }, "Razorpay subscription updated");
    } else if (sub.notes?.orgId && mapStatus(sub.status) === "ACTIVE" && (await pendingSubscription(sub.notes.orgId)) === sub.id) {
      // A complimentary organization's checkout, paid without the success handler reaching us.
      const pendingOrg = await prisma.organization.findUnique({ where: { id: sub.notes.orgId } });
      if (pendingOrg && !pendingOrg.billingSubscriptionId && (await applySubscription(pendingOrg, sub))) {
        await deleteInternalSetting(pendingKey(pendingOrg.id));
        logger.info({ orgId: pendingOrg.id, event: event.event, status: sub.status }, "Razorpay subscription started");
      }
    }
  }
  res.json({ ok: true });
});
