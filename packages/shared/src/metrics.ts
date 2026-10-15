/** Raw additive metrics as stored per day. */
export interface MetricTotals {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  videoViews: number;
}

/** Ratios computed from additive totals. Null when the denominator is zero. */
export interface DerivedMetrics {
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cpa: number | null;
  roas: number | null;
  conversionRate: number | null;
}

export type MetricSet = MetricTotals & DerivedMetrics;

export const emptyTotals = (): MetricTotals => ({
  impressions: 0,
  clicks: 0,
  spend: 0,
  conversions: 0,
  conversionValue: 0,
  videoViews: 0,
});

const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

export function deriveMetrics(t: MetricTotals): MetricSet {
  return {
    ...t,
    ctr: ratio(t.clicks, t.impressions),
    cpc: ratio(t.spend, t.clicks),
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
    cpa: ratio(t.spend, t.conversions),
    roas: ratio(t.conversionValue, t.spend),
    conversionRate: ratio(t.conversions, t.clicks),
  };
}

export function addTotals(a: MetricTotals, b: Partial<MetricTotals>): MetricTotals {
  return {
    impressions: a.impressions + (b.impressions ?? 0),
    clicks: a.clicks + (b.clicks ?? 0),
    spend: a.spend + (b.spend ?? 0),
    conversions: a.conversions + (b.conversions ?? 0),
    conversionValue: a.conversionValue + (b.conversionValue ?? 0),
    videoViews: a.videoViews + (b.videoViews ?? 0),
  };
}

/** Relative change from previous to current, e.g. 0.12 = +12%. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

export type MetricKey = keyof MetricSet;

/** Metrics where a lower value is better. Used to color trend indicators. */
export const LOWER_IS_BETTER: ReadonlySet<MetricKey> = new Set(["cpc", "cpm", "cpa"]);
