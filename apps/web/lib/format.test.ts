import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compact, dateTime, initials, longDate, money, moneyCompact, number, percent, shortDate, timeAgo, tokenCount } from "./format";

describe("format helpers", () => {
  it("formats dates from ISO strings", () => {
    expect(shortDate("2026-03-05")).toBe("5 Mar");
    expect(longDate("2026-03-05")).toBe("5 Mar 2026");
    expect(dateTime("2026-03-05T14:07:00")).toBe("5 Mar 2026, 2:07 PM");
  });

  describe("timeAgo", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());

    it("says how long ago a moment was", () => {
      expect(timeAgo("2026-10-30T11:55:00Z")).toBe("5 minutes ago");
      expect(timeAgo("2026-10-28T12:00:00Z")).toBe("2 days ago");
    });
  });

  it("makes initials from up to two words", () => {
    expect(initials("asha verma")).toBe("AV");
    expect(initials("  Ravi   Kumar  Singh ")).toBe("RK");
    expect(initials("Zed")).toBe("Z");
    expect(initials("")).toBe("");
  });

  it("formats AI token counts compactly", () => {
    expect(tokenCount(100_000)).toBe("100K");
    expect(tokenCount(2_500_000)).toBe("2.5M");
    expect(tokenCount(950)).toBe("950");
  });

  it("re-exports the shared number formatters", () => {
    expect(money(319196, "INR")).toBe("₹3,19,196");
    expect(money(12.5, "USD")).toBe("$12.50");
    expect(money(1500, "INR", { decimals: 0 })).toBe("₹1,500");
    expect(money(null)).toBe("—");
    expect(moneyCompact(3_190_000, "INR")).toMatch(/^₹31\.9L$/);
    expect(moneyCompact(5000, "INR")).toBe("₹5,000");
    expect(number(1234567)).toBe("12,34,567");
    expect(number(undefined)).toBe("—");
    expect(compact(1200, "USD")).toBe("1.2K");
    expect(percent(0.0127)).toBe("1.27%");
    expect(percent(Number.NaN)).toBe("—");
  });
});
