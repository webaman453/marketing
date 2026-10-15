import { assertFeature, audit, evaluateRule } from "@ashniva/core";
import { prisma, type Prisma, type Rule, type RuleRun } from "@ashniva/db";
import { ruleSchema, type RuleDTO, type RuleRunDTO, type RuleRunDetail } from "@ashniva/shared";
import { Router, type Request } from "express";
import { z } from "zod";
import { notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const rulesRouter = Router({ mergeParams: true });

export const toRunDTO = (r: RuleRun): RuleRunDTO => ({
  id: r.id,
  status: r.status,
  dryRun: r.dryRun,
  evaluated: r.evaluated,
  matched: r.matched,
  details: (r.details as RuleRunDetail[] | null) ?? null,
  error: r.error,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

const toRuleDTO = (r: Rule & { runs?: RuleRun[] }): RuleDTO => ({
  id: r.id,
  name: r.name,
  isActive: r.isActive,
  scope: r.scope as RuleDTO["scope"],
  conditionLogic: r.conditionLogic === "ANY" ? "ANY" : "ALL",
  conditions: r.conditions as RuleDTO["conditions"],
  actions: r.actions as RuleDTO["actions"],
  lookbackDays: r.lookbackDays,
  frequency: r.frequency,
  cooldownHours: r.cooldownHours,
  lastRunAt: r.lastRunAt?.toISOString() ?? null,
  nextRunAt: r.nextRunAt?.toISOString() ?? null,
  lastRun: r.runs?.[0] ? toRunDTO(r.runs[0]) : null,
  updatedAt: r.updatedAt.toISOString(),
});

const lastRunInclude = { runs: { where: { dryRun: false }, orderBy: { startedAt: "desc" }, take: 1 } } as const;

rulesRouter.get("/rules", async (req, res) => {
  const rules = await prisma.rule.findMany({
    where: { workspaceId: req.workspace!.id },
    orderBy: { createdAt: "desc" },
    include: lastRunInclude,
  });
  res.json(rules.map(toRuleDTO));
});

async function findRule(req: Request) {
  const r = await prisma.rule.findFirst({
    where: { id: req.params.ruleId as string, workspaceId: req.workspace!.id },
    include: lastRunInclude,
  });
  if (!r) throw notFound("Rule");
  return r;
}

/** Campaign ids in a scope must belong to this workspace. */
async function validScope(req: Request, campaignIds: string[]) {
  if (campaignIds.length === 0) return [];
  const found = await prisma.campaign.findMany({
    where: { id: { in: campaignIds }, adAccount: { workspaceId: req.workspace!.id } },
    select: { id: true },
  });
  return found.map((c) => c.id);
}

const data = (input: z.infer<typeof ruleSchema>) => ({
  name: input.name,
  isActive: input.isActive,
  scope: input.scope as unknown as Prisma.InputJsonValue,
  conditionLogic: input.conditionLogic,
  conditions: input.conditions as unknown as Prisma.InputJsonValue,
  actions: input.actions as unknown as Prisma.InputJsonValue,
  lookbackDays: input.lookbackDays,
  frequency: input.frequency,
  cooldownHours: input.cooldownHours,
});

rulesRouter.post("/rules", requirePermission("campaigns:edit"), async (req, res) => {
  assertFeature(req.org!, "automation_rules");
  const input = parse(ruleSchema, req.body);
  input.scope.campaignIds = await validScope(req, input.scope.campaignIds);
  const rule = await prisma.rule.create({
    data: {
      ...data(input),
      orgId: req.org!.id,
      workspaceId: req.workspace!.id,
      createdById: req.userId,
      // First run happens on the next scheduler tick.
      nextRunAt: new Date(),
    },
  });
  await audit({ orgId: rule.orgId, workspaceId: rule.workspaceId, userId: req.userId, action: "rule.created", entityType: "rule", entityId: rule.id, entityName: rule.name });
  res.status(201).json(toRuleDTO(rule));
});

rulesRouter.get("/rules/:ruleId", async (req, res) => {
  res.json(toRuleDTO(await findRule(req)));
});

rulesRouter.patch("/rules/:ruleId", requirePermission("campaigns:edit"), async (req, res) => {
  assertFeature(req.org!, "automation_rules");
  const input = parse(ruleSchema, req.body);
  const rule = await findRule(req);
  input.scope.campaignIds = await validScope(req, input.scope.campaignIds);
  const updated = await prisma.rule.update({
    where: { id: rule.id },
    data: {
      ...data(input),
      // Re-evaluate on the next tick when the schedule changes or the rule is switched on.
      ...(rule.frequency !== input.frequency || (!rule.isActive && input.isActive) ? { nextRunAt: new Date() } : {}),
    },
    include: lastRunInclude,
  });
  await audit({ orgId: rule.orgId, workspaceId: rule.workspaceId, userId: req.userId, action: "rule.updated", entityType: "rule", entityId: rule.id, entityName: updated.name });
  res.json(toRuleDTO(updated));
});

rulesRouter.post("/rules/:ruleId/toggle", requirePermission("campaigns:edit"), async (req, res) => {
  const rule = await findRule(req);
  if (!rule.isActive) assertFeature(req.org!, "automation_rules");
  const updated = await prisma.rule.update({
    where: { id: rule.id },
    data: { isActive: !rule.isActive, ...(!rule.isActive ? { nextRunAt: new Date() } : {}) },
    include: lastRunInclude,
  });
  await audit({ orgId: rule.orgId, workspaceId: rule.workspaceId, userId: req.userId, action: updated.isActive ? "rule.enabled" : "rule.disabled", entityType: "rule", entityId: rule.id, entityName: rule.name });
  res.json(toRuleDTO(updated));
});

rulesRouter.delete("/rules/:ruleId", requirePermission("campaigns:edit"), async (req, res) => {
  const rule = await findRule(req);
  await prisma.rule.delete({ where: { id: rule.id } });
  await audit({ orgId: rule.orgId, workspaceId: rule.workspaceId, userId: req.userId, action: "rule.deleted", entityType: "rule", entityId: rule.id, entityName: rule.name });
  res.status(204).end();
});

/** Runs now. `dryRun: true` previews matches without changing anything. */
rulesRouter.post("/rules/:ruleId/run", requirePermission("campaigns:edit"), async (req, res) => {
  const { dryRun } = parse(z.object({ dryRun: z.boolean().default(true) }), req.body ?? {});
  if (!dryRun) assertFeature(req.org!, "automation_rules");
  const rule = await findRule(req);
  const run = await evaluateRule(rule.id, { dryRun, userId: req.userId });
  res.json(toRunDTO(run));
});

rulesRouter.get("/rules/:ruleId/runs", async (req, res) => {
  const rule = await findRule(req);
  const runs = await prisma.ruleRun.findMany({ where: { ruleId: rule.id }, orderBy: { startedAt: "desc" }, take: 30 });
  res.json(runs.map(toRunDTO));
});
