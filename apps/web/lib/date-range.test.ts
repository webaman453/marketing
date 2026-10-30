import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@/test-utils/polyfills";
import { PRESET_LABELS, resolvePreset, useDateRange, useDateRangeStore } from "./date-range";

afterEach(() => useDateRangeStore.setState({ hydrated: false, preset: "30d", custom: null }));

describe("resolvePreset", () => {
  it.each([
    ["today", "2026-10-30", "2026-10-30"],
    ["7d", "2026-10-24", "2026-10-30"],
    ["14d", "2026-10-17", "2026-10-30"],
    ["30d", "2026-10-01", "2026-10-30"],
    ["90d", "2026-08-02", "2026-10-30"],
    ["mtd", "2026-10-01", "2026-10-30"],
    ["last_month", "2026-09-01", "2026-09-30"],
  ] as const)("%s → %s..%s", (preset, from, to) => {
    expect(resolvePreset(preset, "2026-10-30")).toEqual({ from, to });
  });

  it("last month crosses the year boundary", () => {
    expect(resolvePreset("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("useDateRange", () => {
  it("is not ready until the saved choice is read, and defaults to the last 30 days", () => {
    const { result } = renderHook(() => useDateRange());
    expect(result.current.ready).toBe(false);
    expect(result.current.preset).toBe("30d");
    expect(result.current.label).toBe(PRESET_LABELS["30d"]);
  });

  it("follows preset and custom choices", () => {
    const { result } = renderHook(() => useDateRange());
    act(() => {
      useDateRangeStore.setState({ hydrated: true });
      useDateRangeStore.getState().setPreset("7d");
    });
    expect(result.current).toMatchObject({ preset: "7d", label: "Last 7 days", ready: true });
    act(() => useDateRangeStore.getState().setCustom({ from: "2026-01-01", to: "2026-01-31" }));
    expect(result.current).toMatchObject({ preset: "custom", label: "Custom range", from: "2026-01-01", to: "2026-01-31" });
  });

  it("a custom preset without dates falls back to 30 days", () => {
    useDateRangeStore.setState({ preset: "custom", custom: null });
    const { result } = renderHook(() => useDateRange());
    expect(result.current.preset).toBe("30d");
  });
});
