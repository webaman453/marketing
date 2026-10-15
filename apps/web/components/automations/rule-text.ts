import {
  ACTION_LABELS,
  METRIC_FORMATS,
  OPERATOR_LABELS,
  type RuleAction,
  type RuleCondition,
} from "@ashniva/shared";

/** Human-readable condition value: CTR in %, ROAS as ×, money in currency. */
export function conditionValue(c: RuleCondition, currency: string) {
  if (c.metric === "ctr") return `${c.value}%`;
  if (c.metric === "roas") return `${c.value}×`;
  if (["spend", "cpc", "cpm", "cpa"].includes(c.metric)) return METRIC_FORMATS[c.metric]!.format(c.value, currency);
  return METRIC_FORMATS[c.metric]!.format(c.value, currency);
}

export function describeConditions(conditions: RuleCondition[], logic: "ALL" | "ANY", currency: string) {
  return conditions
    .map((c) => `${METRIC_FORMATS[c.metric]!.label} ${OPERATOR_LABELS[c.operator]} ${conditionValue(c, currency)}`)
    .join(logic === "ANY" ? " or " : " and ");
}

export function describeAction(a: RuleAction, currency: string) {
  switch (a.type) {
    case "INCREASE_BUDGET":
      return `Increase budget by ${a.percent}%${a.maxBudget ? ` (max ${METRIC_FORMATS.spend!.format(a.maxBudget, currency)})` : ""}`;
    case "DECREASE_BUDGET":
      return `Decrease budget by ${a.percent}%`;
    case "NOTIFY":
      return a.email ? "Notify the team by email" : "Notify the team";
    default:
      return ACTION_LABELS[a.type];
  }
}
