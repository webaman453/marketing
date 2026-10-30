/**
 * Permission matrix: every role (and a non-member) against the main org- and workspace-scoped
 * routes. Expectations come from packages/shared/src/roles.ts `can` (plus the few routes that
 * check a role directly), so a change to the role table changes what this suite expects.
 *
 * Each route gets its own team (one member per role); routes that destroy something create
 * a fresh target per call in `prepare`.
 */
import { can, canManageMember, type Permission, type Role } from "@ashniva/shared";
import type { Test } from "supertest";
import { vi, beforeAll, describe, expect, it } from "vitest";
import { prisma, resetDb } from "../../helpers/db";
import { addMember, createWorkspace } from "../../helpers/factories";
import {
  captureMail,
  createConnection,
  draftPayload,
  quickUser,
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

type Caller = Role | "NONMEMBER";
const CALLERS: Caller[] = ["OWNER", "ADMIN", "MANAGER", "ANALYST", "CLIENT", "NONMEMBER"];
type Outcome = "allow" | 403 | 404;

interface Ctx {
  t: Team;
  c: WorkspaceContent;
  ws: string;
  org: string;
}
interface Spec {
  name: string;
  /** A permission from roles.ts, or a function giving the outcome per role. */
  rule: Permission | "member" | ((role: Role) => Outcome);
  ok: number;
  prepare?: (ctx: Ctx) => Promise<string>;
  call: (client: Client, ctx: Ctx, prepared: string) => Test;
}

const outcome = (spec: Spec, caller: Caller): Outcome => {
  if (caller === "NONMEMBER") return 404;
  if (spec.rule === "member") return "allow";
  if (typeof spec.rule === "function") return spec.rule(caller);
  return can(caller, spec.rule) ? "allow" : 403;
};

const notClient403 = (role: Role): Outcome => (role === "CLIENT" ? 403 : "allow");
const notClient404 = (role: Role): Outcome => (role === "CLIENT" ? 404 : "allow");

let n = 0;
const uniq = () => `${Date.now().toString(36)}${n++}`;
const victim = async ({ t }: Ctx) => (await addMember(t.org.id, await quickUser(), "ANALYST", [t.workspace.id])).id;

const ORG_ROUTES: Spec[] = [
  { name: "GET /orgs/:orgId", rule: "member", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}`) },
  { name: "PATCH /orgs/:orgId", rule: "org:update", ok: 200, call: (cl, x) => cl.patch(`/api/orgs/${x.org}`).send({ name: "Renamed org" }) },
  { name: "DELETE /orgs/:orgId (wrong name)", rule: "org:delete", ok: 400, call: (cl, x) => cl.delete(`/api/orgs/${x.org}`).send({ confirmName: "not it" }) },
  { name: "GET /members", rule: notClient403, ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/members`) },
  {
    name: "PATCH /members/:memberId",
    rule: "members:manage",
    ok: 204,
    prepare: victim,
    call: (cl, x, id) => cl.patch(`/api/orgs/${x.org}/members/${id}`).send({ role: "CLIENT" }),
  },
  {
    name: "DELETE /members/:memberId (an analyst)",
    rule: (role) => (canManageMember(role, "ANALYST") ? "allow" : 403),
    ok: 204,
    prepare: victim,
    call: (cl, x, id) => cl.delete(`/api/orgs/${x.org}/members/${id}`),
  },
  { name: "GET /invitations", rule: "members:manage", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/invitations`) },
  {
    name: "POST /invitations",
    rule: "members:manage",
    ok: 201,
    call: (cl, x) => cl.post(`/api/orgs/${x.org}/invitations`).send({ email: `inv-${uniq()}@example.test`, role: "ADMIN" }),
  },
  {
    name: "POST /invitations/:id/resend",
    rule: "members:manage",
    ok: 204,
    prepare: async ({ t }) => (await seedInvitation(t.org.id, { role: "ADMIN" })).invite.id,
    call: (cl, x, id) => cl.post(`/api/orgs/${x.org}/invitations/${id}/resend`),
  },
  {
    name: "DELETE /invitations/:id",
    rule: "members:manage",
    ok: 204,
    prepare: async ({ t }) => (await seedInvitation(t.org.id, { role: "ADMIN" })).invite.id,
    call: (cl, x, id) => cl.delete(`/api/orgs/${x.org}/invitations/${id}`),
  },
  {
    name: "POST /transfer-ownership",
    rule: "org:delete",
    ok: 204,
    prepare: victim,
    call: (cl, x, id) => cl.post(`/api/orgs/${x.org}/transfer-ownership`).send({ memberId: id }),
  },
  { name: "POST /workspaces", rule: "workspaces:manage", ok: 201, call: (cl, x) => cl.post(`/api/orgs/${x.org}/workspaces`).send({ name: `WS ${uniq()}` }) },
  {
    name: "PATCH /workspaces/:workspaceId",
    rule: "workspaces:manage",
    ok: 200,
    call: (cl, x) => cl.patch(`/api/orgs/${x.org}/workspaces/${x.t.other.id}`).send({ name: "Renamed", currency: "INR", timezone: "Asia/Kolkata" }),
  },
  {
    name: "DELETE /workspaces/:workspaceId (archive)",
    rule: "workspaces:manage",
    ok: 204,
    prepare: async ({ t }) => (await createWorkspace(t.org.id)).id,
    call: (cl, x, id) => cl.delete(`/api/orgs/${x.org}/workspaces/${id}`),
  },
  { name: "GET /workspaces/archived", rule: "workspaces:manage", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/workspaces/archived`) },
  {
    name: "POST /workspaces/:workspaceId/restore",
    rule: "workspaces:manage",
    ok: 200,
    prepare: async ({ t }) => (await createWorkspace(t.org.id, { archivedAt: new Date() })).id,
    call: (cl, x, id) => cl.post(`/api/orgs/${x.org}/workspaces/${id}/restore`),
  },
  { name: "GET /audit-logs", rule: "audit:view", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/audit-logs`) },
  { name: "GET /billing", rule: "member", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/billing`) },
  { name: "POST /billing/cancel (no subscription)", rule: "billing:manage", ok: 400, call: (cl, x) => cl.post(`/api/orgs/${x.org}/billing/cancel`) },
  { name: "POST /billing/checkout (bad plan)", rule: "billing:manage", ok: 422, call: (cl, x) => cl.post(`/api/orgs/${x.org}/billing/checkout`).send({ plan: "NOPE" }) },
  { name: "GET /ai/wallet", rule: notClient403, ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/ai/wallet`) },
  { name: "POST /ai/packs/checkout (bad body)", rule: "billing:manage", ok: 422, call: (cl, x) => cl.post(`/api/orgs/${x.org}/ai/packs/checkout`).send({}) },
  { name: "GET /platforms", rule: "member", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/platforms`) },
  { name: "GET /connections", rule: "member", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/connections`) },
  { name: "POST /connections/:id/sync", rule: "integrations:manage", ok: 202, call: (cl, x) => cl.post(`/api/orgs/${x.org}/connections/${x.c.connection.id}/sync`) },
  {
    name: "DELETE /connections/:id",
    rule: "integrations:manage",
    ok: 204,
    prepare: async ({ t }) => (await createConnection(t.org.id)).connection.id,
    call: (cl, x, id) => cl.delete(`/api/orgs/${x.org}/connections/${id}`),
  },
  { name: "GET /ad-accounts", rule: "member", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/ad-accounts`) },
  {
    name: "PATCH /ad-accounts/:id (assign)",
    rule: "integrations:manage",
    ok: 200,
    prepare: async ({ t }) => (await createConnection(t.org.id, { workspaceId: null })).adAccount.id,
    call: (cl, x, id) => cl.patch(`/api/orgs/${x.org}/ad-accounts/${id}`).send({ workspaceId: x.ws }),
  },
  { name: "DELETE /sample-data", rule: "integrations:manage", ok: 200, call: (cl, x) => cl.delete(`/api/orgs/${x.org}/sample-data`) },
  { name: "GET /api-keys", rule: "org:update", ok: 200, call: (cl, x) => cl.get(`/api/orgs/${x.org}/api-keys`) },
  { name: "POST /api-keys", rule: "org:update", ok: 201, call: (cl, x) => cl.post(`/api/orgs/${x.org}/api-keys`).send({ name: "Key" }) },
  {
    name: "DELETE /api-keys/:id",
    rule: "org:update",
    ok: 204,
    prepare: async ({ t }) => (await seedApiKey(t.org.id)).key.id,
    call: (cl, x, id) => cl.delete(`/api/orgs/${x.org}/api-keys/${id}`),
  },
  {
    name: "PATCH /branding",
    rule: "org:update",
    ok: 200,
    call: (cl, x) => cl.patch(`/api/orgs/${x.org}/branding`).send({ brandName: "B", brandColor: "#000000", reportFooter: null }),
  },
  { name: "DELETE /branding/logo", rule: "org:update", ok: 204, call: (cl, x) => cl.delete(`/api/orgs/${x.org}/branding/logo`) },
];

