"use client";

import { addDays } from "@ashniva/shared";
import { format } from "date-fns";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RangePreset = "today" | "7d" | "14d" | "30d" | "90d" | "mtd" | "last_month" | "custom";

export const PRESET_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "Month to date",
  last_month: "Last month",
};

export interface Range {
  from: string;
  to: string;
}

/** Today in the viewer's local calendar, as YYYY-MM-DD. */
export const localToday = () => format(new Date(), "yyyy-MM-dd");

export function resolvePreset(preset: Exclude<RangePreset, "custom">, today = localToday()): Range {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "14d":
      return { from: addDays(today, -13), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "mtd":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const firstThisMonth = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThisMonth, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

interface DateRangeState {
  /** False until the saved choice has been read from localStorage. */
  hydrated: boolean;
  preset: RangePreset;
  custom: Range | null;
  setPreset: (p: Exclude<RangePreset, "custom">) => void;
  setCustom: (r: Range) => void;
}

/** Selected reporting period, remembered per browser. */
export const useDateRangeStore = create<DateRangeState>()(
  persist(
    (set) => ({
      hydrated: false,
      preset: "30d",
      custom: null,
      setPreset: (preset) => set({ preset }),
      setCustom: (custom) => set({ preset: "custom", custom }),
    }),
    {
      name: "ashniva-date-range",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ preset, custom }) => ({ preset, custom }),
      // Read storage after mount so server and first client render match.
      skipHydration: true,
      onRehydrateStorage: () => () => useDateRangeStore.setState({ hydrated: true }),
    },
  ),
);

export function useDateRange(): Range & { preset: RangePreset; label: string; ready: boolean } {
  const { preset, custom, hydrated } = useDateRangeStore();
  if (preset === "custom" && custom) return { ...custom, preset, label: "Custom range", ready: hydrated };
  const p = preset === "custom" ? "30d" : preset;
  return { ...resolvePreset(p), preset: p, label: PRESET_LABELS[p], ready: hydrated };
}
