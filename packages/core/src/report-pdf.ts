/**
 * Renders a ReportResult as a branded PDF (KPI tiles, trend chart, table).
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import {
  DIMENSION_LABELS,
  LOWER_IS_BETTER,
  METRIC_FORMATS,
  fxNote,
  PLATFORM_INFO,
  percentChange,
  type MetricKey,
  type Platform,
  type ReportMetric,
  type ReportResult,
} from "@ashniva/shared";
import { getFile } from "./storage";

const INK = "#1c2333";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const GOOD = "#15803d";
const BAD = "#b91c1c";

const FONT_FILES = ["Inter-Regular.ttf", "Inter-SemiBold.ttf", "Inter-Bold.ttf"] as const;
const FONT_SUBDIRS = [path.join("packages", "core", "assets", "fonts"), path.join("assets", "fonts")];

/** This module's own directory: packages/core/src in dev, apps/<app>/dist once bundled. */
function moduleDir(): string | null {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Finds the bundled Inter fonts. Walks up from REPO_ROOT, the working directory
 * and this module's directory, so it works from the repo root, from
 * apps/api or apps/worker (Docker sets those as working_dir and has no .env),
 * and from a bundled dist/. Throws a clear error rather than letting pdfkit
 * fail later with a bare ENOENT.
 */
export function reportFontDir(): string {
  const starts = [process.env.REPO_ROOT, process.cwd(), moduleDir()].filter((s): s is string => Boolean(s));
  const tried = new Set<string>();
  for (const start of starts) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      for (const sub of FONT_SUBDIRS) {
        const candidate = path.join(dir, sub);
        if (tried.has(candidate)) continue;
        tried.add(candidate);
        if (FONT_FILES.every((f) => existsSync(path.join(candidate, f)))) return candidate;
      }
      if (path.dirname(dir) === dir) break;
    }
  }
  throw new Error(
    `Report PDF fonts (${FONT_FILES.join(", ")}) not found in packages/core/assets/fonts above ${starts.join(", ")}. ` +
      "Make sure that folder ships with the app, or set REPO_ROOT to the repository root.",
  );
}

