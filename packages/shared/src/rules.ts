import { z } from "zod";
import { PLATFORMS } from "./platforms";

export const RULE_METRICS = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "conversions", "cpa", "roas"] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const OPERATOR_LABELS: Record<RuleOperator, string> = {
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};

export const RULE_ACTIONS = ["PAUSE", "ACTIVATE", "INCREASE_BUDGET", "DECREASE_BUDGET", "NOTIFY"] as const;
export type RuleActionType = (typeof RULE_ACTIONS)[number];

export const ACTION_LABELS: Record<RuleActionType, string> = {
  PAUSE: "Pause the campaign",
  ACTIVATE: "Activate the campaign",
  INCREASE_BUDGET: "Increase daily budget",
  DECREASE_BUDGET: "Decrease daily budget",
  NOTIFY: "Notify the team",
};

export const ruleConditionSchema = z.object({
  metric: z.enum(RULE_METRICS),
  operator: z.enum(RULE_OPERATORS),
  value: z.number({ error: "Enter a number" }).min(0),
});
export type RuleCondition = z.infer<typeof ruleConditionSchema>;

export const ruleActionSchema = z.object({
  type: z.enum(RULE_ACTIONS),
  /** Percent change for budget actions */
  percent: z.number().min(1).max(100).optional(),
  /** Never raise a budget above this amount */
  maxBudget: z.number().positive().optional(),
  /** Also email the notification */
  email: z.boolean().optional(),
});
export type RuleAction = z.infer<typeof ruleActionSchema>;

export const ruleScopeSchema = z.object({
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  campaignIds: z.array(z.string()).default([]),
  /** Only campaigns with at least this much spend in the lookback window are evaluated. */
  minSpend: z.number().min(0).default(0),
});
export type RuleScope = z.infer<typeof ruleScopeSchema>;

export const ruleSchema = z
  .object({
    name: z.string().trim().min(2, "Name the rule").max(120),
    isActive: z.boolean().default(true),
    scope: ruleScopeSchema,
    conditionLogic: z.enum(["ALL", "ANY"]).default("ALL"),
    conditions: z.array(ruleConditionSchema).min(1, "Add at least one condition").max(5),
    actions: z.array(ruleActionSchema).min(1, "Add at least one action").max(3),
    lookbackDays: z.number().int().min(1).max(30).default(3),
    frequency: z.enum(["HOURLY", "DAILY"]).default("DAILY"),
    cooldownHours: z.number().int().min(1).max(168).default(24),
    /** Ask a person before applying pause, activate and budget actions. */
    requireApproval: z.boolean().default(false),
  })
  .refine(
    (r) => r.actions.every((a) => !["INCREASE_BUDGET", "DECREASE_BUDGET"].includes(a.type) || a.percent),
    { path: ["actions"], message: "Budget actions need a percentage" },
  )
  .refine((r) => !(r.actions.some((a) => a.type === "PAUSE") && r.actions.some((a) => a.type === "ACTIVATE")), {
    path: ["actions"],
    message: "A rule can't both pause and activate",
  });
export type RuleInput = z.infer<typeof ruleSchema>;

export function compare(value: number | null, op: RuleOperator, target: number): boolean {
  if (value == null) return false;
  switch (op) {
    case "gt":
      return value > target;
    case "gte":
      return value >= target;
    case "lt":
      return value < target;
    case "lte":
      return value <= target;
  }
}

/** A ready-made rule: everything but the name, on/off state and approval mode, which the person chooses. */
export type RuleTemplateBody = Omit<RuleInput, "name" | "isActive" | "requireApproval">;

