/**
 * Tenancy: the owner of org A tries every id-taking route with org B's ids. Nothing of B may
 * be read or changed. One world is seeded for the whole file; every attempt must fail, and the
 * last test checks B's data is exactly as seeded.
 */
import { vi, beforeAll, describe, expect, it } from "vitest";
import { prisma, resetDb } from "../../helpers/db";
import {
  anonymous,
  captureMail,
  draftPayload,
  outbox,
  range,
  reportConfig,
  ruleBody,
  seedApiKey,
  seedInvitation,
  seedTeam,
  seedWorkspaceContent,
  signedIn,
  type Client,
  type Team,
  type WorkspaceContent,
} from "./_support";

let A: Team;
let B: Team;
let a: WorkspaceContent; // A's content, in A's main workspace
let b: WorkspaceContent; // B's content, in B's main workspace
let bKey: { key: { id: string }; secret: string };
let aKey: { secret: string };
let bInvite: { invite: { id: string }; token: string };
let bArchived: { id: string };
let owner: Client; // A's owner
let snapshot: string;

async function snapshotB() {
  const orgId = B.org.id;
  const [org, members, workspaces, campaigns, drafts, creatives, reports, rules, leads, connections, accounts, keys, invites] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
    prisma.membership.findMany({ where: { orgId }, include: { workspaces: true }, orderBy: { id: "asc" } }),
    prisma.workspace.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.campaign.findMany({ where: { adAccount: { orgId } }, orderBy: { id: "asc" } }),
    prisma.campaignDraft.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.creative.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.report.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.rule.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.lead.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.platformConnection.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.adAccount.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.apiKey.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
    prisma.invitation.findMany({ where: { orgId }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ org, members, workspaces, campaigns, drafts, creatives, reports, rules, leads, connections, accounts, keys, invites });
}

// Generous timeouts: these runs share one Postgres with other suites.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

