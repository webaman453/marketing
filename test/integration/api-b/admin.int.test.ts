/**
 * Super-admin console (admin.routes.ts, admin-settings.routes.ts) and the
 * public price list (/api/catalog).
 */
import { decryptSecret, getSyncQueue } from "@ashniva/core";
import { PLANS, PRICING, currentCatalog } from "@ashniva/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anon, as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { addMember } from "../../helpers/factories";
import { OPERATOR_EMAIL, configure, createUser, fetchCalls, orgWith, resetAll, stubFetch } from "./helpers";

const outbox: { to: string[]; subject: string; html: string }[] = [];

beforeAll(async () => {
  const { mailTransport } = await import("../../../apps/api/src/lib/mailer");
  mailTransport.deliver = async (mail) => {
    outbox.push(mail);
    return true;
  };
});
afterAll(async () => {
  // Leave the shipped price list for the next file.
  await prisma.platformSetting.deleteMany({ where: { key: "catalog" } });
  const { loadPlatformSettings } = await import("@ashniva/core");
  await loadPlatformSettings(true);
  await getSyncQueue().close();
});
beforeEach(async () => {
  await resetAll();
  outbox.length = 0;
});

const operator = () => createUser({ email: OPERATOR_EMAIL });

describe("access", () => {
  it("is forbidden to everyone but the platform operator", async () => {
    const { owner } = await orgWith(); // an org owner is not a super admin
    // On the SUPER_ADMIN_EMAILS list, but the address was never verified.
    const unverifiedOperator = await createUser({ email: OPERATOR_EMAIL, emailVerifiedAt: null });
    const routes: [string, string][] = [
      ["get", "/api/admin/stats"],
      ["get", "/api/admin/orgs"],
      ["patch", "/api/admin/orgs/x"],
      ["post", "/api/admin/accounts"],
      ["post", "/api/admin/orgs/x/ai-tokens"],
      ["get", "/api/admin/sync-failures"],
      ["get", "/api/admin/settings/credentials"],
      ["put", "/api/admin/settings/credentials"],
      ["post", "/api/admin/settings/credentials/META/test"],
      ["get", "/api/admin/settings/catalog"],
      ["put", "/api/admin/settings/catalog"],
      ["delete", "/api/admin/settings/catalog"],
    ];
    for (const user of [owner, unverifiedOperator]) {
      const api = await as(user);
      for (const [method, url] of routes) {
        const res = await (api as Record<string, (u: string) => import("supertest").Test>)[method]!(url).send({});
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    }
    expect((await (await anon()).get("/api/admin/stats")).status).toBe(401);
    // isSuperAdmin on the user row works without the email list.
    const flagged = await createUser({ isSuperAdmin: true });
    expect((await (await as(flagged)).get("/api/admin/stats")).status).toBe(200);
  });
});

describe("GET /stats", () => {
  it("counts only Razorpay-billed active organizations towards MRR", async () => {
    const admin = await operator();
    await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_g" }); // billed
    await orgWith("OWNER", { plan: "STARTER", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_s" }); // billed
    await orgWith("OWNER", { plan: "AGENCY", subscriptionStatus: "ACTIVE" }); // complimentary
    await orgWith("OWNER", { plan: "AGENCY", subscriptionStatus: "PAST_DUE", billingSubscriptionId: "sub_pd" });
    await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "CANCELLED", billingSubscriptionId: "sub_c" });
    await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const res = await (await as(admin)).get("/api/admin/stats");
    expect(res.status).toBe(200);
    expect(res.body.mrr).toBe(PLANS.GROWTH.priceMonthly + PLANS.STARTER.priceMonthly);
    expect(res.body.orgs).toBe(6);
    expect(res.body.byPlan).toEqual({ GROWTH: 2, STARTER: 1, AGENCY: 2, TRIAL: 1 });
  });

  it("an unpaid checkout from a complimentary organization doesn't count towards MRR", async () => {
    const admin = await operator();
    await configure({ RAZORPAY_KEY_ID: "rzp_test_ashniva", RAZORPAY_KEY_SECRET: "rzp-key-secret" });
    stubFetch([
      ["https://api.razorpay.com/v1/plans", { json: { id: "plan_growth_1" } }],
      ["https://api.razorpay.com/v1/subscriptions", { json: { id: "sub_never_paid", plan_id: "plan_growth_1", status: "created", current_end: null, customer_id: null } }],
    ]);
    const { org, owner } = await orgWith("OWNER", { plan: "AGENCY", subscriptionStatus: "ACTIVE" });
    expect((await (await as(owner)).post(`/api/orgs/${org.id}/billing/checkout`).send({ plan: "GROWTH" })).status).toBe(200);
    // The customer closes the Razorpay window without paying.
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ plan: "AGENCY", subscriptionStatus: "ACTIVE", billingSubscriptionId: null });
    const res = await (await as(admin)).get("/api/admin/stats");
    expect(res.body.mrr).toBe(0);
  });
});

