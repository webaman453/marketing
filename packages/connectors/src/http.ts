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
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.body as Record<string, string>).toString();
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
  return json as T;
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
