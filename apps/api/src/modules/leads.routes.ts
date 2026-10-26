import { contactOf } from "@ashniva/core";
import { prisma, num, type Lead, type Prisma } from "@ashniva/db";
import { PLATFORMS, type LeadDTO, type LeadsResponse } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { parse } from "../lib/errors";
import { workspaceAccountIds } from "./analytics.service";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const leadsRouter = Router({ mergeParams: true });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  from: isoDate,
  to: isoDate,
  source: z.string().max(20).optional(),
  platform: z.enum(PLATFORMS).optional(),
  campaignId: z.string().max(50).optional(),
  adId: z.string().max(50).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** The instant a calendar day starts in `tz`. */
function dayStart(day: string, tz: string) {
  const guess = new Date(`${day}T00:00:00Z`);
  const p = parts(guess, tz);
  const local = new Date(`${p.day}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:00Z`);
  return new Date(guess.getTime() - (local.getTime() - guess.getTime()));
}
const nextDay = (day: string) => new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

async function load(req: { workspace?: { id: string }; query: unknown }) {
  const q = parse(query, req.query);
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: req.workspace!.id }, select: { timezone: true, currency: true } });
  const tz = ws.timezone;
  const where: Prisma.LeadWhereInput = {
    workspaceId: req.workspace!.id,
    createdTime: { gte: dayStart(q.from, tz), lt: dayStart(nextDay(q.to), tz) },
    ...(q.platform ? { platform: q.platform } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.adId ? { adId: q.adId } : {}),
    ...(q.search
      ? { OR: ["name", "email", "phone", "adName", "campaignName", "formName"].map((k) => ({ [k]: { contains: q.search, mode: "insensitive" as const } })) }
      : {}),
  };
  const leads = await prisma.lead.findMany({ where, orderBy: { createdTime: "desc" } });

  // Estimated cost per lead: the ad's spend that day, shared across the leads it got that day.
  const adIds = [...new Set(leads.flatMap((l) => (l.adId ? [l.adId] : [])))];
  const accountIds = await workspaceAccountIds(req.workspace!.id);
  const [spend, sameAds] = adIds.length
    ? await Promise.all([
        prisma.metricDaily.findMany({
          where: { level: "AD", entityId: { in: adIds }, adAccountId: { in: accountIds }, date: { gte: new Date(`${q.from}T00:00:00Z`), lte: new Date(`${q.to}T00:00:00Z`) } },
          select: { entityId: true, date: true, spend: true },
        }),
        // Count against every lead of those ads that day, even ones this filter hides.
        prisma.lead.findMany({
          where: { workspaceId: req.workspace!.id, adId: { in: adIds }, createdTime: where.createdTime as Prisma.DateTimeFilter },
          select: { adId: true, createdTime: true },
        }),
      ])
    : [[], []];
  const spendBy = new Map(spend.map((m) => [`${m.entityId}|${m.date.toISOString().slice(0, 10)}`, num(m.spend)]));
  const countBy = new Map<string, number>();
  for (const l of sameAds) {
    const k = `${l.adId}|${parts(l.createdTime, tz).day}`;
    countBy.set(k, (countBy.get(k) ?? 0) + 1);
  }
  const costOf = (l: Lead) => {
    if (!l.adId) return null;
    const k = `${l.adId}|${parts(l.createdTime, tz).day}`;
    const s = spendBy.get(k);
    const n = countBy.get(k);
    return s != null && n ? s / n : null;
  };
  return { q, tz, currency: ws.currency, leads, costOf };
}

const toDTO = (l: Lead, estCost: number | null, currency: string): LeadDTO => ({
  id: l.id,
  platform: l.platform,
  source: l.source,
  name: l.name,
  email: l.email,
  phone: l.phone,
  campaignId: l.campaignId,
  campaignName: l.campaignName,
  adGroupName: l.adGroupName,
  adId: l.adId,
  adName: l.adName,
  formName: l.formName,
  createdTime: l.createdTime.toISOString(),
  estCost,
  currency,
  fields: l.fields as Record<string, string[]>,
});

