import { z } from "zod";
import { PLATFORMS } from "./platforms";

export const REPORT_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "conversionValue",
  "cpa",
  "roas",
  "conversionRate",
  "videoViews",
] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export const REPORT_DIMENSIONS = ["date", "platform", "campaign", "adAccount"] as const;
export type ReportDimension = (typeof REPORT_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<ReportDimension, string> = {
  date: "Day",
  platform: "Platform",
  campaign: "Campaign",
  adAccount: "Ad account",
};

export const REPORT_PRESETS = ["7d", "14d", "30d", "90d", "mtd", "last_month"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const PRESET_TITLES: Record<ReportPreset, string> = {
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "Month to date",
  last_month: "Last month",
};

export const reportConfigSchema = z.object({
  metrics: z.array(z.enum(REPORT_METRICS)).min(1, "Pick at least one metric").max(10),
  dimension: z.enum(REPORT_DIMENSIONS).default("campaign"),
  datePreset: z.enum(REPORT_PRESETS).default("30d"),
  platforms: z.array(z.enum(PLATFORMS)).default([]),
  compare: z.boolean().default(true),
  chartMetric: z.enum(REPORT_METRICS).nullable().default("spend"),
});
export type ReportConfig = z.infer<typeof reportConfigSchema>;

export const reportSchema = z.object({
  name: z.string().trim().min(2, "Name the report").max(120),
  description: z.string().trim().max(500).nullable().default(null),
  config: reportConfigSchema,
});
export type ReportInput = z.infer<typeof reportSchema>;

export const reportScheduleSchema = z
  .object({
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]).nullable(),
    hour: z.number().int().min(0).max(23).default(9),
    dayOfWeek: z.number().int().min(0).max(6).default(1),
    dayOfMonth: z.number().int().min(1).max(28).default(1),
    recipients: z.array(z.email("Enter valid email addresses")).max(20).default([]),
  })
  .refine((v) => v.frequency === null || v.recipients.length > 0, {
    path: ["recipients"],
    message: "Add at least one recipient",
  });
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;

export interface ReportRow {
  key: string;
  label: string;
  platform?: string;
  values: Record<ReportMetric, number | null>;
  previous?: Record<ReportMetric, number | null>;
}

export interface ReportResult {
  name: string;
  range: { from: string; to: string };
  compareRange: { from: string; to: string } | null;
  currency: string;
  config: ReportConfig;
  rows: ReportRow[];
  totals: Record<ReportMetric, number | null>;
  previousTotals: Record<ReportMetric, number | null> | null;
  series: { date: string; value: number | null }[];
  branding: { name: string; color: string; logoUrl: string | null; footer: string | null };
  workspaceName: string;
  generatedAt: string;
}

/** Resolves a preset relative to `today` (YYYY-MM-DD). */
export function resolveReportPreset(preset: ReportPreset, today: string): { from: string; to: string } {
  const shift = (iso: string, days: number) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  switch (preset) {
    case "7d":
      return { from: shift(today, -6), to: today };
    case "14d":
      return { from: shift(today, -13), to: today };
    case "30d":
      return { from: shift(today, -29), to: today };
    case "90d":
      return { from: shift(today, -89), to: today };
    case "mtd":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const lastPrev = shift(`${today.slice(0, 7)}-01`, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}
