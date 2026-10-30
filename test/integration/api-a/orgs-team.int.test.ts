/**
 * Organization settings, team management, invitations, workspaces, branding and API keys
 * (apps/api/src/modules/orgs.routes.ts and org-extras.routes.ts).
 */
import { sha256 } from "@ashniva/core";
import { vi, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "../../helpers/db";
import { addMember, createOrg, createWorkspace } from "../../helpers/factories";
import {
  anonymous,
  captureMail,
  fastReset,
  outbox,
  PNG_1PX,
  quickUser,
  seedApiKey,
  seedInvitation,
  seedTeam,
  seedWorkspaceContent,
  signedIn,
  tokenFromMail,
} from "./_support";

// Generous timeouts: these runs share one Postgres with other suites.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

beforeAll(async () => {
  await resetDb();
  await captureMail();
}, 180_000);
beforeEach(async () => {
  await fastReset();
  outbox.length = 0;
});

const auditCount = (orgId: string, action: string) => prisma.auditLog.count({ where: { orgId, action } });

describe("organization", () => {
  it("POST /orgs creates an unpaid org for a user without one, and refuses a second", async () => {
    const user = await quickUser();
    const c = await signedIn(user);
    const res = await c.post("/api/orgs").send({ companyName: "Solo Studio" });
    expect(res.status).toBe(201);
    expect(res.body.orgs).toHaveLength(1);
    expect(res.body.orgs[0]).toMatchObject({ name: "Solo Studio", role: "OWNER", plan: "TRIAL", locked: true });
    expect((await c.post("/api/orgs").send({ companyName: "Second" })).status).toBe(409);
  });

  it("PATCH renames the org, audits the change, validates the name", async () => {
    const { org, owner } = await seedTeam({ name: "Old Name" });
    const c = await signedIn(owner);
    const res = await c.patch(`/api/orgs/${org.id}`).send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: org.id, name: "New Name", role: "OWNER" });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "org.updated" } });
    expect(log.changes).toEqual({ name: { from: "Old Name", to: "New Name" } });
    expect((await c.patch(`/api/orgs/${org.id}`).send({ name: "x" })).status).toBe(422);
  });

  it("DELETE needs the exact name, is owner-only, and removes everything of the org", async () => {
    const t = await seedTeam({ name: "Doomed Org" });
    await seedWorkspaceContent(t.org.id, t.workspace.id);
    expect((await (await signedIn(t.users.ADMIN)).delete(`/api/orgs/${t.org.id}`).send({ confirmName: "Doomed Org" })).status).toBe(403);
    const c = await signedIn(t.owner);
    expect((await c.delete(`/api/orgs/${t.org.id}`).send({ confirmName: "Doomed" })).status).toBe(400);
    expect((await c.delete(`/api/orgs/${t.org.id}`).send({ confirmName: "Doomed Org" })).status).toBe(204);
    expect(await prisma.organization.count({ where: { id: t.org.id } })).toBe(0);
    expect(await prisma.membership.count({ where: { orgId: t.org.id } })).toBe(0);
    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.lead.count()).toBe(0);
    expect(await prisma.user.count({ where: { id: t.owner.id } })).toBe(1); // users survive
  });
});

