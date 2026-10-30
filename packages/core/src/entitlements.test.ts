import { describe, expect, it } from "vitest";
import { EntitlementError, assertFeature, assertNotLocked, isOrgLocked } from "./entitlements";

type Plan = "TRIAL" | "STARTER" | "GROWTH" | "AGENCY";
type Status = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";

const NOW = new Date("2026-10-30T12:00:00Z");
const PAST = new Date("2026-10-01T00:00:00Z");
const FUTURE = new Date("2026-11-30T00:00:00Z");
const PLANS: Plan[] = ["TRIAL", "STARTER", "GROWTH", "AGENCY"];
const STATUSES: Status[] = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED", "EXPIRED"];
const DATES: [string, Date | null][] = [
  ["null", null],
  ["past", PAST],
  ["future", FUTURE],
];

const org = (plan: Plan, subscriptionStatus: Status, trialEndsAt: Date | null = null, currentPeriodEnd: Date | null = null) => ({
  plan,
  subscriptionStatus,
  trialEndsAt,
  currentPeriodEnd,
});

/** The rule the product documents, written out independently of the implementation. */
function expectedLocked(plan: Plan, status: Status, trialEndsAt: Date | null, periodEnd: Date | null) {
  if (plan === "TRIAL") return !(trialEndsAt && trialEndsAt > NOW);
  if (status === "ACTIVE" || status === "PAST_DUE" || status === "TRIALING") return false;
  if (status === "CANCELLED") return !(periodEnd && periodEnd > NOW);
  return true; // EXPIRED
}

describe("isOrgLocked", () => {
  const cases = PLANS.flatMap((plan) =>
    STATUSES.flatMap((status) =>
      DATES.flatMap(([tName, trial]) => DATES.map(([pName, period]) => ({ plan, status, tName, trial, pName, period }))),
    ),
  );

  it.each(cases)("$plan / $status / trialEndsAt=$tName / currentPeriodEnd=$pName", ({ plan, status, trial, period }) => {
    expect(isOrgLocked(org(plan, status, trial, period), NOW)).toBe(expectedLocked(plan, status, trial, period));
  });

  it("a trial ending exactly now is not yet locked", () => {
    expect(isOrgLocked(org("TRIAL", "TRIALING", new Date(NOW)), NOW)).toBe(false);
  });

  it("a cancelled subscription whose period ends exactly now is locked", () => {
    expect(isOrgLocked(org("GROWTH", "CANCELLED", null, new Date(NOW)), NOW)).toBe(true);
  });

  it("uses the current time by default", () => {
    expect(isOrgLocked(org("TRIAL", "TRIALING", new Date(Date.now() + 60_000)))).toBe(false);
    expect(isOrgLocked(org("TRIAL", "TRIALING", new Date(Date.now() - 60_000)))).toBe(true);
  });
});

describe("assertNotLocked", () => {
  const caught = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      return err as EntitlementError;
    }
    throw new Error("expected a throw");
  };

  it("passes for an active subscription", () => {
    expect(() => assertNotLocked(org("STARTER", "ACTIVE"))).not.toThrow();
  });

  it("asks a never-started trial to choose a plan", () => {
    const err = caught(() => assertNotLocked(org("TRIAL", "TRIALING", null)));
    expect(err).toBeInstanceOf(EntitlementError);
    expect(err.code).toBe("ORG_LOCKED");
    expect(err.name).toBe("EntitlementError");
    expect(err.message).toMatch(/Choose a plan to start/);
  });

  it("says the trial ended when it had an end date", () => {
    const err = caught(() => assertNotLocked(org("TRIAL", "TRIALING", new Date(Date.now() - 1000))));
    expect(err.code).toBe("ORG_LOCKED");
    expect(err.message).toMatch(/free trial has ended/);
  });

  it("says the subscription is inactive for paid plans", () => {
    const err = caught(() => assertNotLocked(org("AGENCY", "EXPIRED")));
    expect(err.message).toMatch(/subscription is inactive/);
  });
});

describe("assertFeature", () => {
  it("allows features included in the plan", () => {
    expect(() => assertFeature(org("STARTER", "ACTIVE"), "campaign_builder")).not.toThrow();
    expect(() => assertFeature(org("AGENCY", "ACTIVE"), "white_label")).not.toThrow();
    expect(() => assertFeature(org("TRIAL", "TRIALING", new Date(Date.now() + 86_400_000)), "public_api")).not.toThrow();
  });

  it("names the cheapest plan that has a locked feature", () => {
    expect(() => assertFeature(org("STARTER", "ACTIVE"), "automation_rules")).toThrow(
      expect.objectContaining({ code: "FEATURE_LOCKED", message: expect.stringContaining("Growth plan") }),
    );
    expect(() => assertFeature(org("GROWTH", "ACTIVE"), "white_label")).toThrow(
      expect.objectContaining({ code: "FEATURE_LOCKED", message: expect.stringContaining("Agency plan") }),
    );
  });

  it("reports a locked org before a missing feature", () => {
    expect(() => assertFeature(org("STARTER", "EXPIRED"), "automation_rules")).toThrow(expect.objectContaining({ code: "ORG_LOCKED" }));
  });
});
