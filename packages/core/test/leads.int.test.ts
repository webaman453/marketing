import type { AccountStructure, AdPlatformConnector, ExternalLead } from "@ashniva/connectors";
import type { AdAccount, PlatformConnection } from "@ashniva/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createOrg, createUser, createWorkspace } from "../../../test/helpers/factories";
import { connectors } from "../src/connectors";
import { encryptSecret } from "../src/crypto";
import { syncLeads } from "../src/leads";
import { upsertStructure } from "../src/sync";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

const fetchLeads = vi.fn<(auth: unknown, params: { since: Date | null }) => Promise<ExternalLead[]>>();
let withLeads = true;
let orgId: string;
let ws1: string;
let ws2: string;
let connection: PlatformConnection;
const auth = { accessToken: "t" };

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  fetchLeads.mockReset().mockResolvedValue([]);
  withLeads = true;
  vi.spyOn(connectors(), "get").mockImplementation(((platform: string) => ({ platform, ...(withLeads ? { fetchLeads } : {}) }) as unknown as AdPlatformConnector) as never);
  const { org, workspace } = await createOrg(await createUser());
  orgId = org.id;
  ws1 = workspace.id;
  ws2 = (await createWorkspace(orgId)).id;
  connection = await prisma.platformConnection.create({
    data: { orgId, platform: "META", mode: "LIVE", externalUserId: "meta-login", accessTokenEnc: encryptSecret("t"), status: "ACTIVE" },
  });
});

afterEach(() => vi.restoreAllMocks());

async function account(externalId: string, workspaceId: string | null, campaignId: string): Promise<AdAccount> {
  const acc = await prisma.adAccount.create({
    data: { orgId, connectionId: connection.id, platform: "META", externalId, name: externalId, currency: "INR", status: "ACTIVE", workspaceId },
  });
  const s: AccountStructure = {
    campaigns: [{ externalId: campaignId, name: `C ${campaignId}`, status: "ACTIVE", deliveryStatus: null, objective: "LEADS", dailyBudget: 100, lifetimeBudget: null, startDate: null, endDate: null, updatedAt: null, raw: {} }],
    adGroups: [{ externalId: `${campaignId}-g`, campaignExternalId: campaignId, name: "G", status: "ACTIVE", dailyBudget: null, bidStrategy: null, targeting: null, raw: {} }],
    ads: [{ externalId: `${campaignId}-a`, adGroupExternalId: `${campaignId}-g`, campaignExternalId: campaignId, name: "A", status: "ACTIVE", headline: null, body: null, thumbnailUrl: null, finalUrl: null, raw: {} }],
  };
  await upsertStructure(acc, s, false);
  return acc;
}

let seq = 0;
const lead = (over: Partial<ExternalLead> = {}): ExternalLead => ({
  externalId: `lead-${seq++}`,
  createdTime: new Date("2026-10-20T10:00:00Z"),
  source: "fb",
  isOrganic: false,
  pageId: "page1",
  formId: "form1",
  formName: "Quote form",
  externalAdId: null,
  externalAdGroupId: null,
  externalCampaignId: null,
  adName: null,
  adGroupName: null,
  campaignName: null,
  fields: { full_name: ["Asha Rao"], email: ["asha@example.test"], phone_number: ["+91 90000 00000"] },
  ...over,
});

describe("syncLeads", () => {
  it("places a lead in the workspace of the ad it came from", async () => {
    await account("acc-1", ws1, "camp1");
    const acc2 = await account("acc-2", ws2, "camp2");
    fetchLeads.mockResolvedValue([lead({ externalAdId: "camp2-a", adName: "A" })]);
    expect(await syncLeads(connection, auth)).toBe(1);
    const [saved] = await prisma.lead.findMany();
    const ad = await prisma.ad.findFirstOrThrow({ where: { adAccountId: acc2.id } });
    expect(saved).toMatchObject({
      workspaceId: ws2,
      orgId,
      connectionId: connection.id,
      platform: "META",
      adId: ad.id,
      adGroupId: ad.adGroupId,
      campaignId: ad.campaignId,
      externalAdId: "camp2-a",
      name: "Asha Rao",
      email: "asha@example.test",
      phone: "+91 90000 00000",
      formName: "Quote form",
    });
  });

  it("places a lead by its campaign when the ad is unknown", async () => {
    await account("acc-1", ws1, "camp1");
    const acc2 = await account("acc-2", ws2, "camp2");
    fetchLeads.mockResolvedValue([lead({ externalCampaignId: "camp2", externalAdGroupId: "camp2-g", externalAdId: "deleted-ad" })]);
    expect(await syncLeads(connection, auth)).toBe(1);
    const saved = await prisma.lead.findFirstOrThrow();
    const c = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: acc2.id } });
    const g = await prisma.adGroup.findFirstOrThrow({ where: { adAccountId: acc2.id } });
    expect(saved).toMatchObject({ workspaceId: ws2, campaignId: c.id, adGroupId: g.id, adId: null, externalAdId: "deleted-ad" });
  });

  it("skips unmatched leads when the login reports into several workspaces", async () => {
    await account("acc-1", ws1, "camp1");
    await account("acc-2", ws2, "camp2");
    fetchLeads.mockResolvedValue([lead({ isOrganic: true }), lead({ externalAdId: "other" }), lead({ externalAdId: "camp1-a" })]);
    expect(await syncLeads(connection, auth)).toBe(1);
    expect((await prisma.lead.findMany()).map((l) => l.workspaceId)).toEqual([ws1]);
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining("2 lead(s)"));
  });

  it("puts unmatched leads in the only workspace when there is just one", async () => {
    await account("acc-1", ws1, "camp1");
    await account("acc-3", ws1, "camp3");
    await account("acc-unassigned", null, "camp9");
    fetchLeads.mockResolvedValue([lead({ isOrganic: true }), lead({ externalCampaignId: "camp9" })]);
    expect(await syncLeads(connection, auth)).toBe(2);
    const rows = await prisma.lead.findMany();
    expect(rows.map((l) => l.workspaceId)).toEqual([ws1, ws1]);
    // camp9 belongs to an unassigned account: not linked.
    expect(rows.every((l) => l.campaignId === null)).toBe(true);
  });

  it("asks only for leads since the newest one minus a day, and ignores duplicates", async () => {
    await account("acc-1", ws1, "camp1");
    const first = lead({ externalId: "dup", createdTime: new Date("2026-10-20T10:00:00Z") });
    fetchLeads.mockResolvedValue([first]);
    expect(await syncLeads(connection, auth)).toBe(1);
    expect(fetchLeads).toHaveBeenLastCalledWith(auth, { since: null });

    fetchLeads.mockResolvedValue([first, lead({ externalId: "new" })]);
    expect(await syncLeads(connection, auth)).toBe(1);
    expect(fetchLeads).toHaveBeenLastCalledWith(auth, { since: new Date("2026-10-19T10:00:00Z") });
    expect(await prisma.lead.count()).toBe(2);
  });

  it("does nothing without workspace accounts, without leads, or without lead support", async () => {
    await account("acc-unassigned", null, "c");
    expect(await syncLeads(connection, auth)).toBe(0);
    expect(fetchLeads).not.toHaveBeenCalled();

    await account("acc-1", ws1, "camp1");
    expect(await syncLeads(connection, auth)).toBe(0);
    expect(fetchLeads).toHaveBeenCalledTimes(1);

    withLeads = false;
    expect(await syncLeads(connection, auth)).toBe(0);
    expect(fetchLeads).toHaveBeenCalledTimes(1);
  });
});
