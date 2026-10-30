/**
 * Number formatting shared by the web app, PDFs and emails.
 * Pass the workspace currency everywhere: INR workspaces get Indian grouping
 * (12,34,567 · 1.2L · 3.2Cr); every other currency gets international grouping
 * (1,234,567 · 1.2M · 3.2B). The INR default only exists for older callers.
 */

/** The number locale for a currency (or an explicit locale, which wins). */
export const localeFor = (currency: string, locale?: string) => locale ?? (currency === "INR" ? "en-IN" : "en-US");

const cache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions) {
  const key = locale + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}

/** ₹3,19,196 or $12,340.50 */
export function money(value: number | null | undefined, currency = "INR", opts: { decimals?: number } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  const decimals = opts.decimals ?? (Math.abs(value) >= 1000 ? 0 : 2);
  return nf(localeFor(currency), {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** ₹31.9L, ₹3.2Cr (INR) or $1.2M */
export function moneyCompact(value: number | null | undefined, currency = "INR") {
  if (value == null || Number.isNaN(value)) return "—";
  if (Math.abs(value) < 100_000) return money(value, currency, { decimals: 0 });
  return nf(localeFor(currency), { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Counts: 12,34,568 (INR workspace) or 1,234,568 (others). */
export function number(value: number | null | undefined, opts: { decimals?: number; currency?: string; locale?: string } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  return nf(localeFor(opts.currency ?? "INR", opts.locale), { maximumFractionDigits: opts.decimals ?? 0 }).format(value);
}

/** 1.2L / 3.2Cr (INR workspace) or 1.2K / 1.2M / 3.2B (others). */
export function compact(value: number | null | undefined, currency = "INR", opts: { locale?: string } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  return nf(localeFor(currency, opts.locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** 0.0127 → "1.27%" */
export function percent(value: number | null | undefined, decimals = 2) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(decimals)}%`;
}

/** 4.12 → "4.12×" */
export function multiple(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toFixed(2)}×`;
}

/** "OUTCOME_SALES" → "Sales", "PERFORMANCE_MAX" → "Performance Max" */
export function humanize(value: string | null | undefined) {
  if (!value) return "—";
  return value
    .replace(/^OUTCOME_/, "")
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface MetricFormat {
  /** `currency` is the workspace currency: it picks the symbol for money and the grouping for counts. */
  label: string;
  format: (v: number | null, currency: string) => string;
  short: (v: number | null, currency: string) => string;
}

export const METRIC_FORMATS: Record<string, MetricFormat> = {
  spend: { label: "Spend", format: (v, c) => money(v, c), short: (v, c) => moneyCompact(v, c) },
  impressions: { label: "Impressions", format: (v, c) => number(v, { currency: c }), short: (v, c) => compact(v, c) },
  clicks: { label: "Clicks", format: (v, c) => number(v, { currency: c }), short: (v, c) => compact(v, c) },
  ctr: { label: "CTR", format: (v) => percent(v), short: (v) => percent(v) },
  cpc: { label: "CPC", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 2 }) },
  cpm: { label: "CPM", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 0 }) },
  conversions: { label: "Conversions", format: (v, c) => number(v, { decimals: 1, currency: c }), short: (v, c) => compact(v, c) },
  conversionValue: { label: "Revenue", format: (v, c) => money(v, c), short: (v, c) => moneyCompact(v, c) },
  cpa: { label: "Cost / conv.", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 0 }) },
  roas: { label: "ROAS", format: (v) => multiple(v), short: (v) => multiple(v) },
  conversionRate: { label: "Conv. rate", format: (v) => percent(v), short: (v) => percent(v) },
  videoViews: { label: "Video views", format: (v, c) => number(v, { currency: c }), short: (v, c) => compact(v, c) },
};

/** How workspace-level money was converted from each ad account's own currency. */
export interface FxInfo {
  /**
   * "none": every account already bills in `currency`.
   * "converted": other currencies were converted at daily rates.
   * "unavailable": no rate was known, so amounts are summed unconverted.
   */
  conversion: "none" | "converted" | "unavailable";
  /** The workspace currency the totals are in */
  currency: string;
  /** Ad account currencies that differ from `currency` */
  from: string[];
  /** Where the rates come from */
  source: "ECB";
}

/** A one-line note for screens and PDFs, or null when nothing was converted. */
export function fxNote(fx: FxInfo | null | undefined): string | null {
  if (!fx || fx.conversion === "none") return null;
  if (fx.conversion === "converted") return `Converted to ${fx.currency} at daily ECB rates (from ${fx.from.join(", ")}).`;
  return `Exchange rates are unavailable right now, so ${[...fx.from, fx.currency].join(" and ")} amounts are added up unconverted.`;
}
