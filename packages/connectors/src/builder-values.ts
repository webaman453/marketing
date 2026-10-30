/** Typed readers for builder draft values, shared by every connector's createCampaign. */
import { listTexts, type KeywordValue, type PlacementsValue, type TargetingValue, type Values } from "@ashniva/shared";
import { ConnectorError } from "./errors";
import type { BuilderAsset } from "./types";

export const str = (v: Values, key: string) => (typeof v[key] === "string" ? (v[key] as string).trim() : "");
export const num = (v: Values, key: string) => {
  const n = typeof v[key] === "number" ? (v[key] as number) : v[key] == null || v[key] === "" ? NaN : Number(v[key]);
  return Number.isFinite(n) ? n : null;
};
export const bool = (v: Values, key: string) => v[key] === true;
export const strs = (v: Values, key: string) => (Array.isArray(v[key]) ? (v[key] as unknown[]).map(String).filter(Boolean) : []);
export const texts = (v: Values, key: string) => listTexts(v[key]).filter(Boolean);
/** Text list items with their pin position (Google/Microsoft RSA). */
export const pinned = (v: Values, key: string) =>
  (Array.isArray(v[key]) ? (v[key] as unknown[]) : [])
    .map((x) => (typeof x === "string" ? { text: x.trim(), pin: null } : { text: String((x as { text?: string }).text ?? "").trim(), pin: (x as { pin?: string | null }).pin ?? null }))
    .filter((x) => x.text);
export const targeting = (v: Values, key: string) => (Array.isArray(v[key]) ? (v[key] as TargetingValue[]) : []);
export const included = (v: Values, key: string) => targeting(v, key).filter((t) => !t.exclude);
export const excluded = (v: Values, key: string) => targeting(v, key).filter((t) => t.exclude);
export const keywords = (v: Values, key: string) => (Array.isArray(v[key]) ? (v[key] as KeywordValue[]) : []).filter((k) => k.text?.trim());
export const placements = (v: Values, key: string): PlacementsValue => {
  const p = v[key] as PlacementsValue | undefined;
  return p && (p.mode === "AUTO" || p.mode === "MANUAL") ? p : { mode: "AUTO", items: [] };
};
export const range = (v: Values, key: string) => (v[key] as { min: number; max: number } | undefined) ?? null;
export const repeater = (v: Values, key: string) => (Array.isArray(v[key]) ? (v[key] as Values[]) : []);

/** Country codes among the included locations. */
export const countryCodes = (v: Values, key = "locations") =>
  included(v, key)
    .filter((l) => (l.type ?? "country") === "country")
    .map((l) => l.id.toUpperCase());

/** Media assets referenced by a media field, in order. */
export function mediaOf(v: Values, key: string, assets: Map<string, BuilderAsset>): BuilderAsset[] {
  return strs(v, key)
    .map((id) => assets.get(id))
    .filter((a): a is BuilderAsset => Boolean(a));
}

export function requireMedia(v: Values, key: string, assets: Map<string, BuilderAsset>, what: string) {
  const list = mediaOf(v, key, assets);
  if (list.length === 0) throw new ConnectorError("INVALID_REQUEST", `${what} is missing.`);
  return list;
}

/**
 * "2026-10-08" or "2026-10-08T09:30" → Date in the SERVER's local zone (or null).
 * @deprecated Builder values are wall-clock times in the ad account's zone: use
 * instantOf() for timestamps and dayOf() for date-only APIs.
 */
export function dateOf(v: Values, key: string): Date | null {
  const s = str(v, key);
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The calendar day of a Date built by dateOf (local midnight), without a UTC shift. */
export const isoDate = (d: Date | null) =>
  d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null;

/** "2026-10-08" or "2026-10-08T09:30" → "2026-10-08", read straight from the string (no timezone math). */
export function dayOf(v: Values, key: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v, key));
  if (!m) return null;
  const [, y, mo, d] = m.map(Number) as [number, number, number, number];
  const check = new Date(Date.UTC(y, mo - 1, d));
  return check.getUTCMonth() === mo - 1 && check.getUTCDate() === d ? m[0] : null;
}

