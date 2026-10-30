import { deriveMetrics, emptyTotals, type PlatformBreakdown as Row, type Platform, type TimeseriesPoint } from "@ashniva/shared";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test-utils";
import { KpiCard } from "./kpi-card";
import { PlatformBreakdown, SPEND_COLORS, sortBySpend } from "./platform-breakdown";

const point = (date: string, spend: number): TimeseriesPoint => ({ ...emptyTotals(), date, spend }) as TimeseriesPoint;
const totals = deriveMetrics({ ...emptyTotals(), spend: 100 });

function renderKpi(series: TimeseriesPoint[]) {
  return renderWithProviders(<KpiCard metric="spend" totals={totals} previous={totals} series={series} currency="INR" />, { noWorkspace: true });
}

describe("KpiCard sparkline", () => {
  it("is hidden for a single day, keeping the strip's height", () => {
    renderKpi([point("2026-10-30", 100)]);
    const strip = screen.getByTestId("kpi-spark");
    expect(strip).toHaveClass("h-12");
    expect(strip).toBeEmptyDOMElement();
  });

  it("is hidden when every value is zero", () => {
    renderKpi([point("2026-10-29", 0), point("2026-10-30", 0)]);
    expect(screen.getByTestId("kpi-spark")).toBeEmptyDOMElement();
  });

  it("shows for two or more points with data", () => {
    renderKpi([point("2026-10-29", 0), point("2026-10-30", 50)]);
    expect(screen.getByTestId("kpi-spark")).not.toBeEmptyDOMElement();
  });
});

const row = (platform: Platform, spend: number) => ({ platform, metrics: deriveMetrics({ ...emptyTotals(), spend }) }) as Row;

describe("PlatformBreakdown", () => {
  it("gives every platform its own colour", () => {
    const colours = Object.values(SPEND_COLORS).map((c) => c.toLowerCase());
    expect(new Set(colours).size).toBe(colours.length);
    // The blues that used to blur together.
    expect(new Set([SPEND_COLORS.META, SPEND_COLORS.LINKEDIN, SPEND_COLORS.MICROSOFT, SPEND_COLORS.TABOOLA]).size).toBe(4);
  });

  it("orders by spend and breaks ties by the fixed platform order", () => {
    const sorted = sortBySpend([row("TABOOLA", 10), row("LINKEDIN", 50), row("META", 10), row("GOOGLE", 50)]);
    expect(sorted.map((r) => r.platform)).toEqual(["GOOGLE", "LINKEDIN", "META", "TABOOLA"]);
  });

  it("renders rows biggest first", () => {
    renderWithProviders(<PlatformBreakdown rows={[row("META", 10), row("GOOGLE", 90)]} currency="INR" />, { noWorkspace: true });
    const names = screen.getAllByText(/^(Meta Ads|Google Ads)$/).map((el) => el.textContent);
    expect(names).toEqual(["Google Ads", "Meta Ads"]);
  });
});
