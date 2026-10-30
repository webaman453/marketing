import { addDays, type ReportConfig } from "@ashniva/shared";
import type { Report } from "@ashniva/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(async (_mail: Record<string, unknown>) => ({})) }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: smtp.sendMail, verify: vi.fn(), close: vi.fn() }) } }));

import { prisma } from "../../../test/helpers/db";
import { addMember, createOrg, createUser } from "../../../test/helpers/factories";
import { deliverReport } from "../src/report-delivery";
import { runReport, todayIn } from "../src/reports";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

const MAIL_ENV = { SMTP_HOST: "smtp.example.test", SMTP_USER: "u", SMTP_PASSWORD: "p" };
let orgId: string;
let workspaceId: string;
let owner: { id: string; email: string };
const today = () => todayIn("Asia/Kolkata");

beforeEach(async () => {
  await reset();
  smtp.sendMail.mockClear();
  Object.assign(process.env, MAIL_ENV);
  owner = await createUser();
  const { org, workspace } = await createOrg(owner, { name: "Acme" });
  orgId = org.id;
  workspaceId = workspace.id;
});

afterEach(() => {
  for (const k of Object.keys(MAIL_ENV)) process.env[k] = "";
  vi.restoreAllMocks();
});

let n = 0;
async function account(platform: "META" | "GOOGLE", wsId = workspaceId) {
  const conn = await prisma.platformConnection.create({ data: { orgId, platform, mode: "DEMO", externalUserId: `x${n++}` } });
  return prisma.adAccount.create({ data: { orgId, connectionId: conn.id, platform, externalId: `a${n++}`, name: `${platform} acct`, currency: "INR", status: "ACTIVE", workspaceId: wsId } });
}

async function campaign(acc: { id: string; platform: "META" | "GOOGLE" }, name: string) {
  return prisma.campaign.create({ data: { adAccountId: acc.id, platform: acc.platform, externalId: `c${n++}`, name, status: "ACTIVE" } });
}

async function metric(c: { id: string; adAccountId: string; platform: "META" | "GOOGLE" }, daysAgo: number, spend: number, extra: { clicks?: number; conversions?: number; conversionValue?: number } = {}) {
  await prisma.metricDaily.create({
    data: {
      date: new Date(`${addDays(today(), -daysAgo)}T00:00:00Z`),
      level: "CAMPAIGN",
      entityId: c.id,
      adAccountId: c.adAccountId,
      campaignId: c.id,
      platform: c.platform,
      impressions: 1000,
      clicks: extra.clicks ?? 10,
      spend,
      conversions: extra.conversions ?? 1,
      conversionValue: extra.conversionValue ?? spend * 2,
    },
  });
}

function report(config: Partial<ReportConfig>, over: Partial<Report> = {}) {
  return prisma.report.create({
    data: {
      orgId,
      workspaceId,
      name: "Weekly / summary!",
      config: { metrics: ["spend", "clicks", "roas"], dimension: "campaign", datePreset: "7d", ...config },
      recipients: [],
      ...(over as object),
    },
  });
}

async function seed() {
  const meta = await account("META");
  const google = await account("GOOGLE");
  const a = await campaign(meta, "Meta A");
  const b = await campaign(google, "Google B");
  await metric(a, 0, 100);
  await metric(a, 1, 50);
  await metric(b, 2, 300);
  await metric(a, 8, 1000); // previous 7 days
  await metric(a, 40, 9999); // outside both
  // Another workspace's data never shows.
  const other = await prisma.workspace.create({ data: { orgId, name: "Other", slug: `o${n++}` } });
  const x = await campaign(await account("META", other.id), "Other ws");
  await metric(x, 0, 5000);
  return { meta, google, a, b };
}

describe("runReport", () => {
  it("groups by campaign, sorted by spend, with totals, compare period and a daily series", async () => {
    const { a, b } = await seed();
    const result = await runReport(await report({}));
    expect(result.range).toEqual({ from: addDays(today(), -6), to: today() });
    expect(result.compareRange).toEqual({ from: addDays(today(), -13), to: addDays(today(), -7) });
    expect(result.rows.map((r) => [r.key, r.label, r.platform, r.values.spend])).toEqual([
      [b.id, "Google B", "GOOGLE", 300],
      [a.id, "Meta A", "META", 150],
    ]);
    expect(result.rows[1]!.previous!.spend).toBe(1000);
    expect(result.rows[0]!.previous!.spend).toBe(0);
    expect(result.totals).toMatchObject({ spend: 450, clicks: 30, impressions: 3000, roas: 2 });
    expect(result.previousTotals).toMatchObject({ spend: 1000 });
    expect(result.series).toHaveLength(7);
    expect(result.series.at(-1)).toEqual({ date: today(), value: 100 });
    expect(result.series[0]!.value).toBe(0);
    expect(result).toMatchObject({ name: "Weekly / summary!", currency: "INR", workspaceName: "Acme", branding: { name: "Acme", color: "#3b5bdb", logoUrl: null, footer: null } });
  });

  it("groups by platform and ad account, filtered by platform", async () => {
    const { meta, google } = await seed();
    const byPlatform = await runReport(await report({ dimension: "platform" }));
    expect(byPlatform.rows.map((r) => [r.key, r.label, r.values.spend])).toEqual([
      ["GOOGLE", "Google Ads", 300],
      ["META", "Meta Ads", 150],
    ]);
    const byAccount = await runReport(await report({ dimension: "adAccount", platforms: ["META"] }));
    expect(byAccount.rows.map((r) => [r.key, r.values.spend])).toEqual([[meta.id, 150]]);
    expect(byAccount.totals.spend).toBe(150);
    expect(byAccount.rows.find((r) => r.key === google.id)).toBeUndefined();
  });

  it("groups by date without a per-row comparison and supports a custom range", async () => {
    await seed();
    const range = { from: addDays(today(), -2), to: today() };
    const result = await runReport(await report({ dimension: "date", chartMetric: "clicks" }), { range });
    expect(result.rows.map((r) => [r.key, r.values.spend])).toEqual([
      [range.from, 300],
      [addDays(today(), -1), 50],
      [today(), 100],
    ]);
    expect(result.rows[0]!.previous).toBeUndefined();
    expect(result.series.map((s) => s.value)).toEqual([10, 10, 10]);
  });

  it("omits the comparison and the chart when they are turned off", async () => {
    await seed();
    const result = await runReport(await report({ compare: false, chartMetric: null }));
    expect(result.compareRange).toBeNull();
    expect(result.previousTotals).toBeNull();
    expect(result.rows[0]!.previous).toBeUndefined();
    expect(result.series).toEqual([]);
  });

  it("uses the organization's white-label branding", async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { brandName: "Client Co", brandColor: "#123456", reportFooter: "Confidential" } });
    const result = await runReport(await report({}));
    expect(result.branding).toEqual({ name: "Client Co", color: "#123456", logoUrl: null, footer: "Confidential" });
    expect(result.rows).toEqual([]);
    expect(result.totals.spend).toBe(0);
  });
});

