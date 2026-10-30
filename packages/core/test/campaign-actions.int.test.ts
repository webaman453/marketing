import type { AdPlatformConnector } from "@ashniva/connectors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { addMember, createOrg, createUser } from "../../../test/helpers/factories";
import { adWithConnection, getAdMedia } from "../src/ad-media";
import { audit } from "../src/audit";
import { campaignWithConnection, changeCampaignBudget, changeCampaignStatus } from "../src/campaign-actions";
import { connectors } from "../src/connectors";
import { encryptSecret } from "../src/crypto";
import { emailOptOuts, notify } from "../src/notifications";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

let orgId: string;
let workspaceId: string;
let owner: { id: string; email: string };

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  owner = await createUser();
  const { org, workspace } = await createOrg(owner);
  orgId = org.id;
  workspaceId = workspace.id;
});

afterEach(() => vi.restoreAllMocks());

let n = 0;
async function setup(mode: "DEMO" | "LIVE", raw: Record<string, unknown> | null = null) {
  const conn = await prisma.platformConnection.create({ data: { orgId, platform: "META", mode, externalUserId: `u${n++}`, accessTokenEnc: encryptSecret("live-token") } });
  const acc = await prisma.adAccount.create({ data: { orgId, connectionId: conn.id, platform: "META", externalId: "act_1", name: "Acct", currency: "INR", status: "ACTIVE", workspaceId, meta: { tz: 1 } } });
  const c = await prisma.campaign.create({ data: { adAccountId: acc.id, platform: "META", externalId: "123", name: "Diwali", status: "ACTIVE", dailyBudget: 1000, raw: raw ?? undefined } });
  const g = await prisma.adGroup.create({ data: { adAccountId: acc.id, campaignId: c.id, externalId: "g1", name: "G", status: "ACTIVE" } });
  const ad = await prisma.ad.create({ data: { adAccountId: acc.id, campaignId: c.id, adGroupId: g.id, externalId: "ad1", name: "Ad", status: "ACTIVE", headline: "Hello", finalUrl: "https://x.test", thumbnailUrl: "https://cdn.test/t.jpg" } });
  return {
    campaign: await prisma.campaign.findUniqueOrThrow({ where: { id: c.id }, include: campaignWithConnection }),
    ad: await prisma.ad.findUniqueOrThrow({ where: { id: ad.id }, include: adWithConnection }),
  };
}

function fakeConnector(over: Record<string, unknown> = {}) {
  const fake = { platform: "META", setCampaignStatus: vi.fn(async () => undefined), setCampaignDailyBudget: vi.fn(async () => undefined), ...over };
  vi.spyOn(connectors(), "get").mockReturnValue(fake as unknown as AdPlatformConnector);
  return fake;
}

const actor = () => ({ orgId, workspaceId, userId: owner.id, ip: "10.0.0.1" });

