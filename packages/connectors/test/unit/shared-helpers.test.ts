import { describe, expect, it } from "vitest";
import { ConnectorError, isConnectorError, noRowsUnlessFatal } from "../../src/errors";
import { allPages, codeFromStatus, formBody, MAX_PAGES, nextLink, requestJson, requestWithHeaders } from "../../src/http";
import {
  bool,
  budgetOf,
  countryCodes,
  dateOf,
  dayOf,
  excluded,
  included,
  isoDate,
  keywords,
  mediaOf,
  num,
  pinned,
  placements,
  range,
  repeater,
  requireMedia,
  splitBudget,
  str,
  strs,
  texts,
  withParams,
  youtubeId,
} from "../../src/builder-values";
import { apiError, authHeader, CLIENT_REFRESH, formToken, mapStatus, pkce, requireCredentials, selfRedirect } from "../../src/oauth-flow";
import { accountTree, removalAllowed } from "../../src/tree";
import { createConnectorRegistry } from "../../src/index";
import { fail, hits, http, HttpResponse, onlyHit, server, useMswServer } from "../msw/server";
import { assetsOf, imageAsset } from "../msw/drafts";
import { STATUS_CODES } from "../msw/fixtures";

useMswServer();

const API = "https://api.example.test";
const mapErr = (status: number, body: unknown) => new ConnectorError(codeFromStatus(status), `err ${status}`, body);

