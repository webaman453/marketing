import { ConnectorError, DEMO_PLATFORMS, type AccountStructure, type AdPlatformConnector, type ExternalCampaign, type ExternalMetricRow } from "@ashniva/connectors";
import { isPlatformShown, toISODate, type Platform } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createOrg, createUser } from "../../../test/helpers/factories";
import { connectors } from "../src/connectors";
import { encryptSecret } from "../src/crypto";
import { createSampleConnections, removeSampleConnections } from "../src/sample-data";
import { syncConnection, upsertStructure } from "../src/sync";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

let orgId: string;
let workspaceId: string;
let ownerId: string;

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner);
  orgId = org.id;
  workspaceId = workspace.id;
  ownerId = owner.id;
});

afterEach(() => vi.restoreAllMocks());

// ───────── fake LIVE connector ─────────

const ACCOUNT = { externalId: "live-acc-1", name: "Live account", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" };
const fake = {
  structure: { campaigns: [], adGroups: [], ads: [] } as AccountStructure,
  metrics: [] as ExternalMetricRow[],
  listAdAccounts: vi.fn(async () => [ACCOUNT]),
  fetchLeads: undefined as undefined | ReturnType<typeof vi.fn>,
};

function useFakeLive() {
  const registry = connectors();
  const realGet = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((platform: Platform, mode: "LIVE" | "DEMO" = "LIVE") => {
    if (mode === "DEMO") return realGet(platform, mode);
    return {
      platform,
      listAdAccounts: fake.listAdAccounts,
      fetchStructure: async () => fake.structure,
      fetchMetrics: async () => fake.metrics,
      ...(fake.fetchLeads ? { fetchLeads: fake.fetchLeads } : {}),
    } as unknown as AdPlatformConnector;
  }) as never);
}

beforeEach(() => {
  fake.structure = { campaigns: [], adGroups: [], ads: [] };
  fake.metrics = [];
  fake.fetchLeads = undefined;
  fake.listAdAccounts.mockReset().mockResolvedValue([ACCOUNT]);
});

const campaign = (externalId: string, over: Partial<ExternalCampaign> = {}): ExternalCampaign => ({
  externalId,
  name: `Campaign ${externalId}`,
  status: "ACTIVE",
  deliveryStatus: "ACTIVE",
  objective: "SALES",
  dailyBudget: 500,
  lifetimeBudget: null,
  startDate: "2026-10-01",
  endDate: null,
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  raw: { id: externalId },
  ...over,
});

const structure = (...ids: string[]): AccountStructure => ({
  campaigns: ids.map((id) => campaign(id)),
  adGroups: ids.map((id) => ({ externalId: `${id}-g`, campaignExternalId: id, name: `Group ${id}`, status: "ACTIVE", dailyBudget: null, bidStrategy: null, targeting: null, raw: {} })),
  ads: ids.map((id) => ({ externalId: `${id}-a`, adGroupExternalId: `${id}-g`, campaignExternalId: id, name: `Ad ${id}`, status: "ACTIVE", headline: "H", body: "B", thumbnailUrl: null, finalUrl: "https://x.test", raw: {} })),
});

const row = (level: ExternalMetricRow["level"], externalId: string, date: string, spend: number): ExternalMetricRow => ({
  date,
  level,
  externalId,
  impressions: 1000.4,
  clicks: 20,
  spend,
  conversions: 2,
  conversionValue: 400,
  videoViews: 0,
});

async function liveConnection(opts: { assigned?: boolean } = {}) {
  const connection = await prisma.platformConnection.create({
    data: { orgId, platform: "GOOGLE", mode: "LIVE", externalUserId: `live-${Math.random()}`, externalUserName: "Asha's Google", accessTokenEnc: encryptSecret("tok"), status: "ACTIVE" },
  });
  const account = await prisma.adAccount.create({
    data: { orgId, connectionId: connection.id, platform: "GOOGLE", ...ACCOUNT, workspaceId: opts.assigned === false ? null : workspaceId },
  });
  return { connection, account };
}

const statuses = async (adAccountId: string) =>
  Object.fromEntries((await prisma.campaign.findMany({ where: { adAccountId } })).map((c) => [c.externalId, c.status]));

// ───────── sample data ─────────

