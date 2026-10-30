/**
 * Background worker (apps/worker/src/index.ts). The worker doesn't export its
 * job processors, so this file boots the real worker module with BullMQ's
 * Worker swapped for one that records each processor and never pulls jobs
 * (autorun off). Tests then hand the recorded processors job objects, which
 * runs exactly the worker's code against the test database and Redis.
 */
import { createSampleConnections, enqueueSync, getAutomationQueue, getSyncQueue } from "@ashniva/core";
import type { Job } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../helpers/db";
import { createConnection, isoDay, orgWith, resetAll, seedCampaign, stubFetch } from "./helpers";

type Processor = (job: Partial<Job> & { name: string; data: unknown }) => Promise<unknown>;

const captured = vi.hoisted(() => ({ processors: {} as Record<string, Processor>, workers: [] as { close: () => Promise<void> }[] }));

// The repo root doesn't depend on bullmq, so the mock names the worker's own copy.
vi.mock("../../../apps/worker/node_modules/bullmq", async (importOriginal) => {
  const real = await importOriginal<typeof import("bullmq")>();
  class RecordingWorker extends real.Worker {
    constructor(name: string, processor: unknown, opts: ConstructorParameters<typeof real.Worker>[2]) {
      super(name, processor as never, { ...opts!, autorun: false });
      captured.processors[name] ??= processor as Processor;
      captured.workers.push(this);
    }
  }
  return { ...real, Worker: RecordingWorker };
});

const job = (name: string, data: unknown = {}) => ({ name, data, discard: vi.fn() });
const sync = (connectionId: string) => captured.processors.sync!(job("connection", { connectionId, trigger: "manual" }));
const automation = (name: string, data: unknown = {}) => captured.processors.automation!(job(name, data));

async function clearQueues() {
  await getSyncQueue().obliterate({ force: true });
  await getAutomationQueue().obliterate({ force: true });
}

beforeAll(async () => {
  // The worker loads .env at start-up; point it at an empty file so the developer's keys stay out.
  process.env.ENV_FILE = "/dev/null";
  process.env.SYNC_INTERVAL_MINUTES = "100000";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  await clearQueues();
  await import("../../../apps/worker/src/index");
  expect(Object.keys(captured.processors).sort()).toEqual(["automation", "sync"]);
});
afterAll(async () => {
  await Promise.all(captured.workers.map((w) => w.close()));
  await clearQueues();
  await Promise.all([getSyncQueue().close(), getAutomationQueue().close()]);
});
beforeEach(async () => {
  await resetAll();
  await clearQueues();
});