describe("PATCH /orgs/:orgId", () => {
  it("refuses plan or status changes for Razorpay-billed organizations but allows trial extensions", async () => {
    const admin = await operator();
    const { org } = await orgWith("OWNER", { plan: "GROWTH", subscriptionStatus: "ACTIVE", billingSubscriptionId: "sub_1" });
    const api = await as(admin);
    for (const body of [{ plan: "AGENCY" }, { subscriptionStatus: "CANCELLED" }]) {
      const res = await api.patch(`/api/admin/orgs/${org.id}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/pays through Razorpay/);
    }
    const ext = await api.patch(`/api/admin/orgs/${org.id}`).send({ extendTrialDays: 7 });
    expect(ext.status).toBe(200);
    expect(await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).toMatchObject({ plan: "GROWTH", subscriptionStatus: "ACTIVE" });
    expect((await api.patch(`/api/admin/orgs/nope`).send({ plan: "AGENCY" })).status).toBe(404);
    expect((await api.patch(`/api/admin/orgs/${org.id}`).send({ extendTrialDays: 91 })).status).toBe(422);
  });

  it("moving to TRIAL sets an end date and TRIALING, with every change audited", async () => {
    const admin = await operator();
    const { org } = await orgWith("OWNER", { plan: "STARTER", subscriptionStatus: "EXPIRED" });
    const before = Date.now();
    const res = await (await as(admin)).patch(`/api/admin/orgs/${org.id}`).send({ plan: "TRIAL" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: "TRIAL", subscriptionStatus: "TRIALING" });
    const ends = new Date(res.body.trialEndsAt).getTime();
    expect(ends).toBeGreaterThanOrEqual(before + Math.max(1, PRICING.trialDays) * 86_400_000 - 5_000);
    expect(ends).toBeLessThanOrEqual(Date.now() + Math.max(1, PRICING.trialDays) * 86_400_000 + 5_000);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "admin.org_updated" } });
    expect(log.userId).toBe(admin.id);
    const changes = log.changes as Record<string, { from: unknown; to: unknown }>;
    expect(Object.keys(changes).sort()).toEqual(["plan", "subscriptionStatus", "trialEndsAt"]);
    expect(changes.plan).toEqual({ from: "STARTER", to: "TRIAL" });
    expect(changes.subscriptionStatus).toEqual({ from: "EXPIRED", to: "TRIALING" });
    expect(changes.trialEndsAt!.from).toBeNull();
  });

  it("a manually assigned paid plan becomes ACTIVE", async () => {
    const admin = await operator();
    const { org } = await orgWith("OWNER", { plan: "TRIAL", subscriptionStatus: "EXPIRED" });
    const res = await (await as(admin)).patch(`/api/admin/orgs/${org.id}`).send({ plan: "GROWTH" });
    expect(res.body).toMatchObject({ plan: "GROWTH", subscriptionStatus: "ACTIVE" });
  });
});

describe("POST /accounts", () => {
  it("creates a free (complimentary) account with a set-password email and an audit entry", async () => {
    const admin = await operator();
    const res = await (await as(admin)).post("/api/admin/accounts").send({ name: "Kavya", email: "Kavya@Example.TEST", companyName: "Kavya Foods", access: "free" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "kavya@example.test", access: "free" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "kavya@example.test" }, include: { memberships: { include: { org: true } } } });
    expect(user.passwordHash).toBeNull();
    const org = user.memberships[0]!.org;
    expect(user.memberships[0]!.role).toBe("OWNER");
    expect(org).toMatchObject({ name: "Kavya Foods", plan: "AGENCY", subscriptionStatus: "ACTIVE" });
    expect(org.aiTokenBalance).toBe(PRICING.aiFreeTokens);
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(1);
    expect(outbox.find((m) => m.to.includes("kavya@example.test"))?.html).toContain("/set-password?token=");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "admin.account_created" } });
    expect(log.userId).toBe(admin.id);
    expect((log.changes as Record<string, { to: unknown }>).access!.to).toBe("free");
  });

  it("an email pasted with surrounding spaces is trimmed instead of rejected", async () => {
    const admin = await operator();
    const res = await (await as(admin)).post("/api/admin/accounts").send({ name: "Kavya", email: "  kavya@example.test ", companyName: "Kavya Foods", access: "free" });
    expect(res.status).toBe(201);
  });

  it("creates a paid account that stays locked until it subscribes, and refuses duplicates", async () => {
    const admin = await operator();
    const api = await as(admin);
    const res = await api.post("/api/admin/accounts").send({ name: "Rohit", email: "rohit@example.test", companyName: "Rohit Tours", access: "paid" });
    expect(res.status).toBe(201);
    const org = await prisma.organization.findFirstOrThrow({ where: { name: "Rohit Tours" } });
    expect(org).toMatchObject({ plan: "TRIAL", subscriptionStatus: "EXPIRED", trialEndsAt: null, aiTokenBalance: 0 });
    expect((await api.post("/api/admin/accounts").send({ name: "Rohit", email: "ROHIT@example.test", companyName: "Again", access: "paid" })).status).toBe(409);
    expect((await api.post("/api/admin/accounts").send({ name: "R", email: "bad", companyName: "X", access: "gold" })).status).toBe(422);
  });
});

describe("POST /orgs/:orgId/ai-tokens", () => {
  it("grants and removes tokens with a ledger row and an audit entry", async () => {
    const admin = await operator();
    const { org } = await orgWith("OWNER", { aiTokenBalance: 1_000 });
    const api = await as(admin);
    const grant = await api.post(`/api/admin/orgs/${org.id}/ai-tokens`).send({ tokens: 50_000, note: "Goodwill" });
    expect(grant.body).toEqual({ aiTokenBalance: 51_000 });
    const take = await api.post(`/api/admin/orgs/${org.id}/ai-tokens`).send({ tokens: -1_000 });
    expect(take.body).toEqual({ aiTokenBalance: 50_000 });
    const ledger = await prisma.aiTokenLedger.findMany({ where: { orgId: org.id }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.type, l.tokens, l.balanceAfter, l.note])).toEqual([
      ["ADJUSTMENT", 50_000, 51_000, "Goodwill"],
      ["ADJUSTMENT", -1_000, 50_000, "Removed by Ashniva"],
    ]);
    const logs = await prisma.auditLog.findMany({ where: { orgId: org.id, action: "admin.ai_tokens_adjusted" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.changes)).toEqual([{ aiTokenBalance: { from: 1_000, to: 51_000 } }, { aiTokenBalance: { from: 51_000, to: 50_000 } }]);
    expect((await api.post(`/api/admin/orgs/${org.id}/ai-tokens`).send({ tokens: 0 })).status).toBe(422);
    expect((await api.post(`/api/admin/orgs/missing/ai-tokens`).send({ tokens: 5 })).status).toBe(404);
  });
});

describe("credentials", () => {
  it("saves secrets encrypted, shows them masked, ignores unknown keys and clears with null", async () => {
    const admin = await operator();
    const api = await as(admin);
    const put = await api.put("/api/admin/settings/credentials").send({
      values: { META_APP_ID: "1234567890", META_APP_SECRET: "super-secret-value-9876", DATABASE_URL: "postgres://evil", NOT_A_KEY: "x" },
    });
    expect(put.status).toBe(200);
    const meta = put.body.groups.find((g: { id: string }) => g.id === "META");
    const field = (key: string) => meta.fields.find((f: { key: string }) => f.key === key);
    expect(field("META_APP_ID")).toMatchObject({ set: true, source: "console", display: "1234567890" });
    expect(field("META_APP_SECRET")).toMatchObject({ set: true, source: "console", display: "••••9876" });
    expect(meta.configured).toBe(true);
    expect(JSON.stringify(put.body)).not.toContain("super-secret-value");

    const rows = await prisma.platformSetting.findMany({ orderBy: { key: "asc" } });
    expect(rows.map((r) => r.key)).toEqual(["env:META_APP_ID", "env:META_APP_SECRET"]);
    const secretRow = rows.find((r) => r.key === "env:META_APP_SECRET")!;
    expect(secretRow.secret).toBe(true);
    expect(JSON.stringify(secretRow.value)).not.toContain("super-secret-value");
    expect(decryptSecret((secretRow.value as { v: string }).v)).toBe("super-secret-value-9876");
    expect(secretRow.updatedById).toBe(admin.id);
    expect(process.env.DATABASE_URL).not.toBe("postgres://evil");

    const get = await api.get("/api/admin/settings/credentials");
    expect(get.status).toBe(200);
    expect(get.body.webhookUrl).toBe("http://localhost:3100/api/billing/webhook/razorpay");
    expect(get.body.redirectUrls.META).toBe("http://localhost:3100/api/oauth/meta/callback");
    expect(JSON.stringify(get.body)).not.toContain("super-secret-value");

    const cleared = await api.put("/api/admin/settings/credentials").send({ values: { META_APP_SECRET: null, META_APP_ID: "" } });
    const metaAfter = cleared.body.groups.find((g: { id: string }) => g.id === "META");
    expect(metaAfter.configured).toBe(false);
    expect(await prisma.platformSetting.count()).toBe(0);
    expect(process.env.META_APP_SECRET).toBeUndefined();
  });

  it("only tests groups that can be checked without a customer login", async () => {
    const admin = await operator();
    const api = await as(admin);
    const google = await api.post("/api/admin/settings/credentials/GOOGLE/test");
    expect(google.status).toBe(400);
    expect(google.body.error.message).toMatch(/Integrations page/);
    expect((await api.post("/api/admin/settings/credentials/NOPE/test")).status).toBe(404);
    // Testable but empty: a clear message, no outbound call.
    const meta = await api.post("/api/admin/settings/credentials/META/test");
    expect(meta.body).toEqual({ ok: false, message: "Add the App ID and App secret first." });
    const rzp = await api.post("/api/admin/settings/credentials/RAZORPAY/test");
    expect(rzp.body).toEqual({ ok: false, message: "Add the Key ID and Key secret first." });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("catalog", () => {
  it("saves, validates, publishes and resets the price list", async () => {
    const admin = await operator();
    const api = await as(admin);
    const got = await api.get("/api/admin/settings/catalog");
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ custom: false, updatedAt: null });
    const catalog = structuredClone(got.body.catalog);
    catalog.plans.STARTER.priceMonthly = 3499;
    catalog.trialDays = 21;

    const bad = await api.put("/api/admin/settings/catalog").send({ ...catalog, gstPercent: 80 });
    expect(bad.status).toBe(422);
    const dupPacks = await api.put("/api/admin/settings/catalog").send({ ...catalog, tokenPacks: [catalog.tokenPacks[0], catalog.tokenPacks[0]] });
    expect(dupPacks.status).toBe(400);

    const saved = await api.put("/api/admin/settings/catalog").send(catalog);
    expect(saved.status).toBe(200);
    expect(saved.body.custom).toBe(true);
    expect(saved.body.catalog.plans.STARTER.priceMonthly).toBe(3499);

    const pub = await (await anon()).get("/api/catalog");
    expect(pub.status).toBe(200);
    expect(pub.headers["cache-control"]).toBe("no-cache");
    expect(pub.body.plans.STARTER.priceMonthly).toBe(3499);
    expect(pub.body.trialDays).toBe(21);
    expect(pub.body.paidPlans).toEqual(["STARTER", "GROWTH", "AGENCY"]);
    expect((await api.get("/api/admin/settings/catalog")).body.custom).toBe(true);

    const reset = await api.delete("/api/admin/settings/catalog");
    expect(reset.body.custom).toBe(false);
    expect(reset.body.catalog.plans.STARTER.priceMonthly).toBe(got.body.defaults.plans.STARTER.priceMonthly);
    expect((await (await anon()).get("/api/catalog")).body.plans.STARTER.priceMonthly).toBe(got.body.defaults.plans.STARTER.priceMonthly);
    expect(currentCatalog().trialDays).toBe(got.body.defaults.trialDays);
  });
});

describe("GET /orgs", () => {
  it("lists organizations with owner, counts and lock state, searchable by owner email", async () => {
    const admin = await operator();
    const { org, owner } = await orgWith("OWNER", { plan: "STARTER", subscriptionStatus: "EXPIRED" });
    const member = await createUser();
    await addMember(org.id, member, "ANALYST");
    const res = await (await as(admin)).get(`/api/admin/orgs?q=${encodeURIComponent(owner.email)}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: org.id, locked: true, owner: { email: owner.email }, counts: { members: 2, workspaces: 1 } });
  });
});
