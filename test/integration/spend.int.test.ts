/**
 * Spend & billing: month-to-date spend per account, monthly budgets (alerts, pause at the
 * budget, a new month starting over), the platform's own spending limit, and billing alerts.
 */
import { checkSpendBudgets, connectors, dayInZone, refreshAccountBilling } from "@ashniva/core";
import type { AccountBilling, AdPlatformConnector } from "@ashniva/connectors";
import type { Platform } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as } from "../helpers/api";
import { prisma, resetDb } from "../helpers/db";
import { addMember, createConnection, createOrg, createUser } from "../helpers/factories";

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const TZ = "Asia/Kolkata";
const day = (d: Date) => new Date(`${dayInZone(d, TZ)}T00:00:00Z`);

async function campaign(adAccountId: string, platform: Platform, status: "ACTIVE" | "PAUSED" = "ACTIVE") {
  return prisma.campaign.create({
    data: { adAccountId, platform, externalId: `c-${Math.random().toString(36).slice(2)}`, name: `Campaign ${status}`, status },
  });
}

async function spend(adAccountId: string, platform: Platform, campaignId: string, date: Date, amount: number) {
  await prisma.metricDaily.create({
    data: { date, level: "CAMPAIGN", entityId: campaignId, adAccountId, campaignId, platform, spend: amount },
  });
}

/** An org with one sample META account in its workspace, a running campaign and `amount` spent today. */
async function setup(amount = 0, opts: { platform?: Platform } = {}) {
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner);
  const platform = opts.platform ?? "META";
  const { connection, adAccount } = await createConnection(org.id, { platform, workspaceId: workspace.id });
  const running = await campaign(adAccount.id, platform);
  if (amount) await spend(adAccount.id, platform, running.id, day(new Date()), amount);
  return { owner, org, workspace, connection, adAccount, running };
}

/** Replaces the connector for LIVE and DEMO alike with one whose billing is `billing()`. */
function fakeBilling(billing: () => AccountBilling) {
  const registry = connectors();
  const realGet = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((platform: Platform, mode: "LIVE" | "DEMO" = "LIVE") => {
    const real = realGet(platform, mode);
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { getBilling: async () => billing() }) as AdPlatformConnector;
  }) as never);
}

describe("GET /spend", () => {
  it("adds up this month's spend per account, leaves last month out, and links each platform's billing page", async () => {
    const { owner, workspace, adAccount, running } = await setup(1200);
    const lastMonth = new Date(`${dayInZone(new Date(), TZ).slice(0, 7)}-01T00:00:00Z`);
    lastMonth.setUTCDate(0);
    await spend(adAccount.id, "META", running.id, lastMonth, 999);
    await prisma.spendBudget.create({ data: { orgId: adAccount.orgId, adAccountId: adAccount.id, monthlyLimit: 4000 } });

    const res = await (await as(owner)).get(`/api/workspaces/${workspace.id}/spend`);

    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ monthSpend: 1200, monthlyBudget: 4000 });
    expect(res.body.platforms).toEqual([expect.objectContaining({ platform: "META", monthSpend: 1200, monthlyBudget: 4000, share: 1 })]);
    expect(res.body.accounts[0]).toMatchObject({
      id: adAccount.id,
      monthSpend: 1200,
      activeCampaigns: 1,
      sample: true,
      accountLimit: "spend_cap",
      readsBilling: true,
      budget: { monthlyLimit: 4000, alertPercent: 80, pauseAtLimit: false, pausedAt: null },
    });
    expect(res.body.accounts[0].billingUrl).toContain("business.facebook.com/billing_hub");
  });

  it("leaves hidden platforms out", async () => {
    const { owner, org, workspace } = await setup(100);
    const { adAccount: tiktok } = await createConnection(org.id, { platform: "TIKTOK", workspaceId: workspace.id });
    const res = await (await as(owner)).get(`/api/workspaces/${workspace.id}/spend`);
    expect(res.body.accounts.map((a: { id: string }) => a.id)).not.toContain(tiktok.id);
  });

  it("is readable by a client, who can't change budgets", async () => {
    const { org, workspace, adAccount } = await setup(100);
    const client = await createUser();
    await addMember(org.id, client, "CLIENT", [workspace.id]);
    const api = await as(client);
    expect((await api.get(`/api/workspaces/${workspace.id}/spend`)).status).toBe(200);
    expect((await api.put(`/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/spend-budget`).send({ monthlyLimit: 10 })).status).toBe(403);
  });
});

