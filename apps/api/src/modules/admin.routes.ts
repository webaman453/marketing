/**
 * Super admin (platform operator) endpoints. Mounted at /api/admin behind
 * requireAuth + requireSuperAdmin.
 */
import { adjustAiTokens, audit, hashPassword, isOrgLocked } from "@ashniva/core";
import { prisma, type Prisma } from "@ashniva/db";
import { PLANS, type PlanId } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { conflict, notFound, parse } from "../lib/errors";
import { createOwnedOrg, newOrgSlug } from "../lib/org-setup";
import { adminSettingsRouter } from "./admin-settings.routes";

export const adminRouter = Router();

adminRouter.use("/settings", adminSettingsRouter);

adminRouter.get("/stats", async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [orgs, users, newOrgs, connections, failing, byPlan, activeSubs, runs24h, failed24h, aiUsed, aiSales] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.organization.count({ where: { createdAt: { gte: since } } }),
    prisma.platformConnection.count({ where: { mode: "LIVE", status: { not: "REVOKED" } } }),
    prisma.platformConnection.count({ where: { mode: "LIVE", OR: [{ status: { in: ["EXPIRED", "ERROR"] } }, { syncStatus: "FAILED" }] } }),
    prisma.organization.groupBy({ by: ["plan"], _count: { _all: true } }),
    prisma.organization.groupBy({ by: ["plan"], where: { subscriptionStatus: "ACTIVE" }, _count: { _all: true } }),
    prisma.syncRun.count({ where: { startedAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.syncRun.count({ where: { startedAt: { gte: new Date(Date.now() - 86_400_000) }, status: "FAILED" } }),
    prisma.aiTokenLedger.aggregate({ where: { type: "USAGE", createdAt: { gte: monthStart } }, _sum: { tokens: true } }),
    prisma.aiTokenOrder.aggregate({ where: { status: "PAID", paidAt: { gte: monthStart } }, _sum: { amount: true } }),
  ]);
  const mrr = activeSubs.reduce((sum, p) => sum + PLANS[p.plan as PlanId].priceMonthly * p._count._all, 0);
  res.json({
    orgs,
    users,
    newOrgs30d: newOrgs,
    liveConnections: connections,
    failingConnections: failing,
    syncRuns24h: runs24h,
    syncFailures24h: failed24h,
    mrr,
    aiTokensUsedThisMonth: -(aiUsed._sum.tokens ?? 0),
    aiSalesThisMonth: (aiSales._sum.amount ?? 0) / 100,
    byPlan: Object.fromEntries(byPlan.map((p) => [p.plan, p._count._all])),
  });
});

adminRouter.get("/orgs", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const where: Prisma.OrganizationWhereInput = q
    ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }, { memberships: { some: { user: { email: { contains: q, mode: "insensitive" } } } } }] }
    : {};
  const orgs = await prisma.organization.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      _count: { select: { memberships: true, workspaces: true, adAccounts: true, connections: true } },
      memberships: { where: { role: "OWNER" }, take: 1, include: { user: { select: { name: true, email: true } } } },
    },
  });
  res.json(
    orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      plan: o.plan,
      subscriptionStatus: o.subscriptionStatus,
      trialEndsAt: o.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: o.currentPeriodEnd?.toISOString() ?? null,
      locked: isOrgLocked(o),
      aiTokenBalance: o.aiTokenBalance,
      owner: o.memberships[0]?.user ?? null,
      counts: { members: o._count.memberships, workspaces: o._count.workspaces, adAccounts: o._count.adAccounts, connections: o._count.connections },
      createdAt: o.createdAt.toISOString(),
    })),
  );
});

const updateOrg = z.object({
  plan: z.enum(["TRIAL", "STARTER", "GROWTH", "AGENCY"]).optional(),
  subscriptionStatus: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"]).optional(),
  extendTrialDays: z.number().int().min(1).max(90).optional(),
});

