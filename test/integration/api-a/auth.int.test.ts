/**
 * /api/auth end to end: sign-up, sign-in, session rotation, passwords,
 * email verification and invitation acceptance.
 */
import { sha256 } from "@ashniva/core";
import { vi, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "../../helpers/db";
import { createOrg, createWorkspace } from "../../helpers/factories";
import { agent, anonymous, captureMail, fastReset, outbox, PASSWORD, quickUser, seedInvitation, setCookies, signedIn, tokenFromMail } from "./_support";

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

const signup = (over: Record<string, unknown> = {}) => ({
  name: "Riya Sharma",
  email: "riya@example.test",
  password: "Secret123",
  companyName: "Riya Media",
  ...over,
});

describe("POST /api/auth/register", () => {
  it("creates the user and an unpaid (locked) org they own, signs them in, and emails a verify link", async () => {
    const a = await agent();
    const res = await a.post("/api/auth/register").send(signup());
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Riya Sharma", email: "riya@example.test", emailVerified: false, isSuperAdmin: false });
    expect(res.body.orgs).toHaveLength(1);
    expect(res.body.orgs[0]).toMatchObject({ name: "Riya Media", role: "OWNER", plan: "TRIAL", subscriptionStatus: "EXPIRED", trialEndsAt: null, locked: true });
    expect(res.body.orgs[0].workspaces).toHaveLength(1);
    expect(res.body.orgs[0].workspaces[0].name).toBe("Riya Media");

    const cookies = setCookies(res);
    expect(cookies.ash_at).toBeTruthy();
    expect(cookies.ash_rt).toBeTruthy();
    expect((await a.get("/api/auth/me")).status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "riya@example.test" } });
    expect(user.passwordHash).not.toContain("Secret123");
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
    expect(tokenFromMail("riya@example.test", "/verify-email?token=")).toBeTruthy();
  });

  it("lower-cases the email", async () => {
    const res = await (await agent()).post("/api/auth/register").send(signup({ email: "Riya@Example.TEST" }));
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("riya@example.test");
  });

  it("trims surrounding spaces from the email before validating it", async () => {
    const res = await (await agent()).post("/api/auth/register").send(signup({ email: "  riya@example.test " }));
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("riya@example.test");
  });

  it.each([
    ["missing name", { name: undefined }, "name"],
    ["short name", { name: "R" }, "name"],
    ["bad email", { email: "not-an-email" }, "email"],
    ["short password", { password: "abc12" }, "password"],
    ["password without a number", { password: "abcdefghij" }, "password"],
    ["password without a letter", { password: "1234567890" }, "password"],
    ["missing company", { companyName: "" }, "companyName"],
  ])("rejects %s with 422 and per-field details", async (_label, over, field) => {
    const res = await (await agent()).post("/api/auth/register").send(signup(over));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[field]).toBeDefined();
    expect(await prisma.user.count()).toBe(0);
  });

  it("returns 409 for an email that already has an account (any case), and creates nothing", async () => {
    await quickUser({ email: "riya@example.test" });
    const res = await (await agent()).post("/api/auth/register").send(signup({ email: "RIYA@example.test" }));
    expect(res.status).toBe(409);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.organization.count()).toBe(0);
  });
});

describe("POST /api/auth/login", () => {
  it("signs in with the right password and returns /me", async () => {
    const user = await quickUser({ email: "dev@example.test" });
    await createOrg(user, { name: "Dev Co" });
    const a = await agent();
    const res = await a.post("/api/auth/login").send({ email: "DEV@example.test", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.orgs.map((o: { name: string }) => o.name)).toEqual(["Dev Co"]);
    expect(setCookies(res).ash_rt).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastLoginAt).not.toBeNull();
  });

  it("gives the same 401 for a wrong password and an unknown email, without cookies", async () => {
    await quickUser({ email: "dev@example.test" });
    const wrong = await (await agent()).post("/api/auth/login").send({ email: "dev@example.test", password: "Wrong1234" });
    const unknown = await (await agent()).post("/api/auth/login").send({ email: "nobody@example.test", password: PASSWORD });
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
      expect(setCookies(res).ash_at).toBeUndefined();
    }
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(await prisma.session.count()).toBe(0);
  });

  it("lets an unverified user sign in, reporting emailVerified=false", async () => {
    const user = await quickUser({ email: "new@example.test", emailVerifiedAt: null });
    const res = await (await agent()).post("/api/auth/login").send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.emailVerified).toBe(false);
  });

  it("validates the body", async () => {
    const res = await (await agent()).post("/api/auth/login").send({ email: "x@example.test" });
    expect(res.status).toBe(422);
  });

  it("rate-limits repeated attempts from one address (20 per 15 minutes)", async () => {
    const a = await agent(); // one fixed IP
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await a.post("/api/auth/login").send({ email: "x@example.test", password: "Wrong1234" })).status;
    expect(last).toBe(429);
  });
});

