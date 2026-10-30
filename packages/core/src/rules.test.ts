import { describe, expect, it } from "vitest";
import { contactOf } from "./leads";
import { describeConditions, nextRuleRun } from "./rules";

describe("nextRuleRun", () => {
  it("hourly runs at the top of the next hour", () => {
    const next = nextRuleRun("HOURLY", new Date(2026, 9, 30, 10, 37, 12, 5));
    expect(next).toEqual(new Date(2026, 9, 30, 11, 0, 0, 0));
  });

  it("daily runs 24 hours later", () => {
    const from = new Date(2026, 9, 30, 10, 37);
    expect(nextRuleRun("DAILY", from)).toEqual(new Date(2026, 9, 31, 10, 37));
  });

  it("does not modify its input", () => {
    const from = new Date(2026, 0, 31, 23, 30);
    const copy = new Date(from);
    nextRuleRun("HOURLY", from);
    expect(from).toEqual(copy);
  });

  it("defaults to now", () => {
    expect(nextRuleRun("DAILY").getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
  });
});

describe("describeConditions", () => {
  it("joins conditions with 'and' for ALL and formats each metric", () => {
    const text = describeConditions(
      {
        conditionLogic: "ALL",
        conditions: [
          { metric: "ctr", operator: "lt", value: 1.5 },
          { metric: "roas", operator: "gte", value: 2 },
          { metric: "spend", operator: "gt", value: 1000 },
        ],
      },
      "INR",
    );
    const parts = text.split(" and ");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("CTR is less than 1.5%");
    expect(parts[1]).toBe("ROAS is at least 2×");
    expect(parts[2]).toMatch(/^Spend is greater than ₹\s?1,000/);
  });

  it("joins with 'or' for ANY", () => {
    const text = describeConditions(
      { conditionLogic: "ANY", conditions: [{ metric: "clicks", operator: "lte", value: 10 }, { metric: "cpa", operator: "gt", value: 50 }] },
      "USD",
    );
    expect(text).toMatch(/^Clicks is at most 10 or Cost \/ conv\. is greater than \$50/);
  });

  it("rejects invalid stored conditions", () => {
    expect(() => describeConditions({ conditionLogic: "ALL", conditions: [{ metric: "nope", operator: "gt", value: 1 }] }, "INR")).toThrow();
  });
});

describe("contactOf", () => {
  it("reads full_name, email and phone_number", () => {
    expect(contactOf({ full_name: [" Asha Rao "], email: ["asha@example.test"], phone_number: ["+91 98765 43210"] })).toEqual({
      name: "Asha Rao",
      email: "asha@example.test",
      phone: "+91 98765 43210",
    });
  });

  it("joins first and last name when there is no full name", () => {
    expect(contactOf({ first_name: ["Asha"], last_name: ["Rao"] }).name).toBe("Asha Rao");
    expect(contactOf({ first_name: ["Asha"] }).name).toBe("Asha");
    expect(contactOf({ last_name: ["Rao"] }).name).toBe("Rao");
  });

  it("falls back across alternative keys in order", () => {
    expect(contactOf({ name: ["N"], work_email: ["w@example.test"], work_phone_number: ["123"] })).toEqual({ name: "N", email: "w@example.test", phone: "123" });
    expect(contactOf({ phone: ["555"], phone_number: ["  "] }).phone).toBe("555");
    expect(contactOf({ full_name: [""], name: ["Second"] }).name).toBe("Second");
  });

  it("returns nulls for an empty form", () => {
    expect(contactOf({})).toEqual({ name: null, email: null, phone: null });
    expect(contactOf({ email: [] })).toEqual({ name: null, email: null, phone: null });
  });
});
