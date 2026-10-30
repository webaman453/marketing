import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, activeFilterCount, apiFilters, filtersFromParams, filtersToParams, rangeFromParams, rangeParams } from "./filters";

describe("lead filters in the URL", () => {
  it("round-trips every filter, sort and page size", () => {
    const f = {
      ...EMPTY_FILTERS,
      source: "ig",
      campaignId: "c_1",
      adGroupId: "g_1",
      adId: "ad_1",
      formId: "form_1",
      status: "QUALIFIED" as const,
      hasPhone: "true" as const,
      hasEmail: "false" as const,
      origin: "organic" as const,
      search: "ravi",
      sort: "cost" as const,
      pageSize: 100,
      page: 3,
    };
    const qs = filtersToParams(f, { platform: "META" });
    expect(qs.toString()).toBe(
      "platform=META&source=ig&campaignId=c_1&adGroupId=g_1&adId=ad_1&formId=form_1&status=QUALIFIED&hasPhone=true&hasEmail=false&origin=organic&search=ravi&sort=cost&pageSize=100&page=3",
    );
    expect(filtersFromParams(qs)).toEqual(f);
  });

  it("leaves defaults out of the URL", () => {
    expect(filtersToParams(EMPTY_FILTERS, { platform: "META" }).toString()).toBe("platform=META");
    expect(filtersToParams({ ...EMPTY_FILTERS, search: "   " }).toString()).toBe("");
  });

  it("ignores unknown or malformed values", () => {
    const f = filtersFromParams(new URLSearchParams("status=DONE&sort=random&pageSize=7&page=-2&hasPhone=maybe&origin=both&adId=" + "x".repeat(101)));
    expect(f).toEqual(EMPTY_FILTERS);
  });

  it("counts narrowing filters (not sort or paging) and maps to API params", () => {
    const f = { ...EMPTY_FILTERS, status: "NEW" as const, hasEmail: "true" as const, search: " a ", sort: "oldest" as const, page: 2 };
    expect(activeFilterCount(f)).toBe(3);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(apiFilters(f)).toMatchObject({ status: "NEW", hasEmail: "true", search: "a", sort: "oldest", page: 2, pageSize: 50 });
    expect(apiFilters(EMPTY_FILTERS).search).toBeUndefined();
  });

  it("reads a date range as a preset or fixed days", () => {
    expect(rangeFromParams(new URLSearchParams("range=7d"))).toEqual({ preset: "7d" });
    expect(rangeFromParams(new URLSearchParams("from=2026-10-01&to=2026-10-07"))).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    expect(rangeFromParams(new URLSearchParams("from=2026-10-07&to=2026-10-01"))).toBeNull();
    expect(rangeFromParams(new URLSearchParams("range=custom"))).toBeNull();
    expect(rangeParams({ preset: "30d", from: "a", to: "b" })).toEqual({ range: "30d" });
    expect(rangeParams({ preset: "custom", from: "2026-10-01", to: "2026-10-02" })).toEqual({ from: "2026-10-01", to: "2026-10-02" });
  });
});
