import { describe, expect, it } from "vitest";
import { friendlySyncError } from "./sync-errors";

describe("friendlySyncError", () => {
  it("treats an expired connection as a reconnect, whatever the text says", () => {
    expect(friendlySyncError("whatever", "EXPIRED")).toMatchObject({ kind: "auth", reconnect: true });
    expect(friendlySyncError("Error validating access token: Session has expired")).toMatchObject({ kind: "auth", reconnect: true });
    expect(friendlySyncError("Request failed with status 401")).toMatchObject({ kind: "auth", reconnect: true });
  });

  it("asks to reconnect when a permission is missing", () => {
    expect(friendlySyncError("Leads permission not granted. Reconnect Meta and allow lead access.")).toMatchObject({ kind: "permission", reconnect: true });
    expect(friendlySyncError("403 Forbidden")).toMatchObject({ kind: "permission", reconnect: true });
  });

  it("says rate limits and outages fix themselves", () => {
    expect(friendlySyncError("Too many requests (429)")).toMatchObject({ kind: "rate", reconnect: false });
    expect(friendlySyncError("request timed out")).toMatchObject({ kind: "network", reconnect: false });
    expect(friendlySyncError("Bad gateway 502")).toMatchObject({ kind: "network", reconnect: false });
  });

  it("keeps an unknown message, shortened, and copes with none", () => {
    expect(friendlySyncError("Campaign structure unreadable").message).toBe("Campaign structure unreadable");
    expect(friendlySyncError("x".repeat(300)).message).toHaveLength(138);
    expect(friendlySyncError(null).message).toMatch(/unknown reason/);
  });
});
