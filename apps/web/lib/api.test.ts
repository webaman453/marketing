import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError, api, apiUpload, errorMessage } from "./api";

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api()", () => {
  let fetchMock: MockInstance<typeof fetch>;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, pathname: "/w/ws_1/leads", search: "?platform=META", assign },
    });
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it("builds /api URLs, drops empty query values and sends JSON bodies", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    const out = await api<{ ok: boolean }>("/things", { method: "POST", body: { a: 1 }, query: { q: "x y", empty: "", none: null, n: 0, b: false } });
    expect(out).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/things?q=x+y&n=0&b=false");
    expect(init).toMatchObject({ method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
  });

  it("omits the query string and headers when there is nothing to send", async () => {
    fetchMock.mockResolvedValueOnce(json(200, []));
    await api("/list", { query: { a: undefined } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/list");
    expect((init as RequestInit).headers).toBeUndefined();
    expect((init as RequestInit).method).toBe("GET");
  });

  it("returns undefined for 204", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api("/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("parses API errors into ApiError with code, details and builder issues", async () => {
    fetchMock.mockResolvedValueOnce(
      json(422, {
        error: {
          code: "DRAFT_INVALID",
          message: "Fix the draft",
          details: { name: ["Too short"] },
          issues: [{ level: "campaign", field: "name", message: "Campaign name is required." }],
        },
      }),
    );
    const err = (await api("/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
    expect(err.status).toBe(422);
    expect(err.code).toBe("DRAFT_INVALID");
    expect(err.message).toBe("Fix the draft");
    expect(err.details).toEqual({ name: ["Too short"] });
    expect(err.issues).toHaveLength(1);
  });

  it("falls back to a generic error when the body isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    const err = (await api("/x").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toBe("Something went wrong. Please try again.");
  });

  it("refreshes the session once on 401 and retries the request", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHORIZED", message: "Expired" } }))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(200, { id: 1 }));
    await expect(api("/me")).resolves.toEqual({ id: 1 });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/me", "/api/auth/refresh", "/api/me"]);
    expect(assign).not.toHaveBeenCalled();
  });

  it("shares one refresh between concurrent 401s", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/auth/refresh") return new Promise<Response>((r) => (release = r));
      const n = fetchMock.mock.calls.filter((c) => c[0] === url).length;
      return n === 1 ? json(401, {}) : json(200, { url });
    });
    const both = Promise.all([api("/a"), api("/b")]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release(json(200, {}));
    await expect(both).resolves.toEqual([{ url: "/api/a" }, { url: "/api/b" }]);
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/auth/refresh")).toHaveLength(1);
  });

  it("sends people to sign-in with ?next= when the refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(401, {}));
    await expect(api("/me")).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/w/ws_1/leads?platform=META")}`);
  });

  it("does not try to refresh on a failed login", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { code: "INVALID_CREDENTIALS", message: "Wrong email or password" } }));
    await expect(api("/auth/login", { method: "POST", body: {} })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("errorMessage reads Error messages and falls back otherwise", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("nope")).toBe("Something went wrong. Please try again.");
  });
});

describe("apiUpload()", () => {
  let fetchMock: MockInstance<typeof fetch>;
  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchMock.mockRestore());

  it("posts the form and returns JSON", async () => {
    fetchMock.mockResolvedValueOnce(json(201, [{ id: "c1" }]));
    const form = new FormData();
    await expect(apiUpload("/workspaces/ws/creatives", form)).resolves.toEqual([{ id: "c1" }]);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces/ws/creatives");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(form);
  });

  it("retries after a refresh and reports upload errors", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, {}))
      .mockResolvedValueOnce(json(413, { error: { code: "TOO_LARGE", message: "File too large" } }));
    await expect(apiUpload("/u", new FormData())).rejects.toMatchObject({ status: 413, code: "TOO_LARGE", message: "File too large" });
  });

  it("uses the upload fallback message", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x", { status: 500 }));
    await expect(apiUpload("/u", new FormData())).rejects.toMatchObject({ message: "Upload failed. Please try again." });
  });
});
