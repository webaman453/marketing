import { prisma } from "@ashniva/db";
import { isOrgLocked } from "./entitlements";
import { esc, sendMail } from "./mailer";
import { emailOptOuts } from "./notifications";
import { renderReportPdf } from "./report-pdf";
import { nextRunAt, runReport } from "./reports";

/** Recipients minus team members of the report's organization who turned off report emails. */
async function wantedRecipients(orgId: string, recipients: string[]) {
  const members = await prisma.membership.findMany({
    where: { orgId, user: { email: { in: recipients, mode: "insensitive" } } },
    select: { userId: true, user: { select: { email: true } } },
  });
  const optedOut = await emailOptOuts(members.map((m) => m.userId), "reportCopies");
  const skip = new Set(members.filter((m) => optedOut.has(m.userId)).map((m) => m.user.email.toLowerCase()));
  return recipients.filter((r) => !skip.has(r.toLowerCase()));
}

/** Emails a report's PDF to its recipients and schedules the next send. */
export async function deliverReport(reportId: string) {
  const report = await prisma.report.findUniqueOrThrow({ where: { id: reportId }, include: { workspace: true, org: true } });
  const recipients = await wantedRecipients(report.orgId, report.recipients);
  try {
    // Like syncs and rules: a lapsed organization's data is no longer synced, so its reports stop too.
    if (isOrgLocked(report.org)) throw new Error("Organization is on an inactive plan; scheduled reports are paused.");
    if (recipients.length === 0) {
      // Everyone on the list opted out; nothing to send this time.
      await prisma.reportRun.create({ data: { reportId, status: "SUCCESS", recipients: [], error: "Skipped: every recipient turned off report emails." } });
      return;
    }
    const result = await runReport(report);
    const pdf = await renderReportPdf(result);
    const web = process.env.WEB_URL || "http://localhost:3100";
    const filename = `${report.name.replace(/[^\w\- ]+/g, "").trim() || "report"} ${result.range.from} to ${result.range.to}.pdf`;

    await sendMail({
      to: recipients,
      subject: `${report.name} · ${result.range.from} to ${result.range.to}`,
      heading: esc(report.name),
      body: `Your ${esc(report.scheduleFrequency?.toLowerCase() ?? "")} report for <strong>${esc(result.workspaceName)}</strong> is attached (${result.range.from} to ${result.range.to}).`,
      cta: report.shareToken ? { label: "View online", url: `${web}/r/${report.shareToken}` } : undefined,
      attachments: [{ filename, content: pdf }],
      brand: { name: result.branding.name, color: result.branding.color, logoUrl: result.branding.logoUrl },
    });

    await prisma.reportRun.create({ data: { reportId, status: "SUCCESS", recipients } });
  } catch (err) {
    await prisma.reportRun.create({
      data: { reportId, status: "FAILED", recipients, error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) },
    });
    throw err;
  } finally {
    // Always move the schedule forward so one failure doesn't cause a retry storm.
    await prisma.report.update({
      where: { id: reportId },
      data: {
        lastRunAt: new Date(),
        nextRunAt: report.scheduleFrequency
          ? nextRunAt(
              {
                frequency: report.scheduleFrequency,
                hour: report.scheduleHour ?? 9,
                dayOfWeek: report.scheduleDayOfWeek ?? 1,
                dayOfMonth: report.scheduleDayOfMonth ?? 1,
              },
              report.workspace.timezone,
            )
          : null,
      },
    });
  }
}