describe("members", () => {
  it("lists members with their role and workspaces; CLIENT gets 403", async () => {
    const t = await seedTeam();
    const res = await (await signedIn(t.users.ANALYST)).get(`/api/orgs/${t.org.id}/members`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    const mgr = res.body.find((m: { role: string }) => m.role === "MANAGER");
    expect(mgr).toMatchObject({ id: t.members.MANAGER.id, userId: t.users.MANAGER.id, email: t.users.MANAGER.email, workspaceIds: [t.workspace.id] });
    expect(Object.keys(mgr).sort()).toEqual(["avatarUrl", "email", "id", "joinedAt", "name", "role", "userId", "workspaceIds"]);
    expect((await (await signedIn(t.users.CLIENT)).get(`/api/orgs/${t.org.id}/members`)).status).toBe(403);
  });

  describe("change role", () => {
    it("changes role and workspaces, and audits the role change", async () => {
      const t = await seedTeam();
      const res = await (await signedIn(t.owner))
        .patch(`/api/orgs/${t.org.id}/members/${t.members.MANAGER.id}`)
        .send({ role: "ANALYST", workspaceIds: [t.other.id] });
      expect(res.status).toBe(204);
      const m = await prisma.membership.findUniqueOrThrow({ where: { id: t.members.MANAGER.id }, include: { workspaces: true } });
      expect(m.role).toBe("ANALYST");
      expect(m.workspaces.map((w) => w.workspaceId)).toEqual([t.other.id]);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "member.updated", entityId: m.id } });
      expect(log.changes).toEqual({ role: { from: "MANAGER", to: "ANALYST" } });
    });

    it("the same role is a no-op: workspaces kept, no role change recorded", async () => {
      const t = await seedTeam();
      const res = await (await signedIn(t.owner)).patch(`/api/orgs/${t.org.id}/members/${t.members.MANAGER.id}`).send({ role: "MANAGER" });
      expect(res.status).toBe(204);
      const m = await prisma.membership.findUniqueOrThrow({ where: { id: t.members.MANAGER.id }, include: { workspaces: true } });
      expect(m.role).toBe("MANAGER");
      expect(m.workspaces.map((w) => w.workspaceId)).toEqual([t.workspace.id]);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "member.updated", entityId: m.id } });
      expect(log.changes).toBeNull();
    });

    it("a scoped role needs at least one live workspace of this org", async () => {
      const t = await seedTeam();
      const c = await signedIn(t.owner);
      const url = `/api/orgs/${t.org.id}/members/${t.members.ADMIN.id}`;
      // ADMIN has no assignments, so MANAGER without workspaceIds fails...
      expect((await c.patch(url).send({ role: "MANAGER" })).status).toBe(400);
      expect((await c.patch(url).send({ role: "MANAGER", workspaceIds: [] })).status).toBe(400);
      // ...and so do another org's or an archived workspace.
      const { workspace: foreign } = await createOrg(await quickUser());
      const archived = await createWorkspace(t.org.id, { archivedAt: new Date() });
      expect((await c.patch(url).send({ role: "MANAGER", workspaceIds: [foreign.id, archived.id] })).status).toBe(400);
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: t.members.ADMIN.id } })).role).toBe("ADMIN");
      // Mixed: only the valid one is stored.
      expect((await c.patch(url).send({ role: "MANAGER", workspaceIds: [foreign.id, t.other.id] })).status).toBe(204);
      const m = await prisma.membership.findUniqueOrThrow({ where: { id: t.members.ADMIN.id }, include: { workspaces: true } });
      expect(m.workspaces.map((w) => w.workspaceId)).toEqual([t.other.id]);
    });

    it("the owner's role can't be changed, nobody changes their own role, only the owner manages admins", async () => {
      const t = await seedTeam();
      const second = await quickUser();
      const secondAdmin = await addMember(t.org.id, second, "ADMIN");
      const asOwner = await signedIn(t.owner);
      const asAdmin = await signedIn(t.users.ADMIN);
      expect((await asAdmin.patch(`/api/orgs/${t.org.id}/members/${t.members.OWNER.id}`).send({ role: "ADMIN" })).status).toBe(403);
      expect((await asOwner.patch(`/api/orgs/${t.org.id}/members/${t.members.OWNER.id}`).send({ role: "ADMIN" })).status).toBe(403);
      expect((await asAdmin.patch(`/api/orgs/${t.org.id}/members/${t.members.ADMIN.id}`).send({ role: "MANAGER", workspaceIds: [t.workspace.id] })).status).toBe(403);
      expect((await asAdmin.patch(`/api/orgs/${t.org.id}/members/${secondAdmin.id}`).send({ role: "MANAGER", workspaceIds: [t.workspace.id] })).status).toBe(403);
      expect((await asAdmin.patch(`/api/orgs/${t.org.id}/members/${t.members.ANALYST.id}`).send({ role: "CLIENT" })).status).toBe(204);
      expect((await asOwner.patch(`/api/orgs/${t.org.id}/members/${secondAdmin.id}`).send({ role: "MANAGER", workspaceIds: [t.workspace.id] })).status).toBe(204);
    });

    it("OWNER can't be granted through PATCH, and unknown members are 404", async () => {
      const t = await seedTeam();
      const c = await signedIn(t.owner);
      expect((await c.patch(`/api/orgs/${t.org.id}/members/${t.members.ADMIN.id}`).send({ role: "OWNER" })).status).toBe(422);
      expect((await c.patch(`/api/orgs/${t.org.id}/members/nope`).send({ role: "ADMIN" })).status).toBe(404);
    });
  });

  describe("remove and leave", () => {
    it("owner removes a member (audited); admins can't remove admins; nobody removes the owner", async () => {
      const t = await seedTeam();
      const second = await addMember(t.org.id, await quickUser(), "ADMIN");
      const asAdmin = await signedIn(t.users.ADMIN);
      expect((await asAdmin.delete(`/api/orgs/${t.org.id}/members/${second.id}`)).status).toBe(403);
      expect((await asAdmin.delete(`/api/orgs/${t.org.id}/members/${t.members.OWNER.id}`)).status).toBe(403);
      expect((await (await signedIn(t.owner)).delete(`/api/orgs/${t.org.id}/members/${t.members.OWNER.id}`)).status).toBe(403);
      expect((await asAdmin.delete(`/api/orgs/${t.org.id}/members/${t.members.CLIENT.id}`)).status).toBe(204);
      expect((await (await signedIn(t.owner)).delete(`/api/orgs/${t.org.id}/members/${second.id}`)).status).toBe(204);
      expect(await auditCount(t.org.id, "member.removed")).toBe(2);
      // Removed members lose access immediately.
      expect((await (await signedIn(t.users.CLIENT)).get(`/api/workspaces/${t.workspace.id}/overview`)).status).toBe(404);
    });

    it("managers can't remove anyone else, but can remove themselves (recorded as left)", async () => {
      const t = await seedTeam();
      const c = await signedIn(t.users.MANAGER);
      expect((await c.delete(`/api/orgs/${t.org.id}/members/${t.members.ANALYST.id}`)).status).toBe(403);
      expect((await c.delete(`/api/orgs/${t.org.id}/members/${t.members.MANAGER.id}`)).status).toBe(204);
      expect(await auditCount(t.org.id, "member.left")).toBe(1);
    });

    it("POST /leave works for members but not the owner", async () => {
      const t = await seedTeam();
      expect((await (await signedIn(t.owner)).post(`/api/orgs/${t.org.id}/leave`)).status).toBe(403);
      const c = await signedIn(t.users.ANALYST);
      expect((await c.post(`/api/orgs/${t.org.id}/leave`)).status).toBe(204);
      expect(await prisma.membership.count({ where: { id: t.members.ANALYST.id } })).toBe(0);
      expect(await auditCount(t.org.id, "member.left")).toBe(1);
      expect((await c.get(`/api/orgs/${t.org.id}`)).status).toBe(404);
    });
  });

  describe("transfer ownership", () => {
    it("the owner hands over to a member and becomes an Admin", async () => {
      const t = await seedTeam();
      const res = await (await signedIn(t.owner)).post(`/api/orgs/${t.org.id}/transfer-ownership`).send({ memberId: t.members.MANAGER.id });
      expect(res.status).toBe(204);
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: t.members.MANAGER.id } })).role).toBe("OWNER");
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: t.members.OWNER.id } })).role).toBe("ADMIN");
      expect(await prisma.membership.count({ where: { orgId: t.org.id, role: "OWNER" } })).toBe(1);
      expect(await auditCount(t.org.id, "org.ownership_transferred")).toBe(1);
      // The new owner can now delete; the old one can't.
      expect((await (await signedIn(t.owner)).post(`/api/orgs/${t.org.id}/billing/cancel`)).status).toBe(403);
    });

    it("only the owner can transfer, not to a CLIENT, not to self, not to another org's member", async () => {
      const t = await seedTeam();
      const asOwner = await signedIn(t.owner);
      expect((await (await signedIn(t.users.ADMIN)).post(`/api/orgs/${t.org.id}/transfer-ownership`).send({ memberId: t.members.MANAGER.id })).status).toBe(403);
      expect((await asOwner.post(`/api/orgs/${t.org.id}/transfer-ownership`).send({ memberId: t.members.CLIENT.id })).status).toBe(400);
      expect((await asOwner.post(`/api/orgs/${t.org.id}/transfer-ownership`).send({ memberId: t.members.OWNER.id })).status).toBe(400);
      const other = await seedTeam();
      expect((await asOwner.post(`/api/orgs/${t.org.id}/transfer-ownership`).send({ memberId: other.members.ADMIN.id })).status).toBe(404);
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: other.members.ADMIN.id } })).role).toBe("ADMIN");
      expect((await prisma.membership.findUniqueOrThrow({ where: { id: t.members.OWNER.id } })).role).toBe("OWNER");
    });
  });
});