const w = (x: Ctx, path: string) => `/api/workspaces/${x.ws}${path}`;
const freshCampaign = async ({ c }: Ctx) =>
  (
    await prisma.campaign.create({
      data: { adAccountId: c.adAccount.id, platform: "META", externalId: `c_${uniq()}`, name: "Fresh", status: "ACTIVE", dailyBudget: 100 },
    })
  ).id;

const WORKSPACE_ROUTES: Spec[] = [
  { name: "GET /overview", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/overview?${range()}`)) },
  { name: "GET /campaigns", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/campaigns?${range()}`)) },
  { name: "GET /campaigns/:id", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/campaigns/${x.c.campaign.id}?${range()}`)) },
  {
    name: "PATCH /campaigns/:id/status",
    rule: "campaigns:edit",
    ok: 200,
    prepare: freshCampaign,
    call: (cl, x, id) => cl.patch(w(x, `/campaigns/${id}/status`)).send({ status: "PAUSED" }),
  },
  {
    name: "PATCH /campaigns/:id/budget",
    rule: "campaigns:edit",
    ok: 200,
    prepare: freshCampaign,
    call: (cl, x, id) => cl.patch(w(x, `/campaigns/${id}/budget`)).send({ dailyBudget: 750 }),
  },
  {
    name: "POST /campaigns/bulk-status",
    rule: "campaigns:edit",
    ok: 200,
    call: (cl, x) => cl.post(w(x, "/campaigns/bulk-status")).send({ campaignIds: ["missing"], status: "PAUSED" }),
  },
  { name: "GET /ad-accounts (workspace)", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/ad-accounts")) },
  { name: "GET /leads", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/leads?${range()}`)) },
  { name: "GET /leads/export", rule: "leads:export", ok: 200, call: (cl, x) => cl.get(w(x, `/leads/export?${range()}`)) },
  { name: "GET /creatives", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/creatives")) },
  { name: "PATCH /creatives/:id", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.patch(w(x, `/creatives/${x.c.creative.id}`)).send({ tags: ["a"] }) },
  {
    name: "DELETE /creatives/:id",
    rule: "campaigns:edit",
    ok: 204,
    prepare: async ({ t, ws }) => {
      const k = uniq();
      return (
        await prisma.creative.create({
          data: { orgId: t.org.id, workspaceId: ws, name: "x.png", type: "IMAGE", mimeType: "image/png", sizeBytes: 1, storageKey: `creatives/x/${k}.png`, url: `/api/files/creatives/x/${k}.png` },
        })
      ).id;
    },
    call: (cl, x, id) => cl.delete(w(x, `/creatives/${id}`)),
  },
  { name: "GET /drafts", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/drafts")) },
  { name: "GET /drafts/:id", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/drafts/${x.c.draft.id}`)) },
  { name: "POST /drafts", rule: "campaigns:edit", ok: 201, call: (cl, x) => cl.post(w(x, "/drafts")).send({ name: "D", payload: draftPayload(x.c.adAccount.id) }) },
  { name: "PATCH /drafts/:id", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.patch(w(x, `/drafts/${x.c.draft.id}`)).send({ name: "D2", payload: draftPayload(x.c.adAccount.id) }) },
  { name: "POST /drafts/:id/duplicate", rule: "campaigns:edit", ok: 201, call: (cl, x) => cl.post(w(x, `/drafts/${x.c.draft.id}/duplicate`)) },
  { name: "POST /drafts/:id/validate", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.post(w(x, `/drafts/${x.c.draft.id}/validate`)) },
  {
    name: "DELETE /drafts/:id",
    rule: "campaigns:edit",
    ok: 204,
    prepare: async ({ t, ws, c }) => (await prisma.campaignDraft.create({ data: { orgId: t.org.id, workspaceId: ws, name: "Del", payload: draftPayload(c.adAccount.id) } })).id,
    call: (cl, x, id) => cl.delete(w(x, `/drafts/${id}`)),
  },
  { name: "GET /builder/targeting", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.get(w(x, `/builder/targeting?adAccountId=${x.c.adAccount.id}&kind=location&q=ind`)) },
  { name: "GET /reports", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/reports")) },
  { name: "GET /reports/:id", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/reports/${x.c.report.id}`)) },
  { name: "GET /reports/:id/data", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/reports/${x.c.report.id}/data`)) },
  { name: "GET /reports/:id/export.csv", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/reports/${x.c.report.id}/export.csv`)) },
  { name: "POST /reports/preview", rule: "data:view", ok: 200, call: (cl, x) => cl.post(w(x, "/reports/preview")).send({ config: reportConfig }) },
  { name: "POST /reports", rule: notClient404, ok: 201, call: (cl, x) => cl.post(w(x, "/reports")).send({ name: "Weekly", config: reportConfig }) },
  { name: "PATCH /reports/:id", rule: notClient404, ok: 200, call: (cl, x) => cl.patch(w(x, `/reports/${x.c.report.id}`)).send({ name: "Weekly 2", config: reportConfig }) },
  { name: "PUT /reports/:id/schedule", rule: notClient404, ok: 200, call: (cl, x) => cl.put(w(x, `/reports/${x.c.report.id}/schedule`)).send({ frequency: null }) },
  { name: "POST /reports/:id/share", rule: notClient404, ok: 200, call: (cl, x) => cl.post(w(x, `/reports/${x.c.report.id}/share`)) },
  { name: "DELETE /reports/:id/share", rule: notClient404, ok: 200, call: (cl, x) => cl.delete(w(x, `/reports/${x.c.report.id}/share`)) },
  {
    name: "DELETE /reports/:id",
    rule: notClient404,
    ok: 204,
    prepare: async ({ t, ws }) => (await prisma.report.create({ data: { orgId: t.org.id, workspaceId: ws, name: "Del", config: reportConfig } })).id,
    call: (cl, x, id) => cl.delete(w(x, `/reports/${id}`)),
  },
  { name: "GET /rules", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/rules")) },
  { name: "GET /rules/:id", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/rules/${x.c.rule.id}`)) },
  { name: "GET /rules/:id/runs", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, `/rules/${x.c.rule.id}/runs`)) },
  { name: "POST /rules", rule: "campaigns:edit", ok: 201, call: (cl, x) => cl.post(w(x, "/rules")).send(ruleBody()) },
  { name: "PATCH /rules/:id", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.patch(w(x, `/rules/${x.c.rule.id}`)).send(ruleBody("Renamed rule")) },
  { name: "POST /rules/:id/toggle", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.post(w(x, `/rules/${x.c.rule.id}/toggle`)) },
  { name: "POST /rules/:id/run (dry run)", rule: "campaigns:edit", ok: 200, call: (cl, x) => cl.post(w(x, `/rules/${x.c.rule.id}/run`)).send({ dryRun: true }) },
  {
    name: "DELETE /rules/:id",
    rule: "campaigns:edit",
    ok: 204,
    prepare: async ({ t, ws }) =>
      (await prisma.rule.create({ data: { orgId: t.org.id, workspaceId: ws, name: "Del", scope: {}, conditions: [], actions: [] } })).id,
    call: (cl, x, id) => cl.delete(w(x, `/rules/${id}`)),
  },
  { name: "GET /ai/status", rule: "data:view", ok: 200, call: (cl, x) => cl.get(w(x, "/ai/status")) },
];

// Generous timeouts: these runs share one Postgres with other suites.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

beforeAll(async () => {
  await resetDb();
  await captureMail();
}, 180_000);

function matrix(group: string, specs: Spec[]) {
  describe(group, () => {
    for (const spec of specs) {
      describe(spec.name, () => {
        const ctx = {} as Ctx;
        const clients = {} as Record<Caller, Client>;
        beforeAll(async () => {
          ctx.t = await seedTeam();
          ctx.c = await seedWorkspaceContent(ctx.t.org.id, ctx.t.workspace.id, ctx.t.owner.id);
          ctx.ws = ctx.t.workspace.id;
          ctx.org = ctx.t.org.id;
          for (const caller of CALLERS) clients[caller] = await signedIn(caller === "NONMEMBER" ? ctx.t.outsider : ctx.t.users[caller]);
        });

        it.each(CALLERS)("%s", async (caller) => {
          const prepared = spec.prepare ? await spec.prepare(ctx) : "";
          const res = await spec.call(clients[caller], ctx, prepared);
          const want = outcome(spec, caller);
          if (want === "allow") expect(res.status, JSON.stringify(res.body)).toBe(spec.ok);
          else expect(res.status, JSON.stringify(res.body)).toBe(want);
        });
      });
    }
  });
}

matrix("org-scoped routes", ORG_ROUTES);
matrix("workspace-scoped routes (assigned workspace)", WORKSPACE_ROUTES);

describe("scoped roles and workspaces they aren't assigned to", () => {
  const ctx = {} as Ctx;
  const clients = {} as Record<Caller, Client>;
  beforeAll(async () => {
    ctx.t = await seedTeam();
    ctx.c = await seedWorkspaceContent(ctx.t.org.id, ctx.t.other.id); // all content lives in the unassigned workspace
    ctx.ws = ctx.t.other.id;
    ctx.org = ctx.t.org.id;
    for (const caller of CALLERS) clients[caller] = await signedIn(caller === "NONMEMBER" ? ctx.t.outsider : ctx.t.users[caller]);
  });

  const reads: [string, (x: Ctx) => string][] = [
    ["overview", (x) => w(x, `/overview?${range()}`)],
    ["campaigns", (x) => w(x, `/campaigns?${range()}`)],
    ["campaign detail", (x) => w(x, `/campaigns/${x.c.campaign.id}?${range()}`)],
    ["leads", (x) => w(x, `/leads?${range()}`)],
    ["leads export", (x) => w(x, `/leads/export?${range()}`)],
    ["reports", (x) => w(x, "/reports")],
    ["report", (x) => w(x, `/reports/${x.c.report.id}`)],
    ["drafts", (x) => w(x, "/drafts")],
    ["draft", (x) => w(x, `/drafts/${x.c.draft.id}`)],
    ["creatives", (x) => w(x, "/creatives")],
    ["rules", (x) => w(x, "/rules")],
    ["ad accounts", (x) => w(x, "/ad-accounts")],
    ["ad media", (x) => w(x, `/ads/${x.c.ad.id}/media`)],
  ];
  for (const [label, url] of reads) {
    it.each(CALLERS)(`GET ${label}: %s`, async (caller) => {
      const res = await clients[caller].get(url(ctx));
      const all = caller === "OWNER" || caller === "ADMIN";
      if (all) expect(res.status).not.toBe(404);
      else expect(res.status).toBe(404);
    });
  }

  it.each(["MANAGER", "ANALYST", "CLIENT"] as Role[])("%s can't write there either", async (role) => {
    const cl = clients[role];
    expect((await cl.patch(w(ctx, `/campaigns/${ctx.c.campaign.id}/status`)).send({ status: "PAUSED" })).status).toBe(404);
    expect((await cl.post(w(ctx, "/reports")).send({ name: "Weekly", config: reportConfig })).status).toBe(404);
    expect((await cl.delete(w(ctx, `/drafts/${ctx.c.draft.id}`))).status).toBe(404);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.c.campaign.id } })).status).toBe("ACTIVE");
    expect(await prisma.campaignDraft.count({ where: { id: ctx.c.draft.id } })).toBe(1);
  });

  it.each(["MANAGER", "ANALYST", "CLIENT"] as Role[])("%s only sees connections and ad accounts of assigned workspaces", async (role) => {
    const mine = await seedWorkspaceContent(ctx.t.org.id, ctx.t.workspace.id);
    const accounts = await clients[role].get(`/api/orgs/${ctx.org}/ad-accounts`);
    expect(accounts.status).toBe(200);
    const ids = accounts.body.map((a: { id: string }) => a.id);
    expect(ids).toContain(mine.adAccount.id);
    expect(ids).not.toContain(ctx.c.adAccount.id);
    const conns = (await clients[role].get(`/api/orgs/${ctx.org}/connections`)).body.map((c: { id: string }) => c.id);
    expect(conns).toContain(mine.connection.id);
    expect(conns).not.toContain(ctx.c.connection.id);
    // /me lists only the assigned workspace.
    const me = (await clients[role].get("/api/auth/me")).body;
    expect(me.orgs[0].workspaces.map((x: { id: string }) => x.id)).toEqual([ctx.t.workspace.id]);
  });

  it("owners and admins see every ad account", async () => {
    for (const role of ["OWNER", "ADMIN"] as Role[]) {
      const ids = (await clients[role].get(`/api/orgs/${ctx.org}/ad-accounts`)).body.map((a: { id: string }) => a.id);
      expect(ids).toContain(ctx.c.adAccount.id);
    }
  });
});
