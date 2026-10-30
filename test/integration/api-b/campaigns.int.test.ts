/**
 * Workspace analytics and campaign actions (workspaces.routes.ts): totals leave
 * hidden platforms out, pause/budget changes on sample (DEMO) campaigns, and
 * the campaign detail with ad previews.
 */
import { getSyncQueue } from "@ashniva/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { createConnection, fetchCalls, isoDay, orgWith, resetAll, seedCampaign } from "./helpers";

afterAll(async () => {
  await getSyncQueue().close();
});
beforeEach(resetAll);

const range = `from=${isoDay(-7)}&to=${isoDay(0)}`;

async function workspaceWithMixedPlatforms(role: "OWNER" | "MANAGER" | "ANALYST" = "OWNER") {
  const ctx = await orgWith(role);
  const meta = await createConnection(ctx.org.id, { platform: "META", workspaceId: ctx.workspace.id });
  const tiktok = await createConnection(ctx.org.id, { platform: "TIKTOK", workspaceId: ctx.workspace.id });
  const metaCampaign = await seedCampaign(meta.adAccount, { name: "Meta prospecting", spend: 100, impressions: 5000, clicks: 50 });
  const tiktokCampaign = await seedCampaign(tiktok.adAccount, { name: "TikTok spark", spend: 900, impressions: 90000, clicks: 900 });
  return { ...ctx, meta, tiktok, metaCampaign, tiktokCampaign, api: await as(ctx.user), base: `/api/workspaces/${ctx.workspace.id}` };
}

describe("overview and campaign list", () => {
  it("leave hidden platforms out of every total", async () => {
    const { api, base, metaCampaign } = await workspaceWithMixedPlatforms();
    const overview = await api.get(`${base}/overview?${range}`);
    expect(overview.status).toBe(200);
    expect(overview.body.totals).toMatchObject({ spend: 100, impressions: 5000, clicks: 50 });
    expect(overview.body.byPlatform.map((p: { platform: string }) => p.platform)).toEqual(["META"]);
    expect(overview.body.topCampaigns.map((c: { id: string }) => c.id)).toEqual([metaCampaign.campaign.id]);
    expect(overview.body.accounts).toMatchObject({ total: 1, connections: 1 });
    const daySum = overview.body.timeseries.reduce((s: number, p: { spend: number }) => s + p.spend, 0);
    expect(daySum).toBe(100);

    const list = await api.get(`${base}/campaigns?${range}`);
    expect(list.status).toBe(200);
    expect(list.body.campaigns.map((c: { name: string }) => c.name)).toEqual(["Meta prospecting"]);
    expect(list.body.totals).toMatchObject({ spend: 100, impressions: 5000 });
    // Asking for the hidden platform directly finds nothing either.
    expect((await api.get(`${base}/campaigns?${range}&platform=TIKTOK`)).body.campaigns).toEqual([]);
  });

  it("leaves revoked connections and other workspaces out", async () => {
    const { api, base, meta, org } = await workspaceWithMixedPlatforms();
    const ws2 = await prisma.workspace.create({ data: { orgId: org.id, name: "Other", slug: `other-${Date.now()}` } });
    const google = await createConnection(org.id, { platform: "GOOGLE", workspaceId: ws2.id });
    await seedCampaign(google.adAccount, { spend: 333 });
    expect((await api.get(`${base}/overview?${range}`)).body.totals.spend).toBe(100);
    await prisma.platformConnection.update({ where: { id: meta.connection.id }, data: { status: "REVOKED" } });
    const after = await api.get(`${base}/overview?${range}`);
    expect(after.body.totals.spend).toBe(0);
    expect(after.body.accounts.total).toBe(0);
  });

  it("validates the date range", async () => {
    const { api, base } = await workspaceWithMixedPlatforms();
    expect((await api.get(`${base}/overview?from=${isoDay(0)}&to=${isoDay(-3)}`)).status).toBe(422);
    expect((await api.get(`${base}/campaigns`)).status).toBe(422);
  });
});