describe("sessions: refresh, logout, /me", () => {
  async function login(email = "s@example.test") {
    await quickUser({ email }).catch(() => undefined);
    const a = await agent();
    const res = await a.post("/api/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return { a, rt: setCookies(res).ash_rt! };
  }

  it("rotates the refresh token: old session revoked, new cookies work", async () => {
    const { a, rt } = await login();
    const res = await a.post("/api/auth/refresh");
    expect(res.status).toBe(204);
    const next = setCookies(res);
    expect(next.ash_rt).toBeTruthy();
    expect(next.ash_rt).not.toBe(rt);
    expect((await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(rt) } })).revokedAt).not.toBeNull();
    expect((await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(next.ash_rt!) } })).revokedAt).toBeNull();
    expect((await a.get("/api/auth/me")).status).toBe(200);
  });

  it("treats reuse of a rotated refresh token as theft and revokes every session of the user", async () => {
    const { a, rt } = await login();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "s@example.test" } });
    const other = await login(); // a second device
    expect((await a.post("/api/auth/refresh")).status).toBe(204);

    const replay = await (await anonymous()).post("/api/auth/refresh").set("Cookie", `ash_rt=${rt}`);
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/security/i);
    expect(setCookies(replay).ash_rt).toBe(""); // cleared
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    // The legitimate rotated session and the other device are both dead.
    expect((await a.post("/api/auth/refresh")).status).toBe(401);
    expect((await other.a.post("/api/auth/refresh")).status).toBe(401);
  });

  it("refuses refresh without a cookie, with an unknown token, and with an expired session", async () => {
    const anon = await anonymous();
    expect((await anon.post("/api/auth/refresh")).status).toBe(401);
    expect((await anon.post("/api/auth/refresh").set("Cookie", "ash_rt=nope")).status).toBe(401);
    const { rt } = await login();
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await anon.post("/api/auth/refresh").set("Cookie", `ash_rt=${rt}`)).status).toBe(401);
  });

  it("logout revokes the session and clears both cookies", async () => {
    const { a, rt } = await login();
    const res = await a.post("/api/auth/logout");
    expect(res.status).toBe(204);
    const cleared = setCookies(res);
    expect(cleared.ash_at).toBe("");
    expect(cleared.ash_rt).toBe("");
    expect((await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(rt) } })).revokedAt).not.toBeNull();
    expect((await a.get("/api/auth/me")).status).toBe(401);
    expect((await a.post("/api/auth/refresh")).status).toBe(401);
  });

  it("logout without a session is a harmless 204", async () => {
    expect((await (await anonymous()).post("/api/auth/logout")).status).toBe(204);
  });

  it("rejects a forged or malformed access token", async () => {
    const anon = await anonymous();
    expect((await anon.get("/api/auth/me").set("Cookie", "ash_at=garbage")).status).toBe(401);
  });

  it("/me returns the user DTO and only the workspaces each membership can see", async () => {
    const owner = await quickUser({ name: "Owner" });
    const { org, workspace } = await createOrg(owner, { name: "Agency" });
    const hidden = await createWorkspace(org.id, { name: "Hidden" });
    const archived = await createWorkspace(org.id, { name: "Archived", archivedAt: new Date() });
    const analyst = await quickUser({ name: "Ana" });
    await prisma.membership.create({ data: { orgId: org.id, userId: analyst.id, role: "ANALYST", workspaces: { create: [{ workspaceId: workspace.id }] } } });

    const me = (await (await signedIn(analyst)).get("/api/auth/me")).body;
    expect(Object.keys(me.user).sort()).toEqual(["avatarUrl", "createdAt", "email", "emailVerified", "id", "isSuperAdmin", "name", "trialUsed"]);
    expect(me.user).not.toHaveProperty("passwordHash");
    expect(me.orgs).toHaveLength(1);
    expect(me.orgs[0]).toMatchObject({ id: org.id, role: "ANALYST", locked: false, plan: "AGENCY" });
    expect(me.orgs[0].branding).toEqual({ brandName: null, brandColor: null, brandLogoUrl: null, reportFooter: null });
    expect(me.orgs[0].workspaces.map((w: { id: string }) => w.id)).toEqual([workspace.id]);

    const ownerMe = (await (await signedIn(owner)).get("/api/auth/me")).body;
    const ids = ownerMe.orgs[0].workspaces.map((w: { id: string }) => w.id);
    expect(ids).toEqual([workspace.id, hidden.id]);
    expect(ids).not.toContain(archived.id);
  });

  it("PATCH /me renames the user and validates the name", async () => {
    const user = await quickUser();
    const c = await signedIn(user);
    const res = await c.patch("/api/auth/me").send({ name: "  New Name " });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    expect((await c.patch("/api/auth/me").send({ name: "x" })).status).toBe(422);
  });
});

