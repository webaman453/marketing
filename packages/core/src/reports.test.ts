import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportConfigSchema, type ReportMetric, type ReportResult } from "@ashniva/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderReportPdf } from "./report-pdf";
import { nextRunAt, reportToCsv, todayIn } from "./reports";
import { putFile } from "./storage";

const TZ = process.env.TZ;
const UPLOAD_DIR = process.env.UPLOAD_DIR;
let dir: string;

beforeAll(() => {
  // nextRunAt does its arithmetic in the server's local time; tests pin it.
  process.env.TZ = "UTC";
  dir = mkdtempSync(path.join(os.tmpdir(), "core-reports-"));
  process.env.UPLOAD_DIR = dir;
});

afterAll(() => {
  process.env.TZ = TZ;
  process.env.UPLOAD_DIR = UPLOAD_DIR;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("todayIn", () => {
  it("returns the date in the given timezone", () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T20:00:00Z") });
    expect(todayIn("Asia/Kolkata")).toBe("2026-10-31");
    expect(todayIn("America/Los_Angeles")).toBe("2026-10-30");
    expect(todayIn("UTC")).toBe("2026-10-30");
  });

  it("falls back to the UTC date for an unknown timezone", () => {
    vi.useFakeTimers({ now: new Date("2026-10-30T20:00:00Z") });
    expect(todayIn("Not/AZone")).toBe("2026-10-30");
  });
});

describe("nextRunAt", () => {
  // Friday 30 Oct 2026, 17:30 in Kolkata.
  const from = new Date("2026-10-30T12:00:00Z");
  const s = (frequency: "DAILY" | "WEEKLY" | "MONTHLY", hour: number, dayOfWeek = 1, dayOfMonth = 1) => ({ frequency, hour, dayOfWeek, dayOfMonth });

  it("daily: later today when the hour is still ahead", () => {
    expect(nextRunAt(s("DAILY", 20), "Asia/Kolkata", from).toISOString()).toBe("2026-10-30T14:30:00.000Z");
  });

  it("daily: tomorrow when the hour has passed", () => {
    expect(nextRunAt(s("DAILY", 9), "Asia/Kolkata", from).toISOString()).toBe("2026-10-31T03:30:00.000Z");
  });

  it("daily: the same hour right now moves to tomorrow", () => {
    expect(nextRunAt(s("DAILY", 17), "Asia/Kolkata", new Date("2026-10-30T11:30:00Z")).toISOString()).toBe("2026-10-31T11:30:00.000Z");
  });

  it("weekly: the next matching weekday", () => {
    // Monday 2 Nov 09:00 IST
    expect(nextRunAt(s("WEEKLY", 9, 1), "Asia/Kolkata", from).toISOString()).toBe("2026-11-02T03:30:00.000Z");
    // Friday already past 9:00 → next Friday
    expect(nextRunAt(s("WEEKLY", 9, 5), "Asia/Kolkata", from).toISOString()).toBe("2026-11-06T03:30:00.000Z");
    // Friday 20:00 still ahead today
    expect(nextRunAt(s("WEEKLY", 20, 5), "Asia/Kolkata", from).toISOString()).toBe("2026-10-30T14:30:00.000Z");
  });

  it("monthly: the given day this month, else next month", () => {
    expect(nextRunAt(s("MONTHLY", 9, 1, 1), "Asia/Kolkata", from).toISOString()).toBe("2026-11-01T03:30:00.000Z");
    expect(nextRunAt(s("MONTHLY", 9, 1, 30), "Asia/Kolkata", from).toISOString()).toBe("2026-11-30T03:30:00.000Z");
    expect(nextRunAt(s("MONTHLY", 20, 1, 30), "Asia/Kolkata", from).toISOString()).toBe("2026-10-30T14:30:00.000Z");
    expect(nextRunAt(s("MONTHLY", 9, 1, 28), "Asia/Kolkata", new Date("2026-12-30T00:00:00Z")).toISOString()).toBe("2027-01-28T03:30:00.000Z");
  });

  it("works for timezones behind UTC", () => {
    // 05:00 in Los Angeles (PDT, UTC-7) on 30 Oct
    expect(nextRunAt(s("DAILY", 9), "America/Los_Angeles", from).toISOString()).toBe("2026-10-30T16:00:00.000Z");
  });

  it("is always in the future", () => {
    for (const f of ["DAILY", "WEEKLY", "MONTHLY"] as const) {
      for (const hour of [0, 9, 23]) expect(nextRunAt(s(f, hour, 3, 15), "Asia/Kolkata", from).getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

const values = (spend: number | null, extra: Partial<Record<ReportMetric, number | null>> = {}): Record<ReportMetric, number | null> => ({
  spend,
  impressions: 1000,
  clicks: 50,
  ctr: 0.05,
  cpc: spend == null ? null : spend / 50,
  cpm: 12.5,
  conversions: 4,
  conversionValue: 900,
  cpa: 31.25,
  roas: 3.6,
  conversionRate: 0.08,
  videoViews: 0,
  ...extra,
});

function result(overrides: Partial<ReportResult> = {}, config: Partial<ReportResult["config"]> = {}): ReportResult {
  return {
    name: "Weekly",
    range: { from: "2026-10-01", to: "2026-10-07" },
    compareRange: { from: "2026-09-24", to: "2026-09-30" },
    currency: "INR",
    config: reportConfigSchema.parse({ metrics: ["spend", "ctr", "roas", "conversionRate"], dimension: "campaign", ...config }),
    rows: [
      { key: "c1", label: 'Diwali, "big" sale', platform: "META", values: values(1234.567), previous: values(1000) },
      { key: "c2", label: "Search\nbrand", platform: undefined, values: values(null, { ctr: null, roas: null }) },
    ],
    totals: values(1234.567),
    previousTotals: values(1000),
    series: [
      { date: "2026-10-01", value: 100 },
      { date: "2026-10-02", value: null },
      { date: "2026-10-03", value: 250 },
    ],
    branding: { name: "Acme Agency", color: "#3b5bdb", logoUrl: null, footer: "Prepared by Acme" },
    workspaceName: "Client A",
    generatedAt: "2026-10-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("reportToCsv", () => {
  it("writes a header, one line per row and a total, quoting where needed", () => {
    const lines = reportToCsv(result()).split("\n");
    expect(lines[0]).toBe("Campaign,Platform,Spend,CTR,ROAS,Conv. rate");
    expect(lines[1]).toBe('"Diwali, ""big"" sale",Meta Ads,1234.57,5.00%,3.60,8.00%');
    expect(lines[2]).toBe('"Search');
    expect(lines[3]).toBe('brand",,,,,8.00%');
    expect(lines[4]).toBe("Total,,1234.57,5.00%,3.60,8.00%");
  });

  it("has no platform column for other dimensions", () => {
    const csv = reportToCsv(result({ rows: [{ key: "META", label: "Meta", platform: "META", values: values(10) }] }, { dimension: "platform" }));
    expect(csv.split("\n")).toEqual(["Platform,Spend,CTR,ROAS,Conv. rate", "Meta,10,5.00%,3.60,8.00%", "Total,1234.57,5.00%,3.60,8.00%"]);
  });

  it("neutralizes spreadsheet formulas in labels (CSV injection)", () => {
    const csv = reportToCsv(result({ rows: [{ key: "x", label: '=HYPERLINK("http://evil.test","click")', platform: "META", values: values(1) }] }));
    const cell = csv.split("\n")[1]!;
    expect(cell.startsWith("=") || cell.startsWith('"=')).toBe(false);
  });
});

describe("renderReportPdf", () => {
  it("renders a portrait PDF with KPI tiles, chart and table", async () => {
    const pdf = await renderReportPdf(result());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it("renders landscape for many metrics, without compare data, and with an empty table", async () => {
    const r = result(
      { rows: [], compareRange: null, previousTotals: null, series: [], branding: { name: "X", color: "#000000", logoUrl: null, footer: null } },
      { metrics: ["spend", "impressions", "clicks", "ctr", "cpc", "cpm", "conversions", "roas"], compare: false, chartMetric: null, dimension: "date" },
    );
    const pdf = await renderReportPdf(r);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("embeds a logo from our storage and from an https URL, and ignores bad logos", async () => {
    // 1×1 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const stored = await putFile("logos/test.png", png, "image/png");
    const withStored = await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: `http://localhost:4000${stored.url}`, footer: null } }));
    const without = await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: null, footer: null } }));
    expect(withStored.length).toBeGreaterThan(without.length);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const remote = await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: "https://cdn.example.test/logo.png", footer: null } }));
    expect(fetchSpy).toHaveBeenCalledWith("https://cdn.example.test/logo.png", expect.anything());
    expect(remote.length).toBeGreaterThan(without.length);

    fetchSpy.mockResolvedValue(new Response("<svg/>", { status: 200, headers: { "content-type": "image/svg+xml" } }));
    const svg = await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: "https://cdn.example.test/logo.svg", footer: null } }));
    expect(svg.subarray(0, 5).toString()).toBe("%PDF-");

    fetchSpy.mockRejectedValue(new Error("offline"));
    const offline = await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: "https://cdn.example.test/x.png", footer: null } }));
    expect(offline.subarray(0, 5).toString()).toBe("%PDF-");

    fetchSpy.mockClear();
    await renderReportPdf(result({ branding: { name: "A", color: "#111111", logoUrl: "javascript:alert(1)", footer: null } }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