describe("sync jobs", () => {
  it("syncs a sample connection end to end", async () => {
    const { org, workspace } = await orgWith();
    const ids = await createSampleConnections(org.id, workspace.id, null);
    const meta = await prisma.platformConnection.findFirstOrThrow({ where: { id: { in: ids }, platform: "META" } });

    const stats = (await sync(meta.id)) as { accounts: number; campaigns: number; ads: number; metricRows: number };
    expect(stats.accounts).toBe(1);
    expect(stats.campaigns).toBeGreaterThan(0);
    expect(stats.ads).toBeGreaterThan(0);
    expect(stats.metricRows).toBeGreaterThan(0);

    const conn = await prisma.platformConnection.findUniqueOrThrow({ where: { id: meta.id }, include: { adAccounts: true, syncRuns: true } });
    expect(conn).toMatchObject({ syncStatus: "SUCCESS", lastSyncError: null, status: "ACTIVE" });
    expect(conn.lastSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 120_000);
    expect(conn.syncRuns).toHaveLength(1);
    expect(conn.syncRuns[0]).toMatchObject({ status: "SUCCESS", trigger: "manual" });
    const accountId = conn.adAccounts[0]!.id;
    const metricRows = await prisma.metricDaily.count({ where: { adAccountId: accountId } });
    expect(metricRows).toBe(stats.metricRows);
    expect(await prisma.campaign.count({ where: { adAccountId: accountId } })).toBe(stats.campaigns);

    // The data shows on the workspace overview.
    const { as } = await import("../../helpers/api");
    const owner = await prisma.membership.findFirstOrThrow({ where: { orgId: org.id, role: "OWNER" } });
    const overview = await (await as({ id: owner.userId })).get(`/api/workspaces/${workspace.id}/overview?from=${isoDay(-29)}&to=${isoDay(0)}`);
    expect(overview.body.totals.spend).toBeGreaterThan(0);

    // A second sync updates rows in place.
    await sync(meta.id);
    expect(await prisma.metricDaily.count({ where: { adAccountId: accountId } })).toBe(metricRows);
  });

  it("discards a job whose credentials expired, marks the connection and tells admins", async () => {
    const { org, workspace } = await orgWith();
    const { connection } = await createConnection(org.id, { platform: "META", mode: "LIVE", workspaceId: workspace.id });
    stubFetch([["graph.facebook.com", { status: 400, json: { error: { message: "Error validating access token", code: 190 } } }]]);
    const j = job("connection", { connectionId: connection.id, trigger: "schedule" });
    await expect(captured.processors.sync!(j)).rejects.toThrow(/access token/);
    expect(j.discard).toHaveBeenCalledTimes(1);
    const conn = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id }, include: { syncRuns: true } });
    expect(conn).toMatchObject({ status: "EXPIRED", syncStatus: "FAILED" });
    expect(conn.syncRuns[0]).toMatchObject({ status: "FAILED" });
    expect(await prisma.notification.count({ where: { orgId: org.id, type: "integration.expired" } })).toBeGreaterThan(0);
  });

  it("lets a temporary platform error retry", async () => {
    const { org, workspace } = await orgWith();
    const { connection } = await createConnection(org.id, { platform: "META", mode: "LIVE", workspaceId: workspace.id });
    stubFetch([["graph.facebook.com", { status: 503, json: { error: { message: "Service temporarily unavailable", code: 2 } } }]]);
    const j = job("connection", { connectionId: connection.id, trigger: "schedule" });
    await expect(captured.processors.sync!(j)).rejects.toThrow();
    expect(j.discard).not.toHaveBeenCalled();
    const conn = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn).toMatchObject({ status: "ACTIVE", syncStatus: "FAILED" });
    expect(conn.lastSyncError).toMatch(/temporarily unavailable/);
    expect(await prisma.notification.count({ where: { orgId: org.id, type: "integration.sync_failed" } })).toBeGreaterThan(0);
  });

  it("fans out the periodic sync to healthy connections of active organizations only", async () => {
    const active = await orgWith();
    const locked = await orgWith("OWNER", { plan: "STARTER", subscriptionStatus: "EXPIRED" });
    const ok = await createConnection(active.org.id, { workspaceId: active.workspace.id });
    const expired = await createConnection(active.org.id, { workspaceId: active.workspace.id });
    await prisma.platformConnection.update({ where: { id: expired.connection.id }, data: { status: "EXPIRED" } });
    await createConnection(locked.org.id, { workspaceId: locked.workspace.id });
    const result = await captured.processors.sync!(job("sync-all", { connectionId: "", trigger: "schedule" }));
    expect(result).toEqual({ queued: 1 });
    const jobs = await getSyncQueue().getJobs(["waiting"]);
    expect(jobs.map((x) => x.data)).toEqual([{ connectionId: ok.connection.id, trigger: "schedule" }]);
  });

  it("enqueueSync queues again after the previous job failed, but never twice while one waits", async () => {
    const { org, workspace } = await orgWith();
    const { connection } = await createConnection(org.id, { workspaceId: workspace.id });
    await enqueueSync(connection.id, "manual");
    await enqueueSync(connection.id, "manual");
    expect((await getSyncQueue().getJobCounts("waiting")).waiting).toBe(1);

    // Fail it the way a worker would.
    const { Worker } = await vi.importActual<typeof import("bullmq")>("../../../apps/worker/node_modules/bullmq");
    const { redisConnection, SYNC_QUEUE } = await import("@ashniva/core");
    const w = new Worker(SYNC_QUEUE, null, { connection: redisConnection(), autorun: false });
    const taken = (await w.getNextJob("test-token"))!;
    expect(taken.id).toBe(`sync-${connection.id}`);
    await taken.discard();
    await taken.moveToFailed(new Error("boom"), "test-token");
    await w.close();
    expect(await (await getSyncQueue().getJob(`sync-${connection.id}`))!.getState()).toBe("failed");

    await enqueueSync(connection.id, "manual");
    const again = await getSyncQueue().getJob(`sync-${connection.id}`);
    expect(await again!.getState()).toBe("waiting");
    expect(again!.data).toEqual({ connectionId: connection.id, trigger: "manual" });
  });
});

