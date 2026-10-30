import os from "node:os";
import path from "node:path";
import { reportConfigSchema, type ReportResult } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderReportPdf, reportFontDir } from "./report-pdf";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fonts = path.join(repoRoot, "packages/core/assets/fonts");

const report = (): ReportResult => ({
  name: "Weekly",
  range: { from: "2026-10-01", to: "2026-10-07" },
  compareRange: null,
  currency: "INR",
  config: reportConfigSchema.parse({ metrics: ["spend"], dimension: "date", compare: false }),
  rows: [],
  totals: { spend: 100 } as Partial<ReportResult["totals"]> as ReportResult["totals"],
  previousTotals: null,
  series: [],
  branding: { name: "Acme", color: "#3b5bdb", logoUrl: null, footer: null },
  workspaceName: "Client A",
  generatedAt: "2026-10-08T00:00:00.000Z",
});

// Docker runs the API and worker with working_dir apps/api / apps/worker and no
// .env, so loadEnv() never sets REPO_ROOT. Fonts must still be found.
describe("report PDF fonts outside the repo root", () => {
  const cwd = process.cwd();
  const saved = process.env.REPO_ROOT;

  beforeEach(() => {
    delete process.env.REPO_ROOT;
  });

  afterEach(() => {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.REPO_ROOT;
    else process.env.REPO_ROOT = saved;
  });

  it("renders a PDF with cwd = apps/api and no REPO_ROOT", async () => {
    process.chdir(path.join(repoRoot, "apps/api"));
    expect(reportFontDir()).toBe(fonts);
    const pdf = await renderReportPdf(report());
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("finds the fonts from the module's own location when cwd is unrelated", () => {
    process.chdir(os.tmpdir());
    expect(reportFontDir()).toBe(fonts);
  });

  it("ignores a REPO_ROOT that has no fonts and keeps looking", () => {
    process.env.REPO_ROOT = os.tmpdir();
    process.chdir(path.join(repoRoot, "apps/worker"));
    expect(reportFontDir()).toBe(fonts);
  });
});