describe("http.requestJson", () => {
  it("sends JSON bodies with Accept/Content-Type and drops undefined query values", async () => {
    server.use(http.post(`${API}/things`, () => HttpResponse.json({ ok: true })));
    const out = await requestJson<{ ok: boolean }>(`${API}/things`, { method: "POST", query: { a: 1, b: undefined, c: "x y" }, body: { n: 2 }, headers: { "X-Key": "k" } }, mapErr);
    expect(out).toEqual({ ok: true });
    const h = await onlyHit({ path: "/things" });
    expect(h.url.searchParams.get("a")).toBe("1");
    expect(h.url.searchParams.has("b")).toBe(false);
    expect(h.url.searchParams.get("c")).toBe("x y");
    expect(h.headers.get("content-type")).toBe("application/json");
    expect(h.headers.get("accept")).toBe("application/json");
    expect(h.headers.get("x-key")).toBe("k");
    expect(h.json).toEqual({ n: 2 });
  });

  it("form-encodes bodies with form:true and never sends 'undefined' or 'null'", async () => {
    server.use(http.post(`${API}/token`, () => HttpResponse.json({ access_token: "t" })));
    await requestJson(`${API}/token`, { method: "POST", form: true, body: { grant_type: "refresh_token", scope: undefined, extra: null, n: 0 } }, mapErr);
    const h = await onlyHit({ path: "/token" });
    expect(h.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(h.text).toBe("grant_type=refresh_token&n=0");
    expect(h.text).not.toMatch(/undefined|null/);
  });

  it("defaults to GET with no body", async () => {
    server.use(http.get(`${API}/x`, () => HttpResponse.json([1])));
    expect(await requestJson(`${API}/x`, {}, mapErr)).toEqual([1]);
    const h = await onlyHit({ path: "/x" });
    expect(h.method).toBe("GET");
    expect(h.headers.get("content-type")).toBeNull();
  });

  it("returns non-JSON text as a string and empty bodies as null", async () => {
    server.use(
      http.get(`${API}/text`, () => new HttpResponse("plain", { status: 200 })),
      http.delete(`${API}/empty`, () => new HttpResponse(null, { status: 204 })),
    );
    expect(await requestJson(`${API}/text`, {}, mapErr)).toBe("plain");
    expect(await requestJson(`${API}/empty`, { method: "DELETE" }, mapErr)).toBeNull();
  });

  it.each(STATUS_CODES)("maps HTTP %i through mapError to %s with the parsed body", async (status, code) => {
    server.use(http.get(`${API}/fail`, () => fail(status, { reason: "nope" })));
    const err = await requestJson(`${API}/fail`, {}, mapErr).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe(code);
    expect(err.details).toEqual({ reason: "nope" });
  });

  it("turns a network failure into a retryable PLATFORM_ERROR naming the host", async () => {
    server.use(http.get(`${API}/down`, () => HttpResponse.error()));
    const err = await requestJson(`${API}/down`, {}, mapErr).catch((e) => e);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("api.example.test");
  });

  it("requestWithHeaders exposes response headers", async () => {
    server.use(http.get(`${API}/h`, () => HttpResponse.json({}, { headers: { Link: `<${API}/h?page=2>; rel="next"` } })));
    const { headers } = await requestWithHeaders(`${API}/h`, {}, mapErr);
    expect(nextLink(headers.get("link"))).toBe(`${API}/h?page=2`);
  });
});

describe("http helpers", () => {
  it("formBody skips undefined and null but keeps falsy values", () => {
    expect(formBody({ a: undefined, b: null, c: 0, d: false, e: "", f: "x" })).toBe("c=0&d=false&e=&f=x");
  });

  it("nextLink finds rel=next among several links and returns null otherwise", () => {
    expect(nextLink(`<https://a/1>; rel="prev", <https://a/3>; rel="next"`)).toBe("https://a/3");
    expect(nextLink(`<https://a/3>; rel=next`)).toBe("https://a/3");
    expect(nextLink(`<https://a/1>; rel="prev"`)).toBeNull();
    expect(nextLink(null)).toBeNull();
  });

  it("codeFromStatus maps the status families", () => {
    expect(codeFromStatus(401)).toBe("AUTH_EXPIRED");
    expect(codeFromStatus(403)).toBe("PERMISSION_DENIED");
    expect(codeFromStatus(429)).toBe("RATE_LIMITED");
    expect(codeFromStatus(404)).toBe("INVALID_REQUEST");
    expect(codeFromStatus(502)).toBe("PLATFORM_ERROR");
  });

  it("allPages follows cursors to the last page", async () => {
    const pages: Record<string, { items: number[]; next: string | null }> = { a: { items: [1, 2], next: "b" }, b: { items: [3], next: "c" }, c: { items: [4], next: null } };
    const seen: string[] = [];
    expect(await allPages("a", async (c) => (seen.push(c), pages[c]!))).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("allPages stops on an empty page or empty cursor", async () => {
    expect(await allPages(0, async (n) => ({ items: n < 2 ? [n] : [], next: n + 1 }))).toEqual([0, 1]);
    expect(await allPages("x", async () => ({ items: [1], next: "" }))).toEqual([1]);
  });

  it("allPages throws instead of returning a partial list past MAX_PAGES", async () => {
    let calls = 0;
    const err = await allPages(0, async (n) => (calls++, { items: [n], next: n + 1 }), "campaign list").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.code).toBe("PLATFORM_ERROR");
    expect(err.message).toContain("campaign list");
    expect(calls).toBe(MAX_PAGES);
  });

  it("allPages propagates a page error (no silent empty list)", async () => {
    const err = await allPages(0, async (n) => {
      if (n === 1) throw new ConnectorError("AUTH_EXPIRED", "expired");
      return { items: [n], next: n + 1 };
    }).catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
  });
});

describe("errors", () => {
  it("retryable only for RATE_LIMITED and PLATFORM_ERROR", () => {
    expect(new ConnectorError("RATE_LIMITED", "").retryable).toBe(true);
    expect(new ConnectorError("PLATFORM_ERROR", "").retryable).toBe(true);
    for (const c of ["AUTH_EXPIRED", "PERMISSION_DENIED", "INVALID_REQUEST", "UNSUPPORTED", "NOT_CONFIGURED"] as const) expect(new ConnectorError(c, "").retryable).toBe(false);
    expect(isConnectorError(new ConnectorError("UNSUPPORTED", "x"))).toBe(true);
    expect(isConnectorError(new Error("x"))).toBe(false);
    expect(new ConnectorError("UNSUPPORTED", "x").name).toBe("ConnectorError");
  });

  it("noRowsUnlessFatal swallows report-shape errors only", () => {
    expect(noRowsUnlessFatal(new ConnectorError("INVALID_REQUEST", ""))).toEqual([]);
    expect(noRowsUnlessFatal(new ConnectorError("UNSUPPORTED", ""))).toEqual([]);
    for (const c of ["AUTH_EXPIRED", "PERMISSION_DENIED", "RATE_LIMITED", "PLATFORM_ERROR"] as const) {
      expect(() => noRowsUnlessFatal(new ConnectorError(c, ""))).toThrow(ConnectorError);
    }
    expect(() => noRowsUnlessFatal(new TypeError("boom"))).toThrow(TypeError);
  });
});

describe("builder-values", () => {
  it("str/num/bool/strs read typed values defensively", () => {
    const v = { s: "  hi ", n: 5, ns: "7.5", bad: "abc", empty: "", t: true, tt: "true", list: ["a", "", 3] };
    expect(str(v, "s")).toBe("hi");
    expect(str(v, "n")).toBe("");
    expect(num(v, "n")).toBe(5);
    expect(num(v, "ns")).toBe(7.5);
    expect(num(v, "bad")).toBeNull();
    expect(num(v, "empty")).toBeNull();
    expect(num(v, "missing")).toBeNull();
    expect(bool(v, "t")).toBe(true);
    expect(bool(v, "tt")).toBe(false);
    expect(strs(v, "list")).toEqual(["a", "3"]);
    expect(strs(v, "s")).toEqual([]);
  });

  it("texts, pinned, targeting, keywords, placements, range, repeater", () => {
    const v = {
      headlines: ["One", "", "Two"],
      rsa: ["Plain", { text: " Pinned ", pin: "HEADLINE_1" }, { text: "" }],
      locs: [{ id: "in", name: "India", type: "country" }, { id: "us", name: "US", exclude: true }, { id: "123", name: "Delhi", type: "city" }],
      kws: [{ text: "saree", matchType: "EXACT" }, { text: "  ", matchType: "BROAD" }],
      pl: { mode: "MANUAL", items: ["feed"] },
      badPl: { mode: "WHAT" },
      age: { min: 18, max: 34 },
      rows: [{ a: 1 }],
    };
    expect(texts(v, "headlines")).toEqual(["One", "Two"]);
    expect(pinned(v, "rsa")).toEqual([{ text: "Plain", pin: null }, { text: "Pinned", pin: "HEADLINE_1" }]);
    expect(included(v, "locs").map((l) => l.id)).toEqual(["in", "123"]);
    expect(excluded(v, "locs").map((l) => l.id)).toEqual(["us"]);
    expect(countryCodes(v, "locs")).toEqual(["IN"]);
    expect(keywords(v, "kws")).toHaveLength(1);
    expect(placements(v, "pl")).toEqual({ mode: "MANUAL", items: ["feed"] });
    expect(placements(v, "badPl")).toEqual({ mode: "AUTO", items: [] });
    expect(range(v, "age")).toEqual({ min: 18, max: 34 });
    expect(range(v, "none")).toBeNull();
    expect(repeater(v, "rows")).toEqual([{ a: 1 }]);
    expect(repeater(v, "age")).toEqual([]);
  });

  it("mediaOf keeps order and skips unknown ids; requireMedia throws INVALID_REQUEST when empty", () => {
    const assets = assetsOf(imageAsset("a"), imageAsset("b"));
    expect(mediaOf({ m: ["b", "zzz", "a"] }, "m", assets).map((a) => a.creativeId)).toEqual(["b", "a"]);
    expect(() => requireMedia({ m: [] }, "m", assets, "Ad image")).toThrow(/Ad image is missing/);
    try {
      requireMedia({}, "m", assets, "Video");
    } catch (e) {
      expect((e as ConnectorError).code).toBe("INVALID_REQUEST");
    }
  });

  it("dayOf reads the calendar day straight from the string, whatever the process timezone", () => {
    expect(dayOf({ d: "2026-10-08" }, "d")).toBe("2026-10-08");
    expect(dayOf({ d: "2026-10-08T23:30" }, "d")).toBe("2026-10-08");
    expect(dayOf({ d: "2026-10-08T00:15:00+05:30" }, "d")).toBe("2026-10-08");
    expect(dayOf({ d: "2026-02-30" }, "d")).toBeNull();
    expect(dayOf({ d: "2026-13-01" }, "d")).toBeNull();
    expect(dayOf({ d: "" }, "d")).toBeNull();
    expect(dayOf({}, "d")).toBeNull();
  });

  it("dateOf builds local midnight for a bare date and isoDate gives the same calendar day back", () => {
    for (const day of ["2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31"]) {
      const d = dateOf({ d: day }, "d");
      expect(d).not.toBeNull();
      expect(d!.getHours()).toBe(0);
      expect(isoDate(d)).toBe(day);
    }
    expect(isoDate(dateOf({ d: "2026-10-08T23:30" }, "d"))).toBe("2026-10-08");
    expect(dateOf({ d: "not a date" }, "d")).toBeNull();
    expect(dateOf({}, "d")).toBeNull();
    expect(isoDate(null)).toBeNull();
  });

  it("splitBudget rounds each part down to cents so the total never goes over", () => {
    expect(splitBudget(100, 1)).toBe(100);
    expect(splitBudget(100, 0)).toBe(100);
    expect(splitBudget(100, 3)).toBe(33.33);
    expect(splitBudget(10, 4)).toBe(2.5);
    expect(splitBudget(0.05, 2)).toBe(0.02);
    for (const [amount, parts] of [[100, 3], [99.99, 7], [12.34, 5], [1, 3]] as const) {
      expect(splitBudget(amount, parts) * parts).toBeLessThanOrEqual(amount + 1e-9);
    }
    expect(splitBudget(0.3, 3)).toBe(0.1);
  });

  it("budgetOf returns null for missing/zero/negative budgets and reads LIFETIME/TOTAL", () => {
    expect(budgetOf({})).toBeNull();
    expect(budgetOf({ budget: 0 })).toBeNull();
    expect(budgetOf({ budget: -5 })).toBeNull();
    expect(budgetOf({ budget: "abc" })).toBeNull();
    expect(budgetOf({ budget: 50 })).toEqual({ amount: 50, lifetime: false });
    expect(budgetOf({ budget: "50", budgetType: "DAILY" })).toEqual({ amount: 50, lifetime: false });
    expect(budgetOf({ budget: 50, budgetType: "LIFETIME" })).toEqual({ amount: 50, lifetime: true });
    expect(budgetOf({ cap: 9, capType: "TOTAL" }, "cap")).toEqual({ amount: 9, lifetime: true });
  });

  it("withParams appends tracking parameters with the right separator", () => {
    expect(withParams("https://a.com/p", "")).toBe("https://a.com/p");
    expect(withParams("https://a.com/p", "utm_source=x")).toBe("https://a.com/p?utm_source=x");
    expect(withParams("https://a.com/p?a=1", "?utm_source=x")).toBe("https://a.com/p?a=1&utm_source=x");
    expect(withParams("https://a.com/p", " &b=2 ")).toBe("https://a.com/p?b=2");
  });

  it("youtubeId understands watch, short, shorts and embed links", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeId("https://youtube.com/shorts/abcdef123")).toBe("abcdef123");
    expect(youtubeId("https://www.youtube.com/embed/abcdef123")).toBe("abcdef123");
    expect(youtubeId("https://vimeo.com/123")).toBeNull();
  });
});

