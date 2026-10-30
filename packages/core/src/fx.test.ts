import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for the exchange_rates table, covering the queries fx.ts makes. */
type Row = { date: Date; base: string; quote: string; rate: number };
const table: Row[] = [];
type DateFilter = { gte?: Date; lte?: Date; lt?: Date };
type Where = { base?: string; quote?: string | { in: string[] }; date?: DateFilter };
const matches = (r: Row, w: Where) =>
  (w.base === undefined || r.base === w.base) &&
  (w.quote === undefined || (typeof w.quote === "string" ? r.quote === w.quote : w.quote.in.includes(r.quote))) &&
  (!w.date?.gte || r.date >= w.date.gte) &&
  (!w.date?.lte || r.date <= w.date.lte) &&
  (!w.date?.lt || r.date < w.date.lt);

vi.mock("@ashniva/db", () => ({
  num: (v: number | { toNumber(): number } | null | undefined) => (v == null ? 0 : typeof v === "number" ? v : v.toNumber()),
  prisma: {
    exchangeRate: {
      findMany: async ({ where, distinct }: { where: Where; distinct?: ("date" | "quote")[] }) => {
        const rows = table.filter((r) => matches(r, where));
        if (!distinct) return rows;
        const seen = new Set<string>();
        return rows.filter((r) => {
          const k = distinct.map((d) => (d === "date" ? r.date.toISOString() : r.quote)).join("|");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      },
      findFirst: async ({ where }: { where: Where }) =>
        table.filter((r) => matches(r, where)).sort((a, b) => b.date.getTime() - a.date.getTime())[0] ?? null,
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) {
          if (!table.some((r) => r.base === d.base && r.quote === d.quote && r.date.getTime() === d.date.getTime())) table.push({ ...d });
        }
        return { count: data.length };
      },
    },
  },
}));

const fx = await import("./fx");
const { RateTable, convert, fetchEcbRates, fxContext, getRates, resetFxMemo, scaleMoney } = fx;

const seed = (date: string, rates: Record<string, number>) => {
  for (const [quote, rate] of Object.entries(rates)) table.push({ date: new Date(`${date}T00:00:00Z`), base: "EUR", quote, rate });
};
const apiRows = (date: string, rates: Record<string, number>) => Object.entries(rates).map(([quote, rate]) => ({ date, base: "EUR", quote, rate }));
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const FX_API_URL = process.env.FX_API_URL;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  table.length = 0;
  resetFxMemo();
  // Pretend it's Wednesday 28 Oct 2026, so "yesterday" is the 27th.
  vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z"), toFake: ["Date"] });
  fetchMock = vi.fn(async () => {
    throw new Error("network is off in unit tests");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (FX_API_URL === undefined) delete process.env.FX_API_URL;
  else process.env.FX_API_URL = FX_API_URL;
});

describe("RateTable", () => {
  const t = new RateTable([
    { date: "2026-10-23", quote: "USD", rate: 1.12 },
    { date: "2026-10-23", quote: "INR", rate: 106.4 },
    { date: "2026-10-26", quote: "USD", rate: 1.1 },
    { date: "2026-10-26", quote: "INR", rate: 110 },
  ]);

  it("same currency needs no rate", () => {
    expect(t.rate("JPY", "JPY", "2020-01-01")).toBe(1);
    expect(t.convert(42, "INR", "INR", "1999-01-01")).toBe(42);
  });

  it("cross-converts through EUR", () => {
    expect(t.convert(110, "INR", "USD", "2026-10-26")).toBeCloseTo(1.1, 10);
    expect(t.convert(1.1, "USD", "INR", "2026-10-26")).toBeCloseTo(110, 10);
    expect(t.convert(1, "EUR", "USD", "2026-10-26")).toBe(1.1);
    expect(t.convert(1.12, "USD", "EUR", "2026-10-23")).toBeCloseTo(1, 10);
  });

  it("weekends and holidays use the last published rate", () => {
    // Saturday 24 and Sunday 25 Oct fall back to Friday 23rd.
    expect(t.rate("INR", "USD", "2026-10-24")).toBeCloseTo(1.12 / 106.4, 12);
    expect(t.rate("INR", "USD", "2026-10-25")).toBeCloseTo(1.12 / 106.4, 12);
    expect(t.effectiveDate("2026-10-25")).toBe("2026-10-23");
    // Days after the last published one keep using it.
    expect(t.rate("INR", "USD", "2026-11-30")).toBeCloseTo(0.01, 12);
  });

  it("returns null when no rate is known on or before the day", () => {
    expect(t.rate("INR", "USD", "2026-10-22")).toBeNull();
    expect(t.convert(100, "GBP", "USD", "2026-10-26")).toBeNull();
    expect(new RateTable([]).convert(1, "INR", "USD", "2026-10-26")).toBeNull();
  });

  it("prices the dirham through its US dollar peg", () => {
    expect(t.rate("USD", "AED", "2026-10-26")).toBeCloseTo(3.6725, 10);
    expect(t.convert(3672.5, "AED", "INR", "2026-10-26")).toBeCloseTo(100_000, 6);
  });
});

