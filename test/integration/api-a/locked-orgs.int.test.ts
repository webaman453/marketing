/**
 * Locked organizations (unpaid sign-ups, ended trials, expired or lapsed subscriptions) are
 * read-only: reads work, and writes behind requireActivePlanForWrites / assertNotLocked /
 * assertFeature / assertWithinLimit answer 402 ORG_LOCKED without changing anything.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Test } from "supertest";
import { prisma, resetDb } from "../../helpers/db";
import { createWorkspace } from "../../helpers/factories";
import {
  anonymous,
  captureMail,
  createConnection,
  draftPayload,
  outbox,
  PNG_1PX,
  range,
  reportConfig,
  ruleBody,
  seedApiKey,
  seedTeam,
  seedWorkspaceContent,
  signedIn,
  type Client,
  type Team,
  type WorkspaceContent,
} from "./_support";

// Generous timeouts: these runs share one Postgres with other suites.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

beforeAll(async () => {
  await resetDb();
  await captureMail();
}, 180_000);

const past = () => new Date(Date.now() - 86_400_000);
const future = () => new Date(Date.now() + 7 * 86_400_000);

interface World {
  t: Team;
  c: WorkspaceContent;
  owner: Client;
  secret: string;
  keyId: string;
  archivedId: string;
  liveAccountId: string;
}

async function world(billing: Record<string, unknown>): Promise<World> {
  const t = await seedTeam();
  await prisma.organization.update({ where: { id: t.org.id }, data: billing });
  const c = await seedWorkspaceContent(t.org.id, t.workspace.id, t.owner.id);
  const { key, secret } = await seedApiKey(t.org.id);
  const archived = await createWorkspace(t.org.id, { archivedAt: new Date() });
  const live = await createConnection(t.org.id, { mode: "LIVE", workspaceId: null });
  return { t, c, owner: await signedIn(t.owner), secret, keyId: key.id, archivedId: archived.id, liveAccountId: live.adAccount.id };
}

const LOCKED: [string, Record<string, unknown>][] = [
  ["unpaid sign-up (TRIAL, no trial end)", { plan: "TRIAL", subscriptionStatus: "EXPIRED", trialEndsAt: null }],
  ["ended trial", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: past() }],
  ["expired subscription", { plan: "AGENCY", subscriptionStatus: "EXPIRED" }],
  ["cancelled, period over", { plan: "AGENCY", subscriptionStatus: "CANCELLED", currentPeriodEnd: past() }],
];

const UNLOCKED: [string, Record<string, unknown>][] = [
  ["running trial", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: future() }],
  ["past due", { plan: "AGENCY", subscriptionStatus: "PAST_DUE" }],
  ["cancelled, still in paid period", { plan: "AGENCY", subscriptionStatus: "CANCELLED", currentPeriodEnd: future() }],
];

const ws = (w: World, p: string) => `/api/workspaces/${w.t.workspace.id}${p}`;
const org = (w: World, p: string) => `/api/orgs/${w.t.org.id}${p}`;

const READS: [string, (w: World) => string][] = [
  ["org", (w) => org(w, "")],
  ["members", (w) => org(w, "/members")],
  ["billing", (w) => org(w, "/billing")],
  ["audit log", (w) => org(w, "/audit-logs")],
  ["connections", (w) => org(w, "/connections")],
  ["ad accounts", (w) => org(w, "/ad-accounts")],
  ["api keys", (w) => org(w, "/api-keys")],
  ["archived workspaces", (w) => org(w, "/workspaces/archived")],
  ["ai wallet", (w) => org(w, "/ai/wallet")],
  ["overview", (w) => ws(w, `/overview?${range()}`)],
  ["campaigns", (w) => ws(w, `/campaigns?${range()}`)],
  ["campaign", (w) => ws(w, `/campaigns/${w.c.campaign.id}?${range()}`)],
  ["leads", (w) => ws(w, `/leads?${range()}`)],
  ["leads export", (w) => ws(w, `/leads/export?${range()}`)],
  ["reports", (w) => ws(w, "/reports")],
  ["report data", (w) => ws(w, `/reports/${w.c.report.id}/data`)],
  ["report csv", (w) => ws(w, `/reports/${w.c.report.id}/export.csv`)],
  ["drafts", (w) => ws(w, "/drafts")],
  ["rules", (w) => ws(w, "/rules")],
  ["rule runs", (w) => ws(w, `/rules/${w.c.rule.id}/runs`)],
  ["creatives", (w) => ws(w, "/creatives")],
  ["ai status", (w) => ws(w, "/ai/status")],
];

const WRITES: [string, (w: World) => Test][] = [
  ["PATCH campaign status", (w) => w.owner.patch(ws(w, `/campaigns/${w.c.campaign.id}/status`)).send({ status: "PAUSED" })],
  ["PATCH campaign budget", (w) => w.owner.patch(ws(w, `/campaigns/${w.c.campaign.id}/budget`)).send({ dailyBudget: 9 })],
  ["POST bulk-status", (w) => w.owner.post(ws(w, "/campaigns/bulk-status")).send({ campaignIds: [w.c.campaign.id], status: "PAUSED" })],
  ["POST draft", (w) => w.owner.post(ws(w, "/drafts")).send({ name: "New", payload: draftPayload(w.c.adAccount.id) })],
  ["PATCH draft", (w) => w.owner.patch(ws(w, `/drafts/${w.c.draft.id}`)).send({ name: "Changed", payload: draftPayload(w.c.adAccount.id) })],
  ["duplicate draft", (w) => w.owner.post(ws(w, `/drafts/${w.c.draft.id}/duplicate`))],
  ["launch draft", (w) => w.owner.post(ws(w, `/drafts/${w.c.draft.id}/launch`))],
  ["DELETE draft", (w) => w.owner.delete(ws(w, `/drafts/${w.c.draft.id}`))],
  ["POST report", (w) => w.owner.post(ws(w, "/reports")).send({ name: "New", config: reportConfig })],
  ["PATCH report", (w) => w.owner.patch(ws(w, `/reports/${w.c.report.id}`)).send({ name: "Changed", config: reportConfig })],
  ["PUT report schedule", (w) => w.owner.put(ws(w, `/reports/${w.c.report.id}/schedule`)).send({ frequency: null })],
  ["POST report send", (w) => w.owner.post(ws(w, `/reports/${w.c.report.id}/send`))],
  ["POST report share", (w) => w.owner.post(ws(w, `/reports/${w.c.report.id}/share`))],
  ["DELETE report", (w) => w.owner.delete(ws(w, `/reports/${w.c.report.id}`))],
  ["POST rule", (w) => w.owner.post(ws(w, "/rules")).send(ruleBody())],
  ["PATCH rule", (w) => w.owner.patch(ws(w, `/rules/${w.c.rule.id}`)).send(ruleBody("Changed"))],
  ["toggle rule", (w) => w.owner.post(ws(w, `/rules/${w.c.rule.id}/toggle`))],
  ["run rule", (w) => w.owner.post(ws(w, `/rules/${w.c.rule.id}/run`)).send({ dryRun: false })],
  ["DELETE rule", (w) => w.owner.delete(ws(w, `/rules/${w.c.rule.id}`))],
  ["upload creative", (w) => w.owner.post(ws(w, "/creatives")).attach("files", PNG_1PX, { filename: "a.png", contentType: "image/png" })],
  ["PATCH creative", (w) => w.owner.patch(ws(w, `/creatives/${w.c.creative.id}`)).send({ name: "Changed" })],
  ["DELETE creative", (w) => w.owner.delete(ws(w, `/creatives/${w.c.creative.id}`))],
  ["AI insights", (w) => w.owner.post(ws(w, "/ai/insights")).send({})],
  ["create workspace", (w) => w.owner.post(org(w, "/workspaces")).send({ name: "Another" })],
  ["restore workspace", (w) => w.owner.post(org(w, `/workspaces/${w.archivedId}/restore`))],
  ["invite member", (w) => w.owner.post(org(w, "/invitations")).send({ email: "new@example.test", role: "ADMIN" })],
  ["PATCH branding", (w) => w.owner.patch(org(w, "/branding")).send({ brandName: "X", brandColor: null, reportFooter: null })],
  ["upload logo", (w) => w.owner.post(org(w, "/branding/logo")).attach("file", PNG_1PX, { filename: "l.png", contentType: "image/png" })],
  ["DELETE logo", (w) => w.owner.delete(org(w, "/branding/logo"))],
  ["create API key", (w) => w.owner.post(org(w, "/api-keys")).send({ name: "Key" })],
  ["revoke API key", (w) => w.owner.delete(org(w, `/api-keys/${w.keyId}`))],
  ["sync connection", (w) => w.owner.post(org(w, `/connections/${w.c.connection.id}/sync`))],
  ["authorize platform", (w) => w.owner.post(org(w, "/connections/META/authorize")).send({ workspaceId: w.t.workspace.id })],
  ["assign a live ad account", (w) => w.owner.patch(org(w, `/ad-accounts/${w.liveAccountId}`)).send({ workspaceId: w.t.workspace.id })],
];

describe.each(LOCKED)("locked: %s", (_label, billing) => {
  let w: World;
  let before: string;
  const state = async () =>
    JSON.stringify(
      await Promise.all([
        prisma.campaign.findMany({ where: { adAccount: { orgId: w.t.org.id } }, orderBy: { id: "asc" } }),
        prisma.campaignDraft.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.report.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.rule.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.creative.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.workspace.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.invitation.count({ where: { orgId: w.t.org.id } }),
        prisma.apiKey.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.adAccount.findMany({ where: { orgId: w.t.org.id }, orderBy: { id: "asc" } }),
        prisma.organization.findUniqueOrThrow({ where: { id: w.t.org.id } }),
      ]),
    );

  beforeAll(async () => {
    w = await world(billing);
    before = await state();
  });

  it("/me reports the org as locked", async () => {
    const me = (await w.owner.get("/api/auth/me")).body;
    expect(me.orgs[0]).toMatchObject({ id: w.t.org.id, locked: true });
  });

  it.each(READS)("reads work: %s", async (_name, url) => {
    const res = await w.owner.get(url(w));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("the public report link still works", async () => {
    expect((await (await anonymous()).get(`/api/public/reports/${w.c.report.shareToken}`)).status).toBe(200);
  });

  it.each(WRITES)("writes are refused with 402 ORG_LOCKED: %s", async (_name, call) => {
    const res = await call(w);
    expect(res.status, JSON.stringify(res.body)).toBe(402);
    expect(res.body.error.code).toBe("ORG_LOCKED");
  });

  it("the API key is refused", async () => {
    const res = await (await anonymous()).get("/api/v1/workspaces").set("Authorization", `Bearer ${w.secret}`);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("ORG_LOCKED");
  });

  it("nothing was changed by the refused writes", async () => {
    expect(await state()).toBe(before);
    expect(outbox.filter((m) => m.to.includes("new@example.test"))).toHaveLength(0);
  });
});

describe.each(UNLOCKED)("not locked: %s", (_label, billing) => {
  let w: World;
  beforeAll(async () => {
    w = await world(billing);
  });

  it("/me reports the org as unlocked and writes go through", async () => {
    expect((await w.owner.get("/api/auth/me")).body.orgs[0].locked).toBe(false);
    expect((await w.owner.post(ws(w, "/reports")).send({ name: "New", config: reportConfig })).status).toBe(201);
    expect((await w.owner.post(ws(w, "/drafts")).send({ name: "New", payload: draftPayload(w.c.adAccount.id) })).status).toBe(201);
    expect((await w.owner.patch(ws(w, `/campaigns/${w.c.campaign.id}/budget`)).send({ dailyBudget: 900 })).status).toBe(200);
    expect((await w.owner.post(org(w, "/workspaces")).send({ name: "Another" })).status).toBe(201);
    const v1 = await (await anonymous()).get("/api/v1/workspaces").set("Authorization", `Bearer ${w.secret}`);
    expect(v1.status).toBe(200);
  });
});

describe("unlocking", () => {
  it("writes refused while locked go through once the plan is active again", async () => {
    const w = await world({ plan: "AGENCY", subscriptionStatus: "EXPIRED" });
    const call = () => w.owner.post(ws(w, "/rules")).send(ruleBody());
    expect((await call()).status).toBe(402);
    await prisma.organization.update({ where: { id: w.t.org.id }, data: { subscriptionStatus: "ACTIVE" } });
    expect((await call()).status).toBe(201);
  });
});
