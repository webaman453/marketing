/**
 * Email verification and the admin set-password flow, end to end through the API.
 * Mail is captured instead of sent.
 */
import { randomToken, sha256 } from "@ashniva/core";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app, as } from "../helpers/api";
import { prisma, resetDb } from "../helpers/db";
import { createOrg, createUser } from "../helpers/factories";

const OPERATOR = "operator@example.test"; // listed in SUPER_ADMIN_EMAILS by test/setup/env.ts

const outbox: { to: string[]; subject: string; html: string }[] = [];

beforeAll(async () => {
  const { mailTransport } = await import("../../apps/api/src/lib/mailer");
  mailTransport.deliver = async (mail) => {
    outbox.push(mail);
    return true;
  };
});

beforeEach(async () => {
  await resetDb();
  outbox.length = 0;
});

/** Token from the newest email to `to` whose link points at `path`. */
function tokenFrom(to: string, path: string) {
  const mail = outbox.findLast((m) => m.to.includes(to) && m.html.includes(path));
  expect(mail, `no ${path} email sent to ${to}`).toBeDefined();
  const token = new RegExp(`${path}\\?token=([\\w-]+)`).exec(mail!.html)?.[1];
  expect(token, `no token in ${path} email`).toBeDefined();
  return token!;
}

/** Signs up through /auth/register; the agent keeps the session cookies. */
async function register(email: string) {
  const agent = request.agent(await app());
  const res = await agent
    .post("/api/auth/register")
    .send({ name: "Flow User", email, password: "Secret123", companyName: "Flow Co" });
  expect(res.status).toBe(201);
  return { agent, me: res.body };
}

describe("email verification", () => {
  it("sends a link at sign-up; SUPER_ADMIN_EMAILS and operator access only apply once verified", async () => {
    const { agent, me } = await register(OPERATOR);
    expect(me.user.emailVerified).toBe(false);
    expect(me.user.isSuperAdmin).toBe(false);
    expect(me.orgs[0].locked).toBe(true);
    expect((await agent.get("/api/admin/stats")).status).toBe(403);

    const token = tokenFrom(OPERATOR, "/verify-email");
    expect((await agent.post("/api/auth/verify-email").send({ token: "not-a-real-token" })).status).toBe(400);
    expect((await agent.post("/api/auth/verify-email").send({ token })).status).toBe(204);
    expect((await agent.post("/api/auth/verify-email").send({ token })).status).toBe(400); // single-use

    const after = (await agent.get("/api/auth/me")).body;
    expect(after.user.emailVerified).toBe(true);
    expect(after.user.isSuperAdmin).toBe(true);
    expect(after.orgs[0]).toMatchObject({ plan: "AGENCY", locked: false });
    expect((await agent.get("/api/admin/stats")).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "org.operator_access_granted" } })).toBe(1);
  });

  it("does not make a listed email an admin while it is unverified", async () => {
    const user = await createUser({ email: OPERATOR, emailVerifiedAt: null });
    const me = (await (await as(user)).get("/api/auth/me")).body;
    expect(me.user.isSuperAdmin).toBe(false);
    expect((await (await as(user)).get("/api/admin/stats")).status).toBe(403);
  });

  it("blocks team invites until the email is verified", async () => {
    const user = await createUser({ emailVerifiedAt: null });
    const { org } = await createOrg(user);
    const res = await (await as(user)).post(`/api/orgs/${org.id}/invitations`).send({ email: "teammate@example.test", role: "ADMIN", workspaceIds: [] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("resends with a cooldown and is a no-op once verified", async () => {
    const { agent } = await register("resend@example.test");
    expect((await agent.post("/api/auth/resend-verification")).status).toBe(429);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "resend@example.test" } });
    await prisma.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { createdAt: new Date(0) } });
    expect((await agent.post("/api/auth/resend-verification")).status).toBe(204);
    expect(outbox.filter((m) => m.html.includes("/verify-email"))).toHaveLength(2);

    await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    expect((await agent.post("/api/auth/resend-verification")).status).toBe(204);
    expect(outbox.filter((m) => m.html.includes("/verify-email"))).toHaveLength(2);
  });

  it("rejects expired links", async () => {
    const { agent } = await register("expired@example.test");
    const token = tokenFrom("expired@example.test", "/verify-email");
    await prisma.emailVerificationToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await agent.post("/api/auth/verify-email").send({ token })).status).toBe(400);
  });
});

describe("admin-created accounts", () => {
  const CUSTOMER = "customer@example.test";

  async function createAccount() {
    const admin = await createUser({ email: OPERATOR });
    const res = await (await as(admin))
      .post("/api/admin/accounts")
      .send({ name: "Flow Customer", email: CUSTOMER, companyName: "Customer Co", access: "paid" });
    expect(res.status).toBe(201);
    return prisma.user.findUniqueOrThrow({ where: { email: CUSTOMER } });
  }

  it("creates the user without a password and emails a 24-hour set-password link, with an audit entry", async () => {
    const user = await createAccount();
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).toBeNull();

    const link = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } });
    expect((link.expiresAt.getTime() - link.createdAt.getTime()) / 3_600_000).toBeCloseTo(24, 1);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.account_created" } });
    expect(entry.changes).toMatchObject({ owner: { to: CUSTOMER }, access: { to: "paid" } });

    const customer = request.agent(await app());
    expect((await customer.post("/api/auth/login").send({ email: CUSTOMER, password: "Anything123" })).status).toBe(401);

    const token = tokenFrom(CUSTOMER, "/set-password");
    expect((await customer.post("/api/auth/reset-password").send({ token, password: "Chosen123" })).status).toBe(204);
    expect((await customer.post("/api/auth/reset-password").send({ token, password: "Again1234" })).status).toBe(400); // single-use

    const login = await customer.post("/api/auth/login").send({ email: CUSTOMER, password: "Chosen123" });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true); // the emailed link proves the address
    expect(login.body.user.isSuperAdmin).toBe(false);
  });

  it("rejects an expired set-password link", async () => {
    const user = await createAccount();
    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await request(await app()).post("/api/auth/reset-password").send({ token, password: "Later1234" })).status).toBe(400);
  });
});