describe("sample connections", () => {
  it("creates one sample login per shown platform with its account in the workspace", async () => {
    const ids = await createSampleConnections(orgId, workspaceId, ownerId);
    const shown = DEMO_PLATFORMS.filter(isPlatformShown);
    expect(ids).toHaveLength(shown.length);
    expect(shown).not.toContain("TIKTOK");
    const conns = await prisma.platformConnection.findMany({ where: { orgId }, include: { adAccounts: true } });
    expect(new Set(conns.map((c) => c.platform))).toEqual(new Set(shown));
    for (const c of conns) {
      expect(c.mode).toBe("DEMO");
      expect(c.adAccounts).toHaveLength(1);
      expect(c.adAccounts[0]!.workspaceId).toBe(workspaceId);
    }
  });

  it("is idempotent and re-attaches unassigned sample accounts", async () => {
    const first = await createSampleConnections(orgId, workspaceId, ownerId);
    await prisma.adAccount.updateMany({ where: { orgId }, data: { workspaceId: null } });
    await prisma.platformConnection.updateMany({ where: { orgId }, data: { status: "REVOKED" } });
    const second = await createSampleConnections(orgId, workspaceId, ownerId);
    expect(second).toEqual(first);
    expect(await prisma.adAccount.count({ where: { orgId, workspaceId } })).toBe(first.length);
    expect(await prisma.platformConnection.count({ where: { orgId, status: "ACTIVE" } })).toBe(first.length);
  });

  it("removeSampleConnections deletes only sample data", async () => {
    await createSampleConnections(orgId, workspaceId, ownerId);
    const { connection } = await liveConnection();
    const removed = await removeSampleConnections(orgId);
    expect(removed).toBeGreaterThan(0);
    expect((await prisma.platformConnection.findMany({ where: { orgId } })).map((c) => c.id)).toEqual([connection.id]);
  });
});

describe("syncConnection with sample data", () => {
  async function metaSample() {
    await createSampleConnections(orgId, workspaceId, ownerId);
    return prisma.platformConnection.findFirstOrThrow({ where: { orgId, platform: "META" }, include: { adAccounts: true } });
  }

  it("pulls structure and metrics, and records the run", async () => {
    const conn = await metaSample();
    const stats = await syncConnection(conn.id, "sample");
    expect(stats.accounts).toBe(1);
    expect(stats.campaigns).toBeGreaterThan(0);
    expect(stats.adGroups).toBeGreaterThan(0);
    expect(stats.ads).toBeGreaterThan(0);
    expect(stats.metricRows).toBeGreaterThan(0);
    // The sample lead-gen campaign brings in form leads, tied to its ads.
    expect(stats.leads).toBeGreaterThan(0);
    expect(stats.leadsError).toBeUndefined();
    expect(await prisma.lead.count({ where: { connectionId: conn.id, workspaceId, adId: { not: null } } })).toBe(stats.leads);

    const account = conn.adAccounts[0]!;
    expect(await prisma.campaign.count({ where: { adAccountId: account.id } })).toBe(stats.campaigns);
    expect(await prisma.metricDaily.count({ where: { adAccountId: account.id } })).toBe(stats.metricRows);
    const after = await prisma.platformConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(after).toMatchObject({ syncStatus: "SUCCESS", status: "ACTIVE", lastSyncError: null });
    expect(after.lastSyncedAt).toBeInstanceOf(Date);
    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: conn.id } });
    expect(run).toMatchObject({ trigger: "sample", status: "SUCCESS" });
    expect(run.stats).toMatchObject({ campaigns: stats.campaigns, metricRows: stats.metricRows });
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: account.id } })).lastSyncedAt).toBeInstanceOf(Date);
  });

  it("is idempotent, keeps local status/budget edits and never removes builder campaigns", async () => {
    const conn = await metaSample();
    const account = conn.adAccounts[0]!;
    await syncConnection(conn.id, "sample");
    const metricCount = await prisma.metricDaily.count({ where: { adAccountId: account.id } });
    const edited = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: account.id, status: "ACTIVE" } });
    await prisma.campaign.update({ where: { id: edited.id }, data: { status: "PAUSED", dailyBudget: 4321 } });
    const builder = await prisma.campaign.create({ data: { adAccountId: account.id, platform: "META", externalId: "demo-meta-1001-new-abc", name: "Built here", status: "ACTIVE" } });

    const stats = await syncConnection(conn.id, "manual");
    expect(stats.metricRows).toBeLessThan(metricCount); // later syncs only re-fetch the restatement window
    expect(await prisma.metricDaily.count({ where: { adAccountId: account.id } })).toBe(metricCount);
    const kept = await prisma.campaign.findUniqueOrThrow({ where: { id: edited.id } });
    expect(kept.status).toBe("PAUSED");
    expect(Number(kept.dailyBudget)).toBe(4321);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: builder.id } })).status).toBe("ACTIVE");
    expect(await prisma.syncRun.count({ where: { connectionId: conn.id } })).toBe(2);
  });

  it("does nothing for a revoked connection", async () => {
    const conn = await metaSample();
    await prisma.platformConnection.update({ where: { id: conn.id }, data: { status: "REVOKED" } });
    expect(await syncConnection(conn.id, "manual")).toEqual({ accounts: 0, campaigns: 0, adGroups: 0, ads: 0, metricRows: 0 });
    expect(await prisma.syncRun.count()).toBe(0);
  });

  it("throws for an unknown connection", async () => {
    await expect(syncConnection("nope", "manual")).rejects.toThrow("Connection nope not found");
  });
});