describe("POST /api/auth/change-password", () => {
  it("changes the password and signs out every other session, keeping this one", async () => {
    const user = await quickUser({ email: "cp@example.test" });
    const here = await agent();
    expect((await here.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
    const elsewhere = await agent();
    expect((await elsewhere.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);

    const res = await here.post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: "Brandnew99" });
    expect(res.status).toBe(204);
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    expect((await here.post("/api/auth/refresh")).status).toBe(204);
    expect((await elsewhere.post("/api/auth/refresh")).status).toBe(401);

    expect((await (await agent()).post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
    expect((await (await agent()).post("/api/auth/login").send({ email: user.email, password: "Brandnew99" })).status).toBe(200);
  });

  it("a device signed out by change-password refreshing later doesn't sign out the device that changed it", async () => {
    const user = await quickUser({ email: "cp2@example.test" });
    const here = await agent();
    await here.post("/api/auth/login").send({ email: user.email, password: PASSWORD });
    const elsewhere = await agent();
    await elsewhere.post("/api/auth/login").send({ email: user.email, password: PASSWORD });
    expect((await here.post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: "Brandnew99" })).status).toBe(204);
    expect((await elsewhere.post("/api/auth/refresh")).status).toBe(401); // its access token expired; it tries to refresh
    expect((await here.post("/api/auth/refresh")).status).toBe(204);
  });

  it("rejects a wrong current password (422 on currentPassword) and a weak new one", async () => {
    const user = await quickUser();
    const c = await signedIn(user);
    const wrong = await c.post("/api/auth/change-password").send({ currentPassword: "Nope12345", newPassword: "Brandnew99" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details.currentPassword).toBeDefined();
    const weak = await c.post("/api/auth/change-password").send({ currentPassword: PASSWORD, newPassword: "short" });
    expect(weak.status).toBe(422);
    expect(weak.body.error.details.newPassword).toBeDefined();
  });

  it("requires a signed-in user", async () => {
    expect((await (await anonymous()).post("/api/auth/change-password").send({ currentPassword: "a", newPassword: "Brandnew99" })).status).toBe(401);
  });
});

describe("forgot / reset password", () => {
  it("answers 204 for an unknown email and sends nothing", async () => {
    const res = await (await anonymous()).post("/api/auth/forgot-password").send({ email: "ghost@example.test" });
    expect(res.status).toBe(204);
    expect(outbox).toHaveLength(0);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("emails a single-use, hashed reset link for a known email (any case)", async () => {
    const user = await quickUser({ email: "known@example.test" });
    const res = await (await anonymous()).post("/api/auth/forgot-password").send({ email: "KNOWN@example.test" });
    expect(res.status).toBe(204);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toEqual(["known@example.test"]);
    const token = tokenFromMail("known@example.test", "/reset-password?token=");
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBe(sha256(token)); // only the hash is stored
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it("resets the password once, revokes every session and verifies the email", async () => {
    const user = await quickUser({ email: "reset@example.test", emailVerifiedAt: null });
    const device = await agent();
    expect((await device.post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
    await (await anonymous()).post("/api/auth/forgot-password").send({ email: user.email });
    const token = tokenFromMail(user.email, "/reset-password?token=");

    const anon = await anonymous();
    expect((await anon.post("/api/auth/reset-password").send({ token, password: "Fresh1234" })).status).toBe(204);
    expect(await prisma.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect((await device.post("/api/auth/refresh")).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();

    const again = await anon.post("/api/auth/reset-password").send({ token, password: "Another123" });
    expect(again.status).toBe(400);
    expect((await (await agent()).post("/api/auth/login").send({ email: user.email, password: "Fresh1234" })).status).toBe(200);
    expect((await (await agent()).post("/api/auth/login").send({ email: user.email, password: "Another123" })).status).toBe(401);
  });

  it("rejects an expired token, an unknown token and a weak password", async () => {
    const user = await quickUser({ email: "exp@example.test" });
    await (await anonymous()).post("/api/auth/forgot-password").send({ email: user.email });
    const token = tokenFromMail(user.email, "/reset-password?token=");
    const anon = await anonymous();
    expect((await anon.post("/api/auth/reset-password").send({ token, password: "short" })).status).toBe(422);
    await prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await anon.post("/api/auth/reset-password").send({ token, password: "Fresh1234" })).status).toBe(400);
    expect((await anon.post("/api/auth/reset-password").send({ token: "x".repeat(40), password: "Fresh1234" })).status).toBe(400);
    expect((await (await agent()).post("/api/auth/login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
  });
});

describe("email verification", () => {
  it("verify-email works without being signed in and is single-use; expired links fail", async () => {
    const a = await agent();
    expect((await a.post("/api/auth/register").send(signup({ email: "v@example.test" }))).status).toBe(201);
    const token = tokenFromMail("v@example.test", "/verify-email?token=");
    const anon = await anonymous();
    expect((await anon.post("/api/auth/verify-email").send({ token })).status).toBe(204);
    expect((await anon.post("/api/auth/verify-email").send({ token })).status).toBe(400);
    expect((await a.get("/api/auth/me")).body.user.emailVerified).toBe(true);
    // A normal (non-operator) sign-up stays unpaid after verifying.
    expect((await a.get("/api/auth/me")).body.orgs[0]).toMatchObject({ plan: "TRIAL", locked: true });

    const user2 = await quickUser({ email: "v2@example.test", emailVerifiedAt: null });
    const c2 = await signedIn(user2);
    expect((await c2.post("/api/auth/resend-verification")).status).toBe(204);
    const t2 = tokenFromMail("v2@example.test", "/verify-email?token=");
    await prisma.emailVerificationToken.updateMany({ where: { userId: user2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await anon.post("/api/auth/verify-email").send({ token: t2 })).status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user2.id } })).emailVerifiedAt).toBeNull();
  });

  it("resend-verification: no-op when verified, cooldown of a minute otherwise", async () => {
    const verified = await quickUser();
    expect((await (await signedIn(verified)).post("/api/auth/resend-verification")).status).toBe(204);
    expect(outbox).toHaveLength(0);

    const user = await quickUser({ email: "cool@example.test", emailVerifiedAt: null });
    const c = await signedIn(user);
    expect((await c.post("/api/auth/resend-verification")).status).toBe(204);
    const again = await c.post("/api/auth/resend-verification");
    expect(again.status).toBe(429);
    expect(outbox).toHaveLength(1);
    await prisma.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 61_000) } });
    expect((await c.post("/api/auth/resend-verification")).status).toBe(204);
    expect(outbox).toHaveLength(2);
    expect((await (await anonymous()).post("/api/auth/resend-verification")).status).toBe(401);
  });

  it("rejects a malformed token body", async () => {
    expect((await (await anonymous()).post("/api/auth/verify-email").send({ token: "short" })).status).toBe(422);
  });
});

describe("invitations: lookup and accept", () => {
  async function setup() {
    const owner = await quickUser({ name: "Inviter Ivan" });
    const { org, workspace } = await createOrg(owner, { name: "Invite Org" });
    return { owner, org, workspace };
  }

  it("GET /invitations/:token describes the invite; unknown, accepted and expired tokens are 404", async () => {
    const { owner, org } = await setup();
    const { token } = await seedInvitation(org.id, { email: "new@example.test", role: "ADMIN", invitedById: owner.id });
    const anon = await anonymous();
    const res = await anon.get(`/api/auth/invitations/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: "new@example.test", orgName: "Invite Org", role: "ADMIN", invitedBy: "Inviter Ivan", hasAccount: false });
    expect((await anon.get(`/api/auth/invitations/${"z".repeat(43)}`)).status).toBe(404);
    const { token: expired } = await seedInvitation(org.id, { expiresAt: new Date(Date.now() - 1000) });
    expect((await anon.get(`/api/auth/invitations/${expired}`)).status).toBe(404);
  });

  it("creates a verified account for a new user, assigns only live workspaces of that org, and is single-use", async () => {
    const { org, workspace } = await setup();
    const archived = await createWorkspace(org.id, { archivedAt: new Date() });
    const otherOwner = await quickUser();
    const { workspace: foreignWs } = await createOrg(otherOwner);
    const { invite, token } = await seedInvitation(org.id, {
      email: "fresh@example.test",
      role: "MANAGER",
      workspaceIds: [workspace.id, archived.id, foreignWs.id],
    });

    const a = await agent();
    const res = await a.post("/api/auth/invitations/accept").send({ token, name: "Fresh Person", password: "Joinme123" });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: "fresh@example.test", emailVerified: true });
    expect(res.body.orgs).toHaveLength(1);
    expect(res.body.orgs[0]).toMatchObject({ id: org.id, role: "MANAGER" });
    expect(res.body.orgs[0].workspaces.map((w: { id: string }) => w.id)).toEqual([workspace.id]);
    expect((await a.get("/api/auth/me")).status).toBe(200); // signed in

    const m = await prisma.membership.findFirstOrThrow({ where: { orgId: org.id, user: { email: "fresh@example.test" } }, include: { workspaces: true } });
    expect(m.workspaces.map((w) => w.workspaceId)).toEqual([workspace.id]);
    expect(await prisma.membershipWorkspace.count({ where: { workspaceId: foreignWs.id } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invite.id } })).acceptedAt).not.toBeNull();

    const reuse = await (await agent()).post("/api/auth/invitations/accept").send({ token, name: "Again", password: "Joinme123" });
    expect(reuse.status).toBe(404);
  });

  it("a workspace archived after the invite was sent is not granted", async () => {
    const { org, workspace } = await setup();
    const later = await createWorkspace(org.id);
    const { token } = await seedInvitation(org.id, { email: "late@example.test", role: "ANALYST", workspaceIds: [workspace.id, later.id] });
    await prisma.workspace.update({ where: { id: later.id }, data: { archivedAt: new Date() } });
    const res = await (await agent()).post("/api/auth/invitations/accept").send({ token, name: "Late", password: "Joinme123" });
    expect(res.status).toBe(200);
    const m = await prisma.membership.findFirstOrThrow({ where: { orgId: org.id, role: "ANALYST" }, include: { workspaces: true } });
    expect(m.workspaces.map((w) => w.workspaceId)).toEqual([workspace.id]);
  });

  it("a new user must give a name and password", async () => {
    const { org } = await setup();
    const { token } = await seedInvitation(org.id, { email: "np@example.test" });
    const res = await (await agent()).post("/api/auth/invitations/accept").send({ token });
    expect(res.status).toBe(400);
    expect(await prisma.user.count({ where: { email: "np@example.test" } })).toBe(0);
  });

  it("an existing account must be signed in as the invited email", async () => {
    const { org, workspace } = await setup();
    const invited = await quickUser({ email: "exists@example.test" });
    const someoneElse = await quickUser();
    const { invite, token } = await seedInvitation(org.id, { email: invited.email, role: "CLIENT", workspaceIds: [workspace.id] });

    expect((await (await anonymous()).get(`/api/auth/invitations/${token}`)).body.hasAccount).toBe(true);
    expect((await (await anonymous()).post("/api/auth/invitations/accept").send({ token })).status).toBe(401);
    expect((await (await signedIn(someoneElse)).post("/api/auth/invitations/accept").send({ token })).status).toBe(401);
    // A name/password in the body doesn't let an anonymous caller take over the existing account.
    expect((await (await anonymous()).post("/api/auth/invitations/accept").send({ token, name: "Mallory", password: "Takeover1" })).status).toBe(401);
    expect(await prisma.membership.count({ where: { orgId: org.id } })).toBe(1);

    const res = await (await signedIn(invited)).post("/api/auth/invitations/accept").send({ token });
    expect(res.status).toBe(200);
    expect(res.body.orgs.find((o: { id: string }) => o.id === org.id)).toMatchObject({ role: "CLIENT" });
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: invite.id } })).acceptedAt).not.toBeNull();
    // The existing password is untouched.
    expect((await (await agent()).post("/api/auth/login").send({ email: invited.email, password: PASSWORD })).status).toBe(200);
  });

  it("an expired invitation can't be accepted", async () => {
    const { org } = await setup();
    const { token } = await seedInvitation(org.id, { email: "late2@example.test", expiresAt: new Date(Date.now() - 60_000) });
    const res = await (await agent()).post("/api/auth/invitations/accept").send({ token, name: "Late", password: "Joinme123" });
    expect(res.status).toBe(404);
    expect(await prisma.user.count({ where: { email: "late2@example.test" } })).toBe(0);
  });

  it("an invite emailed through the API can be accepted with the token from the email", async () => {
    const { owner, org, workspace } = await setup();
    const res = await (await signedIn(owner)).post(`/api/orgs/${org.id}/invitations`).send({ email: "mailed@example.test", role: "ANALYST", workspaceIds: [workspace.id] });
    expect(res.status).toBe(201);
    const token = tokenFromMail("mailed@example.test", "/invite/");
    const acc = await (await agent()).post("/api/auth/invitations/accept").send({ token, name: "Mailed", password: "Joinme123" });
    expect(acc.status).toBe(200);
    expect(acc.body.orgs[0]).toMatchObject({ id: org.id, role: "ANALYST" });
  });
});
