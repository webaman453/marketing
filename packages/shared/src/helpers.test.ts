/** Small shared helpers: metrics, dates, reports, rules, notifications, builder common/geo/preview/drafts, AI. */
import { describe, expect, it } from "vitest";
import { AI_FEATURES, AI_TOKEN_PACKS, aiPackById } from "./ai";
import { adGroupIs, adIs, all, any, budgetFields, campaignIs, ctaLabel, ctaOptions, launchSection, lifetimeNeedsEnd, locationsField, not, opts, scheduleFields, setupIs, urlField } from "./builder/common";
import { draftSchema } from "./builder/drafts";
import { COUNTRIES, LANGUAGES, countryName, languageName } from "./builder/geo";
import { emptyContext } from "./builder/engine";
import { displayDomain } from "./builder/preview";
import { addDays, daysBetween, eachDay, parseISODate, previousPeriod, toISODate } from "./dates";
import { LOWER_IS_BETTER, addTotals, deriveMetrics, emptyTotals, percentChange } from "./metrics";
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_PREFS, notificationPrefsSchema } from "./notifications";
import { reportScheduleSchema, reportSchema, resolveReportPreset } from "./reports";
import { RULE_TEMPLATES, compare, ruleSchema } from "./rules";

describe("metrics", () => {
  it("derives ratios and returns null on zero denominators", () => {
    const m = deriveMetrics({ impressions: 1000, clicks: 50, spend: 250, conversions: 5, conversionValue: 1000, videoViews: 0 });
    expect(m).toMatchObject({ ctr: 0.05, cpc: 5, cpm: 250, cpa: 50, roas: 4, conversionRate: 0.1 });
    expect(deriveMetrics(emptyTotals())).toMatchObject({ ctr: null, cpc: null, cpm: null, cpa: null, roas: null, conversionRate: null });
  });
  it("adds partial totals", () => {
    expect(addTotals({ ...emptyTotals(), spend: 1 }, { spend: 2, clicks: 3 })).toEqual({ ...emptyTotals(), spend: 3, clicks: 3 });
  });
  it("percentChange", () => {
    expect(percentChange(112, 100)).toBeCloseTo(0.12);
    expect(percentChange(-50, -100)).toBeCloseTo(0.5);
    expect(percentChange(1, 0)).toBeNull();
    expect(percentChange(null, 1)).toBeNull();
    expect(percentChange(1, null)).toBeNull();
  });
  it("cost metrics are lower-is-better", () => {
    expect([...LOWER_IS_BETTER].sort()).toEqual(["cpa", "cpc", "cpm"]);
  });
});

describe("dates", () => {
  it("adds days across month and year boundaries in UTC", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(toISODate(parseISODate("2026-10-30"))).toBe("2026-10-30");
  });
  it("counts days inclusively and lists them", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(31);
    expect(daysBetween("2026-10-01", "2026-10-01")).toBe(1);
    expect(eachDay("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(eachDay("2026-10-02", "2026-10-01")).toEqual([]);
  });
  it("previous period has the same length and ends the day before", () => {
    expect(previousPeriod("2026-10-08", "2026-10-14")).toEqual({ from: "2026-10-01", to: "2026-10-07" });
  });
});