describe("fetchEcbRates", () => {
  it("reads Frankfurter v2 ECB rows", async () => {
    process.env.FX_API_URL = "https://fx.example.test/v2/";
    fetchMock.mockResolvedValueOnce(jsonResponse([...apiRows("2026-10-23", { USD: 1.1193, INR: 106.272, EUR: 1 }), { date: "bad", base: "EUR", quote: "GBP", rate: 1 }]));
    const rows = await fetchEcbRates("2026-10-24", "2026-10-25");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://fx.example.test/v2/rates?providers=ECB&base=EUR&from=2026-10-24&to=2026-10-25",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(rows).toEqual([
      { date: "2026-10-23", quote: "USD", rate: 1.1193 },
      { date: "2026-10-23", quote: "INR", rate: 106.272 },
    ]);
  });

  it("never touches the network in tests unless a URL is configured", async () => {
    delete process.env.FX_API_URL;
    await expect(fetchEcbRates("2026-10-01", "2026-10-02")).rejects.toThrow(/disabled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on an HTTP error", async () => {
    process.env.FX_API_URL = "https://fx.example.test/v2";
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 503));
    await expect(fetchEcbRates("2026-10-01", "2026-10-02")).rejects.toThrow(/503/);
  });
});

describe("cached conversion", () => {
  it("fetches missing days once, stores them and converts per day", async () => {
    process.env.FX_API_URL = "https://fx.example.test/v2";
    fetchMock.mockResolvedValue(
      jsonResponse([...apiRows("2026-10-23", { USD: 1.12, INR: 112 }), ...apiRows("2026-10-26", { USD: 1.1, INR: 110 }), ...apiRows("2026-10-27", { USD: 1.1, INR: 121 })]),
    );
    expect(await convert(1120, "INR", "USD", "2026-10-25")).toBeCloseTo(11.2, 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(table.length).toBe(6);
    // Now cached: no second request.
    expect(await convert(1210, "INR", "USD", "2026-10-27")).toBeCloseTo(11, 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the most recent cached rate when the API is down", async () => {
    process.env.FX_API_URL = "https://fx.example.test/v2";
    seed("2026-09-30", { USD: 1.2, INR: 100 });
    expect(await convert(100, "INR", "USD", "2026-10-26")).toBeCloseTo(1.2, 10);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns null when nothing is cached and nothing can be fetched", async () => {
    expect(await convert(100, "INR", "USD", "2026-10-26")).toBeNull();
    expect(await convert(100, "USD", "USD", "2026-10-26")).toBe(100);
    expect(await getRates("2026-10-26")).toBeNull();
  });

  it("getRates returns the rates effective that day", async () => {
    seed("2026-10-23", { USD: 1.12, INR: 106.4 });
    expect(await getRates("2026-10-25")).toEqual({ date: "2026-10-23", base: "EUR", rates: { USD: 1.12, INR: 106.4, AED: 1.12 * 3.6725 } });
  });
});

describe("fxContext", () => {
  const accounts = [
    { id: "a-usd", currency: "USD" },
    { id: "a-inr", currency: "INR" },
  ];

  it("needs no rates when every account is in the workspace currency", async () => {
    const ctx = await fxContext("USD", [accounts[0]!], { from: "2026-10-01", to: "2026-10-27" });
    expect(ctx.info).toEqual({ conversion: "none", currency: "USD", from: [], source: "ECB" });
    expect(ctx.accountFactor("a-usd", "2026-10-05")).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("converts each day at its own rate", async () => {
    seed("2026-10-16", { USD: 1, INR: 100 });
    seed("2026-10-23", { USD: 1, INR: 100 });
    seed("2026-10-26", { USD: 1, INR: 80 });
    const ctx = await fxContext("USD", accounts, { from: "2026-10-23", to: "2026-10-26" });
    expect(ctx.info.conversion).toBe("converted");
    expect(ctx.info.from).toEqual(["INR"]);
    expect(ctx.converts("a-inr")).toBe(true);
    expect(ctx.converts("a-usd")).toBe(false);
    expect(ctx.accountFactor("a-inr", "2026-10-25")).toBeCloseTo(0.01, 12);
    expect(ctx.accountFactor("a-inr", new Date("2026-10-26T00:00:00Z"))).toBeCloseTo(0.0125, 12);
    const t = { impressions: 1000, clicks: 10, spend: 8000, conversions: 2, conversionValue: 16000, videoViews: 0 };
    expect(scaleMoney(t, ctx.accountFactor("a-inr", "2026-10-26"))).toEqual({ ...t, spend: 100, conversionValue: 200 });
  });

  it("flags 'unavailable' and leaves amounts as they are when a rate is missing", async () => {
    const ctx = await fxContext("USD", accounts, { from: "2026-10-23", to: "2026-10-26" });
    expect(ctx.info).toEqual({ conversion: "unavailable", currency: "USD", from: ["INR"], source: "ECB" });
    expect(ctx.accountFactor("a-inr", "2026-10-25")).toBe(1);
    expect(ctx.converts("a-inr")).toBe(false);
  });
});
