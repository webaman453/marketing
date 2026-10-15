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

/** "2026-10-08" or "2026-10-08T09:30" → Date (or null). */
export function dateOf(v: Values, key: string): Date | null {
  const s = str(v, key);
  if (!s) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

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
