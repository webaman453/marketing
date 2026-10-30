/**
 * Leads (leads.routes.ts): range limits, the row cap, source filtering,
 * export permission with an audit entry, and CSV formula-injection escaping.
 */
import { getSyncQueue } from "@ashniva/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { createConnection, orgWith, resetAll } from "./helpers";

afterAll(async () => {
  await getSyncQueue().close();
});
beforeEach(resetAll);

const DAY = "2026-10-01";
const at = (hourUtc: number) => new Date(`${DAY}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

async function leadsWorkspace(role: "OWNER" | "MANAGER" | "ANALYST" | "CLIENT" = "OWNER") {
  const ctx = await orgWith(role);
  // UTC keeps day boundaries simple.
  await prisma.workspace.update({ where: { id: ctx.workspace.id }, data: { timezone: "UTC" } });
  const { connection } = await createConnection(ctx.org.id, { platform: "META", workspaceId: ctx.workspace.id });
  let n = 0;
  const lead = (data: Partial<Parameters<typeof prisma.lead.create>[0]["data"]> = {}) =>
    prisma.lead.create({
      data: {
        orgId: ctx.org.id,
        workspaceId: ctx.workspace.id,
        connectionId: connection.id,
        platform: "META",
        externalId: `lead-${n++}`,
        fields: {},
        createdTime: at(10),
        ...data,
      },
    });
  return { ...ctx, connection, lead, api: await as(ctx.user), base: `/api/workspaces/${ctx.workspace.id}` };
}

describe("GET /leads", () => {
  it("allows at most 366 days and a from before to", async () => {
    const { api, base } = await leadsWorkspace();
    const tooLong = await api.get(`${base}/leads?from=2025-01-01&to=2026-01-03`);
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.details.from[0]).toMatch(/366 days/);
    expect((await api.get(`${base}/leads?from=2025-01-01&to=2026-01-02`)).status).toBe(200);
    expect((await api.get(`${base}/leads?from=2026-02-01&to=2026-01-01`)).status).toBe(422);
    expect((await api.get(`${base}/leads?from=2026-1-1&to=2026-01-02`)).status).toBe(422);
  });

  it("filters by source, where 'unknown' means leads without a source", async () => {
    const { api, base, lead } = await leadsWorkspace();
    await lead({ source: "fb", name: "Asha" });
    await lead({ source: "ig", name: "Ravi" });
    await lead({ source: null, name: "Meera" });
    const q = `from=${DAY}&to=${DAY}`;
    const all = await api.get(`${base}/leads?${q}`);
    expect(all.body.total).toBe(3);
    expect(all.body.bySource).toEqual(expect.arrayContaining([{ source: "unknown", count: 1 }, { source: "fb", count: 1 }]));
    const unknown = await api.get(`${base}/leads?${q}&source=unknown`);
    expect(unknown.body.leads.map((l: { name: string }) => l.name)).toEqual(["Meera"]);
    const ig = await api.get(`${base}/leads?${q}&source=ig`);
    expect(ig.body.leads.map((l: { name: string }) => l.name)).toEqual(["Ravi"]);
  });

  it("caps a request at 20,000 rows", async () => {
    const { api, base, org, workspace, connection } = await leadsWorkspace();
    const rows = Array.from({ length: 20_001 }, (_, i) => ({
      orgId: org.id,
      workspaceId: workspace.id,
      connectionId: connection.id,
      platform: "META" as const,
      externalId: `bulk-${i}`,
      fields: {},
      createdTime: new Date(at(0).getTime() + i * 1000),
    }));
    await prisma.lead.createMany({ data: rows });
    const res = await api.get(`${base}/leads?from=${DAY}&to=${DAY}&pageSize=10`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(20_000);
    expect(res.body.leads).toHaveLength(10);
    // Newest first, so the oldest one is the row left out.
    expect(res.body.leads[0].createdTime).toBe(new Date(at(0).getTime() + 20_000 * 1000).toISOString());
  }, 120_000);

  it("only shows this workspace's leads", async () => {
    const { api, base, lead } = await leadsWorkspace();
    await lead({ name: "Mine" });
    const other = await leadsWorkspace();
    await other.lead({ name: "Theirs" });
    const res = await api.get(`${base}/leads?from=${DAY}&to=${DAY}`);
    expect(res.body.leads.map((l: { name: string }) => l.name)).toEqual(["Mine"]);
  });
});

describe("GET /leads/export", () => {
  it("needs leads:export", async () => {
    for (const role of ["ANALYST", "CLIENT"] as const) {
      const { api, base } = await leadsWorkspace(role);
      expect((await api.get(`${base}/leads/export?from=${DAY}&to=${DAY}`)).status, role).toBe(403);
    }
    const { api, base } = await leadsWorkspace("MANAGER");
    expect((await api.get(`${base}/leads/export?from=${DAY}&to=${DAY}`)).status).toBe(200);
  });

  it("writes an audit row and a CSV with the form answers", async () => {
    const { api, base, lead, org, workspace, user } = await leadsWorkspace();
    await lead({ name: "Asha Rao", email: "asha@example.test", phone: "+91 98765 43210", source: "fb", campaignName: "Diwali, 2026", fields: { city: ["Pune"], budget: ["5-10L"] } });
    const res = await api.get(`${base}/leads/export?from=${DAY}&to=${DAY}&platform=META`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = res.text.replace(/^﻿/, "").split("\r\n");
    // Status and note (the team's follow-up) come before the form's own answers.
    expect(lines[0]).toBe("Date,Time,Name,Email,Phone,Source,Campaign,Ad set,Ad,Form,Est. cost (INR),Status,Note,budget,city");
    expect(lines[1]).toBe(`${DAY},10:00:00,Asha Rao,asha@example.test,+91 98765 43210,fb,"Diwali, 2026",,,,,New,,5-10L,Pune`);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "leads.exported" } });
    expect(log).toMatchObject({ workspaceId: workspace.id, userId: user.id, entityName: `1 leads · ${DAY} to ${DAY} · META` });
  });

  it("escapes values a spreadsheet would run as formulas", async () => {
    const { api, base, lead } = await leadsWorkspace();
    await lead({
      name: "=HYPERLINK(\"http://evil.test\",\"click\")",
      email: "@SUM(1+1)",
      phone: "-2+3+cmd|' /C calc'!A0",
      campaignName: "+cmd",
      adName: "\t=1+1",
      fields: { note: ["=2*3"], mobile: ["+91 99999 00000"] },
      createdTime: at(9),
    });
    const res = await api.get(`${base}/leads/export?from=${DAY}&to=${DAY}`);
    const [head, row] = res.text.replace(/^﻿/, "").split("\r\n");
    const cols = head!.split(",");
    // Parse the one row (quoted cells may contain commas).
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < row!.length; i++) {
      const ch = row![i]!;
      if (quoted && ch === '"' && row![i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) cells.push(cur), (cur = "");
      else cur += ch;
    }
    cells.push(cur);
    const cell = (name: string) => cells[cols.indexOf(name)]!;
    expect(cell("Name")).toBe(`'=HYPERLINK("http://evil.test","click")`);
    expect(cell("Email")).toBe("'@SUM(1+1)");
    expect(cell("Phone")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(cell("Campaign")).toBe("'+cmd");
    expect(cell("Ad")).toBe("'\t=1+1");
    expect(cell("note")).toBe("'=2*3");
    // Phone-like values stay as they are.
    expect(cell("mobile")).toBe("+91 99999 00000");
    for (const c of cells) expect(c).not.toMatch(/^[=@\t\r]/);
  });
});
