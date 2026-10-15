/** Number formatting shared by the web app, PDFs and emails. */

const localeFor = (currency: string) => (currency === "INR" ? "en-IN" : "en-US");

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

export function number(value: number | null | undefined, opts: { decimals?: number; currency?: string } = {}) {
  if (value == null || Number.isNaN(value)) return "—";
  return nf(localeFor(opts.currency ?? "INR"), { maximumFractionDigits: opts.decimals ?? 0 }).format(value);
}

export function compact(value: number | null | undefined, currency = "INR") {
  if (value == null || Number.isNaN(value)) return "—";
  return nf(localeFor(currency), { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
  label: string;
  format: (v: number | null, currency: string) => string;
  short: (v: number | null, currency: string) => string;
}

export const METRIC_FORMATS: Record<string, MetricFormat> = {
  spend: { label: "Spend", format: (v, c) => money(v, c), short: (v, c) => moneyCompact(v, c) },
  impressions: { label: "Impressions", format: (v) => number(v), short: (v) => compact(v) },
  clicks: { label: "Clicks", format: (v) => number(v), short: (v) => compact(v) },
  ctr: { label: "CTR", format: (v) => percent(v), short: (v) => percent(v) },
  cpc: { label: "CPC", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 2 }) },
  cpm: { label: "CPM", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 0 }) },
  conversions: { label: "Conversions", format: (v) => number(v, { decimals: 1 }), short: (v) => compact(v) },
  conversionValue: { label: "Revenue", format: (v, c) => money(v, c), short: (v, c) => moneyCompact(v, c) },
  cpa: { label: "Cost / conv.", format: (v, c) => money(v, c, { decimals: 2 }), short: (v, c) => money(v, c, { decimals: 0 }) },
  roas: { label: "ROAS", format: (v) => multiple(v), short: (v) => multiple(v) },
  conversionRate: { label: "Conv. rate", format: (v) => percent(v), short: (v) => percent(v) },
  videoViews: { label: "Video views", format: (v) => number(v), short: (v) => compact(v) },
};
