/**
 * Minimal Razorpay Subscriptions client.
 * Docs: https://razorpay.com/docs/api/payments/subscriptions/
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { getInternalSetting, setInternalSetting } from "@ashniva/core";
import { BRAND, PAID_PLANS, PLANS, withGst, type PaidPlanId } from "@ashniva/shared";
import { HttpError } from "./errors";

const API = "https://api.razorpay.com/v1";

export const razorpayConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

/** Razorpay plans we've created, per plan and price; older ones stay so renewals still map back. */
type PlanRef = { id: string; amount: number; keyId: string };
type PlanStore = Partial<Record<PaidPlanId, PlanRef[]>>;
const PLAN_STORE = "razorpay_plans";

/**
 * The Razorpay plan for a plan's current price (with GST). Created on the
 * first checkout after the owner changes a price, so nobody has to set plans
 * up in the Razorpay dashboard. A RAZORPAY_PLAN_* id from .env is reused when
 * its amount matches.
 */
export async function razorpayPlanFor(plan: PaidPlanId): Promise<string> {
  const amount = withGst(PLANS[plan].priceMonthly) * 100;
  if (amount <= 0) throw new HttpError(400, "BILLING_ERROR", "This plan is free, so there's nothing to pay.");
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const store = (await getInternalSetting<PlanStore>(PLAN_STORE)) ?? {};
  const hit = store[plan]?.find((p) => p.amount === amount && p.keyId === keyId);
  if (hit) return hit.id;
  const envId = process.env[`RAZORPAY_PLAN_${plan}`];
  if (envId) {
    const existing = await call<{ id: string; item?: { amount?: number } }>(`/plans/${envId}`).catch(() => null);
    if (existing?.item?.amount === amount) return envId;
  }
  const created = await call<{ id: string }>("/plans", {
    method: "POST",
    body: {
      period: "monthly",
      interval: 1,
      item: { name: `${BRAND.name} ${PLANS[plan].name}`, amount, currency: "INR", description: `${PLANS[plan].name} plan, billed monthly` },
      notes: { plan },
    },
  });
  store[plan] = [...(store[plan] ?? []), { id: created.id, amount, keyId }];
  await setInternalSetting(PLAN_STORE, store);
  return created.id;
}

export async function planFromRazorpayId(id: string, notes?: Record<string, string>): Promise<PaidPlanId | null> {
  for (const p of PAID_PLANS) if (process.env[`RAZORPAY_PLAN_${p}`] === id) return p;
  const store = (await getInternalSetting<PlanStore>(PLAN_STORE)) ?? {};
  for (const p of PAID_PLANS) if (store[p]?.some((r) => r.id === id)) return p;
  const fromNotes = notes?.plan as PaidPlanId | undefined;
  return fromNotes && PAID_PLANS.includes(fromNotes) ? fromNotes : null;
}

/** Checks the keys with a harmless read. */
export async function testRazorpay() {
  await call<unknown>("/plans?count=1");
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!razorpayConfigured()) throw new HttpError(503, "BILLING_NOT_CONFIGURED", "Online billing isn't configured yet.");
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
  if (!res.ok) throw new HttpError(502, "BILLING_ERROR", data.error?.description ?? `Razorpay error (${res.status})`);
  return data as T;
}

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: "created" | "authenticated" | "active" | "pending" | "halted" | "cancelled" | "completed" | "expired" | "paused";
  current_end: number | null;
  customer_id: string | null;
  short_url?: string;
  notes?: Record<string, string>;
}

export async function createSubscription(plan: PaidPlanId, notes: Record<string, string>) {
  const planId = await razorpayPlanFor(plan);
  return call<RazorpaySubscription>("/subscriptions", {
    method: "POST",
    // 120 monthly cycles ≈ 10 years; customers cancel any time.
    body: { plan_id: planId, total_count: 120, customer_notify: 1, notes: { ...notes, plan } },
  });
}

export const fetchSubscription = (id: string) => call<RazorpaySubscription>(`/subscriptions/${id}`);

/** Cancels at the end of the paid period, or right away with `immediately`. */
export const cancelSubscription = (id: string, { immediately = false } = {}) =>
  call<RazorpaySubscription>(`/subscriptions/${id}/cancel`, { method: "POST", body: { cancel_at_cycle_end: immediately ? 0 : 1 } });

/** Subscription states Razorpay can still bill from, so they must be cancelled. */
export const BILLABLE_STATUSES: readonly RazorpaySubscription["status"][] = ["created", "authenticated", "active", "pending", "halted", "paused"];

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Checkout handler signature: HMAC(payment_id|subscription_id, key_secret). */
export function verifyCheckoutSignature(paymentId: string, subscriptionId: string, signature: string) {
  const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "").update(`${paymentId}|${subscriptionId}`).digest("hex");
  return safeEqual(expected, signature);
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}

// ───────── One-time orders (AI token packs) ─────────

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: "created" | "attempted" | "paid";
}

/** `amount` is in paise. */
export const createOrder = (amount: number, receipt: string, notes: Record<string, string>) =>
  call<RazorpayOrder>("/orders", { method: "POST", body: { amount, currency: "INR", receipt, notes } });

/** Order checkout signature: HMAC(order_id|payment_id, key_secret). */
export function verifyOrderSignature(orderId: string, paymentId: string, signature: string) {
  const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "").update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqual(expected, signature);
}

/** Maps a Razorpay subscription status onto ours. */
export function mapStatus(status: RazorpaySubscription["status"]) {
  switch (status) {
    case "active":
    case "authenticated":
      return "ACTIVE" as const;
    case "pending":
    case "halted":
      return "PAST_DUE" as const;
    case "cancelled":
    case "paused":
      return "CANCELLED" as const;
    case "completed":
    case "expired":
      return "EXPIRED" as const;
    default:
      return null;
  }
}
