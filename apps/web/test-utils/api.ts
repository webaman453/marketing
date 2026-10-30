/**
 * Routes a mocked `api()` to canned responses. In a test file:
 *
 *   vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn(), apiUpload: vi.fn() }));
 *   import { api } from "@/lib/api";
 *   routeApi(api, { "GET /orgs/org_1/platforms": [...], "POST /orgs/:id/connections/:p/authorize": () => ({ url }) });
 *
 * Keys are "METHOD /path" (method defaults to GET when omitted) and may use
 * `:param` segments or `*` for the rest. A handler is a value or a function of
 * (opts, params); a thrown error (e.g. ApiError) rejects the call. Unmatched
 * calls reject so a missing canned response is loud.
 */
import type { Mock } from "vitest";

export type Opts = { method?: string; body?: unknown; query?: Record<string, unknown> } | undefined;
export type HandlerFn = (opts: Opts, params: Record<string, string>) => unknown;
/** A canned value, or a function computing one from the call. */
export type Handler = HandlerFn | object | string | number | boolean | null | undefined;

function compile(pattern: string) {
  const [maybeMethod, maybePath] = pattern.includes(" ") ? pattern.split(" ", 2) : ["GET", pattern];
  const names: string[] = [];
  const re = new RegExp(
    `^${maybePath!
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*|\*/g, ".*")
      .replace(/:(\w+)/g, (_, n: string) => {
        names.push(n);
        return "([^/]+)";
      })}$`,
  );
  return { method: maybeMethod!.toUpperCase(), re, names };
}

export function routeApi(apiMock: unknown, routes: Record<string, Handler>) {
  const compiled = Object.entries(routes).map(([k, h]) => ({ ...compile(k), h, key: k }));
  const calls: { method: string; path: string; opts: Opts }[] = [];
  (apiMock as Mock).mockImplementation(async (path: string, opts?: Opts) => {
    const method = (opts?.method ?? "GET").toUpperCase();
    calls.push({ method, path, opts });
    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]!]));
      const out = typeof r.h === "function" ? await (r.h as HandlerFn)(opts, params) : r.h;
      return structuredClone(out);
    }
    throw new Error(`No canned api() response for ${method} ${path}`);
  });
  return calls;
}

/** The calls a mocked api() received, as "METHOD /path". */
export const apiCalls = (apiMock: unknown) =>
  (apiMock as Mock).mock.calls.map(([path, opts]) => `${((opts as Opts)?.method ?? "GET").toUpperCase()} ${path as string}`);