describe("oauth-flow", () => {
  it("apiError picks the most specific message from common error payload shapes", () => {
    const m = apiError("Test");
    expect(m(400, { error_description: "bad grant", error: "invalid_grant" }).message).toBe("bad grant");
    expect(m(400, { error: "invalid_client" }).message).toBe("invalid_client");
    expect(m(400, { error: { error_user_msg: "user msg", message: "dev msg" } }).message).toBe("user msg");
    expect(m(400, { error: { message: "dev msg" } }).message).toBe("dev msg");
    expect(m(400, { errors: [{ message: "first" }] }).message).toBe("first");
    expect(m(400, { message: "top" }).message).toBe("top");
    expect(m(502, null).message).toBe("Test error (502)");
    expect(m(401, {}).code).toBe("AUTH_EXPIRED");
    expect(m(429, {}).code).toBe("RATE_LIMITED");
  });

  it("formToken posts a form body and computes expiresAt from expires_in", async () => {
    const before = Date.now();
    server.use(http.post("https://auth.example.test/token", () => HttpResponse.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "read write,admin" })));
    const t = await formToken("https://auth.example.test/token", { grant_type: "authorization_code", code: "c" }, { Authorization: "Basic xyz" });
    expect(t.accessToken).toBe("a");
    expect(t.refreshToken).toBe("r");
    expect(t.scopes).toEqual(["read", "write", "admin"]);
    const ms = t.expiresAt!.getTime() - before;
    expect(ms).toBeGreaterThanOrEqual(3600_000);
    expect(ms).toBeLessThan(3600_000 + 5_000);
    const h = await onlyHit({ path: "/token" });
    expect(h.form?.get("grant_type")).toBe("authorization_code");
    expect(h.headers.get("authorization")).toBe("Basic xyz");
  });

  it("formToken leaves expiresAt undefined without expires_in and maps OAuth errors", async () => {
    server.use(http.post("https://auth.example.test/token", () => HttpResponse.json({ access_token: "a" })));
    const t = await formToken("https://auth.example.test/token", {});
    expect(t.expiresAt).toBeUndefined();
    expect(t.scopes).toEqual([]);
    server.use(http.post("https://auth.example.test/token", () => fail(401, { error: "invalid_client", error_description: "Client authentication failed" })));
    const err = await formToken("https://auth.example.test/token", {}).catch((e) => e);
    expect(err.code).toBe("AUTH_EXPIRED");
    expect(err.message).toBe("Client authentication failed");
  });

  it("selfRedirect sends the browser back to our callback with code and state", () => {
    const u = new URL(selfRedirect("https://app.test/cb?x=1", "st"));
    expect(u.searchParams.get("code")).toBe(CLIENT_REFRESH);
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("x")).toBe("1");
    expect(new URL(selfRedirect("https://app.test/cb", "st", "saved")).searchParams.get("code")).toBe("saved");
  });

  it("pkce is deterministic per state and the challenge is S256(verifier)", async () => {
    const { createHash } = await import("node:crypto");
    const a = pkce("secret", "state-1");
    expect(pkce("secret", "state-1")).toEqual(a);
    expect(pkce("secret", "state-2").verifier).not.toBe(a.verifier);
    expect(a.challenge).toBe(createHash("sha256").update(a.verifier).digest("base64url"));
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mapStatus normalizes platform statuses", () => {
    expect(mapStatus("enabled")).toBe("ACTIVE");
    expect(mapStatus("RUNNING")).toBe("ACTIVE");
    expect(mapStatus("ARCHIVED")).toBe("ARCHIVED");
    expect(mapStatus("deleted")).toBe("REMOVED");
    expect(mapStatus("COMPLETED")).toBe("REMOVED");
    expect(mapStatus("PAUSED")).toBe("PAUSED");
    expect(mapStatus(undefined)).toBe("PAUSED");
    expect(mapStatus("LIVE", ["LIVE"])).toBe("ACTIVE");
    expect(mapStatus("ACTIVE", ["LIVE"])).toBe("PAUSED");
  });

  it("authHeader builds a bearer header with extras", () => {
    expect(authHeader("t", { "X-A": "1" })).toEqual({ Authorization: "Bearer t", "X-A": "1" });
  });

  it("requireCredentials trims every field and names the first missing one", () => {
    expect(requireCredentials("TRADEDESK", { apiToken: " tok ", partnerId: "p1 " })).toEqual({ apiToken: "tok", partnerId: "p1" });
    const err = (() => {
      try {
        requireCredentials("TRADEDESK", { apiToken: "tok", partnerId: "  " });
      } catch (e) {
        return e as ConnectorError;
      }
    })();
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(err?.message).toMatch(/Partner ID/);
    expect(requireCredentials("META", { anything: "x" })).toEqual({});
  });
});