beforeAll(async () => {
  await resetDb();
  await captureMail();
  A = await seedTeam({ name: "Org A" });
  B = await seedTeam({ name: "Org B" });
  a = await seedWorkspaceContent(A.org.id, A.workspace.id, A.owner.id);
  b = await seedWorkspaceContent(B.org.id, B.workspace.id, B.owner.id);
  bKey = await seedApiKey(B.org.id);
  aKey = await seedApiKey(A.org.id);
  bInvite = await seedInvitation(B.org.id, { role: "ADMIN" });
  // B spent money yesterday: none of it may show up in A's numbers.
  const yesterday = new Date(`${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
  await prisma.metricDaily.create({
    data: { date: yesterday, level: "CAMPAIGN", entityId: b.campaign.id, adAccountId: b.adAccount.id, campaignId: b.campaign.id, platform: "META", impressions: 5000, clicks: 77, spend: 999 },
  });
  bArchived = await prisma.workspace.create({ data: { orgId: B.org.id, name: "B archived", slug: "b-archived", archivedAt: new Date() } });
  owner = await signedIn(A.owner);
  snapshot = await snapshotB();
}, 180_000);

const expect404 = async (p: PromiseLike<{ status: number; body: unknown }>) => {
  const res = await p;
  expect(res.status, JSON.stringify(res.body)).toBe(404);
};

describe("org B's own routes are invisible to A's owner", () => {
  const routes: [string, string, unknown?][] = [
    ["get", ""],
    ["patch", "", { name: "Hijacked" }],
    ["delete", "", { confirmName: "Org B" }],
    ["get", "/members"],
    ["get", "/invitations"],
    ["post", "/invitations", { email: "spy@example.test", role: "ADMIN" }],
    ["post", "/leave"],
    ["post", "/workspaces", { name: "Injected" }],
    ["get", "/workspaces/archived"],
    ["get", "/audit-logs"],
    ["get", "/billing"],
    ["post", "/billing/cancel"],
    ["get", "/ai/wallet"],
    ["get", "/connections"],
    ["get", "/ad-accounts"],
    ["get", "/api-keys"],
    ["post", "/api-keys", { name: "Backdoor" }],
    ["patch", "/branding", { brandName: "X", brandColor: null, reportFooter: null }],
    ["delete", "/branding/logo"],
    ["delete", "/sample-data"],
    ["post", "/sample-data", { workspaceId: "x" }],
  ];
  it.each(routes)("%s /orgs/B%s → 404", async (method, path, body) => {
    const req = owner[method as "get"](`/api/orgs/${B.org.id}${path}`);
    await expect404(body ? (req as unknown as { send: (b: unknown) => typeof req }).send(body) : req);
  });

  it("id-taking routes under /orgs/B with B's ids → 404", async () => {
    const o = `/api/orgs/${B.org.id}`;
    await expect404(owner.patch(`${o}/members/${B.members.MANAGER.id}`).send({ role: "ADMIN" }));
    await expect404(owner.delete(`${o}/members/${B.members.MANAGER.id}`));
    await expect404(owner.post(`${o}/transfer-ownership`).send({ memberId: B.members.ADMIN.id }));
    await expect404(owner.delete(`${o}/invitations/${bInvite.invite.id}`));
    await expect404(owner.post(`${o}/invitations/${bInvite.invite.id}/resend`));
    await expect404(owner.patch(`${o}/workspaces/${B.workspace.id}`).send({ name: "Hijacked" }));
    await expect404(owner.delete(`${o}/workspaces/${B.other.id}`));
    await expect404(owner.post(`${o}/workspaces/${bArchived.id}/restore`));
    await expect404(owner.post(`${o}/connections/${b.connection.id}/sync`));
    await expect404(owner.delete(`${o}/connections/${b.connection.id}`));
    await expect404(owner.patch(`${o}/ad-accounts/${b.adAccount.id}`).send({ workspaceId: null }));
    await expect404(owner.delete(`${o}/api-keys/${bKey.key.id}`));
  });
});

describe("B's ids through A's org routes", () => {
  const o = () => `/api/orgs/${A.org.id}`;

  it("members, invitations and ownership", async () => {
    await expect404(owner.patch(`${o()}/members/${B.members.MANAGER.id}`).send({ role: "ADMIN" }));
    await expect404(owner.delete(`${o()}/members/${B.members.MANAGER.id}`));
    await expect404(owner.post(`${o()}/transfer-ownership`).send({ memberId: B.members.ADMIN.id }));
    await expect404(owner.delete(`${o()}/invitations/${bInvite.invite.id}`));
    await expect404(owner.post(`${o()}/invitations/${bInvite.invite.id}/resend`));
    // B's workspaces can't be handed out through A's invites or role changes.
    const inv = await owner.post(`${o()}/invitations`).send({ email: "x@example.test", role: "MANAGER", workspaceIds: [B.workspace.id] });
    expect(inv.status).toBe(400);
    const role = await owner.patch(`${o()}/members/${A.members.ADMIN.id}`).send({ role: "MANAGER", workspaceIds: [B.workspace.id] });
    expect(role.status).toBe(400);
    const mixed = await owner.patch(`${o()}/members/${A.members.ANALYST.id}`).send({ role: "ANALYST", workspaceIds: [A.workspace.id, B.workspace.id] });
    expect(mixed.status).toBe(204);
    expect(await prisma.membershipWorkspace.count({ where: { membershipId: A.members.ANALYST.id, workspaceId: B.workspace.id } })).toBe(0);
    expect(outbox.filter((m) => m.to.includes("x@example.test"))).toHaveLength(0);
  });

  it("workspaces", async () => {
    await expect404(owner.patch(`${o()}/workspaces/${B.workspace.id}`).send({ name: "Hijacked" }));
    await expect404(owner.delete(`${o()}/workspaces/${B.other.id}`));
    await expect404(owner.post(`${o()}/workspaces/${bArchived.id}/restore`));
    const archived = await owner.get(`${o()}/workspaces/archived`);
    expect(archived.body.map((w: { id: string }) => w.id)).not.toContain(bArchived.id);
  });

  it("connections, ad accounts, sample data, API keys", async () => {
    await expect404(owner.post(`${o()}/connections/${b.connection.id}/sync`));
    await expect404(owner.delete(`${o()}/connections/${b.connection.id}`));
    await expect404(owner.patch(`${o()}/ad-accounts/${b.adAccount.id}`).send({ workspaceId: A.workspace.id }));
    // A's own account can't be moved into B's workspace.
    await expect404(owner.patch(`${o()}/ad-accounts/${a.adAccount.id}`).send({ workspaceId: B.workspace.id }));
    await expect404(owner.post(`${o()}/connections/META/authorize`).send({ workspaceId: B.workspace.id }));
    await expect404(owner.post(`${o()}/sample-data`).send({ workspaceId: B.workspace.id }));
    await expect404(owner.delete(`${o()}/api-keys/${bKey.key.id}`));

    const conns = (await owner.get(`${o()}/connections`)).body.map((c: { id: string }) => c.id);
    expect(conns).toEqual([a.connection.id]);
    const accounts = (await owner.get(`${o()}/ad-accounts`)).body.map((x: { id: string }) => x.id);
    expect(accounts).toEqual([a.adAccount.id]);
    const keys = (await owner.get(`${o()}/api-keys`)).body.map((k: { id: string }) => k.id);
    expect(keys).not.toContain(bKey.key.id);
    const logs = (await owner.get(`${o()}/audit-logs`)).body.items;
    expect(logs.every((l: { entityId: string | null }) => l.entityId !== b.campaign.id)).toBe(true);
    const members = (await owner.get(`${o()}/members`)).body.map((m: { userId: string }) => m.userId);
    expect(members).not.toContain(B.owner.id);
  });

  it("audit-log filter by B's workspace returns nothing of B", async () => {
    await prisma.auditLog.create({ data: { orgId: B.org.id, workspaceId: B.workspace.id, action: "secret.b", entityType: "x" } });
    const res = await owner.get(`${o()}/audit-logs?workspaceId=${B.workspace.id}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    await prisma.auditLog.deleteMany({ where: { action: "secret.b" } });
  });
});