describe("monthly budgets", () => {
  it("a manager sets, changes and removes a budget, each change in the activity log", async () => {
    const { org, workspace, adAccount } = await setup();
    const manager = await createUser();
    await addMember(org.id, manager, "MANAGER", [workspace.id]);
    const api = await as(manager);
    const url = `/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/spend-budget`;

    expect((await api.put(url).send({ monthlyLimit: 5000, alertPercent: 90, pauseAtLimit: true })).status).toBe(200);
    expect(await prisma.spendBudget.findUniqueOrThrow({ where: { adAccountId: adAccount.id } })).toMatchObject({ alertPercent: 90, pauseAtLimit: true });
    expect((await api.put(url).send({ monthlyLimit: 8000 })).status).toBe(200);
    expect((await api.put(url).send({ monthlyLimit: null })).status).toBe(200);
    expect(await prisma.spendBudget.count()).toBe(0);

    const log = await prisma.auditLog.findMany({ where: { entityId: adAccount.id }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["ad_account.budget_set", "ad_account.budget_set", "ad_account.budget_removed"]);
  });

  it("rejects a zero or negative budget and an alert outside 10–99%", async () => {
    const { owner, workspace, adAccount } = await setup();
    const api = await as(owner);
    const url = `/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/spend-budget`;
    expect((await api.put(url).send({ monthlyLimit: 0 })).status).toBe(422);
    expect((await api.put(url).send({ monthlyLimit: -5 })).status).toBe(422);
    expect((await api.put(url).send({ monthlyLimit: 100, alertPercent: 100 })).status).toBe(422);
  });

  it("can't touch an account in another workspace", async () => {
    const { owner, org, workspace } = await setup();
    const other = await prisma.workspace.create({ data: { orgId: org.id, name: "Other", slug: "other" } });
    const { adAccount } = await createConnection(org.id, { workspaceId: other.id });
    const res = await (await as(owner)).put(`/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/spend-budget`).send({ monthlyLimit: 100 });
    expect(res.status).toBe(404);
  });
});

describe("checkSpendBudgets", () => {
  it("alerts once at the alert percent, then once at the budget", async () => {
    const { adAccount, running } = await setup(850);
    await prisma.spendBudget.create({ data: { orgId: adAccount.orgId, adAccountId: adAccount.id, monthlyLimit: 1000 } });

    expect(await checkSpendBudgets()).toMatchObject({ checked: 1, alerts: 1, paused: 0 });
    expect(await checkSpendBudgets()).toMatchObject({ alerts: 0 });
    const first = await prisma.notification.findMany({ where: { type: "spend.budget_alert" } });
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toContain("85%");
    expect(first[0]!.link).toBe(`/w/${adAccount.workspaceId}/spend`);

    await prisma.metricDaily.updateMany({ where: { adAccountId: adAccount.id, spend: 850 }, data: { spend: 1000 } });
    expect(await checkSpendBudgets()).toMatchObject({ alerts: 1, paused: 0 });
    expect(await prisma.notification.count({ where: { type: "spend.budget_reached" } })).toBe(1);
    // Not asked to pause: the campaign keeps running.
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("ACTIVE");
  });

  it("pauses the account's running campaigns at the budget when asked to, and logs who did it", async () => {
    const { adAccount, running } = await setup(1200);
    const paused = await campaign(adAccount.id, "META", "PAUSED");
    await prisma.spendBudget.create({ data: { orgId: adAccount.orgId, adAccountId: adAccount.id, monthlyLimit: 1000, pauseAtLimit: true } });

    expect(await checkSpendBudgets()).toMatchObject({ alerts: 1, paused: 1 });

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("PAUSED");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe("PAUSED");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: running.id, action: "campaign.paused" } });
    expect(JSON.stringify(log.changes)).toContain("Monthly budget");
    expect((await prisma.spendBudget.findFirstOrThrow()).pausedAt).not.toBeNull();
    const note = await prisma.notification.findFirstOrThrow({ where: { type: "spend.budget_reached" } });
    expect(note.body).toContain("1 running campaign was paused");

    // A second run doesn't pause again or repeat the alert.
    expect(await checkSpendBudgets()).toMatchObject({ alerts: 0, paused: 0 });
  });

  it("starts over in a new month, without resuming anything", async () => {
    const { adAccount, running } = await setup(1200);
    await prisma.campaign.update({ where: { id: running.id }, data: { status: "PAUSED" } });
    await prisma.spendBudget.create({
      data: { orgId: adAccount.orgId, adAccountId: adAccount.id, monthlyLimit: 1000, alertedMonth: "2020-01", alertedLevel: 2, pausedAt: new Date("2020-01-20") },
    });

    // This month's spend is over the budget again: one fresh alert, and the old pause is cleared.
    expect(await checkSpendBudgets()).toMatchObject({ alerts: 1 });
    const budget = await prisma.spendBudget.findFirstOrThrow();
    expect(budget.alertedMonth).toBe(dayInZone(new Date(), TZ).slice(0, 7));
    expect(budget.pausedAt).toBeNull();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: running.id } })).status).toBe("PAUSED");
  });

  it("skips organizations whose plan is inactive", async () => {
    const owner = await createUser();
    const { org, workspace } = await createOrg(owner, { plan: "TRIAL", subscriptionStatus: "EXPIRED", trialEndsAt: null });
    const { adAccount } = await createConnection(org.id, { workspaceId: workspace.id });
    const c = await campaign(adAccount.id, "META");
    await spend(adAccount.id, "META", c.id, day(new Date()), 5000);
    await prisma.spendBudget.create({ data: { orgId: org.id, adAccountId: adAccount.id, monthlyLimit: 10, pauseAtLimit: true } });
    expect(await checkSpendBudgets()).toMatchObject({ checked: 0, alerts: 0, paused: 0 });
  });

  it("a raised budget can alert again this month", async () => {
    const { owner, workspace, adAccount } = await setup(900);
    await prisma.spendBudget.create({ data: { orgId: adAccount.orgId, adAccountId: adAccount.id, monthlyLimit: 1000 } });
    await checkSpendBudgets();
    await (await as(owner)).put(`/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/spend-budget`).send({ monthlyLimit: 1100 });
    expect(await checkSpendBudgets()).toMatchObject({ alerts: 1 });
  });
});

