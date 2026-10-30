/**
 * Account billing (getBilling / setSpendLimit): Meta spend cap, Google account budgets,
 * Microsoft financial status and the sample connector.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_ACCOUNTS, DemoConnector, resetDemoBilling } from "../../src/demo";
import { GoogleAdsConnector } from "../../src/google";
import { MetaConnector, metaBillingHealth } from "../../src/meta";
import { MicrosoftAdsConnector, microsoftBillingHealth } from "../../src/microsoft";
import { account, auth } from "../msw/fixtures";
import { GRAPH, metaConfig, metaError } from "../msw/handlers/meta";
import { ADS, googleConfig, googleSearch } from "../msw/handlers/google";
import { MS_CUSTOMER, msPost } from "../msw/handlers/microsoft";
import { hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";

useMswServer();

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as { code: string; message: string });

describe("Meta billing", () => {
  const meta = () => new MetaConnector(metaConfig);
  const actGet = (body: Record<string, unknown>) => http.get(`${GRAPH}/act_123`, () => HttpResponse.json({ id: "act_123", ...body }));

  it("reads spend cap, amount spent and balance from minor units (paise) to rupees", async () => {
    server.use(actGet({ spend_cap: "5000000", amount_spent: "1234550", balance: "45000", account_status: 1, currency: "INR" }));
    const billing = await meta().getBilling(auth(), account("123", { currency: "INR" }));
    expect(billing).toEqual({ spendLimit: 50_000, spentTowardLimit: 12_345.5, balanceDue: 450, fundsRemaining: null, health: "ok", note: null });
    const hit = await onlyHit({ path: "/act_123" });
    expect(hit.url.searchParams.get("fields")).toBe("spend_cap,amount_spent,balance,account_status,disable_reason,currency");
    expect(hit.url.searchParams.get("access_token")).toBe("access-1");
  });

  it("keeps zero-decimal currencies (JPY) as they are", async () => {
    server.use(actGet({ spend_cap: "300000", amount_spent: "120000", balance: "500", account_status: 1, currency: "JPY" }));
    const billing = await meta().getBilling(auth(), account("123", { currency: "JPY" }));
    expect(billing).toMatchObject({ spendLimit: 300_000, spentTowardLimit: 120_000, balanceDue: 500 });
  });

  it("treats a spend cap of 0 or none as no limit", async () => {
    server.use(actGet({ spend_cap: "0", amount_spent: "999900", balance: "0", account_status: 1 }));
    expect(await meta().getBilling(auth(), account("123"))).toMatchObject({ spendLimit: null, spentTowardLimit: 9999, health: "ok" });
    server.use(actGet({ amount_spent: "100", account_status: 1 }));
    expect(await meta().getBilling(auth(), account("123"))).toMatchObject({ spendLimit: null, balanceDue: null });
  });

  it("flags an account near or at its spend cap", async () => {
    server.use(actGet({ spend_cap: "100000", amount_spent: "92000", account_status: 1 }));
    expect(await meta().getBilling(auth(), account("123"))).toMatchObject({ health: "attention", note: "92% of the spending limit used." });
    server.use(actGet({ spend_cap: "100000", amount_spent: "100000", account_status: 1 }));
    expect(await meta().getBilling(auth(), account("123"))).toMatchObject({ health: "blocked", note: expect.stringContaining("Spending limit reached") });
  });

  it.each([
    [1, "ok"],
    [2, "blocked"],
    [3, "blocked"],
    [7, "attention"],
    [8, "blocked"],
    [9, "attention"],
    [100, "blocked"],
    [101, "blocked"],
    [undefined, "unknown"],
  ] as const)("account_status %s → %s", (status, health) => {
    expect(metaBillingHealth(status, null, null).health).toBe(health);
  });

  it("an unsettled account is blocked for payment even under its cap", () => {
    expect(metaBillingHealth(3, 1000, 10)).toEqual({ health: "blocked", note: "Payment failed. Ads stop until the balance is paid." });
  });

  it("sets the spend cap in the currency's basic unit (rupees, not paise)", async () => {
    server.use(http.post(`${GRAPH}/act_123`, () => HttpResponse.json({ success: true })));
    await meta().setSpendLimit(auth(), account("123", { currency: "INR" }), 5000);
    const hit = await onlyHit({ method: "POST", path: "/act_123" });
    expect(Object.fromEntries(hit.form!)).toEqual({ spend_cap: "5000.00", access_token: "access-1" });
  });

  it("sends whole yen for JPY and removes the cap with spend_cap_action=delete", async () => {
    server.use(http.post(`${GRAPH}/act_123`, () => HttpResponse.json({ success: true })));
    await meta().setSpendLimit(auth(), account("123", { currency: "JPY" }), 30000.4);
    await meta().setSpendLimit(auth(), account("123"), null);
    const [jpy, del] = await hits({ method: "POST" });
    expect(jpy!.form!.get("spend_cap")).toBe("30000");
    expect(Object.fromEntries(del!.form!)).toEqual({ spend_cap_action: "delete", access_token: "access-1" });
  });

  it("surfaces Meta's error when the cap is rejected", async () => {
    server.use(http.post(`${GRAPH}/act_123`, () => metaError(400, 100, "Spend cap must be above the amount spent")));
    const err = await errorOf(meta().setSpendLimit(auth(), account("123"), 1));
    expect(err).toMatchObject({ code: "INVALID_REQUEST", message: "Spend cap must be above the amount spent" });
  });
});

describe("Google billing", () => {
  const g = () => new GoogleAdsConnector(googleConfig);
  const acct = account("1112223333", { currency: "INR", meta: { loginCustomerId: "9998887777" } });
  const budget = (over: Record<string, unknown> = {}) => ({
    accountBudget: {
      resourceName: "customers/1112223333/accountBudgets/555",
      status: "APPROVED",
      approvedSpendingLimitMicros: "100000000000",
      amountServedMicros: "25500000000",
      billingSetup: "customers/1112223333/billingSetups/7",
      ...over,
    },
  });
  const mutate = () => http.post(`${ADS}/customers/:cid/accountBudgetProposals\\:mutate`, () => HttpResponse.json({ result: { resourceName: "customers/1112223333/accountBudgetProposals/1" } }));

  it("reads the approved account budget in micros", async () => {
    server.use(googleSearch({ customer: [{ customer: { status: "ENABLED" } }], account_budget: [budget()] }));
    const billing = await g().getBilling(auth(), acct);
    expect(billing).toEqual({ spendLimit: 100_000, spentTowardLimit: 25_500, balanceDue: null, fundsRemaining: 74_500, health: "ok", note: null });
    const queries = (await hits({ path: "googleAds:search" })).map((h) => h.json.query as string);
    expect(queries.some((q) => /FROM account_budget/.test(q) && /status = 'APPROVED'/.test(q))).toBe(true);
    expect((await hits({ path: "googleAds:search" }))[0]!.headers.get("login-customer-id")).toBe("9998887777");
  });

  it("reports no limit for card-paid accounts and an unlimited (INFINITE) budget", async () => {
    server.use(googleSearch({ customer: [{ customer: { status: "ENABLED" } }], account_budget: [] }));
    expect(await g().getBilling(auth(), acct)).toMatchObject({ spendLimit: null, spentTowardLimit: null, health: "ok" });
    server.use(googleSearch({ customer: [{ customer: { status: "ENABLED" } }], account_budget: [budget({ approvedSpendingLimitMicros: undefined, approvedSpendingLimitType: "INFINITE" })] }));
    expect(await g().getBilling(auth(), acct)).toMatchObject({ spendLimit: null, spentTowardLimit: 25_500, fundsRemaining: null });
  });

  it("ignores an approved budget whose end date has passed", async () => {
    server.use(googleSearch({ customer: [{ customer: { status: "ENABLED" } }], account_budget: [budget({ approvedEndDateTime: "2020-01-31 23:59:59" })] }));
    expect(await g().getBilling(auth(), acct)).toMatchObject({ spendLimit: null });
  });

  it("marks suspended accounts and nearly spent budgets", async () => {
    server.use(googleSearch({ customer: [{ customer: { status: "SUSPENDED" } }], account_budget: [] }));
    expect(await g().getBilling(auth(), acct)).toMatchObject({ health: "blocked" });
    server.use(googleSearch({ customer: [{ customer: { status: "ENABLED" } }], account_budget: [budget({ amountServedMicros: "95000000000" })] }));
    expect(await g().getBilling(auth(), acct)).toMatchObject({ health: "attention", note: "95% of the account budget used." });
  });

  it("proposes a new spending limit for the approved budget", async () => {
    server.use(googleSearch({ account_budget: [budget()] }), mutate());
    await g().setSpendLimit(auth(), acct, 150000.555);
    const hit = await onlyHit({ path: "accountBudgetProposals:mutate" });
    expect(hit.url.pathname).toBe("/v21/customers/1112223333/accountBudgetProposals:mutate");
    expect(hit.headers.get("login-customer-id")).toBe("9998887777");
    expect(hit.json).toEqual({
      operation: {
        create: {
          proposalType: "UPDATE",
          accountBudget: "customers/1112223333/accountBudgets/555",
          proposedSpendingLimitMicros: "150000560000",
        },
      },
    });
  });

  it("removing the limit proposes an INFINITE spending limit", async () => {
    server.use(googleSearch({ account_budget: [budget()] }), mutate());
    await g().setSpendLimit(auth(), acct, null);
    const hit = await onlyHit({ path: "accountBudgetProposals:mutate" });
    expect(hit.json.operation.create).toEqual({ proposalType: "UPDATE", accountBudget: "customers/1112223333/accountBudgets/555", proposedSpendingLimitType: "INFINITE" });
  });

  it("refuses accounts without an account budget (paid by card), sending nothing", async () => {
    server.use(googleSearch({ account_budget: [] }));
    const err = await errorOf(g().setSpendLimit(auth(), acct, 1000));
    expect(err).toMatchObject({ code: "UNSUPPORTED", message: expect.stringContaining("paid by card") });
    expect(await hits({ path: "accountBudgetProposals:mutate" })).toHaveLength(0);
  });
});

describe("Microsoft billing", () => {
  const ms = () => new MicrosoftAdsConnector({ clientId: "c", clientSecret: "s", developerToken: "d", tenant: "common" });

  it("reads AccountFinancialStatus from Account/Query", async () => {
    server.use(msPost(MS_CUSTOMER, "/Account/Query", { Account: { Id: 149, AccountFinancialStatus: "Hold", AccountLifeCycleStatus: "Active" } }));
    const billing = await ms().getBilling(auth(), account("149"));
    expect(billing).toMatchObject({ spendLimit: null, balanceDue: null, health: "blocked", note: expect.stringContaining("Billing hold") });
    expect((await onlyHit({ path: "/Account/Query" })).json).toEqual({ AccountId: 149 });
  });

  it.each([
    ["ClearFinancialStatus", "Active", "ok"],
    ["CreditWarning", "Active", "attention"],
    ["PendingCreditCheck", "Active", "attention"],
    ["SoldToAndBillToOnHold", "Active", "blocked"],
    ["ClearFinancialStatus", "Suspended", "blocked"],
    ["ClearFinancialStatus", "Pause", "attention"],
    [undefined, undefined, "unknown"],
  ] as const)("%s / %s → %s", (financial, lifecycle, health) => {
    expect(microsoftBillingHealth(financial, lifecycle).health).toBe(health);
  });
});

describe("Sample billing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    resetDemoBilling();
  });
  afterEach(async () => {
    expect(await hits()).toEqual([]);
    vi.useRealTimers();
  });

  const ref = (platform: keyof typeof DEMO_ACCOUNTS) => {
    const a = DEMO_ACCOUNTS[platform]!;
    return { externalId: a.externalId, currency: a.currency, timezone: a.timezone };
  };

  it("gives the Meta sample a spend cap above this month's spend and a recent balance", async () => {
    const billing = await new DemoConnector("META").getBilling(auth(), ref("META"));
    expect(billing.spendLimit).toBeGreaterThan(billing.spentTowardLimit!);
    expect(billing.spentTowardLimit).toBeGreaterThan(0);
    expect(billing.balanceDue).toBeGreaterThan(0);
    expect(billing.health).toBe("ok");
    // Deterministic: the same day gives the same numbers.
    expect(await new DemoConnector("META").getBilling(auth(), ref("META"))).toEqual(billing);
  });

  it("keeps a limit set from the app, and removing it leaves no limit", async () => {
    const meta = new DemoConnector("META");
    const before = await meta.getBilling(auth(), ref("META"));
    await meta.setSpendLimit(auth(), ref("META"), before.spentTowardLimit! / 0.95);
    expect(await meta.getBilling(auth(), ref("META"))).toMatchObject({ health: "attention", note: "95% of the spending limit used." });
    await meta.setSpendLimit(auth(), ref("META"), null);
    expect(await meta.getBilling(auth(), ref("META"))).toMatchObject({ spendLimit: null, health: "ok" });
  });

  it("other sample platforms are ok with no limits, and refuse a spending limit", async () => {
    for (const platform of Object.keys(DEMO_ACCOUNTS).filter((p) => p !== "META" && p !== "GOOGLE") as (keyof typeof DEMO_ACCOUNTS)[]) {
      const c = new DemoConnector(platform);
      expect(await c.getBilling(auth(), ref(platform))).toEqual({ spendLimit: null, spentTowardLimit: null, balanceDue: null, fundsRemaining: null, health: "ok", note: null });
      expect(await errorOf(c.setSpendLimit(auth(), ref(platform), 100))).toMatchObject({ code: "UNSUPPORTED" });
    }
  });

  it("Google sample has an account budget with funds remaining", async () => {
    const billing = await new DemoConnector("GOOGLE").getBilling(auth(), ref("GOOGLE"));
    expect(billing.fundsRemaining).toBeCloseTo(billing.spendLimit! - billing.spentTowardLimit!, 2);
    expect(billing.balanceDue).toBeNull();
  });
});