describe("deliverReport", () => {
  it("emails the PDF to every recipient and moves the schedule forward", async () => {
    await seed();
    const r = await report({}, { recipients: ["client@example.test", owner.email], scheduleFrequency: "WEEKLY", scheduleHour: 9, scheduleDayOfWeek: 1, shareToken: "share-tok" } as Partial<Report>);
    await deliverReport(r.id);

    expect(smtp.sendMail).toHaveBeenCalledTimes(1);
    const mail = smtp.sendMail.mock.calls[0]![0] as { to: string[]; subject: string; html: string; attachments: { filename: string; content: Buffer }[] };
    expect(mail.to).toEqual(["client@example.test", owner.email]);
    expect(mail.subject).toBe(`Weekly / summary! · ${addDays(today(), -6)} to ${today()}`);
    expect(mail.html).toContain("Your weekly report for <strong>Acme</strong>");
    expect(mail.html).toContain("http://localhost:3100/r/share-tok");
    expect(mail.attachments[0]!.filename).toBe(`Weekly  summary ${addDays(today(), -6)} to ${today()}.pdf`);
    expect(mail.attachments[0]!.content.subarray(0, 5).toString()).toBe("%PDF-");

    const run = await prisma.reportRun.findFirstOrThrow({ where: { reportId: r.id } });
    expect(run).toMatchObject({ status: "SUCCESS", recipients: ["client@example.test", owner.email], error: null });
    const after = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.lastRunAt).toBeInstanceOf(Date);
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", hourCycle: "h23" }).format(after.nextRunAt!)).toBe("Mon, 09");
  });

  it("leaves out team members who turned report emails off (matching email case-insensitively)", async () => {
    const analyst = await createUser();
    await addMember(orgId, analyst, "ANALYST");
    await prisma.notificationPreference.create({ data: { userId: analyst.id, reportCopies: false } });
    const r = await report({}, { recipients: [analyst.email.toUpperCase(), "client@example.test"] } as Partial<Report>);
    await deliverReport(r.id);
    expect((smtp.sendMail.mock.calls[0]![0] as { to: string[] }).to).toEqual(["client@example.test"]);
  });

  it("records a skipped run when everyone opted out", async () => {
    await prisma.notificationPreference.create({ data: { userId: owner.id, reportCopies: false } });
    const r = await report({}, { recipients: [owner.email], scheduleFrequency: "DAILY" } as Partial<Report>);
    await deliverReport(r.id);
    expect(smtp.sendMail).not.toHaveBeenCalled();
    const run = await prisma.reportRun.findFirstOrThrow({ where: { reportId: r.id } });
    expect(run).toMatchObject({ status: "SUCCESS", recipients: [], error: "Skipped: every recipient turned off report emails." });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: r.id } })).nextRunAt).toBeInstanceOf(Date);
  });

  it("records a failure, rethrows, and still reschedules", async () => {
    smtp.sendMail.mockRejectedValueOnce(new Error("SMTP down"));
    const r = await report({}, { recipients: ["client@example.test"], scheduleFrequency: "MONTHLY", scheduleDayOfMonth: 1 } as Partial<Report>);
    await expect(deliverReport(r.id)).rejects.toThrow("SMTP down");
    const run = await prisma.reportRun.findFirstOrThrow({ where: { reportId: r.id } });
    expect(run).toMatchObject({ status: "FAILED", error: "SMTP down", recipients: ["client@example.test"] });
    const after = await prisma.report.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.nextRunAt).toBeInstanceOf(Date);
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", day: "numeric" }).format(after.nextRunAt!)).toBe("1");
  });

  it("clears the next run for an unscheduled report", async () => {
    const r = await report({}, { recipients: ["client@example.test"], nextRunAt: new Date() } as Partial<Report>);
    await deliverReport(r.id);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: r.id } })).nextRunAt).toBeNull();
  });
});
