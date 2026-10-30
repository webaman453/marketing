import { describe, expect, it } from "vitest";
import { FEATURE_LABELS, PAID_PLANS, PLANS, isUnlimited, minimumPlanFor, planHasFeature, type Feature, type PlanId } from "./plans";

const FEATURES = Object.keys(FEATURE_LABELS) as Feature[];

describe("planHasFeature", () => {
  const matrix: Record<PlanId, Feature[]> = {
    TRIAL: FEATURES,
    STARTER: ["campaign_builder", "ai_assistant"],
    GROWTH: ["campaign_builder", "scheduled_reports", "automation_rules", "ai_assistant"],
    AGENCY: FEATURES,
  };
  const cells = (Object.keys(matrix) as PlanId[]).flatMap((plan) => FEATURES.map((feature) => ({ plan, feature, has: matrix[plan].includes(feature) })));
  it.each(cells)("$plan / $feature → $has", ({ plan, feature, has }) => {
    expect(planHasFeature(plan, feature)).toBe(has);
  });
});

describe("minimumPlanFor", () => {
  it.each([
    ["campaign_builder", "STARTER"],
    ["ai_assistant", "STARTER"],
    ["scheduled_reports", "GROWTH"],
    ["automation_rules", "GROWTH"],
    ["white_label", "AGENCY"],
    ["public_api", "AGENCY"],
  ] as const)("%s → %s", (feature, plan) => {
    expect(minimumPlanFor(feature)).toBe(plan);
  });
  it("falls back to Agency for an unknown feature", () => {
    expect(minimumPlanFor("nope" as Feature)).toBe("AGENCY");
  });
  it("never returns the trial", () => {
    for (const f of FEATURES) expect(PAID_PLANS).toContain(minimumPlanFor(f));
  });
});

describe("plan catalogue", () => {
  it("paid plans get more expensive and never lose features or limits", () => {
    for (let i = 1; i < PAID_PLANS.length; i++) {
      const lo = PLANS[PAID_PLANS[i - 1]!];
      const hi = PLANS[PAID_PLANS[i]!];
      expect(hi.priceMonthly).toBeGreaterThan(lo.priceMonthly);
      for (const f of lo.features) expect(hi.features).toContain(f);
      for (const k of ["workspaces", "adAccounts", "members"] as const) expect(hi.limits[k]).toBeGreaterThanOrEqual(lo.limits[k]);
    }
  });
  it("the trial is free; only Growth is marked popular", () => {
    expect(PLANS.TRIAL.priceMonthly).toBe(0);
    expect((Object.keys(PLANS) as PlanId[]).filter((p) => PLANS[p].popular)).toEqual(["GROWTH"]);
  });
  it("isUnlimited", () => {
    expect(isUnlimited(PLANS.AGENCY.limits.members)).toBe(true);
    expect(isUnlimited(Number.NEGATIVE_INFINITY)).toBe(true);
    expect(isUnlimited(NaN)).toBe(true);
    expect(isUnlimited(10)).toBe(false);
    expect(isUnlimited(0)).toBe(false);
  });
});
