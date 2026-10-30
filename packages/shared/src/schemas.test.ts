import { describe, expect, it } from "vitest";
import {
  acceptInviteSchema,
  bulkCampaignActionSchema,
  campaignListQuery,
  changePasswordSchema,
  dateRangeQuery,
  forgotPasswordSchema,
  inviteMemberSchema,
  loginSchema,
  platformParam,
  registerSchema,
  resetPasswordSchema,
  updateCampaignBudgetSchema,
  updateMemberSchema,
  workspaceSchema,
} from "./schemas";

const firstMessage = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;
const reg = { name: "Aman Kumar", email: "aman@example.com", password: "Password123", companyName: "Ashniva" };

describe("registerSchema", () => {
  it("accepts a valid sign-up and lower-cases the email", () => {
    expect(registerSchema.parse({ ...reg, email: "Aman@Example.COM", name: "  Aman  " })).toEqual({ ...reg, name: "Aman" });
  });
  it.each([
    ["short password", { password: "Pass12" }, "Password must be at least 8 characters"],
    ["no number", { password: "Passwordxx" }, "Password must contain a number"],
    ["no letter", { password: "12345678" }, "Password must contain a letter"],
    ["too long", { password: `a1${"x".repeat(127)}` }, "Password is too long"],
    ["bad email", { email: "aman@" }, "Enter a valid email address"],
    ["short name", { name: " A " }, "Must be at least 2 characters"],
    ["no company", { companyName: " " }, "Enter your company name"],
  ])("rejects %s", (_n, patch, message) => {
    expect(firstMessage(registerSchema.safeParse({ ...reg, ...patch }))).toBe(message);
  });
  it("trims an email typed with a leading/trailing space before validating it", () => {
    expect(registerSchema.safeParse({ ...reg, email: " aman@example.com " }).success).toBe(true);
    expect(registerSchema.parse({ ...reg, email: " Aman@Example.com " }).email).toBe("aman@example.com");
  });
});

describe("loginSchema", () => {
  it("needs an email and a non-empty password (any strength)", () => {
    expect(loginSchema.parse({ email: "A@B.co", password: "x" })).toEqual({ email: "a@b.co", password: "x" });
    expect(firstMessage(loginSchema.safeParse({ email: "a@b.co", password: "" }))).toBe("Enter your password");
    expect(firstMessage(loginSchema.safeParse({ email: "a@b.co" }))).toBe("Enter your password");
    expect(loginSchema.safeParse({ email: "nope", password: "x" }).success).toBe(false);
  });
  it("accepts a trailing space after the email when logging in (mobile autocomplete)", () => {
    expect(loginSchema.safeParse({ email: "aman@example.com ", password: "x" }).success).toBe(true);
  });
});

describe("other auth schemas", () => {
  it("forgot / reset / change password", () => {
    expect(forgotPasswordSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
    expect(resetPasswordSchema.safeParse({ token: "short", password: "Password123" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ token: "0123456789", password: "Password123" }).success).toBe(true);
    expect(changePasswordSchema.safeParse({ currentPassword: "", newPassword: "Password123" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "weak" }).success).toBe(false);
  });
  it("accept invite: name and password optional but validated", () => {
    expect(acceptInviteSchema.safeParse({ token: "0123456789" }).success).toBe(true);
    expect(acceptInviteSchema.safeParse({ token: "0123456789", password: "short1" }).success).toBe(false);
  });
});

describe("inviteMemberSchema", () => {
  it("admins need no workspaces", () => {
    expect(inviteMemberSchema.parse({ email: "a@b.co", role: "ADMIN" })).toEqual({ email: "a@b.co", role: "ADMIN", workspaceIds: [] });
  });
  it.each(["MANAGER", "ANALYST", "CLIENT"])("%s needs at least one workspace", (role) => {
    const r = inviteMemberSchema.safeParse({ email: "a@b.co", role });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]).toMatchObject({ path: ["workspaceIds"], message: "Choose at least one workspace" });
    expect(inviteMemberSchema.safeParse({ email: "a@b.co", role, workspaceIds: ["w1"] }).success).toBe(true);
  });
  it("can't invite an owner or an unknown role", () => {
    expect(inviteMemberSchema.safeParse({ email: "a@b.co", role: "OWNER", workspaceIds: ["w1"] }).success).toBe(false);
    expect(inviteMemberSchema.safeParse({ email: "a@b.co", role: "GOD", workspaceIds: ["w1"] }).success).toBe(false);
  });
  it("updateMemberSchema: no owner, workspaces optional", () => {
    expect(updateMemberSchema.safeParse({ role: "OWNER" }).success).toBe(false);
    expect(updateMemberSchema.parse({ role: "CLIENT" })).toEqual({ role: "CLIENT" });
  });
});