describe("automation ticks", () => {
  const ruleData = (orgId: string, workspaceId: string, name: string, extra: Record<string, unknown> = {}) => ({
    orgId,
    workspaceId,
    name,
    scope: { platforms: [], campaignIds: [], minSpend: 0 },
    conditions: [{ metric: "spend", operator: "gt", value: 10 }],
    actions: [{ type: "PAUSE" }],
    lookbackDays: 7,
    ...extra,
  });

  it("queues due rules of non-archived workspaces only, and evaluates them", async () => {
    const { org, workspace } = await orgWith();
    const archived = await prisma.workspace.create({ data: { orgId: org.id, name: "Old", slug: `old-${Date.now()}`, archivedAt: new Date() } });
    const past = new Date(Date.now() - 60_000);
    const { adAccount } = await createConnection(org.id, { platform: "META", workspaceId: workspace.id });
    const { campaign } = await seedCampaign(adAccount, { spend: 500, date: isoDay(-1) });

    const due = await prisma.rule.create({ data: ruleData(org.id, workspace.id, "Pause big spenders", { nextRunAt: past }) as never });
    const neverRun = await prisma.rule.create({ data: ruleData(org.id, workspace.id, "Never run", { nextRunAt: null, conditions: [{ metric: "spend", operator: "gt", value: 1_000_000 }] }) as never });
    await prisma.rule.create({ data: ruleData(org.id, workspace.id, "Later", { nextRunAt: new Date(Date.now() + 3_600_000) }) as never });
    await prisma.rule.create({ data: ruleData(org.id, workspace.id, "Off", { nextRunAt: past, isActive: false }) as never });
    const inArchived = await prisma.rule.create({ data: ruleData(org.id, archived.id, "Archived", { nextRunAt: past }) as never });

    expect(await automation("rules-tick")).toEqual({ queued: 2 });
    const queued = await getAutomationQueue().getJobs(["waiting"]);
    const ruleIds = queued.filter((q) => q.name === "rule").map((q) => q.data.ruleId).sort();
    expect(ruleIds).toEqual([due.id, neverRun.id].sort());
    expect(ruleIds).not.toContain(inArchived.id);

    for (const id of ruleIds) await automation("rule", { ruleId: id });
    expect(await prisma.ruleRun.count({ where: { ruleId: inArchived.id } })).toBe(0);
    const run = await prisma.ruleRun.findFirstOrThrow({ where: { ruleId: due.id } });
    expect(run).toMatchObject({ status: "SUCCESS", evaluated: 1, matched: 1 });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("PAUSED");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: campaign.id, action: "campaign.paused" } });
    expect(log.changes).toMatchObject({ via: { to: "Rule: Pause big spenders" } });
    expect(await prisma.ruleRun.findFirstOrThrow({ where: { ruleId: neverRun.id } })).toMatchObject({ status: "SUCCESS", matched: 0 });
    // The schedule moves on, so the next tick doesn't pick them up again.
    const after = await prisma.rule.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    await getAutomationQueue().obliterate({ force: true });
    expect(await automation("rules-tick")).toEqual({ queued: 0 });
  });

  it("doesn't act for an organization on an inactive plan", async () => {
    const { org, workspace } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "EXPIRED" });
    const { adAccount } = await createConnection(org.id, { platform: "META", workspaceId: workspace.id });
    const { campaign } = await seedCampaign(adAccount, { spend: 500 });
    const rule = await prisma.rule.create({ data: ruleData(org.id, workspace.id, "Locked", { nextRunAt: new Date(Date.now() - 1000) }) as never });
    await expect(automation("rule", { ruleId: rule.id })).rejects.toThrow(/inactive plan/);
    expect(await prisma.ruleRun.findFirstOrThrow({ where: { ruleId: rule.id } })).toMatchObject({ status: "FAILED" });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ACTIVE");
  });

  it("queues due scheduled reports, skipping archived workspaces, and delivers them", async () => {
    const { org, workspace, owner } = await orgWith();
    const archived = await prisma.workspace.create({ data: { orgId: org.id, name: "Old", slug: `old-${Date.now()}`, archivedAt: new Date() } });
    const { adAccount } = await createConnection(org.id, { platform: "META", workspaceId: workspace.id });
    await seedCampaign(adAccount, { spend: 250 });
    const past = new Date(Date.now() - 60_000);
    const report = (workspaceId: string, name: string, extra: Record<string, unknown>) =>
      prisma.report.create({
        data: { orgId: org.id, workspaceId, name, config: { metrics: ["spend", "clicks"], dimension: "campaign", datePreset: "7d" }, recipients: ["client@example.test"], createdById: owner.id, ...extra } as never,
      });
    const due = await report(workspace.id, "Weekly spend", { scheduleFrequency: "DAILY", scheduleHour: 9, nextRunAt: past });
    await report(workspace.id, "Not yet", { scheduleFrequency: "DAILY", nextRunAt: new Date(Date.now() + 3_600_000) });
    await report(workspace.id, "Unscheduled", { scheduleFrequency: null, nextRunAt: past });
    const inArchived = await report(archived.id, "Archived", { scheduleFrequency: "DAILY", nextRunAt: past });

    expect(await automation("reports-tick")).toEqual({ queued: 1 });
    const queued = await getAutomationQueue().getJobs(["waiting"]);
    expect(queued.map((q) => q.data)).toEqual([{ reportId: due.id }]);
    expect(queued.map((q) => q.data.reportId)).not.toContain(inArchived.id);

    expect(await automation("report", { reportId: due.id })).toEqual({ ok: true });
    const run = await prisma.reportRun.findFirstOrThrow({ where: { reportId: due.id } });
    expect(run).toMatchObject({ status: "SUCCESS", recipients: ["client@example.test"] });
    const after = await prisma.report.findUniqueOrThrow({ where: { id: due.id } });
    expect(after.lastRunAt).not.toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.reportRun.count({ where: { reportId: inArchived.id } })).toBe(0);
  });

  it("scheduled reports stop for an organization on an inactive plan", async () => {
    const { org, workspace, owner } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "EXPIRED" });
    const report = await prisma.report.create({
      data: { orgId: org.id, workspaceId: workspace.id, name: "Weekly", config: { metrics: ["spend"], dimension: "campaign", datePreset: "7d" }, recipients: ["client@example.test"], scheduleFrequency: "DAILY", nextRunAt: new Date(Date.now() - 60_000), createdById: owner.id } as never,
    });
    await automation("reports-tick");
    const queued = (await getAutomationQueue().getJobs(["waiting"])).filter((q) => q.name === "report");
    for (const q of queued) await automation("report", q.data).catch(() => undefined);
    expect(await prisma.reportRun.count({ where: { reportId: report.id, status: "SUCCESS" } })).toBe(0);
  });
});