async function loadLogo(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const marker = "/api/files/";
    const idx = url.indexOf(marker);
    if (idx >= 0) {
      const file = await getFile(url.slice(idx + marker.length));
      return file && /png|jpe?g/.test(file.contentType) ? file.data : null;
    }
    if (!/^https?:\/\//.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const type = res.headers.get("content-type") ?? "";
    return res.ok && /png|jpe?g/.test(type) ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

const fmt = (m: ReportMetric, v: number | null, currency: string) => METRIC_FORMATS[m]!.format(v, currency);
const short = (m: ReportMetric, v: number | null, currency: string) => METRIC_FORMATS[m]!.short(v, currency);

export async function renderReportPdf(r: ReportResult): Promise<Buffer> {
  const metrics = r.config.metrics;
  const landscape = metrics.length > 5;
  const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 40, bufferPages: true, info: { Title: r.name, Author: r.branding.name } });
  const dir = reportFontDir();
  doc.registerFont("R", path.join(dir, "Inter-Regular.ttf"));
  doc.registerFont("S", path.join(dir, "Inter-SemiBold.ttf"));
  doc.registerFont("B", path.join(dir, "Inter-Bold.ttf"));

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width;
  const M = 40;
  const inner = W - M * 2;
  const brand = r.branding.color;

  // ── Header ──
  const logo = await loadLogo(r.branding.logoUrl);
  if (logo) {
    try {
      doc.image(logo, M, M, { fit: [140, 32] });
    } catch {
      doc.font("B").fontSize(14).fillColor(brand).text(r.branding.name, M, M + 6);
    }
  } else {
    doc.font("B").fontSize(14).fillColor(brand).text(r.branding.name, M, M + 6);
  }
  doc.font("S").fontSize(9).fillColor(MUTED).text(r.workspaceName, M, M + 6, { width: inner, align: "right" });
  doc.font("R").text(`${r.range.from} → ${r.range.to}`, M, M + 19, { width: inner, align: "right" });

  doc.moveTo(M, M + 44).lineTo(W - M, M + 44).lineWidth(2).strokeColor(brand).stroke();
  doc.font("B").fontSize(20).fillColor(INK).text(r.name, M, M + 60, { width: inner });
  if (r.compareRange) {
    doc.font("R").fontSize(9).fillColor(MUTED).text(`Compared with ${r.compareRange.from} → ${r.compareRange.to}`, { width: inner });
  }
  const fxLine = fxNote(r.fx);
  if (fxLine) doc.font("R").fontSize(8).fillColor(MUTED).text(`Amounts in ${r.currency}. ${fxLine}`, { width: inner });

  // ── KPI tiles ──
  const kpis = metrics.slice(0, landscape ? 6 : 6);
  const perRow = landscape ? 6 : 3;
  const gap = 10;
  const tileW = (inner - gap * (perRow - 1)) / perRow;
  const tileH = 58;
  let y = doc.y + 16;
  kpis.forEach((m, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = M + col * (tileW + gap);
    const ty = y + row * (tileH + gap);
    doc.roundedRect(x, ty, tileW, tileH, 6).lineWidth(1).strokeColor(LINE).stroke();
    doc.font("S").fontSize(8).fillColor(MUTED).text(METRIC_FORMATS[m]!.label.toUpperCase(), x + 10, ty + 9, { width: tileW - 20 });
    doc.font("B").fontSize(15).fillColor(INK).text(short(m, r.totals[m], r.currency), x + 10, ty + 22, { width: tileW - 20 });
    const change = r.previousTotals ? percentChange(r.totals[m], r.previousTotals[m]) : null;
    if (change != null && Number.isFinite(change)) {
      const up = change > 0;
      const good = LOWER_IS_BETTER.has(m as MetricKey) ? !up : up;
      doc.font("S").fontSize(8).fillColor(Math.abs(change) < 0.0005 ? MUTED : good ? GOOD : BAD)
        .text(`${up ? "▲" : "▼"} ${Math.abs(change * 100).toFixed(1)}% vs previous`, x + 10, ty + 42, { width: tileW - 20 });
    }
  });
  y += Math.ceil(kpis.length / perRow) * (tileH + gap) + 8;

  // ── Trend chart ──
  const cm = r.config.chartMetric;
  const values = r.series.map((p) => p.value ?? 0);
  if (cm && values.length > 1) {
    const chartH = 120;
    const chartX = M + 50;
    const chartW = inner - 50;
    // Round the axis up to a "nice" number so tick labels read cleanly.
    const raw = Math.max(...values, 0) || 1;
    const step = 10 ** Math.floor(Math.log10(raw / 4));
    const max = Math.ceil(raw / 4 / step) * step * 4;
    doc.font("S").fontSize(10).fillColor(INK).text(`${METRIC_FORMATS[cm]!.label} by day`, M, y);
    const top = y + 18;
    // Gridlines and y labels
    for (let i = 0; i <= 4; i++) {
      const gy = top + chartH - (chartH * i) / 4;
      doc.moveTo(chartX, gy).lineTo(chartX + chartW, gy).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font("R").fontSize(7).fillColor(MUTED).text(short(cm, (max * i) / 4, r.currency), M, gy - 4, { width: 46, align: "right" });
    }
    const pt = (i: number) => [chartX + (chartW * i) / (values.length - 1), top + chartH - (chartH * values[i]!) / max] as const;
    doc.save();
    doc.moveTo(chartX, top + chartH);
    values.forEach((_, i) => doc.lineTo(...pt(i)));
    doc.lineTo(chartX + chartW, top + chartH).closePath().fillOpacity(0.12).fill(brand);
    doc.restore();
    doc.moveTo(...pt(0));
    values.forEach((_, i) => i > 0 && doc.lineTo(...pt(i)));
    doc.lineWidth(1.6).strokeColor(brand).stroke();
    // X labels: first, middle, last
    [0, Math.floor((values.length - 1) / 2), values.length - 1].forEach((i) => {
      const [x] = pt(i);
      doc.font("R").fontSize(7).fillColor(MUTED).text(r.series[i]!.date.slice(5), x - 20, top + chartH + 4, { width: 40, align: "center" });
    });
    y = top + chartH + 24;
  }

  // ── Table ──
  const firstW = Math.max(150, inner - metrics.length * 78);
  const colW = (inner - firstW) / metrics.length;
  const rowH = 20;
  const bottom = doc.page.height - 60;

  const header = (ty: number) => {
    doc.rect(M, ty, inner, rowH).fill("#f3f4f6");
    doc.font("S").fontSize(8).fillColor(MUTED).text(DIMENSION_LABELS[r.config.dimension], M + 8, ty + 6, { width: firstW - 12 });
    metrics.forEach((m, i) =>
      doc.text(METRIC_FORMATS[m]!.label, M + firstW + i * colW, ty + 6, { width: colW - 8, align: "right" }),
    );
    return ty + rowH;
  };

  y += 6;
  if (y + rowH * 3 > bottom) {
    doc.addPage();
    y = M;
  }
  y = header(y);
  const all = [...r.rows, { key: "__total", label: "Total", values: r.totals } as (typeof r.rows)[number]];
  all.forEach((row, idx) => {
    if (y + rowH > bottom) {
      doc.addPage();
      y = header(M);
    }
    const total = row.key === "__total";
    if (total) doc.rect(M, y, inner, rowH).fill("#f9fafb");
    else if (idx % 2 === 1) doc.rect(M, y, inner, rowH).fill("#fcfcfd");
    const label = row.platform && r.config.dimension === "campaign" ? `${row.label}  ·  ${PLATFORM_INFO[row.platform as Platform]?.name ?? ""}` : row.label;
    doc.font(total ? "B" : "R").fontSize(8).fillColor(INK).text(label, M + 8, y + 6, { width: firstW - 12, height: 10, ellipsis: true, lineBreak: false });
    metrics.forEach((m, i) =>
      doc.font(total ? "B" : "R").text(fmt(m, row.values[m], r.currency), M + firstW + i * colW, y + 6, { width: colW - 8, align: "right", lineBreak: false }),
    );
    doc.moveTo(M, y + rowH).lineTo(W - M, y + rowH).lineWidth(0.5).strokeColor(LINE).stroke();
    y += rowH;
  });

  // ── Footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Writing inside the bottom margin would otherwise make pdfkit add a page.
    doc.page.margins.bottom = 0;
    const fy = doc.page.height - 34;
    const left = r.branding.footer ?? `Prepared by ${r.branding.name}`;
    doc.font("R").fontSize(7).fillColor(MUTED);
    doc.text(left, M, fy, { width: inner * 0.7, lineBreak: false });
    doc.text(`Generated ${r.generatedAt.slice(0, 10)} · Page ${i + 1} of ${range.count}`, M, fy, { width: inner, align: "right", lineBreak: false });
  }

  doc.end();
  return done;
}
