import { beforeAll, describe, expect, it } from "vitest";
import { alertActionUrl, signAlertAction, verifyAlertAction } from "./alert-actions";

beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
});

const NOW = new Date("2026-11-03T10:00:00Z");

describe("alert action links", () => {
  it("round-trips the claims", () => {
    const token = signAlertAction({ a: "snooze", c: "camp1", o: "org1", d: 7 }, NOW);
    expect(verifyAlertAction(token, NOW)).toMatchObject({ a: "snooze", c: "camp1", o: "org1", d: 7 });
  });

  it("expires after a week", () => {
    const token = signAlertAction({ a: "pause", c: "camp1", o: "org1" }, NOW);
    expect(verifyAlertAction(token, new Date(NOW.getTime() + 6 * 86_400_000))).not.toBeNull();
    expect(verifyAlertAction(token, new Date(NOW.getTime() + 8 * 86_400_000))).toBeNull();
  });

  it("rejects a token whose claims were changed", () => {
    const token = signAlertAction({ a: "snooze", c: "camp1", o: "org1", d: 1 }, NOW);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), a: "pause", c: "someone-elses" })).toString("base64url");
    expect(verifyAlertAction(`${forged}.${mac}`, NOW)).toBeNull();
    expect(verifyAlertAction(`${body}.${mac!.slice(0, -2)}xx`, NOW)).toBeNull();
  });

  it("rejects junk", () => {
    for (const t of ["", "abc", "a.b", "a.b.c"]) expect(verifyAlertAction(t, NOW)).toBeNull();
  });

  it("builds a link to the confirmation page", () => {
    expect(alertActionUrl({ a: "pause", c: "c1", o: "o1" }, NOW)).toMatch(/\/alert-action\?t=[\w-]+\.[\w-]+$/);
  });
});
