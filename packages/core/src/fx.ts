/**
 * Currency conversion for workspace-level totals.
 *
 * Rates are the European Central Bank's daily reference rates, read through the free
 * Frankfurter API (no key) and cached in `exchange_rates` (base EUR). A metric day uses
 * that day's rate, or the last one published before it (weekends and ECB holidays).
 * If the API can't be reached we fall back to the cache; with no usable rate at all the
 * converter reports "unavailable" so callers show amounts unconverted, never wrong.
 */
import { num, prisma, type Prisma } from "@ashniva/db";
import type { FxInfo, MetricTotals } from "@ashniva/shared";

export const FX_BASE = "EUR";
export const FX_SOURCE = "ECB" as const;
const DEFAULT_API = "https://api.frankfurter.dev/v2";
/** Days looked back for the "last published rate" (covers Easter and Christmas closures). */
const LOOKBACK_DAYS = 10;
const FETCH_TIMEOUT_MS = 5_000;
/** After a failed fetch, serve from the cache for this long before trying the network again. */
const RETRY_AFTER_MS = 5 * 60_000;

/** Currencies the ECB doesn't publish but that are fixed to one it does. */
const PEGS: Record<string, { anchor: string; rate: number }> = {
  // UAE dirham, pegged to the US dollar since 1997.
  AED: { anchor: "USD", rate: 3.6725 },
};

export interface RateRow {
  /** YYYY-MM-DD */
  date: string;
  /** 1 EUR = `rate` `quote` */
  quote: string;
  rate: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const shift = (day: string, days: number) => iso(new Date(toDate(day).getTime() + days * 86_400_000));
const dayOf = (d: Date | string) => (typeof d === "string" ? d.slice(0, 10) : iso(d));
const isWeekday = (day: string) => {
  const w = toDate(day).getUTCDay();
  return w !== 0 && w !== 6;
};

/** ECB quote needed to price `currency` against EUR (pegged currencies use their anchor). */
const ecbQuote = (currency: string) => PEGS[currency]?.anchor ?? currency;

/** Rates in memory: for each quote, its published days in order. Pure, so it's unit-tested directly. */
export class RateTable {
  private readonly byQuote = new Map<string, { dates: string[]; rates: number[] }>();

  constructor(rows: RateRow[]) {
    const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const r of sorted) {
      if (!(r.rate > 0)) continue;
      let s = this.byQuote.get(r.quote);
      if (!s) this.byQuote.set(r.quote, (s = { dates: [], rates: [] }));
      if (s.dates[s.dates.length - 1] === r.date) s.rates[s.rates.length - 1] = r.rate;
      else {
        s.dates.push(r.date);
        s.rates.push(r.rate);
      }
    }
  }

  get isEmpty() {
    return this.byQuote.size === 0;
  }

  /** The latest published (date, rate) on or before `day`, or null. */
  private lookup(quote: string, day: string): { date: string; rate: number } | null {
    const s = this.byQuote.get(quote);
    if (!s) return null;
    let lo = 0;
    let hi = s.dates.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.dates[mid]! <= day) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found < 0 ? null : { date: s.dates[found]!, rate: s.rates[found]! };
  }

  /** How many units of `currency` 1 EUR buys on `day`. */
  eurRate(currency: string, day: string): number | null {
    if (currency === FX_BASE) return 1;
    const peg = PEGS[currency];
    if (peg) {
      const anchor = this.eurRate(peg.anchor, day);
      return anchor == null ? null : anchor * peg.rate;
    }
    return this.lookup(currency, day)?.rate ?? null;
  }

  /** Units of `to` per unit of `from` on `day`; 1 for the same currency. */
  rate(from: string, to: string, day: string): number | null {
    if (from === to) return 1;
    const f = this.eurRate(from, day);
    const t = this.eurRate(to, day);
    return f == null || t == null ? null : t / f;
  }

  convert(amount: number, from: string, to: string, day: string): number | null {
    const r = this.rate(from, to, day);
    return r == null ? null : amount * r;
  }

  /** The day whose rates apply to `day`, i.e. the last published one on or before it. */
  effectiveDate(day: string, quote = "USD"): string | null {
    return this.lookup(ecbQuote(quote), day)?.date ?? null;
  }

  /** Every quote's rate effective on `day`. */
  ratesOn(day: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const q of this.byQuote.keys()) {
      const r = this.lookup(q, day);
      if (r) out[q] = r.rate;
    }
    for (const c of Object.keys(PEGS)) {
      const r = this.eurRate(c, day);
      if (r != null) out[c] = r;
    }
    return out;
  }
}

// ───────── Fetching ─────────

