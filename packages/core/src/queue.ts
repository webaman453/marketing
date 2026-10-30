import { Queue, type ConnectionOptions } from "bullmq";

export const SYNC_QUEUE = "sync";

export type SyncTrigger = "connect" | "manual" | "schedule" | "sample";

export interface SyncJobData {
  connectionId: string;
  trigger: SyncTrigger;
}

export function redisConnection(): ConnectionOptions {
  const url = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    // redis://host:6379/15 selects database 15 (tests and side-by-side setups rely on it).
    db: Number(url.pathname.slice(1)) || 0,
    maxRetriesPerRequest: null,
  };
}

let syncQueue: Queue<SyncJobData> | undefined;

export function getSyncQueue() {
  syncQueue ??= new Queue<SyncJobData>(SYNC_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });
  return syncQueue;
}

/**
 * Queues a sync for a connection. The job id makes this idempotent: a
 * connection that is already queued or running is not queued twice.
 * BullMQ ignores an add whose id still exists, and failed jobs are kept for
 * inspection (removeOnFail), so a finished job with that id is removed first;
 * otherwise one failure would silently drop every later sync.
 */
export async function enqueueSync(connectionId: string, trigger: SyncTrigger) {
  const queue = getSyncQueue();
  const jobId = `sync-${connectionId}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.remove().catch(() => undefined);
  }
  await queue.add("connection", { connectionId, trigger }, { jobId });
}

export const AUTOMATION_QUEUE = "automation";

export type AutomationJob =
  | { name: "rules-tick" }
  | { name: "reports-tick" }
  | { name: "rule"; ruleId: string }
  | { name: "report"; reportId: string };

let automationQueue: Queue | undefined;

export function getAutomationQueue() {
  automationQueue ??= new Queue(AUTOMATION_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: true, removeOnFail: 200 },
  });
  return automationQueue;
}
