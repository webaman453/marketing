import type { ApiErrorBody, BuilderIssue } from "@ashniva/shared";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
    /** Campaign builder problems (code DRAFT_INVALID) */
    public readonly issues?: BuilderIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
}

/** Endpoints where a 401 means "wrong credentials", not "session expired". */
const NO_REFRESH = new Set(["/auth/login", "/auth/register", "/auth/refresh", "/auth/logout", "/auth/invitations/accept"]);

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, shared by every request that hit a 401 concurrently. */
function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function buildUrl(path: string, query?: Query) {
  const url = `/api${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function send(path: string, opts: RequestOptions) {
  return fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    credentials: "include",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
}

/**
 * Typed fetch for the Ashniva API. Transparently refreshes the session once
 * on 401, and sends the user to sign-in if that fails.
 */
export async function api<T = void>(path: string, opts: RequestOptions = {}): Promise<T> {
  let res = await send(path, opts);

  if (res.status === 401 && !NO_REFRESH.has(path)) {
    if (await refreshSession()) {
      res = await send(path, opts);
    } else if (typeof window !== "undefined") {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      // Plain module (no router here); a full navigation also drops stale client state.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/login?next=${next}`);
    }
  }

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? "Something went wrong. Please try again.",
      err?.details,
      err?.issues,
    );
  }
  return data as T;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong. Please try again.";

/** Multipart upload (files) with the same session refresh and error handling as `api`. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const send = () => fetch(`/api${path}`, { method: "POST", credentials: "include", body: form });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? "UNKNOWN", err?.message ?? "Upload failed. Please try again.", err?.details);
  }
  return data as T;
}
