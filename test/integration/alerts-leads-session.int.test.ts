/**
 * Integration alerts link to the Integrations page, sample data brings sample leads,
 * and a deleted user's still-valid access cookie gets a 401 rather than a 500.
 */
import { connectors, syncConnection } from "@ashniva/core";
import type { AdPlatformConnector } from "@ashniva/connectors";
import { addDays, toISODate, type Platform } from "@ashniva/shared";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, as, sessionCookie } from "../helpers/api";
import { prisma, resetDb } from "../helpers/db";
import { createConnection, createOrg, createUser, createWorkspace } from "../helpers/factories";

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

/** LIVE connectors fail every call with `error`; sample (DEMO) ones still work. */
function failLive(error: Error) {
  const registry = connectors();
  const realGet = registry.get.bind(registry);
  vi.spyOn(registry, "get").mockImplementation(((platform: Platform, mode: "LIVE" | "DEMO" = "LIVE") => {
    if (mode === "DEMO") return realGet(platform, mode);
    return {
      platform,
      listAdAccounts: async () => {
        throw error;
      },
    } as unknown as AdPlatformConnector;
  }) as never);
}

describe("integration alerts", () => {
  it("a sync failure links to the Integrations page of the workspace using that login, in the app and the email", async () => {
    const owner = await createUser();
    const { org } = await createOrg(owner);
    const clientWs = await createWorkspace(org.id);
    const { connection } = await createConnection(org.id, { platform: "GOOGLE", mode: "LIVE", workspaceId: clientWs.id });
    failLive(new Error("Quota exceeded"));
    const info = vi.mocked(console.info);

    await expect(syncConnection(connection.id, "schedule")).rejects.toThrow("Quota exceeded");

    const res = await (await as(owner)).get(`/api/notifications?orgId=${org.id}`);
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(1);
    expect(res.body.items[0]).toMatchObject({ type: "integration.sync_failed", link: `/w/${clientWs.id}/integrations` });
    expect(await prisma.notification.findFirstOrThrow({ where: { orgId: org.id } })).toMatchObject({ workspaceId: clientWs.id });
    // No mail provider in tests, so the email is logged with its button's link.
    expect(info.mock.calls.some(([line]) => String(line).includes(`link=`) && String(line).includes(`/w/${clientWs.id}/integrations`))).toBe(true);
  });

  it("an expired login with no assigned account links to the org's first workspace", async () => {
    const owner = await createUser();
    const { org, workspace } = await createOrg(owner);
    await createWorkspace(org.id);
    const { connection } = await createConnection(org.id, { platform: "META", mode: "LIVE", workspaceId: null });
    const { ConnectorError } = await import("@ashniva/connectors");
    failLive(new ConnectorError("AUTH_EXPIRED", "Token revoked"));

    await expect(syncConnection(connection.id, "schedule")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    const note = await prisma.notification.findFirstOrThrow({ where: { orgId: org.id, type: "integration.expired" } });
    expect(note).toMatchObject({ link: `/w/${workspace.id}/integrations`, workspaceId: workspace.id });
  });

  it("the bell's list and mark-all-read are scoped to one organization", async () => {
    const owner = await createUser();
    const a = await createOrg(owner);
    const b = await createOrg(owner);
    for (const org of [a.org, b.org]) {
      await prisma.notification.create({ data: { orgId: org.id, userId: owner.id, type: "x", title: `Note ${org.id}` } });
    }
    const api = await as(owner);
    const list = await api.get(`/api/notifications?orgId=${a.org.id}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.unread).toBe(1);
    expect((await api.post("/api/notifications/read").send({ orgId: a.org.id })).status).toBe(204);
    expect((await api.get(`/api/notifications?orgId=${a.org.id}`)).body.unread).toBe(0);
    expect((await api.get(`/api/notifications?orgId=${b.org.id}`)).body.unread).toBe(1);
  });
});

describe("sample leads", () => {
  it("loading sample data fills the Leads page with leads tied to sample ads, and removing it removes them", async () => {
    const owner = await createUser();
    const { org, workspace } = await createOrg(owner);
    const api = await as(owner);
    expect((await api.post(`/api/orgs/${org.id}/sample-data`).send({ workspaceId: workspace.id })).status).toBe(202);

    // What the worker does with the queued sync jobs (only the platforms with lead-gen campaigns, to keep this quick).
    const conns = await prisma.platformConnection.findMany({ where: { orgId: org.id, mode: "DEMO", platform: { in: ["META", "LINKEDIN"] } } });
    expect(conns).toHaveLength(2);
    for (const c of conns) {
      const stats = await syncConnection(c.id, "sample");
      expect(stats.leads).toBeGreaterThan(0);
    }

    const today = toISODate(new Date());
    const res = await api.get(`/api/workspaces/${workspace.id}/leads?from=${addDays(today, -30)}&to=${addDays(today, 1)}&platform=META`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(100);
    const lead = res.body.leads[0];
    expect(lead).toMatchObject({ platform: "META", campaignName: "Lead Gen – Free Style Consultation" });
    expect(["fb", "ig"]).toContain(lead.source);
    expect(lead.email).toMatch(/@example\.com$/);
    expect(lead.phone).toMatch(/^\+91 98765 \d{5}$/);
    expect(lead.name).toBeTruthy();
    expect(lead.fields.city).toHaveLength(1);
    expect(lead.campaignId).toBeTruthy();
    expect(res.body.leads.some((l: { estCost: number | null }) => l.estCost != null && l.estCost > 0)).toBe(true);

    // A second sync adds nothing new.
    const before = await prisma.lead.count({ where: { orgId: org.id } });
    await syncConnection(conns[0]!.id, "sample");
    expect(await prisma.lead.count({ where: { orgId: org.id } })).toBe(before);

    expect((await api.delete(`/api/orgs/${org.id}/sample-data`)).status).toBe(200);
    expect(await prisma.lead.count({ where: { orgId: org.id } })).toBe(0);
  }, 240_000); // Syncs two sample accounts' full history.
});

describe("signed-in user deleted", () => {
  it("GET /api/auth/me with their still-valid access cookie is a 401 and clears the cookies", async () => {
    const user = await createUser();
    const cookie = await sessionCookie(user);
    const server = await app();
    expect((await request(server).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);

    await prisma.user.delete({ where: { id: user.id } });
    const res = await request(server).get("/api/auth/me").set("Cookie", cookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    const cleared = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
    expect(cleared.some((c) => c.startsWith("ash_at=;"))).toBe(true);
    expect(cleared.some((c) => c.startsWith("ash_rt=;"))).toBe(true);
  });

  it("a revoked session's access cookie is a 401 on any signed-in route", async () => {
    const user = await createUser();
    const { org } = await createOrg(user);
    const cookie = await sessionCookie(user);
    await prisma.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    const res = await request(await app()).get(`/api/orgs/${org.id}/connections`).set("Cookie", cookie);
    expect(res.status).toBe(401);
  });
});
