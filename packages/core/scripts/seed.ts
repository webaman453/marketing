/**
 * Seeds a demo organization with a login and sample ad data.
 *   pnpm db:seed
 * Login: demo@ashniva.com / Demo@12345
 */
import { loadEnv } from "../src/env";

loadEnv();

const { prisma } = await import("@ashniva/db");
const { hashPassword, createSampleConnections, syncConnection } = await import("../src/index");

const EMAIL = "demo@ashniva.com";
const PASSWORD = "Demo@12345";

const user = await prisma.user.upsert({
  where: { email: EMAIL },
  create: { name: "Demo User", email: EMAIL, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date() },
  update: {},
});

let membership = await prisma.membership.findFirst({ where: { userId: user.id }, include: { org: true } });
if (!membership) {
  const org = await prisma.organization.create({
    data: {
      name: "Ashniva Demo Agency",
      slug: "ashniva-demo",
      trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
      memberships: { create: { userId: user.id, role: "OWNER" } },
      workspaces: {
        create: [
          { name: "Ashniva Retail", slug: "ashniva-retail" },
          { name: "Urban Threads", slug: "urban-threads" },
        ],
      },
    },
  });
  membership = await prisma.membership.findFirstOrThrow({ where: { userId: user.id, orgId: org.id }, include: { org: true } });
}

const workspace = await prisma.workspace.findFirstOrThrow({
  where: { orgId: membership.orgId },
  orderBy: { createdAt: "asc" },
});

// The demo org showcases every feature, so it's on the Agency plan with sample branding.
await prisma.organization.update({
  where: { id: membership.orgId },
  data: {
    plan: "AGENCY",
    subscriptionStatus: "ACTIVE",
    currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    brandName: membership.org.brandName ?? "Ashniva Demo Agency",
    brandColor: membership.org.brandColor ?? "#3b5bdb",
    reportFooter: membership.org.reportFooter ?? "Prepared by Ashniva Demo Agency · hello@ashniva.com",
  },
});

const connectionIds = await createSampleConnections(membership.orgId, workspace.id, user.id);
for (const id of connectionIds) {
  const stats = await syncConnection(id, "sample");
  console.log(`synced ${id}:`, stats);
}

// Example report and automation rule, created once.
if ((await prisma.report.count({ where: { workspaceId: workspace.id } })) === 0) {
  await prisma.report.create({
    data: {
      orgId: membership.orgId,
      workspaceId: workspace.id,
      name: "Monthly performance summary",
      description: "Spend, revenue and return by campaign for the last 30 days.",
      config: {
        metrics: ["spend", "impressions", "clicks", "ctr", "conversions", "cpa", "roas"],
        dimension: "campaign",
        datePreset: "30d",
        platforms: [],
        compare: true,
        chartMetric: "spend",
      },
      createdById: user.id,
    },
  });
}
if ((await prisma.rule.count({ where: { workspaceId: workspace.id } })) === 0) {
  await prisma.rule.create({
    data: {
      orgId: membership.orgId,
      workspaceId: workspace.id,
      name: "Pause campaigns with poor ROAS",
      isActive: false,
      scope: { platforms: [], campaignIds: [], minSpend: 1000 },
      conditionLogic: "ALL",
      conditions: [{ metric: "roas", operator: "lt", value: 1 }],
      actions: [{ type: "PAUSE" }, { type: "NOTIFY", email: false }],
      lookbackDays: 3,
      frequency: "DAILY",
      cooldownHours: 24,
      createdById: user.id,
    },
  });
}

console.log(`\n✔ Seeded. Log in with ${EMAIL} / ${PASSWORD}`);
await prisma.$disconnect();