describe("workspaceSchema", () => {
  it("defaults currency and timezone", () => {
    expect(workspaceSchema.parse({ name: " Acme " })).toEqual({ name: "Acme", currency: "INR", timezone: "Asia/Kolkata" });
  });
  it.each(["America/New_York", "Europe/London", "UTC", "Asia/Dubai"])("accepts IANA timezone %s", (timezone) => {
    expect(workspaceSchema.safeParse({ name: "Acme", timezone }).success).toBe(true);
  });
  it.each(["Mars/Olympus", "Asia/Bangalore", "GMT+5:30x"])("rejects %s", (timezone) => {
    expect(firstMessage(workspaceSchema.safeParse({ name: "Acme", timezone }))).toBe("Choose a valid timezone");
  });
  it("rejects an empty timezone, unknown currency and short names", () => {
    expect(workspaceSchema.safeParse({ name: "Acme", timezone: "" }).success).toBe(false);
    expect(workspaceSchema.safeParse({ name: "Acme", currency: "JPY" }).success).toBe(false);
    expect(workspaceSchema.safeParse({ name: "A" }).success).toBe(false);
  });
});

describe("campaign and query schemas", () => {
  it("platformParam", () => {
    expect(platformParam.safeParse("META").success).toBe(true);
    expect(platformParam.safeParse("meta").success).toBe(false);
  });
  it("budget must be positive and capped", () => {
    expect(updateCampaignBudgetSchema.safeParse({ dailyBudget: 0 }).success).toBe(false);
    expect(updateCampaignBudgetSchema.safeParse({ dailyBudget: 100_000_001 }).success).toBe(false);
    expect(updateCampaignBudgetSchema.safeParse({ dailyBudget: 500 }).success).toBe(true);
  });
  it("bulk actions need 1–200 ids and an on/off status", () => {
    expect(bulkCampaignActionSchema.safeParse({ campaignIds: [], status: "PAUSED" }).success).toBe(false);
    expect(bulkCampaignActionSchema.safeParse({ campaignIds: ["c"], status: "ARCHIVED" }).success).toBe(false);
    expect(bulkCampaignActionSchema.safeParse({ campaignIds: Array.from({ length: 201 }, (_, i) => `${i}`), status: "ACTIVE" }).success).toBe(false);
  });
  it("date ranges are ISO and ordered", () => {
    expect(dateRangeQuery.safeParse({ from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
    expect(dateRangeQuery.safeParse({ from: "2026-10-01", to: "2026-10-01" }).success).toBe(true);
    expect(firstMessage(dateRangeQuery.safeParse({ from: "2026-11-01", to: "2026-10-31" }))).toBe("`from` must be before `to`");
    expect(firstMessage(dateRangeQuery.safeParse({ from: "01/10/2026", to: "2026-10-31" }))).toBe("Expected YYYY-MM-DD");
  });
  it("campaign list query trims search and checks enums", () => {
    expect(campaignListQuery.parse({ from: "2026-10-01", to: "2026-10-31", search: "  sale " }).search).toBe("sale");
    expect(campaignListQuery.safeParse({ from: "2026-10-01", to: "2026-10-31", status: "DELETED" }).success).toBe(false);
  });
});
