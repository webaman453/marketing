/**
 * Leads you can filter and work with (leads.routes.ts, core/leads.ts): the extra filters
 * (ad set, ad, form, phone, email, organic, status) in the list, summary and CSV; sorting;
 * the status/note PATCH with its permission and audit entry; and sync leaving status/note alone.
 */
import type { AdPlatformConnector, ExternalLead } from "@ashniva/connectors";
import { connectors, getSyncQueue, syncLeads } from "@ashniva/core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { createConnection, orgWith, resetAll } from "./helpers";

afterAll(async () => {
  await getSyncQueue().close();
});
beforeEach(resetAll);
afterEach(() => vi.restoreAllMocks());

const DAY = "2026-10-01";
const at = (hourUtc: number) => new Date(`${DAY}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
const range = `from=${DAY}&to=${DAY}`;
type Row = { name: string };
const names = (body: { leads: Row[] }) => body.leads.map((l) => l.name);

async function leadsWorkspace(role: "OWNER" | "ADMIN" | "MANAGER" | "ANALYST" | "CLIENT" = "OWNER") {
  const ctx = await orgWith(role);
  await prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { timezone: "UTC" } });
  const { connection } = await createConnection(ctx.org.id, { platform: "META", workspaceId: ctx.workspace.id });
  let n = 0;
  const lead = (data: Partial<Parameters<typeof prisma.lead.create>[0]["data"]> = {}) =>
    prisma.lead.create({
      data: { orgId: ctx.org.id, workspaceId: ctx.workspace.id, connectionId: connection.id, platform: "META", externalId: `lead-${n++}`, fields: {}, createdTime: at(10), ...data },
    });
  return { ...ctx, connection, lead, api: await as(ctx.user), base: `/api/workspaces/${ctx.workspace.id}` };
}

/** Five leads that differ in ad set, ad, form, contact details, origin and status. */
async function seeded() {
  const ws = await leadsWorkspace();
  await ws.lead({ name: "Asha", phone: "+91 90000 00001", email: "asha@example.test", adGroupId: "g1", adGroupName: "Prospecting", adId: "a1", adName: "Ad A", formId: "f1", formName: "Quote", campaignName: "Zeta", createdTime: at(9) });
  await ws.lead({ name: "Ravi", phone: "+91 90000 00002", email: null, adGroupId: "g1", adGroupName: "Prospecting", adId: "a2", adName: "Ad B", formId: "f1", formName: "Quote", campaignName: "Alpha", createdTime: at(11), status: "CONTACTED" });
  await ws.lead({ name: "Meera", phone: "", email: "meera@example.test", adGroupId: "g2", adGroupName: "Retargeting", adId: "a3", adName: "Ad C", formId: "f2", formName: "Callback", campaignName: "Alpha", createdTime: at(12), status: "WON" });
  await ws.lead({ name: "Kiran", phone: null, email: null, isOrganic: true, formId: "f2", formName: "Callback", createdTime: at(13) });
  await ws.lead({ name: "Dev", phone: "+91 90000 00005", email: "dev@example.test", adGroupId: "g2", adGroupName: "Retargeting", adId: "a3", adName: "Ad C", formId: "f2", formName: "Callback", campaignName: "Beta", createdTime: at(14), status: "WON" });
  return ws;
}

describe("GET /leads filters", () => {
  it("filters by ad set, ad and form, and offers each as a menu", async () => {
    const { api, base } = await seeded();
    const all = await api.get(`${base}/leads?${range}`);
    expect(all.status).toBe(200);
    expect(all.body.byAdGroup).toEqual([{ id: "g1", name: "Prospecting", count: 2 }, { id: "g2", name: "Retargeting", count: 2 }]);
    expect(all.body.byAd).toEqual([{ id: "a3", name: "Ad C", count: 2 }, { id: "a1", name: "Ad A", count: 1 }, { id: "a2", name: "Ad B", count: 1 }]);
    expect(all.body.byForm).toEqual([{ id: "f2", name: "Callback", count: 3 }, { id: "f1", name: "Quote", count: 2 }]);
    expect(names((await api.get(`${base}/leads?${range}&adGroupId=g1`)).body)).toEqual(["Ravi", "Asha"]);
    expect(names((await api.get(`${base}/leads?${range}&adId=a3`)).body)).toEqual(["Dev", "Meera"]);
    expect(names((await api.get(`${base}/leads?${range}&formId=f2`)).body)).toEqual(["Dev", "Kiran", "Meera"]);
  });

  it("filters by phone, email and organic vs paid; blank values count as missing", async () => {
    const { api, base } = await seeded();
    expect(names((await api.get(`${base}/leads?${range}&hasPhone=true`)).body)).toEqual(["Dev", "Ravi", "Asha"]);
    expect(names((await api.get(`${base}/leads?${range}&hasPhone=false`)).body)).toEqual(["Kiran", "Meera"]);
    expect(names((await api.get(`${base}/leads?${range}&hasEmail=true`)).body)).toEqual(["Dev", "Meera", "Asha"]);
    expect(names((await api.get(`${base}/leads?${range}&origin=organic`)).body)).toEqual(["Kiran"]);
    expect((await api.get(`${base}/leads?${range}&origin=paid`)).body.total).toBe(4);
    expect((await api.get(`${base}/leads?${range}&hasPhone=maybe`)).status).toBe(422);
  });

  it("combines every filter, and the summary, charts and status counts follow them", async () => {
    const { api, base } = await seeded();
    const res = await api.get(`${base}/leads?${range}&formId=f2&hasEmail=true&origin=paid&status=WON&search=e`);
    expect(names(res.body)).toEqual(["Dev", "Meera"]);
    expect(res.body.summary).toMatchObject({ total: 2, withPhone: 1, withEmail: 2, organic: 0 });
    expect(res.body.byHour[12]).toBe(1);
    expect(res.body.byHour[14]).toBe(1);
    expect(res.body.byCampaign.map((c: Row) => c.name).sort()).toEqual(["Alpha", "Beta"]);
    // Status counts use every filter except the status one.
    expect(res.body.byStatus).toEqual([
      { status: "NEW", count: 0 },
      { status: "CONTACTED", count: 0 },
      { status: "QUALIFIED", count: 0 },
      { status: "WON", count: 2 },
      { status: "LOST", count: 0 },
    ]);
    const all = await api.get(`${base}/leads?${range}`);
    expect(all.body.byStatus).toEqual([
      { status: "NEW", count: 2 },
      { status: "CONTACTED", count: 1 },
      { status: "QUALIFIED", count: 0 },
      { status: "WON", count: 2 },
      { status: "LOST", count: 0 },
    ]);
    expect(all.body.summary).toMatchObject({ total: 5, withPhone: 3, withEmail: 3, organic: 1 });
    expect(all.body.leads[0]).toMatchObject({ status: "WON", note: null, isOrganic: false, adGroupId: "g2", formId: "f2" });
  });

  it("sorts newest, oldest or by campaign, and keeps the page size limit", async () => {
    const { api, base } = await seeded();
    expect(names((await api.get(`${base}/leads?${range}`)).body)).toEqual(["Dev", "Kiran", "Meera", "Ravi", "Asha"]);
    expect(names((await api.get(`${base}/leads?${range}&sort=oldest`)).body)).toEqual(["Asha", "Ravi", "Meera", "Kiran", "Dev"]);
    // A to Z, newest first within a campaign, no campaign last.
    expect(names((await api.get(`${base}/leads?${range}&sort=campaign`)).body)).toEqual(["Meera", "Ravi", "Dev", "Asha", "Kiran"]);
    // No spend in the test database: every estimate is missing, so cost order falls back to newest first.
    expect(names((await api.get(`${base}/leads?${range}&sort=cost`)).body)).toEqual(["Dev", "Kiran", "Meera", "Ravi", "Asha"]);
    const paged = await api.get(`${base}/leads?${range}&sort=oldest&pageSize=2&page=2`);
    expect(names(paged.body)).toEqual(["Meera", "Kiran"]);
    expect((await api.get(`${base}/leads?${range}&pageSize=201`)).status).toBe(422);
    expect((await api.get(`${base}/leads?${range}&sort=random`)).status).toBe(422);
  });

  it("applies the same filters and sort to the CSV, with status and note columns", async () => {
    const { api, base, lead } = await seeded();
    await lead({ name: "Noted", phone: "+91 90000 00009", status: "QUALIFIED", note: "Call after 6, wants 3BHK", createdTime: at(15) });
    const res = await api.get(`${base}/leads/export?${range}&hasPhone=true&sort=oldest`);
    expect(res.status).toBe(200);
    const lines = res.text.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Date,Time,Name,Email,Phone,Source,Campaign,Ad set,Ad,Form,Est. cost (INR),Status,Note");
    expect(lines.slice(1).map((l) => l.split(",")[2])).toEqual(["Asha", "Ravi", "Dev", "Noted"]);
    expect(lines[2]).toContain(",Contacted,");
    expect(lines.at(-1)).toBe(`${DAY},15:00:00,Noted,,+91 90000 00009,,,,,,,Qualified,"Call after 6, wants 3BHK"`);
  });
});

describe("PATCH /leads/:leadId", () => {
  it("sets the status and note, records who and when, and audits the change", async () => {
    const { api, base, lead, org, workspace, user } = await leadsWorkspace("MANAGER");
    const l = await lead({ name: "Asha" });
    const res = await api.patch(`${base}/leads/${l.id}`).send({ status: "CONTACTED", note: "  Called, call back Friday  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: l.id, status: "CONTACTED", note: "Called, call back Friday", statusUpdatedBy: { id: user.id, name: user.name } });
    expect(Date.parse(res.body.statusUpdatedAt)).toBeGreaterThan(Date.now() - 60_000);
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(row).toMatchObject({ status: "CONTACTED", note: "Called, call back Friday", statusUpdatedById: user.id });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "lead.status_changed" } });
    expect(log).toMatchObject({ workspaceId: workspace.id, userId: user.id, entityType: "lead", entityId: l.id, entityName: "Asha" });
    expect(log.changes).toEqual({ status: { from: "NEW", to: "CONTACTED" }, note: { from: null, to: "Called, call back Friday" } });

    // A note on its own; an empty note clears it.
    await api.patch(`${base}/leads/${l.id}`).send({ note: "" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).note).toBeNull();
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: "lead.note_changed" } })).toBe(1);
    // No change, no audit row.
    expect((await api.patch(`${base}/leads/${l.id}`).send({ status: "CONTACTED" })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: { startsWith: "lead." } } })).toBe(2);

    // The list shows it and can filter by it.
    const list = await api.get(`${base}/leads?${range}&status=CONTACTED`);
    expect(list.body.leads).toEqual([expect.objectContaining({ id: l.id, status: "CONTACTED", statusUpdatedBy: { id: user.id, name: user.name } })]);
  });

  it("validates the status and the note length", async () => {
    const { api, base, lead } = await leadsWorkspace();
    const l = await lead();
    expect((await api.patch(`${base}/leads/${l.id}`).send({ status: "DONE" })).status).toBe(422);
    expect((await api.patch(`${base}/leads/${l.id}`).send({ note: "x".repeat(2001) })).status).toBe(422);
    expect((await api.patch(`${base}/leads/${l.id}`).send({ note: "x".repeat(2000) })).status).toBe(200);
    expect((await api.patch(`${base}/leads/${l.id}`).send({})).status).toBe(422);
    expect((await api.patch(`${base}/leads/${l.id}`).send({ status: "WON", name: "Hacked" })).status).toBe(422);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("NEW");
  });

  it("is read-only for clients and analysts; owners, admins and managers can change it", async () => {
    for (const role of ["CLIENT", "ANALYST"] as const) {
      const { api, base, lead } = await leadsWorkspace(role);
      const l = await lead();
      expect((await api.get(`${base}/leads?${range}`)).status, role).toBe(200);
      expect((await api.patch(`${base}/leads/${l.id}`).send({ status: "WON" })).status, role).toBe(403);
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })).status, role).toBe("NEW");
    }
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) {
      const { api, base, lead } = await leadsWorkspace(role);
      const l = await lead();
      expect((await api.patch(`${base}/leads/${l.id}`).send({ status: "WON" })).status, role).toBe(200);
    }
  });

  it("can't reach another workspace's lead", async () => {
    const mine = await leadsWorkspace();
    const other = await leadsWorkspace();
    const theirs = await other.lead();
    expect((await mine.api.patch(`${mine.base}/leads/${theirs.id}`).send({ status: "WON" })).status).toBe(404);
    // Same org, different workspace.
    const sibling = await prisma.workspace.create({ data: { orgId: mine.org.id, name: "Sibling", slug: `sib-${Date.now()}` } });
    const siblingLead = await prisma.lead.create({
      data: { orgId: mine.org.id, workspaceId: sibling.id, connectionId: mine.connection.id, platform: "META", externalId: "sib-1", fields: {}, createdTime: at(10) },
    });
    expect((await mine.api.patch(`${mine.base}/leads/${siblingLead.id}`).send({ status: "WON" })).status).toBe(404);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe("NEW");
  });
});

describe("lead sync", () => {
  it("never overwrites a lead's status or note, and new leads start as NEW", async () => {
    const { api, base, org, workspace, connection } = await leadsWorkspace();
    const external = (externalId: string, name: string): ExternalLead => ({
      externalId,
      createdTime: at(10),
      source: "fb",
      isOrganic: false,
      pageId: "p1",
      formId: "f1",
      formName: "Quote",
      externalAdId: null,
      externalAdGroupId: null,
      externalCampaignId: null,
      adName: null,
      adGroupName: null,
      campaignName: null,
      fields: { full_name: [name] },
    });
    const fetchLeads = vi.fn(async () => [external("ext-1", "Asha")]);
    vi.spyOn(connectors(), "get").mockImplementation((() => ({ platform: "META", fetchLeads }) as unknown as AdPlatformConnector) as never);

    expect(await syncLeads(connection, { accessToken: "t" })).toBe(1);
    const synced = await prisma.lead.findFirstOrThrow({ where: { orgId: org.id, externalId: "ext-1" } });
    expect(synced).toMatchObject({ workspaceId: workspace.id, status: "NEW", note: null });
    await api.patch(`${base}/leads/${synced.id}`).send({ status: "QUALIFIED", note: "Budget confirmed" });

    // The platform sends the same lead again (overlap window), plus a new one.
    fetchLeads.mockResolvedValue([external("ext-1", "Asha Rao"), external("ext-2", "Ravi")]);
    expect(await syncLeads(connection, { accessToken: "t" })).toBe(1);
    const again = await prisma.lead.findUniqueOrThrow({ where: { id: synced.id } });
    expect(again).toMatchObject({ status: "QUALIFIED", note: "Budget confirmed", name: "Asha" });
    expect(await prisma.lead.findFirstOrThrow({ where: { orgId: org.id, externalId: "ext-2" } })).toMatchObject({ status: "NEW", note: null });
  });
});
