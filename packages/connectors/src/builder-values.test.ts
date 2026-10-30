import { describe, expect, it } from "vitest";
import { builderZone, dayIn, dayOf, instantOf, zonedTimeToUtc } from "./builder-values";

const at = (value: string, tz: string, edge?: "start" | "end") => instantOf({ d: value }, "d", tz, edge)?.toISOString() ?? null;

describe("instantOf (builder wall-clock values in the ad account's zone)", () => {
  it("reads an India datetime as IST: 09:30 → 04:00Z", () => {
    expect(at("2026-10-30T09:30", "Asia/Kolkata")).toBe("2026-10-30T04:00:00.000Z");
    expect(at("2026-10-30T00:15", "Asia/Kolkata")).toBe("2026-10-29T18:45:00.000Z");
  });

  it("handles :45 offsets", () => {
    expect(at("2026-10-30T09:30", "Asia/Kathmandu")).toBe("2026-10-30T03:45:00.000Z");
  });

  it("follows New York across DST", () => {
    // EDT (UTC-4) before 1 Nov 2026, EST (UTC-5) after.
    expect(at("2026-10-31T09:00", "America/New_York")).toBe("2026-10-31T13:00:00.000Z");
    expect(at("2026-11-02T09:00", "America/New_York")).toBe("2026-11-02T14:00:00.000Z");
    // Spring forward on 8 Mar 2026: 01:30 EST, 03:30 EDT.
    expect(at("2026-03-08T01:30", "America/New_York")).toBe("2026-03-08T06:30:00.000Z");
    expect(at("2026-03-08T03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    // 02:30 doesn't exist that day: it moves forward with the clocks (= 03:30 EDT).
    expect(at("2026-03-08T02:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    // 01:30 happens twice on 1 Nov 2026: the first (EDT) one.
    expect(at("2026-11-01T01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("takes a date-only value as the start (or last second) of that day in the zone", () => {
    expect(at("2026-11-01", "Asia/Kolkata")).toBe("2026-10-31T18:30:00.000Z");
    expect(at("2026-11-30", "Asia/Kolkata", "end")).toBe("2026-11-30T18:29:59.000Z");
    expect(at("2026-11-01", "America/New_York")).toBe("2026-11-01T04:00:00.000Z");
    expect(at("2026-11-01", "America/New_York", "end")).toBe("2026-11-02T04:59:59.000Z");
    // The time a datetime was entered with wins over the edge.
    expect(at("2026-11-30T18:00", "Asia/Kolkata", "end")).toBe("2026-11-30T12:30:00.000Z");
  });

  it("keeps the typed day for date-only values in every zone", () => {
    for (const tz of ["Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "UTC"]) {
      expect(dayIn(instantOf({ d: "2026-11-01" }, "d", tz)!, tz)).toBe("2026-11-01");
      expect(dayIn(instantOf({ d: "2026-11-30" }, "d", tz, "end")!, tz)).toBe("2026-11-30");
    }
    expect(dayOf({ d: "2026-11-01" }, "d")).toBe("2026-11-01");
  });

  it("passes explicit offsets through and rejects junk", () => {
    expect(at("2026-10-30T09:30:00Z", "Asia/Kolkata")).toBe("2026-10-30T09:30:00.000Z");
    expect(at("2026-10-30T09:30+05:30", "America/New_York")).toBe("2026-10-30T04:00:00.000Z");
    expect(at("", "UTC")).toBeNull();
    expect(at("2026-02-30", "UTC")).toBeNull();
    expect(at("2026-10-30T25:00", "UTC")).toBeNull();
    expect(at("next tuesday", "UTC")).toBeNull();
    expect(instantOf({}, "d", "UTC")).toBeNull();
  });

  it("does not depend on the server's zone", () => {
    const tz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      expect(at("2026-10-30T09:30", "UTC")).toBe("2026-10-30T09:30:00.000Z");
      process.env.TZ = "America/Los_Angeles";
      expect(at("2026-10-30T09:30", "Asia/Kolkata")).toBe("2026-10-30T04:00:00.000Z");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("builderZone", () => {
  it("uses the account's zone, else UTC (also for an unknown zone)", () => {
    expect(builderZone({ timezone: "Asia/Kolkata" })).toBe("Asia/Kolkata");
    expect(builderZone({ timezone: null })).toBe("UTC");
    expect(builderZone({ timezone: "Not/AZone" })).toBe("UTC");
    expect(builderZone(undefined)).toBe("UTC");
    expect(at("2026-10-30T09:30", "Not/AZone")).toBe("2026-10-30T09:30:00.000Z");
  });
});

describe("zonedTimeToUtc", () => {
  it("handles Lord Howe's 30-minute DST", () => {
    expect(zonedTimeToUtc(2026, 1, 1, 0, 0, 0, "Australia/Lord_Howe").toISOString()).toBe("2025-12-31T13:00:00.000Z");
  });
});
