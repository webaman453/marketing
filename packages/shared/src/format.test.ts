import { describe, expect, it } from "vitest";
import { METRIC_FORMATS, compact, humanize, money, moneyCompact, multiple, number, percent } from "./format";

describe("money", () => {
  it("uses Indian grouping for INR and drops decimals from 1,000 up", () => {
    expect(money(319196)).toBe("₹3,19,196");
    expect(money(1000)).toBe("₹1,000");
    expect(money(1234.56)).toBe("₹1,235");
    expect(money(999.5)).toBe("₹999.50");
    expect(money(0)).toBe("₹0.00");
  });
  it("uses en-US for other currencies", () => {
    expect(money(12.5, "USD")).toBe("$12.50");
    expect(money(1234567, "USD")).toBe("$1,234,567");
    expect(money(-5, "EUR")).toBe("-€5.00");
    expect(money(-1500, "INR")).toBe("-₹1,500");
  });
  it("respects explicit decimals", () => {
    expect(money(1234.5, "USD", { decimals: 2 })).toBe("$1,234.50");
    expect(money(12.345, "INR", { decimals: 0 })).toBe("₹12");
  });
  it("shows a dash for missing values", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(NaN)).toBe("—");
  });
});

describe("moneyCompact", () => {
  it("stays exact below 1 lakh / 100k", () => {
    expect(moneyCompact(99_999)).toBe("₹99,999");
    expect(moneyCompact(12.4, "USD")).toBe("$12");
  });
  it("uses lakh / crore for INR and K/M for others", () => {
    expect(moneyCompact(3_190_000)).toBe("₹31.9L");
    expect(moneyCompact(32_000_000)).toBe("₹3.2Cr");
    expect(moneyCompact(1_234_567, "USD")).toBe("$1.2M");
  });
  it("shows a dash for missing values", () => {
    expect(moneyCompact(null)).toBe("—");
    expect(moneyCompact(NaN, "USD")).toBe("—");
  });
});

describe("number / compact / percent / multiple", () => {
  it("number groups by currency locale and rounds", () => {
    expect(number(1234567.6)).toBe("12,34,568");
    expect(number(1234567.6, { currency: "USD" })).toBe("1,234,568");
    expect(number(1.256, { decimals: 2 })).toBe("1.26");
    expect(number(null)).toBe("—");
  });
  it("compact", () => {
    expect(compact(123456)).toBe("1.2L");
    expect(compact(1500, "USD")).toBe("1.5K");
    expect(compact(undefined)).toBe("—");
  });
  it("percent takes a ratio", () => {
    expect(percent(0.0127)).toBe("1.27%");
    expect(percent(1)).toBe("100.00%");
    expect(percent(0.5, 0)).toBe("50%");
    expect(percent(null)).toBe("—");
  });
  it("multiple", () => {
    expect(multiple(4.123)).toBe("4.12×");
    expect(multiple(0)).toBe("0.00×");
    expect(multiple(NaN)).toBe("—");
  });
});

describe("humanize", () => {
  it.each([
    ["OUTCOME_SALES", "Sales"],
    ["PERFORMANCE_MAX", "Performance Max"],
    ["search", "Search"],
    ["", "—"],
    [null, "—"],
    [undefined, "—"],
  ])("%s → %s", (input, out) => {
    expect(humanize(input)).toBe(out);
  });
});

describe("METRIC_FORMATS", () => {
  it("formats every metric in full and short form", () => {
    for (const [key, f] of Object.entries(METRIC_FORMATS)) {
      expect(f.label.length, key).toBeGreaterThan(0);
      expect(typeof f.format(1234.5, "INR"), key).toBe("string");
      expect(typeof f.short(1234.5, "INR"), key).toBe("string");
      expect(f.format(null, "INR"), key).toBe("—");
      expect(f.short(null, "INR"), key).toBe("—");
    }
    expect(METRIC_FORMATS.spend!.format(319196, "INR")).toBe("₹3,19,196");
    expect(METRIC_FORMATS.spend!.short(3_190_000, "INR")).toBe("₹31.9L");
    expect(METRIC_FORMATS.ctr!.format(0.05, "INR")).toBe("5.00%");
    expect(METRIC_FORMATS.cpc!.format(1234.5, "USD")).toBe("$1,234.50");
    expect(METRIC_FORMATS.cpm!.short(12.6, "USD")).toBe("$13");
    expect(METRIC_FORMATS.roas!.short(3, "INR")).toBe("3.00×");
    expect(METRIC_FORMATS.conversions!.format(12.34, "INR")).toBe("12.3");
  });
});