/** Base URL of the Frankfurter API. Tests run with no URL, so they never reach the network. */
function apiUrl(): string | null {
  const v = process.env.FX_API_URL;
  if (v !== undefined) return v.trim() ? v.trim().replace(/\/+$/, "") : null;
  return process.env.NODE_ENV === "test" ? null : DEFAULT_API;
}

/**
 * ECB rates for every published day in [from, to] (EUR base). Frankfurter also returns the
 * last published day before `from` when `from` itself has none.
 */
export async function fetchEcbRates(from: string, to: string): Promise<RateRow[]> {
  const base = apiUrl();
  if (!base) throw new Error("Exchange-rate fetching is disabled (FX_API_URL is empty)");
  const url = `${base}/rates?providers=${FX_SOURCE}&base=${FX_BASE}&from=${from}&to=${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Exchange rates: ${res.status} from ${base}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Exchange rates: unexpected response");
  const rows: RateRow[] = [];
  for (const r of body as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown }[]) {
    if (r.base !== FX_BASE || typeof r.quote !== "string" || r.quote === FX_BASE) continue;
    if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    const rate = Number(r.rate);
    if (Number.isFinite(rate) && rate > 0) rows.push({ date: r.date, quote: r.quote, rate });
  }
  return rows;
}

async function storeRates(rows: RateRow[]) {
  if (!rows.length) return;
  await prisma.exchangeRate.createMany({
    data: rows.map((r) => ({ date: toDate(r.date), base: FX_BASE, quote: r.quote, rate: r.rate })),
    skipDuplicates: true,
  });
}

/** Weekdays a fetch showed the ECB didn't publish (holidays), so we don't keep asking. */
const closedDays = new Set<string>();
let lastFailureAt = 0;

/** Test hook: forget fetch memos between tests. */
export function resetFxMemo() {
  closedDays.clear();
  lastFailureAt = 0;
}

/** Fetches any published days missing from the cache for [from, to]. Never throws. */
export async function ensureRates(from: string, to: string): Promise<void> {
  // Today's rate appears mid-afternoon CET, so only expect days up to yesterday.
  const end = [to, shift(iso(new Date()), -1)].sort()[0]!;
  const windowStart = shift(from, -LOOKBACK_DAYS);
  if (end < windowStart) return;
  const stored = await prisma.exchangeRate.findMany({
    where: { base: FX_BASE, date: { gte: toDate(windowStart), lte: toDate(end) } },
    distinct: ["date"],
    select: { date: true },
  });
  const have = new Set(stored.map((s) => iso(s.date)));

  const missing: string[] = [];
  // Something on or before `from` to carry forward.
  if (![...have].some((d) => d <= from)) missing.push(from < end ? from : end);
  for (let d = from > windowStart ? from : windowStart; d <= end; d = shift(d, 1)) {
    if (isWeekday(d) && !have.has(d) && !closedDays.has(d)) missing.push(d);
  }
  if (!missing.length) return;
  if (Date.now() - lastFailureAt < RETRY_AFTER_MS) return;

  missing.sort();
  const fetchFrom = missing[0]!;
  const fetchTo = missing[missing.length - 1]!;
  try {
    const rows = await fetchEcbRates(fetchFrom, fetchTo);
    await storeRates(rows);
    const published = new Set(rows.map((r) => r.date));
    for (let d = fetchFrom; d <= fetchTo; d = shift(d, 1)) if (isWeekday(d) && !published.has(d)) closedDays.add(d);
  } catch (err) {
    lastFailureAt = Date.now();
    console.warn(`[fx] couldn't fetch rates for ${fetchFrom}..${fetchTo}; using cached rates`, err instanceof Error ? err.message : err);
  }
}

/**
 * Rates covering [from, to] for the given currencies, from the cache (topped up from the API
 * when days are missing). Each quote also gets its last cached rate before the window, which
 * is the fallback when the API is down.
 */
export async function loadRates(currencies: string[], from: string, to: string): Promise<RateTable> {
  const quotes = [...new Set(currencies.map(ecbQuote))].filter((c) => c !== FX_BASE);
  if (!quotes.length) return new RateTable([]);
  await ensureRates(from, to);
  const windowStart = shift(from, -LOOKBACK_DAYS);
  const rows = await prisma.exchangeRate.findMany({
    where: { base: FX_BASE, quote: { in: quotes }, date: { gte: toDate(windowStart), lte: toDate(to) } },
    select: { date: true, quote: true, rate: true },
  });
  const toRow = (r: { date: Date; quote: string; rate: Prisma.Decimal }): RateRow => ({ date: iso(r.date), quote: r.quote, rate: num(r.rate) });
  const out = rows.map(toRow);
  const covered = new Set(out.filter((r) => r.date <= from).map((r) => r.quote));
  const older = await Promise.all(
    quotes
      .filter((q) => !covered.has(q))
      .map((q) =>
        prisma.exchangeRate.findFirst({
          where: { base: FX_BASE, quote: q, date: { lt: toDate(windowStart) } },
          orderBy: { date: "desc" },
          select: { date: true, quote: true, rate: true },
        }),
      ),
  );
  for (const r of older) if (r) out.push(toRow(r));
  return new RateTable(out);
}

