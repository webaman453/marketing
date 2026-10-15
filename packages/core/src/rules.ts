/**
 * Automation rule engine. Evaluates each in-scope campaign's metrics over the
 * lookback window and, when the conditions match, applies the rule's actions.
 */
import { num, prisma, type Prisma, type Rule } from "@ashniva/db";
import {
  ACTION_LABELS,
  METRIC_FORMATS,
  OPERATOR_LABELS,
  addDays,
  compare,
  deriveMetrics,
  ruleActionSchema,
  ruleConditionSchema,
  ruleScopeSchema,
  type RuleRunDetail,
} from "@ashniva/shared";
import { z } from "zod";
import { campaignWithConnection, changeCampaignBudget, changeCampaignStatus } from "./campaign-actions";
import { isOrgLocked } from "./entitlements";
import { notify } from "./notifications";
import { todayIn } from "./reports";

const SUM = { impressions: true, clicks: true, spend: true, conversions: true, conversionValue: true, videoViews: true } as const;

export function nextRuleRun(frequency: "HOURLY" | "DAILY", from = new Date()) {
  const next = new Date(from);
  if (frequency === "HOURLY") next.setHours(next.getHours() + 1, 0, 0, 0);
  else next.setDate(next.getDate() + 1);
  return next;
}

export function describeConditions(rule: Pick<Rule, "conditions" | "conditionLogic">, currency: string) {
  const conditions = z.array(ruleConditionSchema).parse(rule.conditions);
  return conditions
    .map((c) => {
      const f = METRIC_FORMATS[c.metric]!;
      const value = ["ctr"].includes(c.metric) ? `${c.value}%` : c.metric === "roas" ? `${c.value}×` : f.format(c.value, currency);
      return `${f.label} ${OPERATOR_LABELS[c.operator]} ${value}`;
    })
    .join(rule.conditionLogic === "ANY" ? " or " : " and ");
}

export interface EvaluateOptions {
  dryRun?: boolean;
  /** User who triggered a manual run (for the audit log) */
  userId?: string | null;
}