// ───────── Builder dates in the ad account's timezone ─────────
//
// Builder date fields hold "YYYY-MM-DD" and datetime fields "YYYY-MM-DDTHH:mm"
// with no offset: the wall-clock time the user means in the ad account's zone
// (the UI says "Times are in <zone>"). Never parse them with new Date(), which
// reads them in the server's zone (UTC in Docker).

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(timeZone: string) {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    zoneFormats.set(timeZone, f);
  }
  return f;
}

/** True for an IANA zone this runtime knows (e.g. "Asia/Kolkata"). */
export function isTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    zoneFormat(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The zone builder values are read in: the account's when valid, else UTC. */
export function builderZone(account?: { timezone?: string | null } | null): string {
  const tz = account?.timezone;
  return isTimeZone(tz) ? tz : "UTC";
}

/** How far `timeZone` is ahead of UTC at instant `t`, in ms (+19 800 000 for Asia/Kolkata). */
export function zoneOffsetMs(t: number, timeZone: string): number {
  const parts = Object.fromEntries(zoneFormat(timeZone).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(t / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in `timeZone`. Handles DST and :30/:45
 * offsets; a time skipped by a spring-forward gap moves forward by the gap
 * (02:30 → 03:30), and a repeated fall-back time takes its first occurrence.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Offsets either side of any transition near this time (zones change at most once a day).
  const before = zoneOffsetMs(wall - 86_400_000, timeZone);
  const after = zoneOffsetMs(wall + 86_400_000, timeZone);
  const valid = [wall - before, wall - after].filter((t) => wall - zoneOffsetMs(t, timeZone) === t);
  // Repeated (fall-back) time: the earlier instant. Skipped (spring-forward) time: read with the old offset, which lands after the gap.
  return new Date(valid.length ? Math.min(...valid) : wall - before);
}

/**
 * A builder date/datetime value as a UTC instant, reading it as wall-clock time
 * in `timeZone` (the ad account's; see builderZone). A date-only value means
 * the start of that day, or its last second (23:59:59) with edge "end". Values
 * that already carry an offset ("…Z", "…+05:30") are taken as they are.
 */
export function instantOf(v: Values, key: string, timeZone: string, edge: "start" | "end" = "start"): Date | null {
  const s = str(v, key);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (!m || !dayOf(v, key)) return null;
  if (m[7]) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const timed = m[4] != null;
  const [h, mi, sec] = timed ? [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)] : edge === "end" ? [23, 59, 59] : [0, 0, 0];
  if (h > 23 || mi > 59 || sec > 59) return null;
  return zonedTimeToUtc(y, mo, d, h, mi, sec, isTimeZone(timeZone) ? timeZone : "UTC");
}

/** The calendar day ("YYYY-MM-DD") of an instant in `timeZone`. */
export function dayIn(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(zoneFormat(isTimeZone(timeZone) ? timeZone : "UTC").formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Splits a budget entered once for the campaign across `parts` children
 * (ad sets, lines…), rounded down to cents so the total never goes over.
 */
export function splitBudget(amount: number, parts: number) {
  if (parts <= 1) return amount;
  return Math.floor((amount / parts) * 100 + 1e-9) / 100;
}

/** Appends URL parameters to a landing page. */
export function withParams(url: string, params: string) {
  if (!params.trim()) return url;
  return url + (url.includes("?") ? "&" : "?") + params.trim().replace(/^[?&]/, "");
}

/** Budget for a node: { amount, lifetime } or null when the node has none. */
export function budgetOf(v: Values, key = "budget") {
  const amount = num(v, key);
  if (amount == null || amount <= 0) return null;
  return { amount, lifetime: v[`${key}Type`] === "LIFETIME" || v[`${key}Type`] === "TOTAL" };
}

export const youtubeId = (url: string) => /(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/.exec(url)?.[1] ?? null;
