import { addDays, type RuleRunDetail } from "@ashniva/shared";
import type { Prisma } from "@ashniva/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { addMember, createOrg, createUser } from "../../../test/helpers/factories";
import { encryptSecret } from "../src/crypto";
import { todayIn } from "../src/reports";
import { evaluateRule } from "../src/rules";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

let orgId: string;
let workspaceId: string;
let ownerId: string;
let accountId: string;
const today = () => todayIn("Asia/Kolkata");

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const owner = await createUser();
  ownerId = owner.id;
  const { org, workspace } = await createOrg(owner);
  orgId = org.id;
  workspaceId = workspace.id;
  const connection = await prisma.platformConnection.create({ data: { orgId, platform: "META", mode: "DEMO", externalUserId: "sample-meta", accessTokenEnc: encryptSecret("x") } });
  accountId = (await prisma.adAccount.create({ data: { orgId, connectionId: connection.id, platform: "META", externalId: "demo-meta-1001", name: "Meta", currency: "INR", status: "ACTIVE", workspaceId } })).id;
});

afterEach(() => vi.restoreAllMocks());

let n = 0;
async function campaign(name: string, opts: { status?: "ACTIVE" | "PAUSED" | "REMOVED"; dailyBudget?: number | null; adAccountId?: string; platform?: "META" | "GOOGLE" } = {}) {
  return prisma.campaign.create({
    data: {
      adAccountId: opts.adAccountId ?? accountId,
      platform: opts.platform ?? "META",
      externalId: `c${n++}`,
      name,
      status: opts.status ?? "ACTIVE",
      dailyBudget: opts.dailyBudget === undefined ? 1000 : opts.dailyBudget,
      raw: { daily_budget: "1000" },
    },
  });
}

async function metrics(c: { id: string; adAccountId: string; platform: "META" | "GOOGLE" }, m: { spend: number; impressions?: number; clicks?: number; conversions?: number; conversionValue?: number }, daysAgo = 0) {
  await prisma.metricDaily.create({
    data: {
      date: new Date(`${addDays(today(), -daysAgo)}T00:00:00Z`),
      level: "CAMPAIGN",
      entityId: c.id,
      adAccountId: c.adAccountId,
      campaignId: c.id,
      platform: c.platform,
      impressions: m.impressions ?? 10_000,
      clicks: m.clicks ?? 100,
      spend: m.spend,
      conversions: m.conversions ?? 0,
      conversionValue: m.conversionValue ?? 0,
    },
  });
}

async function rule(over: Partial<Prisma.RuleUncheckedCreateInput> = {}) {
  return prisma.rule.create({
    data: {
      orgId,
      workspaceId,
      name: "Pause costly",
      scope: {},
      conditionLogic: "ALL",
      conditions: [{ metric: "cpa", operator: "gt", value: 200 }],
      actions: [{ type: "PAUSE" }],
      lookbackDays: 3,
      cooldownHours: 24,
      createdById: ownerId,
      ...over,
    },
  });
}

const details = (run: { details: unknown }) => run.details as RuleRunDetail[];