describe("invitations", () => {
  it("creates an invite, emails it, audits it, and lists it", async () => {
    const t = await seedTeam({ name: "Inv Org" });
    const c = await signedIn(t.owner);
    const res = await c.post(`/api/orgs/${t.org.id}/invitations`).send({ email: "New@Example.test", role: "MANAGER", workspaceIds: [t.workspace.id] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "new@example.test", role: "MANAGER", workspaceIds: [t.workspace.id], invitedBy: "Olivia Owner" });
    expect(res.body).not.toHaveProperty("tokenHash");
    const token = tokenFromMail("new@example.test", "/invite/");
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: res.body.id } })).tokenHash).toBe(sha256(token));
    expect(outbox[0]!.subject).toContain("Inv Org");
    expect(await auditCount(t.org.id, "member.invited")).toBe(1);

    await seedInvitation(t.org.id, { email: "old@example.test", expiresAt: new Date(Date.now() - 1000) });
    const list = await c.get(`/api/orgs/${t.org.id}/invitations`);
    expect(list.body.map((i: { email: string }) => i.email)).toEqual(["new@example.test"]);
  });

  it("validates: scoped roles need a workspace of this org, OWNER can't be invited, members can't be re-invited", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.owner);
    const url = `/api/orgs/${t.org.id}/invitations`;
    expect((await c.post(url).send({ email: "a@example.test", role: "MANAGER", workspaceIds: [] })).status).toBe(422);
    const { workspace: foreign } = await createOrg(await quickUser());
    expect((await c.post(url).send({ email: "a@example.test", role: "MANAGER", workspaceIds: [foreign.id] })).status).toBe(400);
    expect((await c.post(url).send({ email: "a@example.test", role: "OWNER", workspaceIds: [] })).status).toBe(422);
    expect((await c.post(url).send({ email: t.users.ANALYST.email, role: "ADMIN" })).status).toBe(409);
    expect((await c.post(url).send({ email: "a@example.test", role: "ADMIN" })).status).toBe(201);
    expect(await prisma.invitation.count()).toBe(1);
  });

  it("an unverified inviter can't send invites", async () => {
    const owner = await quickUser({ emailVerifiedAt: null });
    const { org } = await createOrg(owner);
    const res = await (await signedIn(owner)).post(`/api/orgs/${org.id}/invitations`).send({ email: "x@example.test", role: "ADMIN" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(outbox).toHaveLength(0);
  });

  it("the plan's member limit counts pending invites; re-inviting the same email at the limit works", async () => {
    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "STARTER" }); // 2 members
    const c = await signedIn(owner);
    const url = `/api/orgs/${org.id}/invitations`;
    expect((await c.post(url).send({ email: "one@example.test", role: "ADMIN" })).status).toBe(201);
    const over = await c.post(url).send({ email: "two@example.test", role: "ADMIN" });
    expect(over.status).toBe(402);
    expect(over.body.error.code).toBe("PLAN_LIMIT");
    const first = tokenFromMail("one@example.test", "/invite/");

    const again = await c.post(url).send({ email: "one@example.test", role: "ADMIN" });
    expect(again.status).toBe(201);
    expect(await prisma.invitation.count({ where: { orgId: org.id } })).toBe(1);
    const anon = await anonymous();
    expect((await anon.get(`/api/auth/invitations/${first}`)).status).toBe(404); // replaced
    expect((await anon.get(`/api/auth/invitations/${tokenFromMail("one@example.test", "/invite/")}`)).status).toBe(200);
  });

  it("a re-invite refused by the limit keeps the existing pending invite", async () => {
    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "STARTER" });
    await addMember(org.id, await quickUser(), "ADMIN"); // 2 of 2
    const { invite, token } = await seedInvitation(org.id, { email: "kept@example.test", role: "ADMIN" });
    const res = await (await signedIn(owner)).post(`/api/orgs/${org.id}/invitations`).send({ email: "kept@example.test", role: "ADMIN" });
    expect(res.status).toBe(402);
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).toBe(sha256(token));
  });

  it("revoking deletes the invite (audited) so its link stops working; resend rotates the token", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.users.ADMIN);
    const { invite, token } = await seedInvitation(t.org.id, { email: "r@example.test", role: "ADMIN" });
    expect((await c.post(`/api/orgs/${t.org.id}/invitations/${invite.id}/resend`)).status).toBe(204);
    const fresh = tokenFromMail("r@example.test", "/invite/");
    const anon = await anonymous();
    expect((await anon.get(`/api/auth/invitations/${token}`)).status).toBe(404);
    expect((await anon.get(`/api/auth/invitations/${fresh}`)).status).toBe(200);

    expect((await c.delete(`/api/orgs/${t.org.id}/invitations/${invite.id}`)).status).toBe(204);
    expect(await prisma.invitation.count({ where: { id: invite.id } })).toBe(0);
    expect((await anon.get(`/api/auth/invitations/${fresh}`)).status).toBe(404);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: t.org.id, action: "member.invite_revoked" } });
    expect(log).toMatchObject({ entityId: invite.id, entityName: "r@example.test", userId: t.users.ADMIN.id });
    expect((await c.delete(`/api/orgs/${t.org.id}/invitations/${invite.id}`)).status).toBe(404);
  });
});