describe("campaign detail", () => {
  it("returns metrics, ad groups and ads with their previews", async () => {
    const { api, base, metaCampaign } = await workspaceWithMixedPlatforms();
    const preview = { platform: "META", setup: { objective: "OUTCOME_TRAFFIC" }, campaign: {}, adGroup: {}, ad: { primaryTexts: ["Hello"] }, media: {}, identity: { name: "Acme" } };
    await prisma.ad.update({ where: { id: metaCampaign.ad.id }, data: { preview, headline: "Shop now" } });
    const res = await api.get(`${base}/campaigns/${metaCampaign.campaign.id}?${range}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign).toMatchObject({ id: metaCampaign.campaign.id, platform: "META", dailyBudget: 1000 });
    expect(res.body.campaign.metrics.spend).toBe(100);
    expect(res.body.adGroups.map((g: { id: string; adCount: number }) => [g.id, g.adCount])).toEqual([[metaCampaign.adGroup.id, 1]]);
    expect(res.body.ads[0]).toMatchObject({ id: metaCampaign.ad.id, headline: "Shop now", preview });
  });

  it("hides campaigns of hidden platforms and other workspaces", async () => {
    const { api, base, tiktokCampaign } = await workspaceWithMixedPlatforms();
    expect((await api.get(`${base}/campaigns/${tiktokCampaign.campaign.id}?${range}`)).status).toBe(404);
    const other = await orgWith();
    const g = await createConnection(other.org.id, { platform: "GOOGLE", workspaceId: other.workspace.id });
    const foreign = await seedCampaign(g.adAccount, { spend: 1 });
    expect((await api.get(`${base}/campaigns/${foreign.campaign.id}?${range}`)).status).toBe(404);
    expect((await api.patch(`${base}/campaigns/${foreign.campaign.id}/status`).send({ status: "PAUSED" })).status).toBe(404);
  });
});

describe("campaign actions on sample campaigns", () => {
  it("pauses and resumes with an audit entry each time", async () => {
    const { api, base, metaCampaign, org, user } = await workspaceWithMixedPlatforms("MANAGER");
    const id = metaCampaign.campaign.id;
    const paused = await api.patch(`${base}/campaigns/${id}/status`).send({ status: "PAUSED" });
    expect(paused.status).toBe(200);
    expect(paused.body).toEqual({ id, status: "PAUSED" });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("PAUSED");
    // Same status again is a no-op.
    await api.patch(`${base}/campaigns/${id}/status`).send({ status: "PAUSED" });
    await api.patch(`${base}/campaigns/${id}/status`).send({ status: "ACTIVE" });
    const logs = await prisma.auditLog.findMany({ where: { orgId: org.id, entityId: id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["campaign.paused", "campaign.activated"]);
    expect(logs[0]!.changes).toEqual({ status: { from: "ACTIVE", to: "PAUSED" } });
    expect(logs[0]!.userId).toBe(user.id);
    expect(fetchCalls).toHaveLength(0);

    // The detail page's activity shows them.
    const detail = await api.get(`${base}/campaigns/${id}?${range}`);
    expect(detail.body.activity.map((a: { action: string }) => a.action)).toEqual(["campaign.activated", "campaign.paused"]);
  });

  it("changes the daily budget and validates it", async () => {
    const { api, base, metaCampaign, org } = await workspaceWithMixedPlatforms();
    const id = metaCampaign.campaign.id;
    expect((await api.patch(`${base}/campaigns/${id}/budget`).send({ dailyBudget: 0 })).status).toBe(422);
    const res = await api.patch(`${base}/campaigns/${id}/budget`).send({ dailyBudget: 2500.5 });
    expect(res.status).toBe(200);
    expect(Number((await prisma.campaign.findUniqueOrThrow({ where: { id } })).dailyBudget)).toBe(2500.5);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "campaign.budget_changed" } });
    expect(log.changes).toEqual({ dailyBudget: { from: 1000, to: 2500.5 } });
  });

  it("bulk pauses only this workspace's campaigns", async () => {
    const { api, base, meta, metaCampaign } = await workspaceWithMixedPlatforms();
    const second = await seedCampaign(meta.adAccount, { spend: 5 });
    const other = await orgWith();
    const g = await createConnection(other.org.id, { platform: "GOOGLE", workspaceId: other.workspace.id });
    const foreign = await seedCampaign(g.adAccount, { spend: 1 });
    const res = await api.post(`${base}/campaigns/bulk-status`).send({ campaignIds: [metaCampaign.campaign.id, second.campaign.id, foreign.campaign.id], status: "PAUSED" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, failed: [] });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: foreign.campaign.id } })).status).toBe("ACTIVE");
  });

  it("is forbidden for analysts and blocked while locked", async () => {
    const { api, base, metaCampaign, org, owner } = await workspaceWithMixedPlatforms("ANALYST");
    const id = metaCampaign.campaign.id;
    expect((await api.patch(`${base}/campaigns/${id}/status`).send({ status: "PAUSED" })).status).toBe(403);
    expect((await api.patch(`${base}/campaigns/${id}/budget`).send({ dailyBudget: 10 })).status).toBe(403);
    expect((await api.get(`${base}/campaigns/${id}?${range}`)).status).toBe(200);
    await prisma.organization.update({ where: { id: org.id }, data: { plan: "STARTER", subscriptionStatus: "EXPIRED" } });
    const ownerApi = await as(owner);
    expect((await ownerApi.patch(`${base}/campaigns/${id}/status`).send({ status: "PAUSED" })).status).toBe(402);
    expect((await ownerApi.get(`${base}/overview?${range}`)).status).toBe(200);
  });
});
