/**
 * Billing (billing.routes.ts, ai-wallet.routes.ts, lib/razorpay.ts): billing
 * summary, subscription checkout/verify/cancel, the signed Razorpay webhook and
 * AI token packs. Razorpay's HTTP API is a fetch stub.
 */
import { createHmac } from "node:crypto";
import { getSyncQueue } from "@ashniva/core";
import { PLANS, withGst } from "@ashniva/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { anon, as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { configure, createConnection, fetchCalls, orgWith, resetAll, stubFetch } from "./helpers";

afterAll(async () => {
  await getSyncQueue().close();
});
beforeEach(resetAll);

const KEY_ID = "rzp_test_ashniva";
const KEY_SECRET = "rzp-key-secret";
const WEBHOOK_SECRET = "rzp-webhook-secret";
const RZP = "https://api.razorpay.com/v1";

const razorpay = () => configure({ RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET });
const hmac = (secret: string, data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");

/** Razorpay answers for plan + subscription creation and lookups. */
function stubRazorpay(sub: Partial<{ id: string; status: string; plan_id: string; current_end: number; notes: Record<string, string> }> = {}) {
  const subscription = { id: "sub_1", plan_id: "plan_growth_1", status: "created", current_end: null, customer_id: "cust_1", short_url: "https://rzp.io/i/abc", ...sub };
  return stubFetch([
    [`${RZP}/plans`, (c) => ({ json: { id: "plan_growth_1", item: { amount: JSON.parse(c.body ?? "{}").item?.amount } } })],
    [/\/subscriptions\/[^/]+\/cancel$/, { json: { ...subscription, status: "active", current_end: 1_900_000_000 } }],
    [/\/subscriptions\/[^/]+$/, { json: subscription }],
    [`${RZP}/subscriptions`, (c) => ({ json: { ...subscription, notes: JSON.parse(c.body ?? "{}").notes } })],
    [`${RZP}/orders`, (c) => ({ json: { id: "order_rp_1", amount: JSON.parse(c.body ?? "{}").amount, currency: "INR", status: "created" } })],
  ]);
}

async function webhook(payload: unknown, opts: { raw?: string; signature?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  return (await anon())
    .post("/api/billing/webhook/razorpay")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", opts.signature ?? hmac(WEBHOOK_SECRET, raw))
    .send(raw);
}

const subEvent = (event: string, entity: Record<string, unknown>) => ({ event, payload: { subscription: { entity: { customer_id: "cust_1", current_end: 1_900_000_000, ...entity } } } });

describe("GET /billing", () => {
  it("returns plan, usage and limits without Razorpay keys", async () => {
    const { org, workspace, owner } = await orgWith("OWNER", { plan: "STARTER" });
    await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    await createConnection(org.id, { mode: "DEMO", workspaceId: workspace.id });
    const res = await (await as(owner)).get(`/api/orgs/${org.id}/billing`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plan: "STARTER",
      subscriptionStatus: "ACTIVE",
      trialEndsAt: null,
      currentPeriodEnd: null,
      provider: null,
      usage: { workspaces: 1, adAccounts: 1, members: 1 },
      limits: { workspaces: PLANS.STARTER.limits.workspaces, adAccounts: PLANS.STARTER.limits.adAccounts, members: PLANS.STARTER.limits.members },
      checkoutEnabled: false,
      razorpayKeyId: null,
    });
    const agency = await orgWith();
    const unlimited = await (await as(agency.owner)).get(`/api/orgs/${agency.org.id}/billing`);
    expect(unlimited.body.limits).toEqual({ workspaces: null, adAccounts: null, members: null });
  });

  it("offers checkout once keys are saved", async () => {
    await razorpay();
    const { org, owner } = await orgWith();
    const res = await (await as(owner)).get(`/api/orgs/${org.id}/billing`);
    expect(res.body).toMatchObject({ checkoutEnabled: true, razorpayKeyId: KEY_ID });
    expect(JSON.stringify(res.body)).not.toContain(KEY_SECRET);
  });
});

describe("subscription checkout, verify and cancel", () => {
  it("explains that billing isn't configured instead of failing", async () => {
    const { org, owner } = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "GROWTH" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: "BILLING_NOT_CONFIGURED", message: "Online billing isn't configured yet." });
    expect(fetchCalls).toHaveLength(0);
  });

  it("is for owners only and validates the plan", async () => {
    await razorpay();
    stubRazorpay();
    const { org, user: admin } = await orgWith("ADMIN");
    expect((await (await as(admin)).post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "GROWTH" })).status).toBe(403);
    const { org: o2, owner } = await orgWith();
    expect((await (await as(owner)).post(`/api/orgs/${o2.id}/billing/checkout`).send({ plan: "TRIAL" })).status).toBe(422);
  });

  it("creates the Razorpay plan once and a subscription per checkout", async () => {
    await razorpay();
    stubRazorpay();
    const a = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const res = await (await as(a.owner)).post(`/api/orgs/${a.org.id}/billing/checkout`).send({ plan: "GROWTH" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subscriptionId: "sub_1", keyId: KEY_ID, shortUrl: "https://rzp.io/i/abc" });
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: a.org.id } });
    expect(org).toMatchObject({ billingProvider: "razorpay", billingSubscriptionId: "sub_1", plan: "TRIAL" });

    const planCall = fetchCalls.find((c) => c.url === `${RZP}/plans`)!;
    expect(JSON.parse(planCall.body!).item.amount).toBe(withGst(PLANS.GROWTH.priceMonthly) * 100);
    expect(planCall.headers.authorization).toBe(`Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`);
    const subCall = fetchCalls.find((c) => c.url === `${RZP}/subscriptions`)!;
    expect(JSON.parse(subCall.body!)).toMatchObject({ plan_id: "plan_growth_1", notes: { orgId: a.org.id, plan: "GROWTH" } });

    // A second organization reuses the stored plan.
    await prisma.organization.update({ where: { id: a.org.id }, data: { billingSubscriptionId: null } });
    const b = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    fetchCalls.length = 0;
    await (await as(b.owner)).post(`/api/orgs/${b.org.id}/billing/checkout`).send({ plan: "GROWTH" });
    expect(fetchCalls.map((c) => c.url)).toEqual([`${RZP}/subscriptions`]);
  });

  it("refuses a second subscription while one is active", async () => {
    await razorpay();
    stubRazorpay();
    const { org, owner } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_live" });
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "AGENCY" });
    expect(res.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("checkout while a past-due subscription exists cancels the first instead of orphaning it", async () => {
    await razorpay();
    stubRazorpay({ id: "sub_new" });
    const { org, owner } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "PAST_DUE", billingSubscriptionId: "sub_old" });
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "GROWTH" });
    const cancelledOld = fetchCalls.some((c) => c.url.includes("/subscriptions/sub_old/cancel"));
    expect(res.status === 400 || cancelledOld).toBe(true);
  });

  it("verifies the checkout signature before activating", async () => {
    await razorpay();
    stubRazorpay({ id: "sub_1", status: "active", plan_id: "plan_unknown", notes: { plan: "GROWTH" }, current_end: 1_900_000_000 });
    const { org, owner } = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000), billingSubscriptionId: "sub_1" });
    const api = await as(owner);
    const url = `/api/orgs/${org.id}/billing/verify`;

    const forged = await api.post(url).send({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: hmac("wrong-secret", "pay_1|sub_1") });
    expect(forged.status).toBe(400);
    expect(forged.body.error.message).toBe("Payment verification failed.");
    const otherSub = await api.post(url).send({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_other", razorpay_signature: hmac(KEY_SECRET, "pay_1|sub_other") });
    expect(otherSub.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);

    const ok = await api.post(url).send({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_1", razorpay_signature: hmac(KEY_SECRET, "pay_1|sub_1") });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ plan: "GROWTH", subscriptionStatus: "ACTIVE" });
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(fresh.currentPeriodEnd?.getTime()).toBe(1_900_000_000_000);
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: "billing.subscribed" } })).toBe(1);
  });

  it("a complimentary organization's checkout only becomes its subscription once paid", async () => {
    await razorpay();
    stubRazorpay({ id: "sub_comp", status: "active", notes: { plan: "GROWTH" }, current_end: 1_900_000_000 });
    const { org, owner } = await orgWith("OWNER", { plan: "AGENCY", subscriptionStatus: "ACTIVE" });
    const api = await as(owner);
    expect((await api.post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "GROWTH" })).body.subscriptionId).toBe("sub_comp");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).billingSubscriptionId).toBeNull();
    const url = `/api/orgs/${org.id}/billing/verify`;
    expect((await api.post(url).send({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_other", razorpay_signature: hmac(KEY_SECRET, "pay_1|sub_other") })).status).toBe(400);
    const ok = await api.post(url).send({ razorpay_payment_id: "pay_1", razorpay_subscription_id: "sub_comp", razorpay_signature: hmac(KEY_SECRET, "pay_1|sub_comp") });
    expect(ok.body).toEqual({ plan: "GROWTH", subscriptionStatus: "ACTIVE" });
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ billingProvider: "razorpay", billingSubscriptionId: "sub_comp" });
  });

  it("cancels at the end of the period", async () => {
    await razorpay();
    stubRazorpay();
    const { org, owner } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_1" });
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/billing/cancel`);
    expect(res.status).toBe(204);
    const call = fetchCalls.find((c) => c.url.endsWith("/subscriptions/sub_1/cancel"))!;
    expect(JSON.parse(call.body!)).toEqual({ cancel_at_cycle_end: 1 });
    const fresh = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(fresh.subscriptionStatus).toBe("CANCELLED");
    expect(fresh.currentPeriodEnd?.getTime()).toBe(1_900_000_000_000);
  });
});

describe("POST /api/billing/webhook/razorpay", () => {
  it("rejects a missing, wrong or re-serialised signature, and any signature when no secret is set", async () => {
    const { org } = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000), billingSubscriptionId: "sub_1" });
    const event = subEvent("subscription.activated", { id: "sub_1", plan_id: "p", status: "active", notes: { plan: "AGENCY" } });
    expect((await webhook(event)).status).toBe(400); // no webhook secret configured yet

    await razorpay();
    expect((await webhook(event, { signature: "" })).status).toBe(400);
    expect((await webhook(event, { signature: hmac("nope", JSON.stringify(event)) })).status).toBe(400);
    // Signed over different bytes than were sent (pretty-printed body): the raw body is what counts.
    const pretty = JSON.stringify(event, null, 2);
    expect((await webhook(event, { raw: pretty, signature: hmac(WEBHOOK_SECRET, JSON.stringify(event)) })).status).toBe(400);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).plan).toBe("TRIAL");

    const res = await webhook(event, { raw: pretty, signature: hmac(WEBHOOK_SECRET, pretty) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ plan: "AGENCY", subscriptionStatus: "ACTIVE", billingProvider: "razorpay" });
  });

  it("maps Razorpay subscription states onto ours", async () => {
    await razorpay();
    const { org } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_1" });
    const cases: [string, string][] = [
      ["halted", "PAST_DUE"],
      ["pending", "PAST_DUE"],
      ["active", "ACTIVE"],
      ["authenticated", "ACTIVE"],
      ["cancelled", "CANCELLED"],
      ["paused", "CANCELLED"],
      ["completed", "EXPIRED"],
      ["expired", "EXPIRED"],
    ];
    for (const [rzp, ours] of cases) {
      expect((await webhook(subEvent(`subscription.${rzp}`, { id: "sub_1", plan_id: "p", status: rzp, notes: { plan: "GROWTH" } }))).status).toBe(200);
      expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).subscriptionStatus, rzp).toBe(ours);
    }
    // A state we don't map, or a plan we can't tell, changes nothing.
    await webhook(subEvent("subscription.created", { id: "sub_1", plan_id: "p", status: "created", notes: { plan: "GROWTH" } }));
    await webhook(subEvent("subscription.charged", { id: "sub_1", plan_id: "p", status: "active", notes: {} }));
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).subscriptionStatus).toBe("EXPIRED");
    // Unknown subscriptions are acknowledged and ignored.
    expect((await webhook(subEvent("subscription.charged", { id: "sub_unknown", plan_id: "p", status: "active", notes: { plan: "AGENCY" } }))).status).toBe(200);
  });

  it("a plan the operator assigns after a cancellation is not undone by the old subscription's webhook", async () => {
    await razorpay();
    const { createUser, OPERATOR_EMAIL } = await import("./helpers");
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { org } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "CANCELLED", billingSubscriptionId: "sub_1" });
    const patch = await (await as(operator)).patch(`/api/admin/orgs/${org.id}`).send({ plan: "AGENCY" });
    expect(patch.body).toMatchObject({ plan: "AGENCY", subscriptionStatus: "ACTIVE" });
    // Razorpay ends the cancelled subscription at the end of its cycle.
    await webhook(subEvent("subscription.cancelled", { id: "sub_1", plan_id: "p", status: "cancelled", current_end: Math.floor(Date.now() / 1000) - 60, notes: { plan: "GROWTH" } }));
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ plan: "AGENCY", subscriptionStatus: "ACTIVE" });
  });

  it("credits an AI token pack exactly once however many confirmations arrive", async () => {
    await razorpay();
    const { org, owner } = await orgWith("OWNER", { aiTokenBalance: 1000 });
    const order = await prisma.aiTokenOrder.create({ data: { orgId: org.id, packId: "pack_500k", tokens: 500_000, amount: 58_900, providerOrderId: "order_rp_9", createdById: owner.id } });
    const paid = { event: "order.paid", payload: { payment: { entity: { id: "pay_9", order_id: "order_rp_9", status: "captured" } }, order: { entity: { id: "order_rp_9" } } } };
    const captured = { event: "payment.captured", payload: { payment: { entity: { id: "pay_9", order_id: "order_rp_9", status: "captured" } } } };
    for (const e of [paid, paid, captured]) expect((await webhook(e)).status).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).aiTokenBalance).toBe(501_000);
    const ledger = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: "PURCHASE", tokens: 500_000, balanceAfter: 501_000, orderId: order.id });
    expect(await prisma.aiTokenOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID", paymentId: "pay_9" });
  });
});

describe("AI token packs", () => {
  it("checks out a pack and credits it after a verified payment, once", async () => {
    await razorpay();
    stubRazorpay();
    const { org, owner } = await orgWith("OWNER", { aiTokenBalance: 0 });
    const api = await as(owner);
    const checkout = await api.post(`/api/orgs/${org.id}/ai/packs/checkout`).send({ packId: "pack_500k" });
    expect(checkout.status).toBe(200);
    expect(checkout.body).toMatchObject({ razorpayOrderId: "order_rp_1", amount: withGst(499) * 100, currency: "INR", keyId: KEY_ID });
    expect(JSON.parse(fetchCalls.find((c) => c.url === `${RZP}/orders`)!.body!)).toMatchObject({ amount: withGst(499) * 100, receipt: checkout.body.orderId });

    const url = `/api/orgs/${org.id}/ai/packs/verify`;
    const bad = await api.post(url).send({ razorpay_order_id: "order_rp_1", razorpay_payment_id: "pay_1", razorpay_signature: hmac(KEY_SECRET, "pay_1|order_rp_1") });
    expect(bad.status).toBe(400);
    const sig = hmac(KEY_SECRET, "order_rp_1|pay_1");
    const ok = await api.post(url).send({ razorpay_order_id: "order_rp_1", razorpay_payment_id: "pay_1", razorpay_signature: sig });
    expect(ok.body).toEqual({ balance: 500_000 });
    const again = await api.post(url).send({ razorpay_order_id: "order_rp_1", razorpay_payment_id: "pay_1", razorpay_signature: sig });
    expect(again.body).toEqual({ balance: 500_000 });
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: "ai_tokens.purchased" } })).toBe(1);

    // The webhook arriving later doesn't add more.
    await webhook({ event: "order.paid", payload: { payment: { entity: { id: "pay_1", order_id: "order_rp_1" } } } });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).aiTokenBalance).toBe(500_000);

    const wallet = await api.get(`/api/orgs/${org.id}/ai/wallet`);
    expect(wallet.body).toMatchObject({ balance: 500_000, purchasedTotal: 500_000, checkoutEnabled: true });
  });

  it("can't verify another organization's order", async () => {
    await razorpay();
    const a = await orgWith();
    await prisma.aiTokenOrder.create({ data: { orgId: a.org.id, packId: "pack_500k", tokens: 500_000, amount: 58_900, providerOrderId: "order_a" } });
    const b = await orgWith();
    const res = await (await as(b.owner)).post(`/api/orgs/${b.org.id}/ai/packs/verify`).send({ razorpay_order_id: "order_a", razorpay_payment_id: "pay_x", razorpay_signature: hmac(KEY_SECRET, "order_a|pay_x") });
    expect(res.status).toBe(400);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: b.org.id } })).aiTokenBalance).toBe(100_000);
  });

  it("marks the order failed when Razorpay refuses, and hides the wallet from clients", async () => {
    await razorpay();
    stubFetch([[`${RZP}/orders`, { status: 400, json: { error: { description: "Amount exceeds maximum amount allowed." } } }]]);
    const { org, owner, workspace } = await orgWith();
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/ai/packs/checkout`).send({ packId: "pack_10m" });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toBe("Amount exceeds maximum amount allowed.");
    expect(await prisma.aiTokenOrder.findFirstOrThrow({ where: { orgId: org.id } })).toMatchObject({ status: "FAILED", providerOrderId: null });
    expect((await (await as(owner)).post(`/api/orgs/${org.id}/ai/packs/checkout`).send({ packId: "nope" })).status).toBe(404);

    const { addMember } = await import("../../helpers/factories");
    const { createUser } = await import("./helpers");
    const clientUser = await createUser();
    await addMember(org.id, clientUser, "CLIENT", [workspace.id]);
    expect((await (await as(clientUser)).get(`/api/orgs/${org.id}/ai/wallet`)).status).toBe(403);
  });
});
