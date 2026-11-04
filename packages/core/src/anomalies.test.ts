import { describe, expect, it, vi } from "vitest";

vi.mock("@ashniva/db", () => ({ prisma: {} }));

const { detectLostConversions, detectSpendSpike } = await import("./anomalies");

/** Daily rows ending on `end`, oldest first. */
const days = (end: string, rows: [number, number][]) =>
  rows.map(([spend, conversions], i) => ({
    date: new Date(Date.parse(`${end}T00:00:00Z`) - (rows.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    spend,
    conversions,
  }));

const TODAY = "2026-11-03";

describe("detectSpendSpike", () => {
  const steady: [number, number][] = [[100, 2], [110, 2], [90, 1], [100, 2], [105, 2]];

  it("flags a day at least twice the recent average", () => {
    const found = detectSpendSpike(days(TODAY, [...steady, [260, 2]]), TODAY);
    expect(found?.ratio).toBeGreaterThanOrEqual(2);
    expect(found?.latest).toBe(260);
  });

  it("ignores normal swings", () => {
    expect(detectSpendSpike(days(TODAY, [...steady, [150, 2]]), TODAY)).toBeNull();
  });

  it("needs a few days of history", () => {
    expect(detectSpendSpike(days(TODAY, [[100, 1], [400, 1]]), TODAY)).toBeNull();
  });

  it("does not divide by a zero average (a campaign that just started spending)", () => {
    expect(detectSpendSpike(days(TODAY, [[0, 0], [0, 0], [0, 0], [500, 1]]), TODAY)).toBeNull();
  });

  it("follows the workspace's sensitivity", () => {
    const rows = days(TODAY, [...steady, [160, 2]]);
    expect(detectSpendSpike(rows, TODAY)).toBeNull();
    expect(detectSpendSpike(rows, TODAY, 1.5)?.ratio).toBeGreaterThanOrEqual(1.5);
    expect(detectSpendSpike(days(TODAY, [...steady, [260, 2]]), TODAY, 3)).toBeNull();
  });

  it("ignores stale data", () => {
    expect(detectSpendSpike(days("2026-10-28", [...steady, [900, 2]]), TODAY)).toBeNull();
  });
});

describe("detectLostConversions", () => {
  const converting: [number, number][] = [[100, 3], [100, 2], [100, 4], [100, 3], [100, 2]];

  it("flags days of spend with no conversions after a stretch that had them", () => {
    const found = detectLostConversions(days(TODAY, [...converting, [90, 0], [95, 0], [100, 0]]), TODAY);
    expect(found).toMatchObject({ days: 3, spend: 285, earlierConversions: 14 });
  });

  it("follows the number of days the workspace asked for", () => {
    const rows = days(TODAY, [...converting, [90, 0], [95, 0]]);
    expect(detectLostConversions(rows, TODAY)).toBeNull();
    expect(detectLostConversions(rows, TODAY, 2)).toMatchObject({ days: 2, spend: 185 });
    expect(detectLostConversions(days(TODAY, [...converting, [90, 0], [95, 0], [100, 0]]), TODAY, 5)).toBeNull();
  });

  it("ignores campaigns that never had conversions", () => {
    expect(detectLostConversions(days(TODAY, [[100, 0], [100, 0], [100, 0], [100, 0], [100, 0], [100, 0], [100, 0], [100, 0]]), TODAY)).toBeNull();
  });

  it("needs a conversion inside the window to clear it", () => {
    expect(detectLostConversions(days(TODAY, [...converting, [90, 0], [95, 1], [100, 0]]), TODAY)).toBeNull();
  });

  it("needs spend on every one of the days", () => {
    expect(detectLostConversions(days(TODAY, [...converting, [90, 0], [0, 0], [100, 0]]), TODAY)).toBeNull();
  });

  it("does not bridge a gap in the data", () => {
    const rows = days(TODAY, [...converting, [90, 0], [95, 0], [100, 0]]);
    rows[rows.length - 2]!.date = "2026-10-20";
    expect(detectLostConversions(rows, TODAY)).toBeNull();
  });
});
