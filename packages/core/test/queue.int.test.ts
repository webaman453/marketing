/**
 * enqueueSync against a real Redis. queue.ts drops the database number from
 * REDIS_URL (see the BUG below), so BullMQ is wrapped here to pin this file to
 * TEST_REDIS_URL's database and a private key prefix; nothing touches db 0.
 */
import { Worker } from "bullmq";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = Number(new URL(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/13").pathname.slice(1) || 13);
const PREFIX = "core-test";

vi.mock("bullmq", async (importOriginal) => {
  const m = await importOriginal<typeof import("bullmq")>();
  const db = Number(new URL(process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379/13").pathname.slice(1) || 13);
  class Queue extends m.Queue {
    constructor(name: string, opts: ConstructorParameters<typeof m.Queue>[1]) {
      super(name, { ...opts!, prefix: "core-test", connection: { ...(opts!.connection as object), db } });
    }
  }
  return { ...m, Queue };
});

const { SYNC_QUEUE, enqueueSync, getAutomationQueue, getSyncQueue, redisConnection } = await import("../src/queue");

const workerOpts = () => ({ connection: { ...(redisConnection() as object), db: TEST_DB }, prefix: PREFIX, autorun: false });
let worker: Worker;

beforeEach(async () => {
  await getSyncQueue().obliterate({ force: true });
});

afterAll(async () => {
  await getSyncQueue().obliterate({ force: true });
  await getAutomationQueue().obliterate({ force: true });
  await worker?.close();
  await getSyncQueue().close();
  await getAutomationQueue().close();
});

/** Takes the next waiting job as a worker would. */
async function takeJob() {
  worker ??= new Worker(SYNC_QUEUE, null, workerOpts());
  const job = await worker.getNextJob("tok");
  expect(job).toBeDefined();
  return job!;
}

describe("enqueueSync", () => {
  it("queues one job per connection, however often it is called", async () => {
    await enqueueSync("c1", "manual");
    await enqueueSync("c1", "schedule");
    await enqueueSync("c2", "connect");
    const jobs = await getSyncQueue().getJobs(["waiting"]);
    expect(jobs.map((j) => j.id).sort()).toEqual(["sync-c1", "sync-c2"]);
    expect((await getSyncQueue().getJob("sync-c1"))!.data).toEqual({ connectionId: "c1", trigger: "manual" });
  });

  it("replaces a failed job with the same id", async () => {
    await getSyncQueue().add("connection", { connectionId: "c3", trigger: "schedule" }, { jobId: "sync-c3", attempts: 1 });
    const job = await takeJob();
    await job.moveToFailed(new Error("boom"), "tok", true);
    expect(await (await getSyncQueue().getJob("sync-c3"))!.getState()).toBe("failed");

    await enqueueSync("c3", "manual");
    const fresh = (await getSyncQueue().getJob("sync-c3"))!;
    expect(await fresh.getState()).toBe("waiting");
    expect(fresh.data).toEqual({ connectionId: "c3", trigger: "manual" });
    expect(fresh.failedReason).toBeFalsy();
  });

  it("replaces a completed job that was kept", async () => {
    await getSyncQueue().add("connection", { connectionId: "c4", trigger: "connect" }, { jobId: "sync-c4", removeOnComplete: false });
    const job = await takeJob();
    await job.moveToCompleted("done", "tok", false);
    expect(await (await getSyncQueue().getJob("sync-c4"))!.getState()).toBe("completed");

    await enqueueSync("c4", "manual");
    const fresh = (await getSyncQueue().getJob("sync-c4"))!;
    expect(await fresh.getState()).toBe("waiting");
    expect(fresh.data.trigger).toBe("manual");
  });

  it("leaves a running job alone", async () => {
    await enqueueSync("c5", "connect");
    const job = await takeJob();
    expect(await job.getState()).toBe("active");
    await enqueueSync("c5", "manual");
    const same = (await getSyncQueue().getJob("sync-c5"))!;
    expect(await same.getState()).toBe("active");
    expect(same.data.trigger).toBe("connect");
    expect(await getSyncQueue().getWaitingCount()).toBe(0);
  });

  it("uses retry defaults: 3 attempts with exponential backoff", async () => {
    await enqueueSync("c6", "manual");
    const job = (await getSyncQueue().getJob("sync-c6"))!;
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });
});

describe("queues", () => {
  it("are singletons", () => {
    expect(getSyncQueue()).toBe(getSyncQueue());
    expect(getAutomationQueue()).toBe(getAutomationQueue());
    expect(getAutomationQueue().name).toBe("automation");
  });
});

describe("redisConnection", () => {
  const url = process.env.REDIS_URL;
  const withUrl = (u: string | undefined) => {
    if (u === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = u;
    try {
      return redisConnection() as Record<string, unknown>;
    } finally {
      process.env.REDIS_URL = url;
    }
  };

  it("parses host, port, credentials and TLS", () => {
    expect(withUrl("rediss://user:pa55@redis.example.test:6380")).toMatchObject({ host: "redis.example.test", port: 6380, username: "user", password: "pa55", tls: {}, maxRetriesPerRequest: null });
    expect(withUrl("redis://10.0.0.5")).toMatchObject({ host: "10.0.0.5", port: 6379, username: undefined, password: undefined, tls: undefined });
    expect(withUrl(undefined)).toMatchObject({ host: "127.0.0.1", port: 6379 });
  });

  // Regression: the /<db> part of REDIS_URL used to be dropped, so every environment shared database 0.
  it("keeps the database number from REDIS_URL", () => {
    expect(withUrl("redis://127.0.0.1:6379/13")).toMatchObject({ db: 13 });
    expect(withUrl("redis://127.0.0.1:6379")).toMatchObject({ db: 0 });
  });
});