export async function evaluateRule(ruleId: string, opts: EvaluateOptions = {}) {
  const rule = await prisma.rule.findUniqueOrThrow({ where: { id: ruleId }, include: { workspace: true, org: true } });
  const dryRun = Boolean(opts.dryRun);
  const run = await prisma.ruleRun.create({ data: { ruleId, status: "RUNNING", dryRun } });

  try {
    if (!dryRun && isOrgLocked(rule.org)) throw new Error("Organization is on an inactive plan; automation is paused.");

    const scope = ruleScopeSchema.parse(rule.scope);
    const conditions = z.array(ruleConditionSchema).parse(rule.conditions);
    const actions = z.array(ruleActionSchema).parse(rule.actions);

    const today = todayIn(rule.workspace.timezone);
    const from = addDays(today, -(rule.lookbackDays - 1));
    const accounts = await prisma.adAccount.findMany({
      where: { workspaceId: rule.workspaceId, ...(scope.platforms.length ? { platform: { in: scope.platforms } } : {}) },
      select: { id: true },
    });
    const campaigns = await prisma.campaign.findMany({
      where: {
        adAccountId: { in: accounts.map((a) => a.id) },
        status: { in: ["ACTIVE", "PAUSED"] },
        ...(scope.campaignIds.length ? { id: { in: scope.campaignIds } } : {}),
      },
      include: campaignWithConnection,
    });

    const metricRows = await prisma.metricDaily.groupBy({
      by: ["entityId"],
      where: {
        level: "CAMPAIGN",
        entityId: { in: campaigns.map((c) => c.id) },
        date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${today}T00:00:00Z`) },
      },
      _sum: SUM,
    });
    const metricsOf = new Map(
      metricRows.map((r) => [
        r.entityId,
        deriveMetrics({
          impressions: r._sum.impressions ?? 0,
          clicks: r._sum.clicks ?? 0,
          spend: num(r._sum.spend),
          conversions: num(r._sum.conversions),
          conversionValue: num(r._sum.conversionValue),
          videoViews: r._sum.videoViews ?? 0,
        }),
      ]),
    );

    const cooldowns = new Map(
      (await prisma.ruleTarget.findMany({ where: { ruleId } })).map((t) => [t.campaignId, t.lastActionAt]),
    );
    const cooldownCutoff = Date.now() - rule.cooldownHours * 3600_000;

    const details: RuleRunDetail[] = [];
    let evaluated = 0;
    for (const c of campaigns) {
      const m = metricsOf.get(c.id);
      if (!m || m.spend < scope.minSpend) continue;
      // PAUSE only makes sense on active campaigns and ACTIVATE on paused ones.
      if (actions.every((a) => a.type === "PAUSE") && c.status !== "ACTIVE") continue;
      if (actions.every((a) => a.type === "ACTIVATE") && c.status !== "PAUSED") continue;
      evaluated++;

      // Ratio metrics are stored as fractions; conditions are entered as percentages.
      const valueOf = (metric: string) => {
        const v = m[metric as keyof typeof m] as number | null;
        return metric === "ctr" && v != null ? v * 100 : v;
      };
      const results = conditions.map((cond) => compare(valueOf(cond.metric), cond.operator, cond.value));
      const matched = rule.conditionLogic === "ANY" ? results.some(Boolean) : results.every(Boolean);
      if (!matched) continue;

      const values = Object.fromEntries(conditions.map((cond) => [cond.metric, valueOf(cond.metric)]));
      const detail: RuleRunDetail = { campaignId: c.id, campaignName: c.name, platform: c.platform, values, actions: [] };
      const last = cooldowns.get(c.id);
      if (last && last.getTime() > cooldownCutoff) {
        detail.actions.push({ type: "SKIPPED", ok: true, detail: `In cooldown until ${new Date(last.getTime() + rule.cooldownHours * 3600_000).toISOString()}` });
        details.push(detail);
        continue;
      }

      const actor = { orgId: rule.orgId, workspaceId: rule.workspaceId, userId: opts.userId ?? null, via: `Rule: ${rule.name}` };
      for (const action of actions) {
        if (dryRun) {
          detail.actions.push({ type: action.type, ok: true, detail: "Would run (preview)" });
          continue;
        }
        try {
          if (action.type === "PAUSE") {
            await changeCampaignStatus(c, "PAUSED", actor);
            detail.actions.push({ type: action.type, ok: true });
          } else if (action.type === "ACTIVATE") {
            await changeCampaignStatus(c, "ACTIVE", actor);
            detail.actions.push({ type: action.type, ok: true });
          } else if (action.type === "INCREASE_BUDGET" || action.type === "DECREASE_BUDGET") {
            const current = c.dailyBudget == null ? null : num(c.dailyBudget);
            if (current == null) throw new Error("Campaign has no daily budget");
            const factor = 1 + ((action.type === "INCREASE_BUDGET" ? 1 : -1) * (action.percent ?? 10)) / 100;
            let next = Math.round(current * factor * 100) / 100;
            if (action.maxBudget && next > action.maxBudget) next = action.maxBudget;
            if (next === current) {
              detail.actions.push({ type: action.type, ok: true, detail: "Already at the budget cap" });
            } else {
              await changeCampaignBudget(c, next, actor);
              detail.actions.push({ type: action.type, ok: true, detail: `${current} → ${next}` });
            }
          } else if (action.type === "NOTIFY") {
            detail.actions.push({ type: action.type, ok: true });
          }
        } catch (err) {
          detail.actions.push({ type: action.type, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (!dryRun) {
        await prisma.ruleTarget.upsert({
          where: { ruleId_campaignId: { ruleId, campaignId: c.id } },
          create: { ruleId, campaignId: c.id, lastActionAt: new Date() },
          update: { lastActionAt: new Date() },
        });
      }
      details.push(detail);
    }

    const acted = details.filter((d) => d.actions.some((a) => a.type !== "SKIPPED"));
    const notifyAction = actions.find((a) => a.type === "NOTIFY");
    if (!dryRun && notifyAction && acted.length > 0) {
      const names = acted.slice(0, 5).map((d) => d.campaignName);
      const other = actions.filter((a) => a.type !== "NOTIFY").map((a) => ACTION_LABELS[a.type].toLowerCase());
      await notify({
        orgId: rule.orgId,
        workspaceId: rule.workspaceId,
        type: "rule.triggered",
        title: `Rule “${rule.name}” matched ${acted.length} ${acted.length === 1 ? "campaign" : "campaigns"}`,
        body: `${describeConditions(rule, rule.workspace.currency)}.${other.length ? ` Actions: ${other.join(", ")}.` : ""} ${names.join(", ")}${acted.length > 5 ? ` and ${acted.length - 5} more` : ""}.`,
        link: `/w/${rule.workspaceId}/automations/${rule.id}`,
        roles: ["OWNER", "ADMIN"],
        userIds: rule.createdById ? [rule.createdById] : [],
        email: Boolean(notifyAction.email),
        emailPref: "ruleAlerts",
      });
    }

    const finished = new Date();
    await prisma.ruleRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", evaluated, matched: details.length, details: details as unknown as Prisma.InputJsonValue, finishedAt: finished },
    });
    if (!dryRun) {
      await prisma.rule.update({ where: { id: ruleId }, data: { lastRunAt: finished, nextRunAt: nextRuleRun(rule.frequency, finished) } });
    }
    return prisma.ruleRun.findUniqueOrThrow({ where: { id: run.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.ruleRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message.slice(0, 1000), finishedAt: new Date() } });
    if (!dryRun) {
      await prisma.rule.update({ where: { id: ruleId }, data: { lastRunAt: new Date(), nextRunAt: nextRuleRun(rule.frequency) } });
    }
    throw err;
  }
}