describe("B's workspace through /api/workspaces", () => {
  const paths: [string, string, unknown?][] = [
    ["get", `/overview?RANGE`],
    ["get", `/campaigns?RANGE`],
    ["get", `/ad-accounts`],
    ["get", `/leads?RANGE`],
    ["get", `/leads/export?RANGE`],
    ["get", `/creatives`],
    ["get", `/drafts`],
    ["get", `/reports`],
    ["get", `/rules`],
    ["get", `/ai/status`],
    ["post", `/reports/preview`, { config: reportConfig }],
    ["post", `/reports`, { name: "Spy", config: reportConfig }],
    ["post", `/rules`, ruleBody()],
    ["post", `/campaigns/bulk-status`, { campaignIds: ["x"], status: "PAUSED" }],
  ];
  it.each(paths)("%s /workspaces/B%s → 404", async (method, path, body) => {
    const url = `/api/workspaces/${B.workspace.id}${path.replace("RANGE", range())}`;
    const req = owner[method as "get"](url);
    await expect404(body ? (req as unknown as { send: (b: unknown) => typeof req }).send(body) : req);
  });

  it("B's archived workspace is also 404", async () => {
    await expect404(owner.get(`/api/workspaces/${bArchived.id}/reports`));
  });
});

describe("B's ids through A's workspace routes", () => {
  const ws = (p: string) => `/api/workspaces/${A.workspace.id}${p}`;

  it("A's overview doesn't include B's spend", async () => {
    const res = await owner.get(ws(`/overview?${range()}`));
    expect(res.status).toBe(200);
    expect(res.body.totals.spend).toBe(0);
    expect(res.body.topCampaigns).toEqual([]);
  });

  it("campaigns, ads and AI", async () => {
    await expect404(owner.get(ws(`/campaigns/${b.campaign.id}?${range()}`)));
    await expect404(owner.patch(ws(`/campaigns/${b.campaign.id}/status`)).send({ status: "PAUSED" }));
    await expect404(owner.patch(ws(`/campaigns/${b.campaign.id}/budget`)).send({ dailyBudget: 1 }));
    const bulk = await owner.post(ws("/campaigns/bulk-status")).send({ campaignIds: [b.campaign.id], status: "PAUSED" });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({ updated: 0, failed: [] });
    const filtered = await owner.get(ws(`/campaigns?${range()}&adAccountId=${b.adAccount.id}`));
    expect(filtered.body.campaigns).toEqual([]);
    await expect404(owner.get(ws(`/ads/${b.ad.id}/media`)));
    await expect404(owner.get(ws(`/ads/${b.ad.id}/media/0/download`)));
    await expect404(owner.post(ws(`/ai/campaigns/${b.campaign.id}/insights`)).send({}));
  });

  it("drafts and the builder", async () => {
    await expect404(owner.get(ws(`/drafts/${b.draft.id}`)));
    await expect404(owner.patch(ws(`/drafts/${b.draft.id}`)).send({ name: "x", payload: draftPayload(a.adAccount.id) }));
    await expect404(owner.post(ws(`/drafts/${b.draft.id}/duplicate`)));
    await expect404(owner.post(ws(`/drafts/${b.draft.id}/validate`)));
    await expect404(owner.post(ws(`/drafts/${b.draft.id}/launch`)));
    await expect404(owner.delete(ws(`/drafts/${b.draft.id}`)));
    // A draft can't target B's ad account.
    const create = await owner.post(ws("/drafts")).send({ name: "x", payload: draftPayload(b.adAccount.id) });
    expect(create.status).toBe(400);
    const patch = await owner.patch(ws(`/drafts/${a.draft.id}`)).send({ name: "x", payload: draftPayload(b.adAccount.id) });
    expect(patch.status).toBe(400);
    await expect404(owner.get(ws(`/builder/options?adAccountId=${b.adAccount.id}`)));
    await expect404(owner.get(ws(`/builder/targeting?adAccountId=${b.adAccount.id}&kind=location&q=in`)));
    const list = (await owner.get(ws("/drafts"))).body.map((d: { id: string }) => d.id);
    expect(list).not.toContain(b.draft.id);
  });

  it("creatives", async () => {
    await expect404(owner.patch(ws(`/creatives/${b.creative.id}`)).send({ name: "stolen" }));
    await expect404(owner.delete(ws(`/creatives/${b.creative.id}`)));
    const list = (await owner.get(ws("/creatives"))).body.map((c: { id: string }) => c.id);
    expect(list).toEqual([a.creative.id]);
  });

  it("reports", async () => {
    const r = b.report.id;
    await expect404(owner.get(ws(`/reports/${r}`)));
    await expect404(owner.get(ws(`/reports/${r}/data`)));
    await expect404(owner.get(ws(`/reports/${r}/export.csv`)));
    await expect404(owner.get(ws(`/reports/${r}/export.pdf`)));
    await expect404(owner.patch(ws(`/reports/${r}`)).send({ name: "Hijacked", config: reportConfig }));
    await expect404(owner.put(ws(`/reports/${r}/schedule`)).send({ frequency: null }));
    await expect404(owner.post(ws(`/reports/${r}/send`)));
    await expect404(owner.post(ws(`/reports/${r}/share`)));
    await expect404(owner.delete(ws(`/reports/${r}/share`)));
    await expect404(owner.delete(ws(`/reports/${r}`)));
    const list = (await owner.get(ws("/reports"))).body.map((x: { id: string }) => x.id);
    expect(list).toEqual([a.report.id]);
  });

  it("rules (and B's campaigns are dropped from a rule's scope)", async () => {
    const r = b.rule.id;
    await expect404(owner.get(ws(`/rules/${r}`)));
    await expect404(owner.get(ws(`/rules/${r}/runs`)));
    await expect404(owner.patch(ws(`/rules/${r}`)).send(ruleBody()));
    await expect404(owner.post(ws(`/rules/${r}/toggle`)));
    await expect404(owner.post(ws(`/rules/${r}/run`)).send({ dryRun: true }));
    await expect404(owner.delete(ws(`/rules/${r}`)));
    const body = ruleBody("Scoped");
    body.scope.campaignIds = [b.campaign.id, a.campaign.id] as never[];
    const created = await owner.post(ws("/rules")).send(body);
    expect(created.status).toBe(201);
    expect(created.body.scope.campaignIds).toEqual([a.campaign.id]);
    await prisma.rule.delete({ where: { id: created.body.id } });
  });

  it("leads", async () => {
    const res = await owner.get(ws(`/leads?${range()}`));
    expect(res.status).toBe(200);
    expect(res.body.leads.map((l: { id: string }) => l.id)).toEqual([a.lead.id]);
    const byB = await owner.get(ws(`/leads?${range()}&campaignId=${b.campaign.id}`));
    expect(byB.body.total).toBe(0);
    const csv = await owner.get(ws(`/leads/export?${range()}`));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(a.lead.email!);
    expect(csv.text).not.toContain(b.lead.email!);
  });
});

