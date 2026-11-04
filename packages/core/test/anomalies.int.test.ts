import { addDays } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createOrg, createUser } from "../../../test/helpers/factories";
import { checkAnomalies } from "../src/anomalies";
import { encryptSecret } from "../src/crypto";

const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

let orgId: string;
let workspaceId: string;
let accountId: string;
const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);

beforeEach(async () => {
  await reset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  process.env.TOKEN_ENCRYPTION_KEY ||= "ab".repeat(32);
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner);
  orgId = org.id;
  workspaceId = workspace.id;
  const connection = await prisma.platformConnection.create({ data: { orgId, platform: "META", mode: "DEMO", externalUserId: "sample-meta", accessTokenEnc: encryptSecret("x") } });
  accountId = (await prisma.adAccount.create({ data: { orgId, connectionId: connection.id, platform: "META", externalId: "demo-1", name: "Meta", currency: "INR", status: "ACTIVE", workspaceId } })).id;
});
afterEach(() => vi.restoreAllMocks());

/** A running campaign with six steady days of ₹100 and then `latest` today. */
async function spiking(latest: number) {
  const c = await prisma.campaign.create({ data: { adAccountId: accountId, platform: "META", externalId: `c${Math.random()}`, name: "Diwali", status: "ACTIVE" } });
  const spends = [100, 100, 100, 100, 100, 100, latest];
  for (const [i, spend] of spends.entries()) {
    await prisma.metricDaily.create({
      data: { date: new Date(`${addDays(today, i - 6)}T00:00:00Z`), level: "CAMPAIGN", entityId: c.id, adAccountId: accountId, campaignId: c.id, platform: "META", spend, conversions: 1, impressions: 1000, clicks: 10 },
    });
  }
  return c;
}

describe("checkAnomalies", () => {
  it("alerts once about a spend spike, with one-click links, and not again the same day", async () => {
    await spiking(450);
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 1 });
    const note = await prisma.notification.findFirstOrThrow({ where: { type: "anomaly.spend_spike" } });
    expect(note).toMatchObject({ workspaceId, title: "Spend jumped on 1 campaign" });
    expect(note.body).toContain("Diwali (Meta Ads)");
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 0 });
  });

  it("stays quiet for normal spend", async () => {
    await spiking(130);
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 0 });
  });

  it("respects the workspace's sensitivity and its off switch", async () => {
    await spiking(170);
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 0 });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { anomalySpikeRatio: 1.5 } });
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 1 });

    await prisma.notification.deleteMany();
    await prisma.workspace.update({ where: { id: workspaceId }, data: { anomalyEnabled: false } });
    expect(await checkAnomalies(NOW)).toMatchObject({ checked: 0, alerts: 0 });
  });

  it("skips a muted campaign until the mute ends", async () => {
    const c = await spiking(450);
    await prisma.anomalySnooze.create({ data: { campaignId: c.id, orgId, until: new Date(NOW.getTime() + 86_400_000) } });
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 0 });
    await prisma.anomalySnooze.update({ where: { campaignId: c.id }, data: { until: new Date(NOW.getTime() - 1000) } });
    expect(await checkAnomalies(NOW)).toMatchObject({ alerts: 1 });
  });
});
