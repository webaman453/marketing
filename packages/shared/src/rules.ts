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

/** Ready-made rules shown in the builder. */
export const RULE_TEMPLATES: { name: string; description: string; rule: Omit<RuleInput, "name" | "isActive"> }[] = [
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
];
