/**
 * One MSW server for every connector unit test. Each test file calls
 * `useMswServer()` once; tests add per-platform handlers with `server.use(...)`
 * (see ./handlers/*). Any request without a handler fails the test, so platform
 * HTTP never leaves the machine.
 *
 * Every request is recorded (method, URL, headers, raw + parsed body) so tests
 * can assert on exactly what a connector sent.
 */
import { afterAll, afterEach, beforeAll } from "vitest";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export { HttpResponse, http };

export const server = setupServer();

export interface Hit {
  method: string;
  url: URL;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or null. */
  json: any;
  /** Parsed form body (application/x-www-form-urlencoded), or null. */
  form: URLSearchParams | null;
}

const pending: Promise<Hit>[] = [];

async function toHit(request: Request): Promise<Hit> {
  const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const type = request.headers.get("content-type") ?? "";
  let json: unknown = null;
  if (text && !type.includes("x-www-form-urlencoded") && !type.includes("multipart")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
    text,
    json,
    form: type.includes("x-www-form-urlencoded") ? new URLSearchParams(text) : null,
  };
}

server.events.on("request:start", (event: { request: Request }) => {
  const r = event.request;
  // A streamed multipart upload whose handler answers before reading the body ends with
  // "Premature close": upload handlers must read the body (request.formData()) first.
  pending.push(toHit(r.clone()).catch(() => ({ method: r.method, url: new URL(r.url), headers: r.headers, text: "", json: null, form: null })));
});

/** Every request seen so far in this test, optionally filtered. */
export async function hits(filter?: { method?: string; path?: string | RegExp; host?: string }): Promise<Hit[]> {
  const all = await Promise.all(pending);
  return all.filter((h) => {
    if (filter?.method && h.method !== filter.method) return false;
    if (filter?.host && h.url.hostname !== filter.host) return false;
    if (filter?.path instanceof RegExp && !filter.path.test(h.url.pathname)) return false;
    if (typeof filter?.path === "string" && !h.url.pathname.includes(filter.path)) return false;
    return true;
  });
}

/** The only request matching the filter; throws when there are none or several. */
export async function onlyHit(filter: Parameters<typeof hits>[0]): Promise<Hit> {
  const list = await hits(filter);
  if (list.length !== 1) throw new Error(`Expected 1 request for ${JSON.stringify(filter)}, saw ${list.length}: ${list.map((h) => `${h.method} ${h.url}`).join(", ")}`);
  return list[0]!;
}

export function useMswServer() {
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => {
    server.resetHandlers();
    pending.length = 0;
  });
  afterAll(() => server.close());
}

/** JSON error response helper: `fail(401, { error: ... })`. */
export const fail = (status: number, body: unknown = { message: `error ${status}` }) => HttpResponse.json(body as never, { status });

/** Responds with the given status to every request on a host (used for error-mapping tables). */
export const failEverything = (status: number, body?: unknown) => http.all(/.*/, () => fail(status, body));