describe("platform billing", () => {
  const ok: AccountBilling = { spendLimit: null, spentTowardLimit: 0, balanceDue: 0, fundsRemaining: null, health: "ok", note: null };

  it("tells people once when the platform starts blocking the account's ads", async () => {
    const { adAccount, connection } = await setup();
    let billing: AccountBilling = ok;
    fakeBilling(() => billing);
    const account = async () => ({ ...(await prisma.adAccount.findUniqueOrThrow({ where: { id: adAccount.id } })), connection });

    await refreshAccountBilling(await account());
    expect(await prisma.notification.count()).toBe(0);

    billing = { ...ok, health: "blocked", note: "Payment failed. Ads stop until the balance is paid." };
    await refreshAccountBilling(await account());
    await refreshAccountBilling(await account());

    const notes = await prisma.notification.findMany({ where: { type: "spend.billing_issue" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toContain("can't run");
    expect(notes[0]!.body).toContain("Payment failed");
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: adAccount.id } })).billing).toMatchObject({ health: "blocked" });
  });

  it("refresh reads billing on demand; platforms without billing are refused", async () => {
    const { owner, org, workspace, adAccount } = await setup();
    fakeBilling(() => ({ ...ok, balanceDue: 320 }));
    const api = await as(owner);
    const res = await api.post(`/api/workspaces/${workspace.id}/ad-accounts/${adAccount.id}/billing/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.platformBilling).toMatchObject({ balanceDue: 320, health: "ok" });

    const { adAccount: snap } = await createConnection(org.id, { platform: "SNAPCHAT", workspaceId: workspace.id });
    expect((await api.post(`/api/workspaces/${workspace.id}/ad-accounts/${snap.id}/billing/refresh`)).status).toBe(400);
  });

  it("an admin sets Meta's spending limit; a manager can't; platforms without one are refused", async () => {
    const { org, workspace } = await setup();
    // A sample account the demo connector knows, so its billing can be read back.
    const demoMeta = await prisma.adAccount.create({
      data: { orgId: org.id, connectionId: (await prisma.platformConnection.findFirstOrThrow()).id, platform: "META", externalId: "demo-meta-1001", name: "Sample", currency: "INR", timezone: TZ, status: "ACTIVE", workspaceId: workspace.id },
    });
    const admin = await createUser();
    const manager = await createUser();
    await addMember(org.id, admin, "ADMIN");
    await addMember(org.id, manager, "MANAGER", [workspace.id]);
    const url = `/api/workspaces/${workspace.id}/ad-accounts/${demoMeta.id}/spend-limit`;

    expect((await (await as(manager)).put(url).send({ amount: 50_000 })).status).toBe(403);
    const res = await (await as(admin)).put(url).send({ amount: 50_000 });
    expect(res.status).toBe(200);
    expect(res.body.platformBilling).toMatchObject({ spendLimit: 50_000 });
    expect(await prisma.auditLog.findFirst({ where: { action: "ad_account.spend_limit_changed", entityId: demoMeta.id } })).not.toBeNull();

    const { adAccount: li } = await createConnection(org.id, { platform: "LINKEDIN", workspaceId: workspace.id });
    expect((await (await as(admin)).put(`/api/workspaces/${workspace.id}/ad-accounts/${li.id}/spend-limit`).send({ amount: 10 })).status).toBe(400);
  });

  it("spend alerts are an email preference", async () => {
    const { owner } = await setup();
    const api = await as(owner);
    expect((await api.get("/api/notifications/preferences")).body.spendAlerts).toBe(true);
    const body = { ruleAlerts: true, reportCopies: true, lowAiBalance: true, syncFailures: true, spendAlerts: false };
    expect((await api.put("/api/notifications/preferences").send(body)).body.spendAlerts).toBe(false);
  });
});