const createAccount = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8).max(128).regex(/[A-Za-z]/, "Password must contain a letter").regex(/[0-9]/, "Password must contain a number"),
  companyName: z.string().trim().min(2).max(80),
  access: z.enum(["free", "paid"]),
});

/** Admin-created customer. Free is complimentary access; paid stays locked until they subscribe. */
adminRouter.post("/accounts", async (req, res) => {
  const input = parse(createAccount, req.body);
  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw conflict("An account with this email already exists.");
  }
  const slug = await newOrgSlug(input.companyName);
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { name: input.name, email: input.email, passwordHash, emailVerifiedAt: new Date() },
    });
    await createOwnedOrg(tx, created.id, input.companyName, slug, input.access === "free" ? "complimentary" : "unpaid");
    return created;
  });
  res.status(201).json({ id: user.id, email: user.email, access: input.access });
});

adminRouter.patch("/orgs/:orgId", async (req, res) => {
  const input = parse(updateOrg, req.body);
  const org = await prisma.organization.findUnique({ where: { id: req.params.orgId as string } });
  if (!org) throw notFound("Organization");
  const base = org.trialEndsAt && org.trialEndsAt > new Date() ? org.trialEndsAt : new Date();
  const updated = await prisma.organization.update({
    where: { id: org.id },
    data: {
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.subscriptionStatus ? { subscriptionStatus: input.subscriptionStatus } : {}),
      ...(input.extendTrialDays ? { trialEndsAt: new Date(base.getTime() + input.extendTrialDays * 86_400_000) } : {}),
      // A manually assigned paid plan without a provider is treated as an active invoice-billed plan.
      ...(input.plan && input.plan !== "TRIAL" && !input.subscriptionStatus ? { subscriptionStatus: "ACTIVE" as const } : {}),
    },
  });
  await audit({
    orgId: org.id,
    userId: req.userId,
    action: "admin.org_updated",
    entityType: "organization",
    entityId: org.id,
    entityName: org.name,
    changes: {
      ...(input.plan ? { plan: { from: org.plan, to: updated.plan } } : {}),
      ...(input.extendTrialDays ? { trialEndsAt: { from: org.trialEndsAt, to: updated.trialEndsAt } } : {}),
    },
  });
  res.json({ id: updated.id, plan: updated.plan, subscriptionStatus: updated.subscriptionStatus, trialEndsAt: updated.trialEndsAt });
});

adminRouter.get("/sync-failures", async (_req, res) => {
  const runs = await prisma.syncRun.findMany({
    where: { status: "FAILED" },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: { connection: { select: { platform: true, mode: true, externalUserName: true, org: { select: { id: true, name: true } } } } },
  });
  res.json(
    runs.map((r) => ({
      id: r.id,
      platform: r.connection.platform,
      mode: r.connection.mode,
      login: r.connection.externalUserName,
      org: r.connection.org,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
    })),
  );
});

adminRouter.post("/orgs/:orgId/ai-tokens", async (req, res) => {
  const input = parse(
    z.object({
      tokens: z.number().int().min(-100_000_000).max(100_000_000).refine((n) => n !== 0, "Enter a number of tokens"),
      note: z.string().trim().max(200).default(""),
    }),
    req.body,
  );
  const org = await prisma.organization.findUnique({ where: { id: req.params.orgId as string } });
  if (!org) throw notFound("Organization");
  const balance = await adjustAiTokens(org.id, input.tokens, input.note || (input.tokens > 0 ? "Granted by Ashniva" : "Removed by Ashniva"), req.userId ?? null);
  await audit({
    orgId: org.id,
    userId: req.userId,
    action: "admin.ai_tokens_adjusted",
    entityType: "organization",
    entityId: org.id,
    entityName: org.name,
    changes: { aiTokenBalance: { from: org.aiTokenBalance, to: balance } },
  });
  res.json({ aiTokenBalance: balance });
});