// ───────── LIVE (fake connector) ─────────

describe("syncConnection on a live login", () => {
  beforeEach(useFakeLive);

  it("only syncs accounts assigned to a workspace; new accounts arrive unassigned", async () => {
    const { connection } = await liveConnection({ assigned: false });
    fake.listAdAccounts.mockResolvedValue([ACCOUNT, { ...ACCOUNT, externalId: "live-acc-2", name: "Second" }]);
    fake.structure = structure("c1");
    const stats = await syncConnection(connection.id, "connect");
    expect(stats.accounts).toBe(0);
    expect(await prisma.adAccount.count({ where: { connectionId: connection.id, workspaceId: null } })).toBe(2);
    expect(await prisma.campaign.count()).toBe(0);
  });

  it("marks campaigns missing from a full sync as removed", async () => {
    const { connection, account } = await liveConnection();
    fake.structure = structure("c1", "c2");
    await syncConnection(connection.id, "manual");
    expect(await statuses(account.id)).toEqual({ c1: "ACTIVE", c2: "ACTIVE" });

    fake.structure = structure("c1");
    const stats = await syncConnection(connection.id, "manual");
    expect(stats.warnings).toBeUndefined();
    expect(await statuses(account.id)).toEqual({ c1: "ACTIVE", c2: "REMOVED" });
  });

  it("removes nothing when the platform returns zero campaigns while some are on record", async () => {
    const { connection, account } = await liveConnection();
    fake.structure = structure("c1", "c2");
    await syncConnection(connection.id, "manual");

    fake.structure = structure();
    const stats = await syncConnection(connection.id, "schedule");
    expect(await statuses(account.id)).toEqual({ c1: "ACTIVE", c2: "ACTIVE" });
    expect(stats.warnings).toEqual([`${account.name}: the platform returned no campaigns while 2 are on record; none were marked removed.`]);
    expect((await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id, trigger: "schedule" } })).stats).toMatchObject({ warnings: stats.warnings });
  });

  it("an empty account with nothing on record is fine", async () => {
    const { connection } = await liveConnection();
    const stats = await syncConnection(connection.id, "manual");
    expect(stats.warnings).toBeUndefined();
    expect(stats.accounts).toBe(1);
  });

  it("platform values win over local edits on live data", async () => {
    const { connection, account } = await liveConnection();
    fake.structure = structure("c1");
    await syncConnection(connection.id, "manual");
    await prisma.campaign.updateMany({ where: { adAccountId: account.id }, data: { status: "PAUSED", dailyBudget: 1 } });
    await syncConnection(connection.id, "manual");
    const c = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: account.id } });
    expect(c.status).toBe("ACTIVE");
    expect(Number(c.dailyBudget)).toBe(500);
  });

  it("upserts daily metrics idempotently at every level and skips unknown entities", async () => {
    const { connection, account } = await liveConnection();
    const today = toISODate(new Date());
    fake.structure = structure("c1");
    fake.metrics = [row("CAMPAIGN", "c1", today, 100.25), row("AD_GROUP", "c1-g", today, 100.25), row("AD", "c1-a", today, 100.25), row("CAMPAIGN", "gone", today, 5)];
    const first = await syncConnection(connection.id, "manual");
    expect(first.metricRows).toBe(3);

    fake.metrics = [row("CAMPAIGN", "c1", today, 150.5), row("AD_GROUP", "c1-g", today, 150.5), row("AD", "c1-a", today, 150.5)];
    await syncConnection(connection.id, "manual");
    const rows = await prisma.metricDaily.findMany({ where: { adAccountId: account.id } });
    expect(rows).toHaveLength(3);
    const c = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: account.id } });
    for (const r of rows) {
      expect(Number(r.spend)).toBe(150.5);
      expect(r.impressions).toBe(1000);
      expect(r.campaignId).toBe(c.id);
      expect(r.platform).toBe("GOOGLE");
    }
  });

  it("records a leads failure without failing the sync", async () => {
    const { connection } = await liveConnection();
    fake.fetchLeads = vi.fn().mockRejectedValue(new Error("Lead access (leads_retrieval) not granted"));
    const stats = await syncConnection(connection.id, "manual");
    expect(stats.leadsError).toBe("Lead access (leads_retrieval) not granted");
    expect(stats.leads).toBeUndefined();
    const run = await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(run.status).toBe("SUCCESS");
    expect(run.stats).toMatchObject({ leadsError: "Lead access (leads_retrieval) not granted" });
  });

  it("records a failure and tells admins once, on the first failure", async () => {
    const { connection } = await liveConnection();
    fake.listAdAccounts.mockRejectedValue(new Error("Quota exceeded"));
    await expect(syncConnection(connection.id, "schedule")).rejects.toThrow("Quota exceeded");
    const after = await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after).toMatchObject({ syncStatus: "FAILED", lastSyncError: "Quota exceeded", status: "ACTIVE" });
    expect(await prisma.syncRun.findFirstOrThrow({ where: { connectionId: connection.id } })).toMatchObject({ status: "FAILED", error: "Quota exceeded" });
    const notes = await prisma.notification.findMany({ where: { type: "integration.sync_failed" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: ownerId, title: "Google Ads sync failed" });

    await expect(syncConnection(connection.id, "schedule")).rejects.toThrow();
    expect(await prisma.notification.count({ where: { type: "integration.sync_failed" } })).toBe(1);
  });

  it("marks the login EXPIRED on an auth error and notifies once", async () => {
    const { connection } = await liveConnection();
    fake.listAdAccounts.mockRejectedValue(new ConnectorError("AUTH_EXPIRED", "Token revoked"));
    await expect(syncConnection(connection.id, "schedule")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ status: "EXPIRED", syncStatus: "FAILED" });
    expect(await prisma.notification.count({ where: { type: "integration.expired" } })).toBe(1);

    await expect(syncConnection(connection.id, "schedule")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await prisma.notification.count({ where: { type: "integration.expired" } })).toBe(1);
  });

  it("a successful sync clears an earlier error", async () => {
    const { connection } = await liveConnection();
    await prisma.platformConnection.update({ where: { id: connection.id }, data: { lastSyncError: "old", status: "ERROR" } });
    await syncConnection(connection.id, "manual");
    expect(await prisma.platformConnection.findUniqueOrThrow({ where: { id: connection.id } })).toMatchObject({ lastSyncError: null, status: "ACTIVE" });
  });
});

