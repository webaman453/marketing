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
 */
export async function enqueueSync(connectionId: string, trigger: SyncTrigger) {
  await getSyncQueue().add("connection", { connectionId, trigger }, { jobId: `sync-${connectionId}` });
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
