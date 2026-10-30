/**
 * The Leads page's filters, kept in the URL so a filtered view can be shared or bookmarked:
 * /w/:id/leads?platform=META&status=NEW&hasPhone=true&sort=cost&range=7d
 */
import { LEAD_SORTS, LEAD_STATUSES, type LeadSort, type LeadStatus } from "@ashniva/shared";
import type { RangePreset } from "@/lib/date-range";
import type { LeadFilters } from "@/lib/queries";

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export const SORT_LABELS: Record<LeadSort, string> = { newest: "Newest first", oldest: "Oldest first", campaign: "Campaign (A–Z)", cost: "Highest est. cost" };

export interface LeadViewFilters {
  source?: string;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  formId?: string;
  status?: LeadStatus;
  hasPhone?: "true" | "false";
  hasEmail?: "true" | "false";
  origin?: "paid" | "organic";
  search: string;
  sort: LeadSort;
  page: number;
  pageSize: number;
}

export const EMPTY_FILTERS: LeadViewFilters = { search: "", sort: "newest", page: 1, pageSize: DEFAULT_PAGE_SIZE };

/** Filters that narrow the list (not sort or paging), in the order they appear in a URL. */
const NARROWING = ["source", "campaignId", "adGroupId", "adId", "formId", "status", "hasPhone", "hasEmail", "origin"] as const;

const oneOf = <T extends string>(list: readonly T[], v: string | null): T | undefined => (v && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const idParam = (v: string | null) => (v && v.trim() && v.length <= 100 ? v.trim() : undefined);

/** Reads filters from the page's query string; anything unknown or malformed is ignored. */
export function filtersFromParams(params: URLSearchParams): LeadViewFilters {
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));
  return {
    source: idParam(params.get("source")),
    campaignId: idParam(params.get("campaignId")),
    adGroupId: idParam(params.get("adGroupId")),
    adId: idParam(params.get("adId")),
    formId: idParam(params.get("formId")),
    status: oneOf(LEAD_STATUSES, params.get("status")),
    hasPhone: oneOf(["true", "false"], params.get("hasPhone")),
    hasEmail: oneOf(["true", "false"], params.get("hasEmail")),
    origin: oneOf(["paid", "organic"], params.get("origin")),
    search: (params.get("search") ?? "").slice(0, 100),
    sort: oneOf(LEAD_SORTS, params.get("sort")) ?? "newest",
    page: Number.isInteger(page) && page > 1 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE,
  };
}

/** The query string for a view: only what differs from the defaults, after `base` (platform, date range). */
export function filtersToParams(f: LeadViewFilters, base: Record<string, string> = {}): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of NARROWING) if (f[k]) out.set(k, f[k]!);
  if (f.search.trim()) out.set("search", f.search.trim());
  if (f.sort !== "newest") out.set("sort", f.sort);
  if (f.pageSize !== DEFAULT_PAGE_SIZE) out.set("pageSize", String(f.pageSize));
  if (f.page > 1) out.set("page", String(f.page));
  return out;
}

/** How many narrowing filters are on (search included), for "Clear filters". */
export const activeFilterCount = (f: LeadViewFilters) => NARROWING.filter((k) => f[k]).length + (f.search.trim() ? 1 : 0);

/** The filters as the leads API takes them. */
export function apiFilters(f: LeadViewFilters): Omit<LeadFilters, "platform"> {
  const { search, ...rest } = f;
  return { ...rest, search: search.trim() || undefined };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PRESETS: readonly Exclude<RangePreset, "custom">[] = ["today", "7d", "14d", "30d", "90d", "mtd", "last_month"];

/** A date range named in the URL: a preset (`range=7d`) or fixed days (`from=…&to=…`). */
export function rangeFromParams(params: URLSearchParams): { preset: Exclude<RangePreset, "custom"> } | { from: string; to: string } | null {
  const preset = oneOf(PRESETS, params.get("range"));
  if (preset) return { preset };
  const from = params.get("from");
  const to = params.get("to");
  if (from && to && ISO.test(from) && ISO.test(to) && from <= to) return { from, to };
  return null;
}

/** The URL form of the current date range. */
export const rangeParams = (r: { preset: RangePreset; from: string; to: string }): Record<string, string> =>
  r.preset === "custom" ? { from: r.from, to: r.to } : { range: r.preset };