describe("upsertStructure", () => {
  it("a partial structure (builder launch) never removes other campaigns", async () => {
    useFakeLive();
    const { connection, account } = await liveConnection();
    fake.structure = structure("c1", "c2");
    await syncConnection(connection.id, "manual");

    const ids = await upsertStructure(account, structure("new"), false);
    expect([...ids.campaigns.keys()]).toEqual(["new"]);
    expect(ids.adGroups.get("new-g")!.campaignId).toBe(ids.campaigns.get("new"));
    expect(ids.ads.get("new-a")!.campaignId).toBe(ids.campaigns.get("new"));
    expect(await statuses(account.id)).toEqual({ c1: "ACTIVE", c2: "ACTIVE", new: "ACTIVE" });
  });

  it("drops ad groups and ads whose parent isn't in the structure", async () => {
    const { account } = await liveConnection();
    const s = structure("c1");
    s.adGroups.push({ ...s.adGroups[0]!, externalId: "orphan-g", campaignExternalId: "missing" });
    s.ads.push({ ...s.ads[0]!, externalId: "orphan-a", adGroupExternalId: "missing-g" });
    const ids = await upsertStructure(account, s, false);
    expect([...ids.adGroups.keys()]).toEqual(["c1-g"]);
    expect([...ids.ads.keys()]).toEqual(["c1-a"]);
    expect(await prisma.adGroup.count({ where: { adAccountId: account.id } })).toBe(1);
  });

  it("stores dates, budgets and raw JSON", async () => {
    const { account } = await liveConnection();
    const s = structure("c1");
    s.campaigns[0] = campaign("c1", { startDate: "2026-10-05", endDate: "2026-12-31", lifetimeBudget: 99999.99, dailyBudget: null, raw: { nested: { a: 1 } } });
    await upsertStructure(account, s, false);
    const c = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: account.id } });
    expect(c.startDate!.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(c.endDate!.toISOString().slice(0, 10)).toBe("2026-12-31");
    expect(Number(c.lifetimeBudget)).toBe(99999.99);
    expect(c.dailyBudget).toBeNull();
    expect(c.raw).toEqual({ nested: { a: 1 } });
  });
});
