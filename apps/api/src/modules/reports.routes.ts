import { assertFeature, audit, deliverReport, nextRunAt, randomToken, renderReportPdf, reportToCsv, runReport } from "@ashniva/core";
import { prisma, type Prisma, type Report } from "@ashniva/db";
import {
  dateRangeQuery,
  reportConfigSchema,
  reportScheduleSchema,
  reportSchema,
  type ReportConfig,
  type ReportDTO,
} from "@ashniva/shared";
import { Router, type Response } from "express";
import { notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const reportsRouter = Router({ mergeParams: true });

const toReportDTO = (r: Report & { createdByName?: string | null }): ReportDTO => ({
  id: r.id,
  name: r.name,
  description: r.description,
  config: reportConfigSchema.parse(r.config),
  schedule: {
    frequency: r.scheduleFrequency,
    hour: r.scheduleHour ?? 9,
    dayOfWeek: r.scheduleDayOfWeek ?? 1,
    dayOfMonth: r.scheduleDayOfMonth ?? 1,
    recipients: r.recipients,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
  },
  shareToken: r.shareToken,
  createdBy: r.createdByName ?? null,
  updatedAt: r.updatedAt.toISOString(),
});

const safeName = (s: string) => s.replace(/[^\w\- ]+/g, "").trim() || "report";

export async function sendExport(res: Response, report: Report, format: string, range?: { from: string; to: string }) {
  const result = await runReport(report, { range });
  const base = `${safeName(report.name)} ${result.range.from} to ${result.range.to}`;
  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    res.send(`﻿${reportToCsv(result)}`);
    return;
  }
  if (format === "pdf") {
    const pdf = await renderReportPdf(result);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
    res.send(pdf);
    return;
  }
  res.json(result);
}

const optionalRange = (q: Record<string, unknown>) => (q.from && q.to ? parse(dateRangeQuery, q) : undefined);

reportsRouter.get("/reports", async (req, res) => {
  const reports = await prisma.report.findMany({ where: { workspaceId: req.workspace!.id }, orderBy: { updatedAt: "desc" } });
  const users = await prisma.user.findMany({
    where: { id: { in: reports.map((r) => r.createdById).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  res.json(reports.map((r) => toReportDTO({ ...r, createdByName: r.createdById ? nameOf.get(r.createdById) : null })));
});

/** Runs an unsaved config, for the live preview in the report builder. */
reportsRouter.post("/reports/preview", async (req, res) => {
  const config = parse(reportConfigSchema, req.body?.config);
  const fake = {
    id: "preview",
    orgId: req.org!.id,
    workspaceId: req.workspace!.id,
    name: String(req.body?.name ?? "Untitled report"),
    config: config as unknown as Prisma.JsonValue,
  } as Report;
  res.json(await runReport(fake, { range: optionalRange(req.body ?? {}) }));
});

reportsRouter.post("/reports", requirePermission("data:view"), async (req, res) => {
  if (req.membership!.role === "CLIENT") throw notFound("Route");
  const input = parse(reportSchema, req.body);
  const report = await prisma.report.create({
    data: {
      orgId: req.org!.id,
      workspaceId: req.workspace!.id,
      name: input.name,
      description: input.description,
      config: input.config as unknown as Prisma.InputJsonValue,
      createdById: req.userId,
    },
  });
  await audit({ orgId: report.orgId, workspaceId: report.workspaceId, userId: req.userId, action: "report.created", entityType: "report", entityId: report.id, entityName: report.name });
  res.status(201).json(toReportDTO(report));
});

async function findReport(workspaceId: string, id: string) {
  const r = await prisma.report.findFirst({ where: { id, workspaceId } });
  if (!r) throw notFound("Report");
  return r;
}

reportsRouter.get("/reports/:reportId", async (req, res) => {
  res.json(toReportDTO(await findReport(req.workspace!.id, req.params.reportId as string)));
});

reportsRouter.get("/reports/:reportId/data", async (req, res) => {
  const report = await findReport(req.workspace!.id, req.params.reportId as string);
  await sendExport(res, report, "json", optionalRange(req.query));
});

reportsRouter.get("/reports/:reportId/export.:format", async (req, res) => {
  const format = req.params.format === "pdf" ? "pdf" : "csv";
  const report = await findReport(req.workspace!.id, req.params.reportId as string);
  await sendExport(res, report, format, optionalRange(req.query));
});

const isEditor = (role: string) => role !== "CLIENT";

reportsRouter.patch("/reports/:reportId", async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const input = parse(reportSchema, req.body);
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  const updated = await prisma.report.update({
    where: { id: r.id },
    data: { name: input.name, description: input.description, config: input.config as ReportConfig as unknown as Prisma.InputJsonValue },
  });
  res.json(toReportDTO(updated));
});

reportsRouter.delete("/reports/:reportId", async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  await prisma.report.delete({ where: { id: r.id } });
  await audit({ orgId: r.orgId, workspaceId: r.workspaceId, userId: req.userId, action: "report.deleted", entityType: "report", entityId: r.id, entityName: r.name });
  res.status(204).end();
});

reportsRouter.put("/reports/:reportId/schedule", async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const input = parse(reportScheduleSchema, req.body);
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  if (input.frequency) assertFeature(req.org!, "scheduled_reports");
  const updated = await prisma.report.update({
    where: { id: r.id },
    data: {
      scheduleFrequency: input.frequency,
      scheduleHour: input.hour,
      scheduleDayOfWeek: input.dayOfWeek,
      scheduleDayOfMonth: input.dayOfMonth,
      recipients: input.recipients,
      nextRunAt: input.frequency ? nextRunAt({ ...input, frequency: input.frequency }, req.workspace!.timezone) : null,
    },
  });
  await audit({
    orgId: r.orgId,
    workspaceId: r.workspaceId,
    userId: req.userId,
    action: input.frequency ? "report.scheduled" : "report.unscheduled",
    entityType: "report",
    entityId: r.id,
    entityName: r.name,
  });
  res.json(toReportDTO(updated));
});

reportsRouter.post("/reports/:reportId/send", async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  if (r.recipients.length === 0) throw notFound("Recipients");
  await deliverReport(r.id);
  res.json(toReportDTO(await findReport(req.workspace!.id, r.id)));
});

reportsRouter.post("/reports/:reportId/share", requirePermission("data:view"), async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  const updated = await prisma.report.update({ where: { id: r.id }, data: { shareToken: r.shareToken ?? randomToken(24) } });
  await audit({ orgId: r.orgId, workspaceId: r.workspaceId, userId: req.userId, action: "report.shared", entityType: "report", entityId: r.id, entityName: r.name });
  res.json(toReportDTO(updated));
});

reportsRouter.delete("/reports/:reportId/share", async (req, res) => {
  if (!isEditor(req.membership!.role)) throw notFound("Route");
  const r = await findReport(req.workspace!.id, req.params.reportId as string);
  const updated = await prisma.report.update({ where: { id: r.id }, data: { shareToken: null } });
  res.json(toReportDTO(updated));
});

// ───────── Public, token-protected report view ─────────

export const publicReportsRouter = Router();

publicReportsRouter.get("/:token", async (req, res) => {
  const token = String(req.params.token);
  const report = token.length >= 20 ? await prisma.report.findUnique({ where: { shareToken: token } }) : null;
  if (!report) throw notFound("Report");
  res.setHeader("X-Robots-Tag", "noindex");
  const format = req.query.format === "pdf" ? "pdf" : req.query.format === "csv" ? "csv" : "json";
  await sendExport(res, report, format, optionalRange(req.query));
});
