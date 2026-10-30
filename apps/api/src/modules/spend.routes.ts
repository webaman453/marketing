import { audit, billingInfo, billingOf, dayInZone, fxContext, monthSpendByAccount, refreshAccountBilling, setPlatformSpendLimit } from "@ashniva/core";
import { num, prisma } from "@ashniva/db";
import {
  VISIBLE_PLATFORMS,
  spendBudgetSchema,
  spendLimitSchema,
  type Platform,
  type SpendAccountDTO,
  type SpendOverviewDTO,
  type SpendPlatformTotal,
} from "@ashniva/shared";
import { Router, type Request } from "express";
import { badRequest, notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";

/**
 * Spend & billing. Mounted under /api/workspaces/:workspaceId after loadWorkspace.
 * Payment stays on each platform; this shows spend against budgets and the platform's billing,
 * sets monthly budgets (campaigns:edit) and the platform's own spending limit (integrations:manage).
 */
export const spendRouter = Router({ mergeParams: true });

const accountInclude = { connection: true, spendBudget: true } as const;

async function loadAccount(req: Request) {
  const account = await prisma.adAccount.findFirst({
    where: { id: req.params.accountId as string, workspaceId: req.workspace!.id, platform: { in: [...VISIBLE_PLATFORMS] } },
    include: accountInclude,
  });
  if (!account) throw notFound("Ad account");
  return account;
}

const actorOf = (req: Request) => ({ orgId: req.org!.id, workspaceId: req.workspace!.id, userId: req.userId ?? null, ip: req.ip ?? null });

spendRouter.get("/spend", async (req, res) => {
  const workspace = req.workspace!;
  const now = new Date();
  const accounts = await prisma.adAccount.findMany({
    where: { workspaceId: workspace.id, platform: { in: [...VISIBLE_PLATFORMS] }, connection: { status: { not: "REVOKED" } } },
    include: accountInclude,
    orderBy: [{ platform: "asc" }, { name: "asc" }],
  });
  const [spend, active] = await Promise.all([
    monthSpendByAccount(accounts, now),
    prisma.campaign.groupBy({ by: ["adAccountId"], where: { adAccountId: { in: accounts.map((a) => a.id) }, status: "ACTIVE" }, _count: { _all: true } }),
  ]);
  const activeOf = new Map(active.map((r) => [r.adAccountId, r._count._all]));

  const today = dayInZone(now, workspace.timezone);
  const fx = await fxContext(workspace.currency, accounts, { from: `${today.slice(0, 7)}-01`, to: today });
  const toWorkspace = (id: string, amount: number) => amount * fx.accountFactor(id, today);

  const rows: SpendAccountDTO[] = accounts.map((a) => {
    const s = spend.get(a.id);
    const info = billingInfo(a.platform);
    return {
      id: a.id,
      platform: a.platform,
      name: a.name,
      externalId: a.externalId,
      currency: a.currency,
      timezone: a.timezone,
      sample: a.connection.mode === "DEMO",
      status: a.status,
      monthSpend: s?.spend ?? 0,
      projectedMonthSpend: s?.projected ?? 0,
      activeCampaigns: activeOf.get(a.id) ?? 0,
      budget: a.spendBudget
        ? {
            monthlyLimit: num(a.spendBudget.monthlyLimit),
            alertPercent: a.spendBudget.alertPercent,
            pauseAtLimit: a.spendBudget.pauseAtLimit,
            pausedAt: a.spendBudget.alertedMonth === s?.month ? (a.spendBudget.pausedAt?.toISOString() ?? null) : null,
          }
        : null,
      platformBilling: billingOf(a),
      billingUrl: info?.billingUrl(a.externalId) ?? null,
      accountLimit: info?.accountLimit ?? null,
      readsBilling: info?.readsBilling ?? false,
    };
  });

  const byPlatform = new Map<Platform, SpendPlatformTotal>();
  let total = 0;
  let projected = 0;
  let budgetTotal = 0;
  let budgeted = 0;
  for (const r of rows) {
    const spent = toWorkspace(r.id, r.monthSpend);
    const budget = r.budget ? toWorkspace(r.id, r.budget.monthlyLimit) : null;
    total += spent;
    projected += toWorkspace(r.id, r.projectedMonthSpend);
    if (budget != null) {
      budgetTotal += budget;
      budgeted++;
    }
    const p = byPlatform.get(r.platform) ?? { platform: r.platform, monthSpend: 0, monthlyBudget: null, accounts: 0, share: 0 };
    p.monthSpend += spent;
    p.accounts++;
    if (budget != null) p.monthlyBudget = (p.monthlyBudget ?? 0) + budget;
    byPlatform.set(r.platform, p);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const platforms = [...byPlatform.values()]
    .map((p) => ({ ...p, monthSpend: round(p.monthSpend), monthlyBudget: p.monthlyBudget == null ? null : round(p.monthlyBudget), share: total > 0 ? p.monthSpend / total : 0 }))
    .sort((a, b) => b.monthSpend - a.monthSpend);

  const body: SpendOverviewDTO = {
    month: today.slice(0, 7),
    currency: workspace.currency,
    converted: fx.info.conversion === "converted",
    totals: { monthSpend: round(total), monthlyBudget: budgeted ? round(budgetTotal) : null, projectedMonthSpend: round(projected) },
    platforms,
    accounts: rows,
  };
  res.json(body);
});

spendRouter.put("/ad-accounts/:accountId/spend-budget", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(spendBudgetSchema, req.body);
  const account = await loadAccount(req);
  const before = account.spendBudget;
  if (input.monthlyLimit == null) {
    if (before) await prisma.spendBudget.delete({ where: { id: before.id } });
  } else {
    const data = { monthlyLimit: input.monthlyLimit, alertPercent: input.alertPercent, pauseAtLimit: input.pauseAtLimit };
    // A raised budget (or a new alert level) can alert again this month; a pause stays until campaigns are resumed.
    const reset = before && (input.monthlyLimit > num(before.monthlyLimit) || input.alertPercent !== before.alertPercent) ? { alertedLevel: 0 } : {};
    await prisma.spendBudget.upsert({
      where: { adAccountId: account.id },
      create: { ...data, orgId: account.orgId, adAccountId: account.id, createdById: req.userId ?? null },
      update: { ...data, ...reset },
    });
  }
  await audit({
    orgId: account.orgId,
    workspaceId: req.workspace!.id,
    userId: req.userId,
    action: input.monthlyLimit == null ? "ad_account.budget_removed" : "ad_account.budget_set",
    entityType: "ad_account",
    entityId: account.id,
    entityName: account.name,
    changes: {
      monthlyLimit: { from: before ? num(before.monthlyLimit) : null, to: input.monthlyLimit },
      ...(input.monthlyLimit != null && before?.alertPercent !== input.alertPercent ? { alertPercent: { from: before?.alertPercent ?? null, to: input.alertPercent } } : {}),
      ...(input.monthlyLimit != null && before?.pauseAtLimit !== input.pauseAtLimit ? { pauseAtLimit: { from: before?.pauseAtLimit ?? null, to: input.pauseAtLimit } } : {}),
    },
    ip: req.ip,
  });
  res.json({ ok: true });
});

spendRouter.post("/ad-accounts/:accountId/billing/refresh", requirePermission("campaigns:edit"), async (req, res) => {
  const account = await loadAccount(req);
  if (!billingInfo(account.platform)?.readsBilling) throw badRequest("This platform doesn't share billing details with apps. Open its billing page instead.");
  const billing = await refreshAccountBilling(account);
  res.json({ platformBilling: billing });
});

spendRouter.put("/ad-accounts/:accountId/spend-limit", requirePermission("integrations:manage"), async (req, res) => {
  const { amount } = parse(spendLimitSchema, req.body);
  const account = await loadAccount(req);
  if (!billingInfo(account.platform)?.accountLimit) throw badRequest("This platform doesn't let apps set an account spending limit. Use the monthly budget instead.");
  const billing = await setPlatformSpendLimit(account, amount, actorOf(req));
  res.json({ platformBilling: billing });
});
