import { describe, expect, it } from "vitest";
import { CONNECT_CREDENTIALS, PLATFORMS, PLATFORM_INFO, VISIBLE_PLATFORMS, connectsWithCredentials, isPlatform, isPlatformShown } from "./platforms";

describe("platform list", () => {
  it("has info for every platform, keyed by its id", () => {
    expect(Object.keys(PLATFORM_INFO).sort()).toEqual([...PLATFORMS].sort());
    for (const p of PLATFORMS) {
      expect(PLATFORM_INFO[p].id).toBe(p);
      expect(PLATFORM_INFO[p].color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(PLATFORM_INFO[p].terms.campaign.length).toBeGreaterThan(0);
    }
  });
  it("isPlatform accepts only known ids", () => {
    expect(isPlatform("META")).toBe(true);
    expect(isPlatform("meta")).toBe(false);
    expect(isPlatform("FACEBOOK")).toBe(false);
    expect(isPlatform(undefined)).toBe(false);
    expect(isPlatform(1)).toBe(false);
  });
});

describe("visibility", () => {
  it("hides TikTok, Swiggy, Zepto and Naukri", () => {
    for (const p of ["TIKTOK", "SWIGGY", "ZEPTO", "NAUKRI"] as const) expect(isPlatformShown(p)).toBe(false);
    expect(VISIBLE_PLATFORMS).toEqual([
      "META", "GOOGLE", "LINKEDIN", "MICROSOFT", "SNAPCHAT", "PINTEREST", "AMAZON", "X", "APPLE", "SPOTIFY",
      "CRITEO", "TABOOLA", "OUTBRAIN", "TRADEDESK", "YAHOO", "SHOPIFY",
    ]);
  });
  it("keeps PLATFORMS order and contains only shown platforms", () => {
    expect(VISIBLE_PLATFORMS).toEqual(PLATFORMS.filter(isPlatformShown));
    for (const p of VISIBLE_PLATFORMS) expect(isPlatformShown(p)).toBe(true);
  });
  it("every visible platform is live; the no-API platforms are coming soon", () => {
    for (const p of VISIBLE_PLATFORMS) expect(PLATFORM_INFO[p].availability).toBe("live");
    for (const p of ["SWIGGY", "ZEPTO", "NAUKRI"] as const) expect(PLATFORM_INFO[p].availability).toBe("coming_soon");
  });
});

describe("connect credentials (replaces usesOperatorKey)", () => {
  it("lists the key-based platforms", () => {
    expect(Object.keys(CONNECT_CREDENTIALS).sort()).toEqual(["APPLE", "CRITEO", "OUTBRAIN", "TABOOLA", "TRADEDESK"]);
    for (const p of PLATFORMS) expect(connectsWithCredentials(p)).toBe(p in CONNECT_CREDENTIALS);
    expect(connectsWithCredentials("META")).toBe(false);
    expect(connectsWithCredentials("APPLE")).toBe(true);
  });
  it("every spec has help, an https docs URL and unique field keys, with at least one secret", () => {
    for (const [p, s] of Object.entries(CONNECT_CREDENTIALS)) {
      expect(s!.help.length, p).toBeGreaterThan(10);
      expect(s!.docsUrl, p).toMatch(/^https:\/\//);
      const keys = s!.fields.map((f) => f.key);
      expect(new Set(keys).size, p).toBe(keys.length);
      expect(s!.fields.some((f) => f.secret), p).toBe(true);
    }
  });
  it("Apple asks for a multiline PEM key", () => {
    const pk = CONNECT_CREDENTIALS.APPLE!.fields.find((f) => f.key === "privateKey")!;
    expect(pk).toMatchObject({ secret: true, multiline: true });
  });
  it("only visible platforms connect with credentials", () => {
    for (const p of Object.keys(CONNECT_CREDENTIALS)) expect(isPlatformShown(p as never)).toBe(true);
  });
});