leadsRouter.get("/leads", async (req, res) => {
  const { q, tz, currency, leads, costOf } = await load(req);
  const costs = leads.map(costOf);

  const bySource = new Map<string, number>();
  const byPlatform = new Map<string, number>();
  const byHour = Array<number>(24).fill(0);
  const byDay = new Map<string, number>();
  const byCampaign = new Map<string, { campaignId: string | null; name: string; count: number; cost: number }>();
  leads.forEach((l, i) => {
    bySource.set(l.source ?? "unknown", (bySource.get(l.source ?? "unknown") ?? 0) + 1);
    byPlatform.set(l.platform, (byPlatform.get(l.platform) ?? 0) + 1);
    const p = parts(l.createdTime, tz);
    byHour[p.hour]!++;
    byDay.set(p.day, (byDay.get(p.day) ?? 0) + 1);
    const key = l.campaignId ?? l.campaignName ?? "unknown";
    const row = byCampaign.get(key) ?? { campaignId: l.campaignId, name: l.campaignName ?? "Unknown campaign", count: 0, cost: 0 };
    row.count++;
    row.cost += costs[i] ?? 0;
    byCampaign.set(key, row);
  });

  const priced = costs.filter((c): c is number => c != null);
  const totalCost = priced.length ? priced.reduce((a, b) => a + b, 0) : null;

  // Surface "reconnect to read leads" without failing the page.
  const runs = await prisma.syncRun.findMany({
    where: { status: "SUCCESS", connection: { mode: "LIVE", ...(q.platform ? { platform: q.platform } : {}), adAccounts: { some: { workspaceId: req.workspace!.id } } } },
    orderBy: { startedAt: "desc" },
    take: 5,
    select: { stats: true, connectionId: true },
  });
  const latestPerConnection = new Map<string, unknown>();
  for (const r of runs) if (!latestPerConnection.has(r.connectionId)) latestPerConnection.set(r.connectionId, r.stats);
  const leadsError = [...latestPerConnection.values()].map((s) => (s as { leadsError?: string } | null)?.leadsError).find(Boolean) ?? null;

  const start = (q.page - 1) * q.pageSize;
  const body: LeadsResponse = {
    total: leads.length,
    page: q.page,
    pageSize: q.pageSize,
    leads: leads.slice(start, start + q.pageSize).map((l, i) => toDTO(l, costs[start + i] ?? null, currency)),
    summary: { total: leads.length, avgCost: priced.length ? totalCost! / priced.length : null, totalCost, currency },
    bySource: [...bySource].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byPlatform: [...byPlatform].map(([platform, count]) => ({ platform: platform as LeadsResponse["byPlatform"][number]["platform"], count })).sort((a, b) => b.count - a.count),
    byHour,
    byDay: [...byDay].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    byCampaign: [...byCampaign.values()]
      .map((c) => ({ campaignId: c.campaignId, name: c.name, count: c.count, cost: c.cost || null }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    leadsError,
    timezone: tz,
  };
  res.json(body);
});

const csvCell = (v: unknown) => {
  let s = v == null ? "" : String(v);
  // Stop spreadsheet apps from running a lead's answer as a formula.
  // Phone numbers like +91 98765 43210 are fine and must stay intact.
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]+$/.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

leadsRouter.get("/leads/export", async (req, res) => {
  const { tz, currency, leads, costOf } = await load(req);
  // Name, email and phone already have their own columns.
  const shown = new Set(["full_name", "email", "phone_number"]);
  const fieldKeys = [...new Set(leads.flatMap((l) => Object.keys(l.fields as object)))].filter((k) => !shown.has(k)).sort();
  const head = ["Date", "Time", "Name", "Email", "Phone", "Source", "Campaign", "Ad set", "Ad", "Form", `Est. cost (${currency})`, ...fieldKeys];
  const lines = [head.map(csvCell).join(",")];
  for (const l of leads) {
    const f = l.fields as Record<string, string[]>;
    const { day } = parts(l.createdTime, tz);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(l.createdTime);
    const cost = costOf(l);
    const c = contactOf(f);
    lines.push(
      [day, time, l.name ?? c.name, l.email ?? c.email, l.phone ?? c.phone, l.source, l.campaignName, l.adGroupName, l.adName, l.formName, cost == null ? "" : cost.toFixed(2), ...fieldKeys.map((k) => (f[k] ?? []).join("; "))]
        .map(csvCell)
        .join(","),
    );
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
});