/** Rates (1 EUR = x) effective on `date`, or null when nothing is known for that day. */
export async function getRates(date: string | Date): Promise<{ date: string; base: string; rates: Record<string, number> } | null> {
  const day = dayOf(date);
  const quotes = await prisma.exchangeRate.findMany({ where: { base: FX_BASE }, distinct: ["quote"], select: { quote: true } });
  const table = await loadRates([...new Set([...quotes.map((q) => q.quote), "USD", "INR"])], day, day);
  const rates = table.ratesOn(day);
  const effective = table.effectiveDate(day);
  return effective && Object.keys(rates).length ? { date: effective, base: FX_BASE, rates } : null;
}

/** `amount` in `from` converted to `to` at `date`'s rate; null when no rate is known. */
export async function convert(amount: number, from: string, to: string, date: string | Date): Promise<number | null> {
  if (from === to) return amount;
  const day = dayOf(date);
  const table = await loadRates([from, to], day, day);
  return table.convert(amount, from, to, day);
}

/** Refreshes the last `days` of rates; the worker runs this a few times a day. */
export async function refreshRates(days = 7): Promise<{ stored: number }> {
  const to = iso(new Date());
  const rows = await fetchEcbRates(shift(to, -days), to);
  await storeRates(rows);
  return { stored: rows.length };
}

// ───────── Converting metrics into a workspace currency ─────────

/**
 * One request's converter: built once (one rates load), then used synchronously for every
 * row. When any source currency has no rate the whole context is "unavailable" and every
 * factor is 1, so totals are honest raw sums flagged as unconverted rather than half-converted.
 */
export interface FxContext {
  currency: string;
  info: FxInfo;
  /** Multiplier from `currency` into the context currency on `day`. */
  factor(currency: string, day: Date | string): number;
  /** Multiplier for an ad account's amounts on `day`. */
  accountFactor(adAccountId: string, day: Date | string): number;
  /** True when this account's amounts are being converted. */
  converts(adAccountId: string): boolean;
}

export async function fxContext(
  target: string,
  accounts: { id: string; currency: string }[],
  range: { from: string; to: string },
): Promise<FxContext> {
  const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
  const sources = [...new Set(accounts.map((a) => a.currency))].filter((c) => c !== target).sort();
  if (!sources.length) {
    const info: FxInfo = { conversion: "none", currency: target, from: [], source: FX_SOURCE };
    return { currency: target, info, factor: () => 1, accountFactor: () => 1, converts: () => false };
  }
  const table = await loadRates([...sources, target], range.from, range.to);
  // Rates carry forward, so a rate on the first day means every later day has one too.
  const ok = sources.every((c) => table.rate(c, target, range.from) != null);
  const info: FxInfo = { conversion: ok ? "converted" : "unavailable", currency: target, from: sources, source: FX_SOURCE };
  if (!ok) return { currency: target, info, factor: () => 1, accountFactor: () => 1, converts: () => false };

  const memo = new Map<string, number>();
  const factor = (currency: string, day: Date | string) => {
    if (currency === target) return 1;
    const d = dayOf(day);
    const key = `${currency}|${d}`;
    let f = memo.get(key);
    if (f === undefined) {
      f = table.rate(currency, target, d) ?? 1;
      memo.set(key, f);
    }
    return f;
  };
  return {
    currency: target,
    info,
    factor,
    accountFactor: (id, day) => factor(currencyOf.get(id) ?? target, day),
    converts: (id) => (currencyOf.get(id) ?? target) !== target,
  };
}

/** Money fields scaled by `f`; counts are untouched. */
export function scaleMoney<T extends MetricTotals>(t: T, f: number): T {
  return f === 1 ? t : { ...t, spend: t.spend * f, conversionValue: t.conversionValue * f };
}

export function addTotals(a: MetricTotals, b: MetricTotals): MetricTotals {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    spend: a.spend + b.spend,
    conversions: a.conversions + b.conversions,
    conversionValue: a.conversionValue + b.conversionValue,
    videoViews: a.videoViews + b.videoViews,
  };
}

/** Rounds converted money to cents so float noise never shows. */
export function roundMoney<T extends MetricTotals>(t: T): T {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { ...t, spend: r(t.spend), conversionValue: r(t.conversionValue) };
}
