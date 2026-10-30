import { audit, contactOf, fxContext } from "@ashniva/core";
import { prisma, num, type Lead, type Prisma } from "@ashniva/db";
import {
  LEAD_NOTE_MAX,
  LEAD_SORTS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  PLATFORMS,
  type LeadDTO,
  type LeadFacet,
  type LeadSort,
  type LeadsResponse,
} from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";
import { workspaceAccounts } from "./analytics.service";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const leadsRouter = Router({ mergeParams: true });

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Leads are personal data: one request covers at most a year, and at most this many rows. */
const MAX_RANGE_DAYS = 366;
const MAX_ROWS = 20_000;

const id = z.string().trim().min(1).max(50);
const yesNo = z.enum(["true", "false"]).optional();

const query = z.object({
  from: isoDate,
  to: isoDate,
  source: z.string().max(20).optional(),
  platform: z.enum(PLATFORMS).optional(),
  campaignId: id.optional(),
  adGroupId: id.optional(),
  adId: id.optional(),
  formId: z.string().trim().min(1).max(100).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  hasPhone: yesNo,
  hasEmail: yesNo,
  origin: z.enum(["paid", "organic"]).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(LEAD_SORTS).default("newest"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).refine((v) => v.from <= v.to && (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= MAX_RANGE_DAYS, {
  message: `Choose a date range of up to ${MAX_RANGE_DAYS} days.`,
  path: ["from"],
});
type LeadsQuery = z.infer<typeof query>;

/** Present = a non-blank value. */
const present = (k: "phone" | "email"): Prisma.LeadWhereInput => ({ AND: [{ [k]: { not: null } }, { NOT: { [k]: "" } }] });
const missing = (k: "phone" | "email"): Prisma.LeadWhereInput => ({ OR: [{ [k]: null }, { [k]: "" }] });

/** Every filter of the query, combined (AND). The status filter is left out with `withoutStatus`. */
function leadWhere(q: LeadsQuery, workspaceId: string, createdTime: Prisma.DateTimeFilter, opts: { withoutStatus?: boolean } = {}): Prisma.LeadWhereInput {
  const and: Prisma.LeadWhereInput[] = [];
  if (q.hasPhone) and.push(q.hasPhone === "true" ? present("phone") : missing("phone"));
  if (q.hasEmail) and.push(q.hasEmail === "true" ? present("email") : missing("email"));
  if (q.search) and.push({ OR: ["name", "email", "phone", "adName", "campaignName", "formName"].map((k) => ({ [k]: { contains: q.search, mode: "insensitive" as const } })) });
  return {
    workspaceId,
    createdTime,
    ...(q.platform ? { platform: q.platform } : {}),
    // "unknown" is how the summary labels leads with no source.
    ...(q.source ? { source: q.source === "unknown" ? null : q.source } : {}),
    ...(q.campaignId ? { campaignId: q.campaignId } : {}),
    ...(q.adGroupId ? { adGroupId: q.adGroupId } : {}),
    ...(q.adId ? { adId: q.adId } : {}),
    ...(q.formId ? { formId: q.formId } : {}),
    ...(q.origin ? { isOrganic: q.origin === "organic" } : {}),
    ...(q.status && !opts.withoutStatus ? { status: q.status } : {}),
    ...(and.length ? { AND: and } : {}),
  };
}

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
  const createdTime: Prisma.DateTimeFilter = { gte: dayStart(q.from, tz), lt: dayStart(nextDay(q.to), tz) };
  const where = leadWhere(q, req.workspace!.id, createdTime);
  // Past the row cap, "oldest first" keeps the oldest rows; every other order keeps the newest.
  const leads = await prisma.lead.findMany({ where, orderBy: [{ createdTime: q.sort === "oldest" ? "asc" : "desc" }, { id: "asc" }], take: MAX_ROWS });

  // Estimated cost per lead: the ad's spend that day, shared across the leads it got that day.
  const adIds = [...new Set(leads.flatMap((l) => (l.adId ? [l.adId] : [])))];
  const accounts = await workspaceAccounts(req.workspace!.id);
  const accountIds = accounts.map((a) => a.id);
  // Spend is in each ad account's currency; costs are shown in the workspace's.
  const fx = await fxContext(ws.currency, adIds.length ? accounts : [], { from: q.from, to: q.to });
  const [spend, sameAds] = adIds.length
    ? await Promise.all([
        prisma.metricDaily.findMany({
          where: { level: "AD", entityId: { in: adIds }, adAccountId: { in: accountIds }, date: { gte: new Date(`${q.from}T00:00:00Z`), lte: new Date(`${q.to}T00:00:00Z`) } },
          select: { entityId: true, adAccountId: true, date: true, spend: true },
        }),
        // Count against every lead of those ads that day, even ones this filter hides.
        prisma.lead.findMany({
          where: { workspaceId: req.workspace!.id, adId: { in: adIds }, createdTime },
          select: { adId: true, createdTime: true },
        }),
      ])
    : [[], []];
  const spendBy = new Map(spend.map((m) => [`${m.entityId}|${m.date.toISOString().slice(0, 10)}`, num(m.spend) * fx.accountFactor(m.adAccountId, m.date)]));
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
  const costs = leads.map(costOf);
  const order = sortOrder(q.sort, leads, costs);
  return { q, tz, createdTime, currency: ws.currency, fx: fx.info, leads: order.map((i) => leads[i]!), costs: order.map((i) => costs[i]!) };
}

/** Row order for a sort; `leads` arrive newest (or, for "oldest", oldest) first, which breaks ties. */
function sortOrder(sort: LeadSort, leads: Lead[], costs: (number | null)[]): number[] {
  const idx = leads.map((_, i) => i);
  if (sort === "campaign") {
    // A to Z by campaign name; leads without a campaign go last.
    const name = (i: number) => leads[i]!.campaignName?.trim().toLocaleLowerCase() || null;
    return idx.sort((a, b) => {
      const x = name(a);
      const y = name(b);
      if (x === y) return a - b;
      if (x == null) return 1;
      if (y == null) return -1;
      return x.localeCompare(y) || a - b;
    });
  }
  if (sort === "cost") {
    // Most expensive first; leads without an estimate go last.
    return idx.sort((a, b) => {
      const x = costs[a]!;
      const y = costs[b]!;
      if (x == null || y == null) return x == null && y == null ? a - b : x == null ? 1 : -1;
      return y - x || a - b;
    });
  }
  return idx;
}

/** The top facets of one dimension (ad set, ad, form): leads with an id, most leads first. */
function facets(leads: Lead[], idOf: (l: Lead) => string | null, nameOf: (l: Lead) => string | null, fallback: string, limit = 50): LeadFacet[] {
  const by = new Map<string, LeadFacet>();
  for (const l of leads) {
    const key = idOf(l);
    if (!key) continue;
    const row = by.get(key) ?? { id: key, name: nameOf(l)?.trim() || fallback, count: 0 };
    row.count++;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit);
}

const blank = (v: string | null) => !v?.trim();

const toDTO = (l: Lead, estCost: number | null, currency: string, users: Map<string, string>): LeadDTO => ({
  id: l.id,
  platform: l.platform,
  source: l.source,
  name: l.name,
  email: l.email,
  phone: l.phone,
  campaignId: l.campaignId,
  campaignName: l.campaignName,
  adGroupId: l.adGroupId,
  adGroupName: l.adGroupName,
  adId: l.adId,
  adName: l.adName,
  formId: l.formId,
  formName: l.formName,
  isOrganic: l.isOrganic,
  createdTime: l.createdTime.toISOString(),
  estCost,
  currency,
  fields: l.fields as Record<string, string[]>,
  status: l.status,
  note: l.note,
  statusUpdatedAt: l.statusUpdatedAt?.toISOString() ?? null,
  statusUpdatedBy: l.statusUpdatedById ? { id: l.statusUpdatedById, name: users.get(l.statusUpdatedById) ?? "Former member" } : null,
});

/** Names of the people who last changed these leads' status or note. */
async function updaters(leads: Lead[]) {
  const ids = [...new Set(leads.flatMap((l) => (l.statusUpdatedById ? [l.statusUpdatedById] : [])))];
  if (!ids.length) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}

leadsRouter.get("/leads", async (req, res) => {
  const { q, tz, createdTime, currency, fx, leads, costs } = await load(req);

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

  // Status counts ignore the status filter, so every status tab keeps its number.
  const statusRows = await prisma.lead.groupBy({ by: ["status"], where: leadWhere(q, req.workspace!.id, createdTime, { withoutStatus: true }), _count: { _all: true } });
  const statusCount = new Map(statusRows.map((r) => [r.status, r._count._all]));

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
  const pageRows = leads.slice(start, start + q.pageSize);
  const users = await updaters(pageRows);
  const body: LeadsResponse = {
    total: leads.length,
    page: q.page,
    pageSize: q.pageSize,
    leads: pageRows.map((l, i) => toDTO(l, costs[start + i] ?? null, currency, users)),
    summary: {
      total: leads.length,
      avgCost: priced.length ? totalCost! / priced.length : null,
      totalCost,
      currency,
      fx,
      withPhone: leads.filter((l) => !blank(l.phone)).length,
      withEmail: leads.filter((l) => !blank(l.email)).length,
      organic: leads.filter((l) => l.isOrganic).length,
    },
    byStatus: LEAD_STATUSES.map((status) => ({ status, count: statusCount.get(status) ?? 0 })),
    bySource: [...bySource].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byPlatform: [...byPlatform].map(([platform, count]) => ({ platform: platform as LeadsResponse["byPlatform"][number]["platform"], count })).sort((a, b) => b.count - a.count),
    byHour,
    byDay: [...byDay].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    byCampaign: [...byCampaign.values()]
      .map((c) => ({ campaignId: c.campaignId, name: c.name, count: c.count, cost: c.cost || null }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    byAdGroup: facets(leads, (l) => l.adGroupId, (l) => l.adGroupName, "Unnamed ad set"),
    byAd: facets(leads, (l) => l.adId, (l) => l.adName, "Unnamed ad"),
    byForm: facets(leads, (l) => l.formId, (l) => l.formName, "Unnamed form"),
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

leadsRouter.get("/leads/export", requirePermission("leads:export"), async (req, res) => {
  const { q, tz, currency, leads, costs } = await load(req);
  // Exports leave the app with personal data, so each one is recorded.
  await audit({
    orgId: req.org!.id,
    workspaceId: req.workspace!.id,
    userId: req.userId,
    action: "leads.exported",
    entityType: "workspace",
    entityId: req.workspace!.id,
    entityName: `${leads.length} leads · ${q.from} to ${q.to}${q.platform ? ` · ${q.platform}` : ""}`,
  });
  // Name, email and phone already have their own columns.
  const shown = new Set(["full_name", "email", "phone_number"]);
  const fieldKeys = [...new Set(leads.flatMap((l) => Object.keys(l.fields as object)))].filter((k) => !shown.has(k)).sort();
  const head = ["Date", "Time", "Name", "Email", "Phone", "Source", "Campaign", "Ad set", "Ad", "Form", `Est. cost (${currency})`, "Status", "Note", ...fieldKeys];
  const lines = [head.map(csvCell).join(",")];
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  leads.forEach((l, i) => {
    const f = l.fields as Record<string, string[]>;
    const { day } = parts(l.createdTime, tz);
    const time = timeFmt.format(l.createdTime);
    const cost = costs[i];
    const c = contactOf(f);
    lines.push(
      [
        day,
        time,
        l.name ?? c.name,
        l.email ?? c.email,
        l.phone ?? c.phone,
        l.source,
        l.campaignName,
        l.adGroupName,
        l.adName,
        l.formName,
        cost == null ? "" : cost.toFixed(2),
        LEAD_STATUS_LABELS[l.status],
        l.note,
        ...fieldKeys.map((k) => (f[k] ?? []).join("; ")),
      ]
        .map(csvCell)
        .join(","),
    );
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
});

const updateLead = z
  .object({
    status: z.enum(LEAD_STATUSES, { error: "Choose a status." }).optional(),
    note: z.string().trim().max(LEAD_NOTE_MAX, `Keep the note under ${LEAD_NOTE_MAX.toLocaleString("en-IN")} characters.`).nullable().optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.note !== undefined, { message: "Send a status or a note.", path: ["status"] });

/** Moves a lead through the follow-up workflow and/or edits its note. Analysts and clients only read. */
leadsRouter.patch("/leads/:leadId", requirePermission("leads:manage"), async (req, res) => {
  const input = parse(updateLead, req.body);
  const lead = await prisma.lead.findFirst({ where: { id: String(req.params.leadId), workspaceId: req.workspace!.id } });
  if (!lead) throw notFound("Lead");

  const note = input.note === undefined ? lead.note : input.note || null;
  const status = input.status ?? lead.status;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (status !== lead.status) changes.status = { from: lead.status, to: status };
  if (note !== lead.note) changes.note = { from: lead.note, to: note };

  let saved = lead;
  if (Object.keys(changes).length) {
    saved = await prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: lead.id },
        data: { status, note, statusUpdatedAt: new Date(), statusUpdatedById: req.userId! },
      });
      await audit(
        {
          orgId: req.org!.id,
          workspaceId: req.workspace!.id,
          userId: req.userId,
          action: changes.status ? "lead.status_changed" : "lead.note_changed",
          entityType: "lead",
          entityId: lead.id,
          entityName: lead.name?.trim() || lead.email?.trim() || lead.phone?.trim() || "Unnamed lead",
          changes,
          ip: req.ip,
        },
        tx,
      );
      return row;
    });
  }
  const users = await updaters([saved]);
  // The cost estimate belongs to the list view; it is not recomputed for one lead.
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: req.workspace!.id }, select: { currency: true } });
  res.json(toDTO(saved, null, ws.currency, users));
});
