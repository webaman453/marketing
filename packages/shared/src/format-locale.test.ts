import { describe, expect, it } from "vitest";
import { METRIC_FORMATS, compact, fxNote, localeFor, number } from "./format";

describe("number formatting follows the workspace currency", () => {
  it("INR keeps lakh / crore grouping", () => {
    expect(number(12345678, { currency: "INR" })).toBe("1,23,45,678");
    expect(compact(12_000_000, "INR")).toBe("1.2Cr");
    expect(compact(150_000, "INR")).toBe("1.5L");
  });

  it("other currencies use thousands / millions / billions", () => {
    expect(number(12345678, { currency: "USD" })).toBe("12,345,678");
    expect(number(12345678, { currency: "EUR" })).toBe("12,345,678");
    expect(compact(1_234_567, "USD")).toBe("1.2M");
    expect(compact(3_200_000_000, "GBP")).toBe("3.2B");
    expect(compact(150_000, "USD")).toBe("150K");
  });

  it("an explicit locale wins over the currency", () => {
    expect(localeFor("USD", "en-IN")).toBe("en-IN");
    expect(number(12345678, { currency: "USD", locale: "en-IN" })).toBe("1,23,45,678");
    expect(compact(1_234_567, "INR", { locale: "en-US" })).toBe("1.2M");
  });

  it("METRIC_FORMATS formats counts with the currency it is given", () => {
    expect(METRIC_FORMATS.impressions!.format(12345678, "USD")).toBe("12,345,678");
    expect(METRIC_FORMATS.impressions!.format(12345678, "INR")).toBe("1,23,45,678");
    expect(METRIC_FORMATS.impressions!.short(12_345_678, "USD")).toBe("12.3M");
    expect(METRIC_FORMATS.impressions!.short(12_345_678, "INR")).toBe("1.2Cr");
    expect(METRIC_FORMATS.clicks!.short(1_500, "USD")).toBe("1.5K");
    expect(METRIC_FORMATS.conversions!.format(1234567.25, "USD")).toBe("1,234,567.3");
    expect(METRIC_FORMATS.videoViews!.format(1234567, "INR")).toBe("12,34,567");
  });
});

describe("fxNote", () => {
  it("is silent when nothing was converted", () => {
    expect(fxNote(undefined)).toBeNull();
    expect(fxNote({ conversion: "none", currency: "USD", from: [], source: "ECB" })).toBeNull();
  });

  it("names the target currency and source", () => {
    expect(fxNote({ conversion: "converted", currency: "USD", from: ["INR"], source: "ECB" })).toBe(
      "Converted to USD at daily ECB rates (from INR).",
    );
  });

  it("warns when rates are unavailable", () => {
    expect(fxNote({ conversion: "unavailable", currency: "USD", from: ["INR"], source: "ECB" })).toMatch(/unavailable.*INR and USD.*unconverted/);
  });
});