describe("evaluateRule", () => {
  it("pauses matching campaigns, audits, notifies and schedules the next run", async () => {
    const costly = await campaign("Costly");
    const fine = await campaign("Fine");
    await metrics(costly, { spend: 1000, conversions: 2 }); // CPA 500
    await metrics(fine, { spend: 1000, conversions: 20 }); // CPA 50
    const r = await rule({ actions: [{ type: "PAUSE" }, { type: "NOTIFY", email: true }] });

    const run = await evaluateRule(r.id);
    expect(run).toMatchObject({ status: "SUCCESS", dryRun: false, evaluated: 2, matched: 1 });
    expect(details(run)).toEqual([
      { campaignId: costly.id, campaignName: "Costly", platform: "META", values: { cpa: 500 }, actions: [{ type: "PAUSE", ok: true }, { type: "NOTIFY", ok: true }] },
    ]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: costly.id } })).status).toBe("PAUSED");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fine.id } })).status).toBe("ACTIVE");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "campaign.paused" } });
    expect(log).toMatchObject({ entityId: costly.id, userId: null, entityName: "Costly (Meta Ads)" });
    expect(log.changes).toEqual({ status: { from: "ACTIVE", to: "PAUSED" }, via: { from: null, to: "Rule: Pause costly" } });

    const note = await prisma.notification.findFirstOrThrow({ where: { type: "rule.triggered" } });
    expect(note).toMatchObject({ userId: ownerId, workspaceId, title: "Rule “Pause costly” matched 1 campaign", link: `/w/${workspaceId}/automations/${r.id}` });
    expect(note.body).toContain("Cost / conv. is greater than");
    expect(note.body).toContain("Actions: pause the campaign.");
    expect(note.body).toContain("Costly");

    const after = await prisma.rule.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.lastRunAt).toBeInstanceOf(Date);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(await prisma.ruleTarget.count({ where: { ruleId: r.id, campaignId: costly.id } })).toBe(1);
  });

  it("skips campaigns in cooldown and does not notify again", async () => {
    const c = await campaign("Costly");
    await metrics(c, { spend: 1000, conversions: 1 });
    const r = await rule({ actions: [{ type: "DECREASE_BUDGET", percent: 10 }, { type: "NOTIFY" }] });
    await evaluateRule(r.id);
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget)).toBe(900);
    expect(await prisma.notification.count()).toBe(1);

    const second = await evaluateRule(r.id);
    expect(details(second)[0]!.actions).toEqual([{ type: "SKIPPED", ok: true, detail: expect.stringMatching(/^In cooldown until /) }]);
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget)).toBe(900);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("acts again once the cooldown has passed", async () => {
    const c = await campaign("Costly");
    await metrics(c, { spend: 1000, conversions: 1 });
    const r = await rule({ actions: [{ type: "DECREASE_BUDGET", percent: 10 }], cooldownHours: 1 });
    await prisma.ruleTarget.create({ data: { ruleId: r.id, campaignId: c.id, lastActionAt: new Date(Date.now() - 2 * 3600_000) } });
    const run = await evaluateRule(r.id);
    expect(details(run)[0]!.actions).toEqual([{ type: "DECREASE_BUDGET", ok: true, detail: "1000 → 900" }]);
  });

  it("previews without changing anything, even on a locked organization", async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { plan: "TRIAL", trialEndsAt: new Date(Date.now() - 1000) } });
    const c = await campaign("Costly");
    await metrics(c, { spend: 1000, conversions: 1 });
    const r = await rule({ actions: [{ type: "PAUSE" }, { type: "NOTIFY" }] });
    const run = await evaluateRule(r.id, { dryRun: true });
    expect(run.dryRun).toBe(true);
    expect(details(run)[0]!.actions).toEqual([
      { type: "PAUSE", ok: true, detail: "Would run (preview)" },
      { type: "NOTIFY", ok: true, detail: "Would run (preview)" },
    ]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
    expect(await prisma.ruleTarget.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
    expect((await prisma.rule.findUniqueOrThrow({ where: { id: r.id } })).lastRunAt).toBeNull();
  });

  it("fails (and still reschedules) when the organization is locked", async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { subscriptionStatus: "EXPIRED" } });
    const r = await rule({ frequency: "HOURLY" });
    await expect(evaluateRule(r.id)).rejects.toThrow("Organization is on an inactive plan; automation is paused.");
    const run = await prisma.ruleRun.findFirstOrThrow({ where: { ruleId: r.id } });
    expect(run).toMatchObject({ status: "FAILED", error: "Organization is on an inactive plan; automation is paused." });
    const after = await prisma.rule.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.nextRunAt!.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000);
    expect(after.lastRunAt).toBeInstanceOf(Date);
  });

  it("fails on stored conditions that no longer validate", async () => {
    const r = await rule({ conditions: [{ metric: "nope", operator: "gt", value: 1 }] });
    await expect(evaluateRule(r.id)).rejects.toThrow();
    expect((await prisma.ruleRun.findFirstOrThrow({ where: { ruleId: r.id } })).status).toBe("FAILED");
  });

  it("raises budgets by a percentage up to the cap", async () => {
    const a = await campaign("A", { dailyBudget: 1000 });
    const b = await campaign("B", { dailyBudget: 1000 });
    const capped = await campaign("Capped", { dailyBudget: 1100 });
    for (const c of [a, b, capped]) await metrics(c, { spend: 500, conversions: 10, conversionValue: 3000 }); // ROAS 6
    const r = await rule({ conditions: [{ metric: "roas", operator: "gte", value: 4 }], actions: [{ type: "INCREASE_BUDGET", percent: 20, maxBudget: 1100 }], scope: { campaignIds: [a.id, capped.id] } });
    const run = await evaluateRule(r.id);
    const by = Object.fromEntries(details(run).map((d) => [d.campaignName, d.actions[0]]));
    expect(by).toEqual({
      A: { type: "INCREASE_BUDGET", ok: true, detail: "1000 → 1100" },
      Capped: { type: "INCREASE_BUDGET", ok: true, detail: "Already at the budget cap" },
    });
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id: a.id } })).dailyBudget)).toBe(1100);
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id: b.id } })).dailyBudget)).toBe(1000);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: a.id } });
    expect(updated.raw).toEqual({ daily_budget: "1100" });
    expect(await prisma.auditLog.count({ where: { action: "campaign.budget_changed" } })).toBe(1);
  });

  it("an increase never lowers a budget that is already above the cap", async () => {
    const c = await campaign("Big", { dailyBudget: 2000 });
    await metrics(c, { spend: 500, conversions: 10, conversionValue: 3000 });
    const r = await rule({ conditions: [{ metric: "roas", operator: "gte", value: 4 }], actions: [{ type: "INCREASE_BUDGET", percent: 10, maxBudget: 1500 }] });
    await evaluateRule(r.id);
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).dailyBudget)).toBeGreaterThanOrEqual(2000);
  });

  it("reports a budget action on a campaign without a daily budget as failed", async () => {
    const c = await campaign("Lifetime", { dailyBudget: null });
    await metrics(c, { spend: 500, conversions: 1 });
    const r = await rule({ actions: [{ type: "DECREASE_BUDGET" }] });
    const run = await evaluateRule(r.id);
    expect(details(run)[0]!.actions).toEqual([{ type: "DECREASE_BUDGET", ok: false, error: "Campaign has no daily budget" }]);
    expect(run.status).toBe("SUCCESS");
  });

  it("only activates paused campaigns and only pauses active ones", async () => {
    const paused = await campaign("Paused", { status: "PAUSED" });
    const active = await campaign("Active");
    const removed = await campaign("Removed", { status: "REMOVED" });
    for (const c of [paused, active, removed]) await metrics(c, { spend: 100, conversions: 10 });
    const activate = await rule({ conditions: [{ metric: "cpa", operator: "lt", value: 50 }], actions: [{ type: "ACTIVATE" }] });
    const run = await evaluateRule(activate.id);
    expect(run.evaluated).toBe(1);
    expect(details(run).map((d) => d.campaignName)).toEqual(["Paused"]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: paused.id } })).status).toBe("ACTIVE");
    expect(await prisma.auditLog.count({ where: { action: "campaign.activated" } })).toBe(1);
  });

  it("applies the scope: platforms, minimum spend and lookback window", async () => {
    const gConn = await prisma.platformConnection.create({ data: { orgId, platform: "GOOGLE", mode: "DEMO", externalUserId: "g" } });
    const gAcc = await prisma.adAccount.create({ data: { orgId, connectionId: gConn.id, platform: "GOOGLE", externalId: "demo-google-7781", name: "G", currency: "INR", status: "ACTIVE", workspaceId } });
    const meta = await campaign("Meta big");
    const small = await campaign("Meta small");
    const old = await campaign("Meta old");
    const google = await campaign("Google", { adAccountId: gAcc.id, platform: "GOOGLE" });
    await metrics(meta, { spend: 1000 });
    await metrics(small, { spend: 10 });
    await metrics(old, { spend: 1000 }, 10); // outside the 3-day lookback
    await metrics(google, { spend: 1000 });
    const r = await rule({ conditions: [{ metric: "spend", operator: "gt", value: 0 }], scope: { platforms: ["META"], minSpend: 100 }, actions: [{ type: "NOTIFY" }] });
    const run = await evaluateRule(r.id);
    expect(details(run).map((d) => d.campaignName)).toEqual(["Meta big"]);
    expect(run.evaluated).toBe(1);
  });

  it("supports ANY logic and CTR entered as a percentage", async () => {
    const lowCtr = await campaign("Low CTR");
    const highCpc = await campaign("High CPC");
    const good = await campaign("Good");
    await metrics(lowCtr, { spend: 100, impressions: 10_000, clicks: 50 }); // CTR 0.5%, CPC 2
    await metrics(highCpc, { spend: 5000, impressions: 1000, clicks: 100 }); // CTR 10%, CPC 50
    await metrics(good, { spend: 100, impressions: 1000, clicks: 100 }); // CTR 10%, CPC 1
    const r = await rule({
      conditionLogic: "ANY",
      conditions: [
        { metric: "ctr", operator: "lt", value: 1 },
        { metric: "cpc", operator: "gt", value: 20 },
      ],
      actions: [{ type: "NOTIFY", email: false }],
    });
    const run = await evaluateRule(r.id);
    const d = details(run);
    expect(d.map((x) => x.campaignName).sort()).toEqual(["High CPC", "Low CTR"]);
    expect(d.find((x) => x.campaignName === "Low CTR")!.values.ctr).toBeCloseTo(0.5);
    const note = await prisma.notification.findFirstOrThrow();
    expect(note.title).toBe("Rule “Pause costly” matched 2 campaigns");
    expect(note.body).toContain(" or ");
  });

  it("notifies the rule's author too, and summarizes long lists", async () => {
    const author = await createUser();
    await addMember(orgId, author, "MANAGER", [workspaceId]);
    const cs = [];
    for (let i = 0; i < 7; i++) cs.push(await campaign(`C${i}`));
    for (const c of cs) await metrics(c, { spend: 100 });
    const r = await rule({ createdById: author.id, conditions: [{ metric: "spend", operator: "gte", value: 100 }], actions: [{ type: "NOTIFY" }] });
    await evaluateRule(r.id);
    const notes = await prisma.notification.findMany({ where: { type: "rule.triggered" } });
    expect(new Set(notes.map((x) => x.userId))).toEqual(new Set([ownerId, author.id]));
    expect(notes[0]!.body).toContain("and 2 more");
  });

  it("records who ran a manual evaluation in the audit log", async () => {
    const c = await campaign("Costly");
    await metrics(c, { spend: 1000, conversions: 1 });
    const r = await rule();
    await evaluateRule(r.id, { userId: ownerId });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "campaign.paused" } })).userId).toBe(ownerId);
  });
});