describe("reports", () => {
  it.each([
    ["7d", "2026-10-24", "2026-10-30"],
    ["14d", "2026-10-17", "2026-10-30"],
    ["30d", "2026-10-01", "2026-10-30"],
    ["90d", "2026-08-02", "2026-10-30"],
    ["mtd", "2026-10-01", "2026-10-30"],
    ["last_month", "2026-09-01", "2026-09-30"],
  ] as const)("%s ending 2026-10-30", (preset, from, to) => {
    expect(resolveReportPreset(preset, "2026-10-30")).toEqual({ from, to });
  });
  it("last month in January is December", () => {
    expect(resolveReportPreset("last_month", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("report schema defaults and limits", () => {
    const r = reportSchema.parse({ name: "Weekly", config: { metrics: ["spend"] } });
    expect(r.config).toMatchObject({ dimension: "campaign", datePreset: "30d", compare: true, chartMetric: "spend", platforms: [] });
    expect(r.description).toBeNull();
    expect(reportSchema.safeParse({ name: "Weekly", config: { metrics: [] } }).success).toBe(false);
  });
  it("a schedule needs recipients unless it's off", () => {
    expect(reportScheduleSchema.safeParse({ frequency: "WEEKLY" }).success).toBe(false);
    expect(reportScheduleSchema.safeParse({ frequency: "WEEKLY", recipients: ["a@b.co"] }).success).toBe(true);
    expect(reportScheduleSchema.parse({ frequency: null })).toMatchObject({ hour: 9, dayOfWeek: 1, dayOfMonth: 1, recipients: [] });
    expect(reportScheduleSchema.safeParse({ frequency: "MONTHLY", recipients: ["x"], dayOfMonth: 29 }).success).toBe(false);
  });
});

describe("rules", () => {
  it("compare", () => {
    expect(compare(5, "gt", 4)).toBe(true);
    expect(compare(4, "gt", 4)).toBe(false);
    expect(compare(4, "gte", 4)).toBe(true);
    expect(compare(3, "lt", 4)).toBe(true);
    expect(compare(4, "lte", 4)).toBe(true);
    expect(compare(null, "lt", 4)).toBe(false);
  });
  const base = { name: "Pause losers", scope: {}, conditions: [{ metric: "cpa", operator: "gt", value: 500 }], actions: [{ type: "PAUSE" }] };
  it("applies defaults", () => {
    expect(ruleSchema.parse(base)).toMatchObject({ isActive: true, conditionLogic: "ALL", lookbackDays: 3, frequency: "DAILY", cooldownHours: 24, scope: { platforms: [], campaignIds: [], minSpend: 0 } });
  });
  it("budget actions need a percentage; can't pause and activate", () => {
    expect(ruleSchema.safeParse({ ...base, actions: [{ type: "INCREASE_BUDGET" }] }).error!.issues[0]!.message).toBe("Budget actions need a percentage");
    expect(ruleSchema.safeParse({ ...base, actions: [{ type: "DECREASE_BUDGET", percent: 10 }] }).success).toBe(true);
    expect(ruleSchema.safeParse({ ...base, actions: [{ type: "PAUSE" }, { type: "ACTIVATE" }] }).error!.issues[0]!.message).toBe("A rule can't both pause and activate");
    expect(ruleSchema.safeParse({ ...base, conditions: [] }).success).toBe(false);
  });
  it("every template is a valid rule", () => {
    for (const t of RULE_TEMPLATES) expect(ruleSchema.safeParse({ ...t.rule, name: t.name }).success, t.name).toBe(true);
  });
});

describe("notifications", () => {
  it("defaults are valid and cover every preference", () => {
    expect(notificationPrefsSchema.parse(DEFAULT_NOTIFICATION_PREFS)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(Object.keys(DEFAULT_NOTIFICATION_PREFS).sort()).toEqual(NOTIFICATION_PREFS.map((p) => p.key).sort());
  });
});

describe("AI catalogue", () => {
  it("finds packs by id", () => {
    expect(aiPackById("pack_2m")).toMatchObject({ tokens: 2_000_000, popular: true });
    expect(aiPackById("nope")).toBeUndefined();
    expect(AI_TOKEN_PACKS.length).toBeGreaterThan(0);
    expect(Object.keys(AI_FEATURES)).toContain("builder.fill");
  });
});

describe("builder common helpers", () => {
  const ctx = { ...emptyContext(), setup: { o: "A" }, campaign: { c: "B", t: true }, adGroup: { g: "C" }, ad: { a: "D" } };
  it("conditions", () => {
    expect(setupIs("o", "A", "Z")(ctx)).toBe(true);
    expect(setupIs("missing", "")(ctx)).toBe(true);
    expect(campaignIs("c", "X")(ctx)).toBe(false);
    expect(campaignIs("t", "true")(ctx)).toBe(true);
    expect(adGroupIs("g", "C")(ctx)).toBe(true);
    expect(adIs("a", "D")(ctx)).toBe(true);
    expect(not(adIs("a", "D"))(ctx)).toBe(false);
    expect(all(setupIs("o", "A"), adIs("a", "D"))(ctx)).toBe(true);
    expect(all(setupIs("o", "A"), adIs("a", "X"))(ctx)).toBe(false);
    expect(any(setupIs("o", "X"), adIs("a", "D"))(ctx)).toBe(true);
    expect(any()(ctx)).toBe(false);
    expect(lifetimeNeedsEnd({ ...emptyContext(), adGroup: { budgetType: "LIFETIME" } })).toBe(true);
    expect(lifetimeNeedsEnd({ ...emptyContext(), campaign: { budgetType: "DAILY" } })).toBe(false);
  });
  it("CTA labels", () => {
    expect(ctaLabel("SHOP_NOW")).toBe("Shop now");
    expect(ctaLabel("INSTALL_MOBILE_APP")).toBe("Install now");
    expect(ctaLabel("REQUEST_A_DEMO_NOW")).toBe("Request a demo now");
    expect(ctaOptions(["LEARN_MORE"])).toEqual([{ value: "LEARN_MORE", label: "Learn more" }]);
    expect(opts([["a", "A", "desc"], ["b", "B"]])).toEqual([{ value: "a", label: "A", description: "desc" }, { value: "b", label: "B", description: undefined }]);
  });
  it("field factories", () => {
    expect(budgetFields({}).map((f) => f.key)).toEqual(["budgetType", "budget"]);
    expect(budgetFields({ lifetime: false, key: "spend", min: 5 })).toEqual([expect.objectContaining({ key: "spend", min: 5, required: true })]);
    expect(scheduleFields({ datetime: true }).map((f) => f.type)).toEqual(["datetime", "datetime"]);
    expect(scheduleFields().map((f) => f.type)).toEqual(["date", "date"]);
    expect(launchSection().fields[0]).toMatchObject({ key: "launchStatus", default: "PAUSED" });
    expect(locationsField()).toMatchObject({ required: true, allowExclude: true, default: [{ id: "IN" }] });
    expect(locationsField({ allowExclude: false })).toMatchObject({ allowExclude: false });
    expect(urlField()).toMatchObject({ key: "url", type: "url", required: true, maxLength: 2048 });
    expect(urlField({ required: false, key: "finalUrl" })).toMatchObject({ key: "finalUrl", required: false });
  });
});

describe("geo, preview and drafts", () => {
  it("country and language names", () => {
    expect(countryName("IN")).toBe("India");
    expect(countryName("ZZ")).toBe("ZZ");
    expect(languageName("hi")).toBe("Hindi");
    expect(languageName("xx")).toBe("xx");
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(LANGUAGES.length);
    expect(COUNTRIES.find((c) => c.code === "IN")!.n).toBe(356);
  });
  it("displayDomain", () => {
    expect(displayDomain("https://www.YourStore.com/sale?x=1")).toBe("yourstore.com");
    expect(displayDomain("http://shop.example.co.in:8080/a")).toBe("shop.example.co.in");
    expect(displayDomain("yourstore.com")).toBe("yourstore.com");
    expect(displayDomain(undefined)).toBe("yourstore.com");
    expect(displayDomain("  https://brand.in  ")).toBe("brand.in");
  });
  it("draftSchema defaults the name and trims it", () => {
    expect(draftSchema.parse({ payload: {} })).toEqual({ name: "Untitled campaign", payload: {} });
    expect(draftSchema.parse({ name: "  Sale ", payload: { a: 1 } }).name).toBe("Sale");
    expect(draftSchema.safeParse({ name: "x".repeat(401), payload: {} }).success).toBe(false);
  });
});
