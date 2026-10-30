import "@/test-utils/polyfills";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDateRangeStore } from "@/lib/date-range";
import { DateRangePicker } from "./date-range-picker";

// Both the two-month (desktop) and one-month (mobile) calendars are in the DOM; use the first.
const day = (label: RegExp) => screen.getAllByRole("button", { name: label })[0]!;
const popover = () => within(screen.getByRole("dialog"));
const apply = () => screen.getByRole("button", { name: "Apply" });

async function openWith(from: string, to: string) {
  useDateRangeStore.setState({ hydrated: true, preset: "custom", custom: { from, to } });
  const user = userEvent.setup();
  render(<DateRangePicker />);
  await user.click(screen.getByRole("button", { name: /Custom range/ }));
  return user;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 30, 12));
});
afterEach(() => vi.useRealTimers());

describe("DateRangePicker", () => {
  it("starts a fresh selection on click instead of reshaping the old range", { timeout: 30_000 }, async () => {
    const user = await openWith("2026-10-01", "2026-10-30");
    expect(popover().getByText("1 Oct – 30 Oct 2026")).toBeInTheDocument();

    await user.click(day(/October 28th, 2026/));
    // One click selects just that day; Apply would apply the single day.
    expect(popover().getByText("28 Oct 2026")).toBeInTheDocument();
    expect(popover().getByText(/pick an end date/)).toBeInTheDocument();
    expect(apply()).toBeEnabled();

    await user.click(day(/October 12th, 2026/));
    // An earlier second click becomes the start.
    expect(popover().getByText("12 Oct – 28 Oct 2026")).toBeInTheDocument();
    expect(popover().queryByText(/pick an end date/)).not.toBeInTheDocument();

    await user.click(apply());
    expect(useDateRangeStore.getState().custom).toEqual({ from: "2026-10-12", to: "2026-10-28" });
  });

  it("applies a single day after one click", { timeout: 30_000 }, async () => {
    const user = await openWith("2026-10-01", "2026-10-30");
    await user.click(day(/October 5th, 2026/));
    await user.click(apply());
    expect(useDateRangeStore.getState()).toMatchObject({ preset: "custom", custom: { from: "2026-10-05", to: "2026-10-05" } });
  });
});