describe("workspaces", () => {
  it("creates a workspace (audited) with a unique slug and validates input", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.users.ADMIN);
    const res = await c.post(`/api/orgs/${t.org.id}/workspaces`).send({ name: "Client One", currency: "USD", timezone: "America/New_York" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Client One", currency: "USD", timezone: "America/New_York", orgId: t.org.id, adAccountCount: 0 });
    const dup = await c.post(`/api/orgs/${t.org.id}/workspaces`).send({ name: "Client One" });
    expect(dup.status).toBe(201);
    expect(dup.body.slug).not.toBe(res.body.slug);
    expect(await auditCount(t.org.id, "workspace.created")).toBe(2);
    expect((await c.post(`/api/orgs/${t.org.id}/workspaces`).send({ name: "X" })).status).toBe(422);
    expect((await c.post(`/api/orgs/${t.org.id}/workspaces`).send({ name: "Bad tz", timezone: "Mars/Olympus" })).status).toBe(422);
    expect((await c.post(`/api/orgs/${t.org.id}/workspaces`).send({ name: "Bad cur", currency: "XYZ" })).status).toBe(422);
  });

  it("enforces the plan's workspace limit", async () => {
    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "STARTER" }); // 1 workspace
    const res = await (await signedIn(owner)).post(`/api/orgs/${org.id}/workspaces`).send({ name: "Second" });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PLAN_LIMIT");
  });

  it("PATCH updates the given fields", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.owner);
    const res = await c.patch(`/api/orgs/${t.org.id}/workspaces/${t.other.id}`).send({ name: "Renamed", currency: "EUR", timezone: "Europe/Berlin" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed", currency: "EUR", timezone: "Europe/Berlin" });
    expect((await c.patch(`/api/orgs/${t.org.id}/workspaces/nope`).send({ name: "Renamed" })).status).toBe(404);
  });

  it("PATCH with only a name keeps the workspace's currency and timezone", async () => {
    const t = await seedTeam();
    await prisma.workspace.update({ where: { id: t.other.id }, data: { currency: "USD", timezone: "America/New_York" } });
    const res = await (await signedIn(t.owner)).patch(`/api/orgs/${t.org.id}/workspaces/${t.other.id}`).send({ name: "Just a rename" });
    expect(res.status).toBe(200);
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: t.other.id } });
    expect(ws.name).toBe("Just a rename");
    expect(ws.currency).toBe("USD");
    expect(ws.timezone).toBe("America/New_York");
  });

  it("archiving pauses rules, stops scheduled reports, kills share links and frees ad accounts", async () => {
    const t = await seedTeam();
    const content = await seedWorkspaceContent(t.org.id, t.other.id);
    const anon = await anonymous();
    expect((await anon.get(`/api/public/reports/${content.report.shareToken}`)).status).toBe(200);

    const c = await signedIn(t.owner);
    expect((await c.delete(`/api/orgs/${t.org.id}/workspaces/${t.other.id}`)).status).toBe(204);
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: t.other.id } });
    expect(ws.archivedAt).not.toBeNull();
    expect((await prisma.rule.findUniqueOrThrow({ where: { id: content.rule.id } })).isActive).toBe(false);
    const report = await prisma.report.findUniqueOrThrow({ where: { id: content.report.id } });
    expect(report).toMatchObject({ scheduleFrequency: null, nextRunAt: null, shareToken: null });
    expect((await prisma.adAccount.findUniqueOrThrow({ where: { id: content.adAccount.id } })).workspaceId).toBeNull();
    expect(await auditCount(t.org.id, "workspace.archived")).toBe(1);

    expect((await anon.get(`/api/public/reports/${content.report.shareToken}`)).status).toBe(404);
    expect((await c.get(`/api/workspaces/${t.other.id}/overview?from=2026-01-01&to=2026-01-31`)).status).toBe(404);
    expect((await c.get("/api/auth/me")).body.orgs[0].workspaces.map((w: { id: string }) => w.id)).not.toContain(t.other.id);

    const archived = await c.get(`/api/orgs/${t.org.id}/workspaces/archived`);
    expect(archived.body.map((w: { id: string }) => w.id)).toEqual([t.other.id]);
    expect(archived.body[0].archivedAt).toBeTruthy();
    // Archiving twice is a 404.
    expect((await c.delete(`/api/orgs/${t.org.id}/workspaces/${t.other.id}`)).status).toBe(404);
  });

  it("the last live workspace can't be archived", async () => {
    const owner = await quickUser();
    const { org, workspace } = await createOrg(owner);
    await createWorkspace(org.id, { archivedAt: new Date() });
    const res = await (await signedIn(owner)).delete(`/api/orgs/${org.id}/workspaces/${workspace.id}`);
    expect(res.status).toBe(400);
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).archivedAt).toBeNull();
  });

  it("restores an archived workspace with rules still paused; restore respects the plan limit", async () => {
    const t = await seedTeam();
    const content = await seedWorkspaceContent(t.org.id, t.other.id);
    const c = await signedIn(t.owner);
    await c.delete(`/api/orgs/${t.org.id}/workspaces/${t.other.id}`);
    const res = await c.post(`/api/orgs/${t.org.id}/workspaces/${t.other.id}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(t.other.id);
    expect((await prisma.rule.findUniqueOrThrow({ where: { id: content.rule.id } })).isActive).toBe(false);
    expect((await c.post(`/api/orgs/${t.org.id}/workspaces/${t.other.id}/restore`)).status).toBe(404);

    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "STARTER" });
    const old = await createWorkspace(org.id, { archivedAt: new Date() });
    const limited = await (await signedIn(owner)).post(`/api/orgs/${org.id}/workspaces/${old.id}/restore`);
    expect(limited.status).toBe(402);
  });
});

describe("branding", () => {
  const body = { brandName: "Acme Ads", brandColor: "#112233", reportFooter: "Prepared by Acme" };

  it("is an Agency (white_label) feature", async () => {
    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "GROWTH" });
    const c = await signedIn(owner);
    const res = await c.patch(`/api/orgs/${org.id}/branding`).send(body);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("FEATURE_LOCKED");
    const logo = await c.post(`/api/orgs/${org.id}/branding/logo`).attach("file", PNG_1PX, { filename: "logo.png", contentType: "image/png" });
    expect(logo.status).toBe(402);
  });

  it("saves branding, shows it in /me, validates the colour; empty strings clear", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.users.ADMIN);
    const res = await c.patch(`/api/orgs/${t.org.id}/branding`).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...body, brandLogoUrl: null });
    expect((await c.get("/api/auth/me")).body.orgs[0].branding).toMatchObject(body);
    expect((await c.patch(`/api/orgs/${t.org.id}/branding`).send({ ...body, brandColor: "blue" })).status).toBe(422);
    const cleared = await c.patch(`/api/orgs/${t.org.id}/branding`).send({ brandName: "", brandColor: null, reportFooter: "" });
    expect(cleared.body).toMatchObject({ brandName: null, brandColor: null, reportFooter: null });
    expect((await (await signedIn(t.users.MANAGER)).patch(`/api/orgs/${t.org.id}/branding`).send(body)).status).toBe(403);
  });

  it("uploads a PNG logo, serves it, replaces and removes it", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.owner);
    const res = await c.post(`/api/orgs/${t.org.id}/branding/logo`).attach("file", PNG_1PX, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body.brandLogoUrl).toMatch(/^\/api\/files\/branding\//);
    const file = await (await anonymous()).get(res.body.brandLogoUrl);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("image/png");

    const second = await c.post(`/api/orgs/${t.org.id}/branding/logo`).attach("file", PNG_1PX, { filename: "logo2.png", contentType: "image/png" });
    expect(second.status).toBe(200);
    expect((await (await anonymous()).get(res.body.brandLogoUrl)).status).toBe(404); // old file removed
    expect(await auditCount(t.org.id, "branding.logo_updated")).toBe(2);

    expect((await c.delete(`/api/orgs/${t.org.id}/branding/logo`)).status).toBe(204);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: t.org.id } })).brandLogoUrl).toBeNull();
    expect((await (await anonymous()).get(second.body.brandLogoUrl)).status).toBe(404);
  });

  it("rejects non-PNG/JPEG types, disguised files, missing files and files over 2 MB", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.owner);
    const url = `/api/orgs/${t.org.id}/branding/logo`;
    expect((await c.post(url).attach("file", PNG_1PX, { filename: "logo.gif", contentType: "image/gif" })).status).toBe(400);
    expect((await c.post(url).attach("file", Buffer.from("<svg></svg>"), { filename: "logo.png", contentType: "image/png" })).status).toBe(400);
    expect((await c.post(url).field("x", "y")).status).toBe(400);
    const big = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024 + 10)]);
    const tooBig = await c.post(url).attach("file", big, { filename: "big.png", contentType: "image/png" });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe("UPLOAD_ERROR");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: t.org.id } })).brandLogoUrl).toBeNull();
  });
});

describe("API keys and the public API", () => {
  it("creates a key shown once, lists it without the secret, authenticates /api/v1 with it, and revokes it", async () => {
    const t = await seedTeam();
    const c = await signedIn(t.users.ADMIN);
    const created = await c.post(`/api/orgs/${t.org.id}/api-keys`).send({ name: "Looker" });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^ak_live_/);
    expect(created.body.prefix).toBe(created.body.secret.slice(0, 15));
    expect(await auditCount(t.org.id, "api_key.created")).toBe(1);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: created.body.id } })).keyHash).toBe(sha256(created.body.secret));

    const list = await c.get(`/api/orgs/${t.org.id}/api-keys`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: created.body.id, name: "Looker", createdBy: t.users.ADMIN.name });
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);

    const anon = await anonymous();
    const v1 = await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ${created.body.secret}`);
    expect(v1.status).toBe(200);
    expect(v1.body.data.map((w: { id: string }) => w.id).sort()).toEqual([t.workspace.id, t.other.id].sort());
    expect(v1.headers["ratelimit-policy"]).toMatch(/120/);
    expect(v1.headers.ratelimit).toMatch(/r=\d+/);
    const content = await seedWorkspaceContent(t.org.id, t.workspace.id);
    const camps = await anon.get(`/api/v1/workspaces/${t.workspace.id}/campaigns?from=2026-01-01&to=2026-01-31`).set("Authorization", `Bearer ${created.body.secret}`);
    expect(camps.status).toBe(200);
    expect(camps.body.data.map((r: { id: string }) => r.id)).toEqual([content.campaign.id]);

    expect((await c.delete(`/api/orgs/${t.org.id}/api-keys/${created.body.id}`)).status).toBe(204);
    expect(await auditCount(t.org.id, "api_key.revoked")).toBe(1);
    expect((await c.get(`/api/orgs/${t.org.id}/api-keys`)).body).toHaveLength(0);
    const after = await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ${created.body.secret}`);
    expect(after.status).toBe(401);
    expect((await c.delete(`/api/orgs/${t.org.id}/api-keys/${created.body.id}`)).status).toBe(404);
  });

  it("refuses missing/garbage keys and keys of orgs without the public_api feature", async () => {
    const anon = await anonymous();
    expect((await anon.get("/api/v1/workspaces")).status).toBe(401);
    expect((await anon.get("/api/v1/workspaces").set("Authorization", "Bearer sk_123")).status).toBe(401);
    expect((await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ak_live_${"x".repeat(40)}`)).status).toBe(401);

    const owner = await quickUser();
    const { org } = await createOrg(owner, { plan: "GROWTH" });
    const create = await (await signedIn(owner)).post(`/api/orgs/${org.id}/api-keys`).send({ name: "Nope" });
    expect(create.status).toBe(402);
    const { secret } = await seedApiKey(org.id); // e.g. created before a downgrade
    const res = await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ${secret}`);
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("FEATURE_LOCKED");
  });

  it("counts requests per key in the rate-limit header", async () => {
    const t = await seedTeam();
    const { secret } = await seedApiKey(t.org.id);
    const anon = await anonymous();
    const r1 = await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ${secret}`);
    const r2 = await anon.get("/api/v1/workspaces").set("Authorization", `Bearer ${secret}`);
    const remaining = (h: string) => Number(/r=(\d+)/.exec(h)![1]);
    expect(remaining(r2.headers.ratelimit)).toBe(remaining(r1.headers.ratelimit) - 1);
  });

  it("names are validated and managers can't manage keys", async () => {
    const t = await seedTeam();
    expect((await (await signedIn(t.owner)).post(`/api/orgs/${t.org.id}/api-keys`).send({ name: "x" })).status).toBe(422);
    expect((await (await signedIn(t.users.MANAGER)).get(`/api/orgs/${t.org.id}/api-keys`)).status).toBe(403);
  });
});