describe("public API keys stay inside their org", () => {
  it("A's key lists only A's workspaces and gets 404 for B's", async () => {
    const anon = await anonymous();
    const auth = `Bearer ${aKey.secret}`;
    const list = await anon.get("/api/v1/workspaces").set("Authorization", auth);
    expect(list.body.data.map((w: { id: string }) => w.id).sort()).toEqual([A.workspace.id, A.other.id].sort());
    await expect404(anon.get(`/api/v1/workspaces/${B.workspace.id}/campaigns?${range()}`).set("Authorization", auth));
    await expect404(anon.get(`/api/v1/workspaces/${B.workspace.id}/metrics?${range()}`).set("Authorization", auth));
    const metrics = await anon.get(`/api/v1/workspaces/${A.workspace.id}/metrics?${range()}&campaignId=${b.campaign.id}`).set("Authorization", auth);
    expect(metrics.status).toBe(200);
    expect(metrics.body.data.length).toBeGreaterThan(0);
    expect(metrics.body.data.every((p: { spend: number; clicks: number }) => p.spend === 0 && p.clicks === 0)).toBe(true);
  });
});

describe("notifications are per user", () => {
  it("can't read or mark another user's notifications", async () => {
    const n = await prisma.notification.create({ data: { orgId: B.org.id, userId: B.owner.id, type: "rule", title: "B secret" } });
    const list = await owner.get(`/api/notifications?orgId=${B.org.id}`);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    expect((await owner.post("/api/notifications/read").send({ ids: [n.id] })).status).toBe(204);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull();
    await prisma.notification.delete({ where: { id: n.id } });
  });
});

describe("a member of both orgs is still scoped per org", () => {
  it("A's analyst who is B's client can't use A's role in B", async () => {
    const both = A.users.ADMIN;
    await prisma.membership.create({ data: { orgId: B.org.id, userId: both.id, role: "CLIENT", workspaces: { create: [{ workspaceId: B.workspace.id }] } } });
    const c = await signedIn(both);
    expect((await c.get(`/api/orgs/${A.org.id}/members`)).status).toBe(200);
    expect((await c.get(`/api/orgs/${B.org.id}/members`)).status).toBe(403);
    expect((await c.patch(`/api/orgs/${B.org.id}`).send({ name: "Hijacked" })).status).toBe(403);
    expect((await c.get(`/api/workspaces/${B.other.id}/reports`)).status).toBe(404);
    expect((await c.post(`/api/workspaces/${B.workspace.id}/reports`).send({ name: "x", config: reportConfig })).status).toBe(404);
    await prisma.membership.deleteMany({ where: { orgId: B.org.id, userId: both.id } });
  });
});

describe("org B afterwards", () => {
  it("is exactly as seeded", async () => {
    expect(await snapshotB()).toBe(snapshot);
  });
});
