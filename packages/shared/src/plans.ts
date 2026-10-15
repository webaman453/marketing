/**
 * Plan catalogue: limits, features and list prices (INR per month). These are
 * the defaults; the platform owner changes them in Admin → Plans & pricing,
 * which applies over these objects at runtime (see applyCatalog).
 */
export type PlanId = "TRIAL" | "STARTER" | "GROWTH" | "AGENCY";
export type PaidPlanId = Exclude<PlanId, "TRIAL">;

export type Feature =
  | "campaign_builder"
  | "scheduled_reports"
  | "automation_rules"
  | "ai_assistant"
  | "white_label"
  | "public_api";

export interface PlanDef {
  id: PlanId;
  name: string;
  audience: string;
  /** Monthly price in INR (whole rupees). */
  priceMonthly: number;
  limits: { workspaces: number; adAccounts: number; members: number };
  features: Feature[];
  highlights: string[];
  /** Highlighted as the recommended plan. */
  popular?: boolean;
}

const UNLIMITED = Number.POSITIVE_INFINITY;

export const PLANS: Record<PlanId, PlanDef> = {
  TRIAL: {
    id: "TRIAL",
    name: "Free trial",
    audience: "Explore every feature for 14 days",
    priceMonthly: 0,
    limits: { workspaces: 5, adAccounts: 15, members: 10 },
    features: ["campaign_builder", "scheduled_reports", "automation_rules", "ai_assistant", "white_label", "public_api"],
    highlights: [],
  },
  STARTER: {
    id: "STARTER",
    name: "Starter",
    audience: "Freelancers and small brands",
    priceMonthly: 2999,
    limits: { workspaces: 1, adAccounts: 3, members: 2 },
    features: ["campaign_builder", "ai_assistant"],
    highlights: ["1 workspace", "Up to 3 ad accounts", "2 team members", "Campaign builder", "On-demand reports", "AI assistant (token packs)"],
  },
  GROWTH: {
    id: "GROWTH",
    name: "Growth",
    audience: "Growing teams and small agencies",
    priceMonthly: 7999,
    limits: { workspaces: 5, adAccounts: 15, members: 10 },
    features: ["campaign_builder", "scheduled_reports", "automation_rules", "ai_assistant"],
    highlights: ["5 workspaces", "Up to 15 ad accounts", "10 team members", "Scheduled reports", "Automation rules", "AI assistant"],
    popular: true,
  },
  AGENCY: {
    id: "AGENCY",
    name: "Agency",
    audience: "Agencies managing many clients",
    priceMonthly: 19999,
    limits: { workspaces: UNLIMITED, adAccounts: UNLIMITED, members: UNLIMITED },
    features: ["campaign_builder", "scheduled_reports", "automation_rules", "ai_assistant", "white_label", "public_api"],
    highlights: ["Unlimited workspaces", "Unlimited ad accounts", "Unlimited members", "White-label reports", "Public API", "Priority support"],
  },
};

export const PAID_PLANS: PaidPlanId[] = ["STARTER", "GROWTH", "AGENCY"];

export const FEATURE_LABELS: Record<Feature, string> = {
  campaign_builder: "Campaign builder",
  scheduled_reports: "Scheduled reports",
  automation_rules: "Automation rules",
  ai_assistant: "AI assistant",
  white_label: "White-label branding",
  public_api: "Public API",
};

export const planHasFeature = (plan: PlanId, feature: Feature) => PLANS[plan].features.includes(feature);

/** Cheapest paid plan that includes a feature, for upgrade prompts. */
export const minimumPlanFor = (feature: Feature): PaidPlanId =>
  PAID_PLANS.find((p) => PLANS[p].features.includes(feature)) ?? "AGENCY";

export const isUnlimited = (n: number) => !Number.isFinite(n);