/** Ready-made rules shown in the builder. */
export const RULE_TEMPLATES: { name: string; description: string; rule: RuleTemplateBody }[] = [
  {
    name: "Pause campaigns with poor ROAS",
    description: "Pause when return on ad spend stays below 1× over 3 days.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 1000 },
      conditionLogic: "ALL",
      conditions: [{ metric: "roas", operator: "lt", value: 1 }],
      actions: [{ type: "PAUSE" }, { type: "NOTIFY", email: true }],
      lookbackDays: 3,
      frequency: "DAILY",
      cooldownHours: 24,
    },
  },
  {
    name: "Scale winning campaigns",
    description: "Raise budget 15% when ROAS is above 4× and cost per conversion is healthy.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 2000 },
      conditionLogic: "ALL",
      conditions: [{ metric: "roas", operator: "gt", value: 4 }],
      actions: [{ type: "INCREASE_BUDGET", percent: 15 }, { type: "NOTIFY" }],
      lookbackDays: 7,
      frequency: "DAILY",
      cooldownHours: 72,
    },
  },
  {
    name: "Alert on rising CPC",
    description: "Notify the team when average CPC goes above a threshold.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 500 },
      conditionLogic: "ALL",
      conditions: [{ metric: "cpc", operator: "gt", value: 50 }],
      actions: [{ type: "NOTIFY", email: true }],
      lookbackDays: 1,
      frequency: "HOURLY",
      cooldownHours: 24,
    },
  },
  {
    name: "Pause campaigns with high cost per conversion",
    description: "Pause when cost per conversion stays above a limit over 3 days. Set the limit to your own target.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 1500 },
      conditionLogic: "ALL",
      conditions: [{ metric: "cpa", operator: "gt", value: 800 }],
      actions: [{ type: "PAUSE" }, { type: "NOTIFY", email: true }],
      lookbackDays: 3,
      frequency: "DAILY",
      cooldownHours: 24,
    },
  },
  {
    name: "Spending but not converting",
    description: "Pause campaigns that spent real money over 3 days without a single conversion.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 1000 },
      conditionLogic: "ALL",
      conditions: [{ metric: "conversions", operator: "lt", value: 1 }],
      actions: [{ type: "PAUSE" }, { type: "NOTIFY", email: true }],
      lookbackDays: 3,
      frequency: "DAILY",
      cooldownHours: 24,
    },
  },
  {
    name: "Warn on low click-through rate",
    description: "Notify the team when CTR drops below 0.5% on campaigns with real reach. Often a sign of tired creative.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 500 },
      conditionLogic: "ALL",
      conditions: [{ metric: "ctr", operator: "lt", value: 0.5 }, { metric: "impressions", operator: "gt", value: 5000 }],
      actions: [{ type: "NOTIFY" }],
      lookbackDays: 3,
      frequency: "DAILY",
      cooldownHours: 72,
    },
  },
  {
    name: "Trim budget on weak ROAS",
    description: "Lower the daily budget 20% when ROAS stays under 1.5× for a week. Gentler than pausing.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 2000 },
      conditionLogic: "ALL",
      conditions: [{ metric: "roas", operator: "lt", value: 1.5 }],
      actions: [{ type: "DECREASE_BUDGET", percent: 20 }, { type: "NOTIFY" }],
      lookbackDays: 7,
      frequency: "DAILY",
      cooldownHours: 96,
    },
  },
  {
    name: "Alert on expensive impressions",
    description: "Notify when CPM climbs above a limit, which usually means rising competition or a narrow audience.",
    rule: {
      scope: { platforms: [], campaignIds: [], minSpend: 500 },
      conditionLogic: "ALL",
      conditions: [{ metric: "cpm", operator: "gt", value: 400 }],
      actions: [{ type: "NOTIFY" }],
      lookbackDays: 2,
      frequency: "DAILY",
      cooldownHours: 48,
    },
  },
];

/** Roughly what 1 INR is worth, only to size the example thresholds in templates for another currency. */
const PER_INR: Record<string, number> = { INR: 1, USD: 0.012, EUR: 0.011, GBP: 0.0095, AED: 0.044, SGD: 0.016, AUD: 0.018, CAD: 0.016, NZD: 0.02, CHF: 0.011, JPY: 1.8, SAR: 0.045, ZAR: 0.22, BRL: 0.065, MXN: 0.21, IDR: 190, THB: 0.43, MYR: 0.055, PHP: 0.69, BDT: 1.4, LKR: 3.6, NPR: 1.6, PKR: 3.4 };

/** Two significant digits, so a scaled threshold reads like a number a person would pick (0.6, 9.5, 66000). */
function nice(value: number): number {
  if (value === 0) return 0;
  const digits = 2 - Math.ceil(Math.log10(Math.abs(value)));
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function templateNeedsScaling(currency: string) {
  return currency !== "INR" && currency in PER_INR;
}

/**
 * Template amounts (spend floors, CPC/CPM/CPA limits, budget caps) are examples written in INR.
 * Returns the rule with them sized for the workspace currency; unchanged for INR or a currency we have no rough rate for.
 */
export function scaleRuleForCurrency<T extends RuleTemplateBody>(rule: T, currency: string): T {
  const factor = PER_INR[currency];
  if (!factor || factor === 1) return rule;
  const money = new Set<RuleMetric>(["spend", "cpc", "cpm", "cpa"]);
  return {
    ...rule,
    scope: { ...rule.scope, minSpend: nice(rule.scope.minSpend * factor) },
    conditions: rule.conditions.map((c) => (money.has(c.metric) ? { ...c, value: nice(c.value * factor) } : c)),
    actions: rule.actions.map((a) => (a.maxBudget ? { ...a, maxBudget: nice(a.maxBudget * factor) } : a)),
  };
}
