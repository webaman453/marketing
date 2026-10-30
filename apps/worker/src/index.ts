/**
 * Background worker:
 *  - sync queue: platform data syncs and the periodic re-sync fan-out
 *  - automation queue: automation rules, scheduled report emails and monthly spend budgets
 */
import { loadEnv } from "@ashniva/core";

loadEnv();

const { Worker } = await import("bullmq");
const { isConnectorError } = await import("@ashniva/connectors");
const { prisma } = await import("@ashniva/db");
const {
  AUTOMATION_QUEUE,
  SYNC_QUEUE,
  checkSpendBudgets,
  deliverReport,
  enqueueSync,
  evaluateRule,
  getAutomationQueue,
  getSyncQueue,
  isOrgLocked,
  loadPlatformSettings,
  redisConnection,
  refreshRates,
  syncConnection,
} = await import("@ashniva/core");

const log = (msg: string, extra?: unknown) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`, extra ?? "");

const intervalMin = Number(process.env.SYNC_INTERVAL_MINUTES ?? 180);

// Keys and prices from the admin console; refreshed before each job (cached for a few seconds).
await loadPlatformSettings(true).catch((err: unknown) => log("Couldn't load platform settings; using .env only", err));
const refreshSettings = () => loadPlatformSettings().catch(() => undefined);

// ───────── Sync ─────────

const syncWorker = new Worker(
  SYNC_QUEUE,
  async (job) => {
    await refreshSettings();
    if (job.name === "sync-all") {
      // Fan out one job per healthy connection whose org is on an active plan.
      const connections = await prisma.platformConnection.findMany({
        where: { status: "ACTIVE" },
        select: { id: true, org: { select: { plan: true, trialEndsAt: true, subscriptionStatus: true, currentPeriodEnd: true } } },
      });
      const active = connections.filter((c) => !isOrgLocked(c.org));
      for (const c of active) await enqueueSync(c.id, "schedule");
      return { queued: active.length };
    }

    const { connectionId, trigger } = job.data;
    log(`sync start ${connectionId} (${trigger})`);
    try {
      const stats = await syncConnection(connectionId, trigger);
      log(`sync done ${connectionId}`, stats);
      return stats;
    } catch (err) {
      // Expired credentials or missing permissions won't fix themselves; don't retry.
      if (isConnectorError(err) && !err.retryable) {
        log(`sync failed permanently ${connectionId}: ${err.message}`);
        await job.discard();
      }
      throw err;
    }
  },
  { connection: redisConnection(), concurrency: 4 },
);

// ───────── Automation ─────────

const automationWorker = new Worker(
  AUTOMATION_QUEUE,
  async (job) => {
    await refreshSettings();
    const queue = getAutomationQueue();
    const now = new Date();
    switch (job.name) {
      case "rules-tick": {
        const due = await prisma.rule.findMany({
          where: { isActive: true, workspace: { archivedAt: null }, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
          select: { id: true, nextRunAt: true },
        });
        // The due time is part of the id so a failed run can't block later runs.
        for (const r of due) await queue.add("rule", { ruleId: r.id }, { jobId: `rule-${r.id}-${r.nextRunAt?.getTime() ?? 0}` });
        return { queued: due.length };
      }
      case "reports-tick": {
        const scheduled = await prisma.report.findMany({
          where: { scheduleFrequency: { not: null }, nextRunAt: { lte: now }, workspace: { archivedAt: null } },
          select: { id: true, nextRunAt: true, org: { select: { plan: true, trialEndsAt: true, subscriptionStatus: true, currentPeriodEnd: true } } },
        });
        // Organizations on an inactive plan get no scheduled reports (their data isn't synced either).
        const due = scheduled.filter((r) => !isOrgLocked(r.org));
        for (const r of due) await queue.add("report", { reportId: r.id }, { jobId: `report-${r.id}-${r.nextRunAt?.getTime() ?? 0}` });
        return { queued: due.length };
      }
      case "rule": {
        const run = await evaluateRule(job.data.ruleId);
        log(`rule ${job.data.ruleId}: evaluated ${run.evaluated}, matched ${run.matched}`);
        return { matched: run.matched };
      }
      case "report": {
        await deliverReport(job.data.reportId);
        log(`report ${job.data.reportId} delivered`);
        return { ok: true };
      }
      case "spend-tick": {
        // Monthly budgets: alerts at the alert percent and at the budget, and the optional pause.
        const run = await checkSpendBudgets(now);
        if (run.alerts || run.paused) log(`spend: ${run.checked} budgets, ${run.alerts} alerts, ${run.paused} campaigns paused`);
        return run;
      }
      case "fx-refresh": {
        // ECB reference rates for currency conversion in workspace totals.
        const { stored } = await refreshRates();
        return { stored };
      }
    }
  },
  { connection: redisConnection(), concurrency: 2 },
);

for (const [name, w] of [["sync", syncWorker], ["automation", automationWorker]] as const) {
  w.on("failed", (job, err) => log(`${name} job ${job?.name}:${job?.id} failed: ${err.message}`));
  w.on("error", (err) => log(`${name} worker error: ${err.message}`));
}

await getSyncQueue().upsertJobScheduler(
  "sync-all",
  { every: intervalMin * 60_000 },
  { name: "sync-all", data: { connectionId: "", trigger: "schedule" } },
);
await getAutomationQueue().upsertJobScheduler("rules-tick", { every: 5 * 60_000 }, { name: "rules-tick" });
await getAutomationQueue().upsertJobScheduler("reports-tick", { every: 5 * 60_000 }, { name: "reports-tick" });
// Spend comes in with each sync; checking budgets every 15 minutes keeps a pause close to the limit.
await getAutomationQueue().upsertJobScheduler("spend-tick", { every: 15 * 60_000 }, { name: "spend-tick" });
// The ECB publishes once a weekday around 16:00 CET; checking every 6 hours keeps the cache current.
await getAutomationQueue().upsertJobScheduler("fx-refresh", { every: 6 * 60 * 60_000 }, { name: "fx-refresh" });
log(`worker ready · re-syncing every ${intervalMin} min · rules & reports checked every 5 min`);

async function shutdown() {
  log("shutting down");
  await Promise.all([syncWorker.close(), automationWorker.close()]);
  await Promise.all([getSyncQueue().close(), getAutomationQueue().close()]);
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