describe("changeCampaignStatus", () => {
  it("applies the change on the platform, then locally, then audits", async () => {
    const { campaign } = await setup("LIVE");
    const fake = fakeConnector();
    expect(await changeCampaignStatus(campaign, "PAUSED", actor())).toBe(true);
    expect(fake.setCampaignStatus).toHaveBeenCalledWith(
      { accessToken: "live-token", credentials: null },
      { externalId: "act_1", currency: "INR", meta: { tz: 1 } },
      { externalId: "123", raw: null },
      "PAUSED",
    );
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("PAUSED");
    const log = await prisma.auditLog.findFirstOrThrow();
    expect(log).toMatchObject({ action: "campaign.paused", userId: owner.id, ip: "10.0.0.1", entityName: "Diwali (Meta Ads)" });
    expect(log.changes).toEqual({ status: { from: "ACTIVE", to: "PAUSED" } });
  });

  it("does nothing when the status is unchanged", async () => {
    const { campaign } = await setup("LIVE");
    const fake = fakeConnector();
    expect(await changeCampaignStatus(campaign, "ACTIVE", actor())).toBe(false);
    expect(fake.setCampaignStatus).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("leaves the local copy alone when the platform refuses", async () => {
    const { campaign } = await setup("LIVE");
    fakeConnector({ setCampaignStatus: vi.fn().mockRejectedValue(new Error("Permission denied")) });
    await expect(changeCampaignStatus(campaign, "PAUSED", actor())).rejects.toThrow("Permission denied");
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("ACTIVE");
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("changes sample campaigns locally only", async () => {
    const { campaign } = await setup("DEMO");
    expect(await changeCampaignStatus(campaign, "PAUSED", { ...actor(), via: "Rule: X" })).toBe(true);
    const log = await prisma.auditLog.findFirstOrThrow();
    expect(log.changes).toEqual({ status: { from: "ACTIVE", to: "PAUSED" }, via: { from: null, to: "Rule: X" } });
  });
});

describe("changeCampaignBudget", () => {
  it("updates the budget, keeps Meta's raw daily_budget in step and audits from → to", async () => {
    const { campaign } = await setup("LIVE", { daily_budget: "1000", other: 1 });
    const fake = fakeConnector();
    await changeCampaignBudget(campaign, 1500, actor());
    expect(fake.setCampaignDailyBudget).toHaveBeenCalledWith(expect.anything(), expect.anything(), { externalId: "123", raw: { daily_budget: "1000", other: 1 } }, 1500);
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(Number(after.dailyBudget)).toBe(1500);
    expect(after.raw).toEqual({ daily_budget: "1500", other: 1 });
    expect((await prisma.auditLog.findFirstOrThrow()).changes).toEqual({ dailyBudget: { from: 1000, to: 1500 } });
  });

  it("doesn't invent raw fields on other platforms", async () => {
    const { campaign } = await setup("DEMO");
    await changeCampaignBudget(campaign, 750.5, { orgId, workspaceId, userId: null });
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(Number(after.dailyBudget)).toBe(750.5);
    expect(after.raw).toEqual({});
  });
});

describe("getAdMedia", () => {
  it("falls back to the synced thumbnail for sample data", async () => {
    const { ad } = await setup("DEMO");
    const media = await getAdMedia(ad);
    expect(media).toMatchObject({ live: false, format: "IMAGE", headline: "Hello", link: "https://x.test" });
    expect(media.items).toEqual([expect.objectContaining({ type: "IMAGE", url: "https://cdn.test/t.jpg" })]);
  });

  it("returns live media from the platform", async () => {
    const { ad } = await setup("LIVE");
    const items = [{ type: "VIDEO", url: "https://v.test/v.mp4" }];
    const fetchAdMedia = vi.fn(async () => ({ format: "VIDEO", headline: "H", body: null, callToAction: "SHOP_NOW", link: null, items }));
    fakeConnector({ fetchAdMedia });
    expect(await getAdMedia(ad)).toMatchObject({ live: true, format: "VIDEO", items });
    expect(fetchAdMedia).toHaveBeenCalledWith({ accessToken: "live-token", credentials: null }, { externalId: "act_1", currency: "INR", meta: { tz: 1 } }, { externalId: "ad1" });
  });

  it("falls back when the platform has no files or fails", async () => {
    const { ad } = await setup("LIVE");
    fakeConnector({ fetchAdMedia: vi.fn(async () => ({ format: "IMAGE", headline: null, body: null, callToAction: null, link: null, items: [] })) });
    expect((await getAdMedia(ad)).live).toBe(false);
    vi.restoreAllMocks();
    fakeConnector({ fetchAdMedia: vi.fn().mockRejectedValue(new Error("expired")) });
    const media = await getAdMedia(ad);
    expect(media.live).toBe(false);
    expect(media.items).toHaveLength(1);
  });

  it("reports an unknown format without a thumbnail", async () => {
    const { ad } = await setup("DEMO");
    const media = await getAdMedia({ ...ad, thumbnailUrl: null });
    expect(media).toMatchObject({ format: "UNKNOWN", items: [], live: false });
  });
});

describe("notify", () => {
  it("creates in-app notifications for the given roles and users, and emails those who want it", async () => {
    const admin = await createUser();
    const analyst = await createUser();
    const manager = await createUser();
    await addMember(orgId, admin, "ADMIN");
    await addMember(orgId, analyst, "ANALYST");
    await addMember(orgId, manager, "MANAGER");
    await prisma.notificationPreference.create({ data: { userId: admin.id, syncFailures: false } });
    const count = await notify({ orgId, workspaceId, type: "t", title: "T".repeat(300), body: "<b>x</b>", link: "/w/1", roles: ["OWNER", "ADMIN"], userIds: [manager.id], email: true, emailPref: "syncFailures" });
    expect(count).toBe(3);
    const rows = await prisma.notification.findMany();
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([owner.id, admin.id, manager.id]));
    expect(rows[0]!.title).toHaveLength(200);
    expect(rows[0]).toMatchObject({ workspaceId, body: "<b>x</b>", link: "/w/1" });
    const logged = String(vi.mocked(console.info).mock.calls.at(-1)?.[0]);
    expect(logged).toContain(owner.email);
    expect(logged).toContain(manager.email);
    expect(logged).not.toContain(admin.email);
    expect(logged).toContain("link=http://localhost:3100/w/1");
  });

  it("returns 0 when nobody matches and never crosses organizations", async () => {
    const other = await createOrg(await createUser());
    expect(await notify({ orgId, type: "t", title: "x", userIds: ["nobody"] })).toBe(0);
    expect(await notify({ orgId: other.org.id, type: "t", title: "x", userIds: [owner.id] })).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });

  it("emailOptOuts lists users who turned an email off", async () => {
    const u = await createUser();
    await prisma.notificationPreference.create({ data: { userId: u.id, ruleAlerts: false } });
    expect(await emailOptOuts([], "ruleAlerts")).toEqual(new Set());
    expect(await emailOptOuts([u.id, owner.id], "ruleAlerts")).toEqual(new Set([u.id]));
    expect(await emailOptOuts([u.id], "reportCopies")).toEqual(new Set());
  });
});

describe("audit", () => {
  it("records an entry", async () => {
    await audit({ orgId, workspaceId, userId: owner.id, action: "x.y", entityType: "thing", entityId: "1", changes: { a: { from: 1, to: 2 } } });
    expect(await prisma.auditLog.findFirstOrThrow()).toMatchObject({ action: "x.y", changes: { a: { from: 1, to: 2 } } });
  });

  it("never throws, even when the entry can't be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(audit({ orgId: "missing-org", action: "x", entityType: "y" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[audit] failed to write entry", "x", expect.anything());
  });
});
