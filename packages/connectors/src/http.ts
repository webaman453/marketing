import { ConnectorError, type ConnectorErrorCode } from "./errors";

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Encode body as application/x-www-form-urlencoded instead of JSON. */
  form?: boolean;
  timeoutMs?: number;
}

/**
 * Small fetch wrapper with timeouts and JSON handling. `mapError` turns a
 * platform-specific error payload into a ConnectorError.
 */
export async function requestJson<T>(
  url: string,
  opts: RequestOptions,
  mapError: (status: number, body: unknown) => ConnectorError,
): Promise<T> {
  return (await requestWithHeaders<T>(url, opts, mapError)).data;
}

/** Same as requestJson, plus the response headers (e.g. a Link header for paging). */
export async function requestWithHeaders<T>(
  url: string,
  opts: RequestOptions,
  mapError: (status: number, body: unknown) => ConnectorError,
): Promise<{ data: T; headers: Headers }> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = formBody(opts.body as Record<string, unknown>);
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
  }

  let res: Response;
  try {
    res = await fetch(u, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new ConnectorError("PLATFORM_ERROR", `Network error calling ${u.hostname}`, String(err));
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) throw mapError(res.status, json);
  return { data: json as T, headers: res.headers };
}

/** Form-encodes a body, leaving out undefined/null keys (URLSearchParams would send "undefined"). */
export function formBody(body: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  return params.toString();
}

/** The rel="next" URL of a Link header, if any. */
export function nextLink(header: string | null) {
  for (const part of (header ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** Page limit for list calls; an account past this fails the sync instead of looking smaller than it is. */
export const MAX_PAGES = 100;

/**
 * Follows a list to its last page. `fetchPage` gets the cursor (token, offset,
 * URL…) and returns its rows plus the next cursor, or null on the last page.
 */
export async function allPages<T, C>(first: C, fetchPage: (cursor: C) => Promise<{ items: T[]; next: C | null | undefined }>, what = "list"): Promise<T[]> {
  const out: T[] = [];
  let cursor: C = first;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, next } = await fetchPage(cursor);
    out.push(...items);
    if (next == null || next === "" || items.length === 0) return out;
    cursor = next;
  }
  throw new ConnectorError("PLATFORM_ERROR", `The ${what} has more than ${MAX_PAGES} pages; stopped so a partial list is not saved as the whole account.`);
}

export function codeFromStatus(status: number): ConnectorErrorCode {
  if (status === 401) return "AUTH_EXPIRED";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 400 && status < 500) return "INVALID_REQUEST";
  return "PLATFORM_ERROR";
}

/** Currencies the ad platforms express without a minor unit (no cents). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY", "KRW", "VND", "CLP", "ISK", "PYG", "TWD", "HUF", "COP", "IDR",
]);