describe("tree", () => {
  it("removalAllowed refuses to remove everything on an empty response for an account with campaigns", () => {
    expect(removalAllowed(0, 5)).toBe(false);
    expect(removalAllowed(0, 0)).toBe(true);
    expect(removalAllowed(3, 5)).toBe(true);
  });

  it("accountTree links groups and ads to the campaign", () => {
    const t = accountTree({
      campaign: { id: "c1", name: "C", status: "PAUSED", objective: "TRAFFIC", daily: 10 },
      groups: [{ id: "g1", name: "G", status: "PAUSED", key: "gk" }],
      ads: [{ id: "a1", groupId: "g1", name: "A", status: "PAUSED", key: "ak", url: "https://x" }],
    });
    expect(t.campaigns[0]).toMatchObject({ externalId: "c1", dailyBudget: 10, lifetimeBudget: null, startDate: null });
    expect(t.adGroups[0]).toMatchObject({ campaignExternalId: "c1", sourceKey: "gk", dailyBudget: null });
    expect(t.ads[0]).toMatchObject({ adGroupExternalId: "g1", campaignExternalId: "c1", sourceKey: "ak", finalUrl: "https://x" });
  });
});

describe("registry", () => {
  const blank = new Proxy({}, { get: () => ({}) }) as never;

  it("knows every live platform, hands out demo connectors and rejects unsupported ones", () => {
    const r = createConnectorRegistry(blank);
    expect(r.livePlatforms()).toEqual(expect.arrayContaining(["META", "GOOGLE", "LINKEDIN", "MICROSOFT", "SNAPCHAT", "PINTEREST", "AMAZON", "X", "APPLE", "SPOTIFY", "CRITEO", "TABOOLA", "OUTBRAIN", "TRADEDESK", "YAHOO", "SHOPIFY"]));
    expect(r.get("META", "DEMO")).toBe(r.get("META", "DEMO"));
    expect(r.get("META", "DEMO").platform).toBe("META");
    expect(() => r.get("NAUKRI" as never)).toThrow(/coming soon/);
    expect(r.isConfigured("NAUKRI" as never)).toBe(false);
    expect(r.isConfigured("META")).toBe(false);
  });
});

it("records requests across tests independently", async () => {
  expect(await hits()).toEqual([]);
});
