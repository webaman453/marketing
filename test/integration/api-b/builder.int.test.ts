/**
 * Campaign builder: account options and targeting search on sample (DEMO)
 * accounts, draft CRUD, validation, and launch into campaigns/ad groups/ads.
 */
import { getSyncQueue } from "@ashniva/core";
import { BUILDER_SPECS, newDraft, setupOptions, type BuilderDraft, type Platform } from "@ashniva/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { createConnection, fetchCalls, orgWith, resetAll, stubFetch } from "./helpers";

afterAll(async () => {
  await getSyncQueue().close();
});
beforeEach(resetAll);

/** A complete Amazon Sponsored Products draft (no creatives needed). */
function amazonDraft(adAccountId: string, name = "Diwali SP"): BuilderDraft {
  const spec = BUILDER_SPECS.AMAZON;
  const draft = newDraft(spec, adAccountId, { adProduct: "SPONSORED_PRODUCTS" }, name);
  draft.campaign.budget = 750;
  draft.adGroups[0]!.values.defaultBid = 4.5;
  draft.adGroups[0]!.ads[0]!.values.asin = "B0TESTASIN";
  return draft;
}

/** A first-choice draft for any platform; usually incomplete. */
function roughDraft(platform: Platform, adAccountId: string): BuilderDraft {
  const spec = BUILDER_SPECS[platform];
  const setup: Record<string, unknown> = {};
  for (const c of spec.setup) if (!c.showIf || c.showIf(setup)) setup[c.key] = setupOptions(c, setup)[0]?.value;
  return newDraft(spec, adAccountId, setup, `${platform} draft`);
}

async function setup(role: "OWNER" | "MANAGER" | "ANALYST" | "CLIENT" = "OWNER", platform: Platform = "AMAZON", mode: "DEMO" | "LIVE" = "DEMO") {
  const ctx = await orgWith(role);
  const { adAccount, connection } = await createConnection(ctx.org.id, { platform, mode, workspaceId: ctx.workspace.id });
  return { ...ctx, adAccount, connection, api: await as(ctx.user), base: `/api/workspaces/${ctx.workspace.id}` };
}

describe("builder options and targeting (DEMO account)", () => {
  it("returns sample account assets and searches targeting without calling a platform", async () => {
    const { api, base, adAccount: amazon, org, workspace } = await setup();
    const opts = await api.get(`${base}/builder/options?adAccountId=${amazon.id}`);
    expect(opts.status).toBe(200);
    expect(typeof opts.body).toBe("object");

    const { adAccount: meta } = await createConnection(org.id, { platform: "META", workspaceId: workspace.id });
    const metaOpts = await api.get(`${base}/builder/options?adAccountId=${meta.id}`);
    expect(metaOpts.status).toBe(200);
    expect(Array.isArray(metaOpts.body.pages)).toBe(true);

    const loc = await api.get(`${base}/builder/targeting?adAccountId=${meta.id}&kind=location&q=ind`);
    expect(loc.status).toBe(200);
    expect(loc.body.length).toBeGreaterThan(0);
    expect(loc.body.some((r: { name: string }) => /ind/i.test(r.name))).toBe(true);

    const lang = await api.get(`${base}/builder/targeting?adAccountId=${meta.id}&kind=language&q=hin`);
    expect(lang.status).toBe(200);
    expect(lang.body.some((r: { name: string }) => r.name === "Hindi")).toBe(true);

    expect((await api.get(`${base}/builder/targeting?adAccountId=${meta.id}&kind=bogus`)).status).toBe(422);
    expect(fetchCalls).toHaveLength(0);
  });

  it("only offers accounts of this workspace", async () => {
    const { api, base } = await setup();
    const other = await orgWith();
    const { adAccount: foreign } = await createConnection(other.org.id, { platform: "META", workspaceId: other.workspace.id });
    expect((await api.get(`${base}/builder/options?adAccountId=${foreign.id}`)).status).toBe(404);
    expect((await api.get(`${base}/builder/targeting?adAccountId=${foreign.id}&kind=location`)).status).toBe(404);
  });

  it("needs campaigns:edit", async () => {
    for (const role of ["ANALYST", "CLIENT"] as const) {
      const { api, base, adAccount } = await setup(role);
      expect((await api.get(`${base}/builder/options?adAccountId=${adAccount.id}`)).status, role).toBe(403);
    }
  });
});

describe("drafts", () => {
  it("creates, lists, reads, updates, duplicates and deletes a draft", async () => {
    const { api, base, adAccount, user } = await setup("MANAGER");
    const created = await api.post(`${base}/drafts`).send({ name: "Diwali SP", payload: amazonDraft(adAccount.id) });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Diwali SP", status: "DRAFT", results: null, launchedAt: null });
    const id = created.body.id;

    const list = await api.get(`${base}/drafts`);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([id]);
    expect(list.body[0].createdBy).toBe(user.name);

    const changed = amazonDraft(adAccount.id, "Diwali SP v2");
    changed.campaign.budget = 900;
    const patched = await api.patch(`${base}/drafts/${id}`).send({ name: "Diwali SP v2", payload: changed });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe("Diwali SP v2");
    expect((await api.get(`${base}/drafts/${id}`)).body.payload.campaign.budget).toBe(900);

    const dup = await api.post(`${base}/drafts/${id}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.body.name).toBe("Diwali SP v2 (copy)");
    expect(dup.body.payload.campaign.name).toBe("Diwali SP v2 (copy)");
    expect(dup.body.id).not.toBe(id);

    expect((await api.delete(`${base}/drafts/${id}`)).status).toBe(204);
    expect((await api.get(`${base}/drafts/${id}`)).status).toBe(404);
    expect(await prisma.campaignDraft.count()).toBe(1);
  });

  it("refuses payloads that aren't drafts or use an account from elsewhere", async () => {
    const { api, base, adAccount, org } = await setup();
    expect((await api.post(`${base}/drafts`).send({ name: "x", payload: { hello: "world" } })).status).toBe(400);
    const other = await orgWith();
    const { adAccount: foreign } = await createConnection(other.org.id, { platform: "AMAZON", workspaceId: other.workspace.id });
    expect((await api.post(`${base}/drafts`).send({ name: "x", payload: amazonDraft(foreign.id) })).status).toBe(400);
    const { adAccount: meta } = await createConnection(org.id, { platform: "META", workspaceId: (await prisma.workspace.findFirstOrThrow({ where: { orgId: org.id } })).id });
    const mismatched = { ...amazonDraft(meta.id) };
    const res = await api.post(`${base}/drafts`).send({ name: "x", payload: mismatched });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/doesn't match/);
    expect(adAccount).toBeTruthy();
  });

  it("is read-only for analysts and clients", async () => {
    for (const role of ["ANALYST", "CLIENT"] as const) {
      const { api, base, adAccount, org, workspace, owner } = await setup(role);
      const draft = await prisma.campaignDraft.create({ data: { orgId: org.id, workspaceId: workspace.id, name: "D", payload: amazonDraft(adAccount.id) as object, createdById: owner.id } });
      expect((await api.get(`${base}/drafts`)).status, role).toBe(200);
      expect((await api.post(`${base}/drafts`).send({ name: "x", payload: amazonDraft(adAccount.id) })).status, role).toBe(403);
      expect((await api.patch(`${base}/drafts/${draft.id}`).send({ name: "x", payload: amazonDraft(adAccount.id) })).status, role).toBe(403);
      expect((await api.post(`${base}/drafts/${draft.id}/duplicate`)).status, role).toBe(403);
      expect((await api.post(`${base}/drafts/${draft.id}/validate`)).status, role).toBe(403);
      expect((await api.post(`${base}/drafts/${draft.id}/launch`)).status, role).toBe(403);
      expect((await api.delete(`${base}/drafts/${draft.id}`)).status, role).toBe(403);
    }
  });

  it("returns 402 for writes while the organization is locked", async () => {
    const { api, base, adAccount, org } = await setup();
    await prisma.organization.update({ where: { id: org.id }, data: { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 86_400_000) } });
    const res = await api.post(`${base}/drafts`).send({ name: "x", payload: amazonDraft(adAccount.id) });
    expect(res.status).toBe(402);
    expect((await api.get(`${base}/drafts`)).status).toBe(200);
  });
});

describe("validate and launch", () => {
  it("lists every issue of an incomplete draft", async () => {
    const { api, base, adAccount } = await setup();
    const rough = roughDraft("AMAZON", adAccount.id);
    const d = await api.post(`${base}/drafts`).send({ name: "rough", payload: rough });
    const res = await api.post(`${base}/drafts/${d.body.id}/validate`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    const fields = res.body.issues.map((i: { field?: string }) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["budget", "defaultBid", "asin"]));

    const good = await api.post(`${base}/drafts`).send({ name: "good", payload: amazonDraft(adAccount.id) });
    expect((await api.post(`${base}/drafts/${good.body.id}/validate`)).body).toEqual({ ok: true, issues: [] });

    // Launching the incomplete one is a 422 with the same issues.
    const launch = await api.post(`${base}/drafts/${d.body.id}/launch`);
    expect(launch.status).toBe(422);
    expect(launch.body.error.code).toBe("DRAFT_INVALID");
    expect(launch.body.error.issues.length).toBe(res.body.issues.length);
  });

  it("launches on a DEMO account: campaign, ad group and ad rows with previews, draft LAUNCHED", async () => {
    const { api, base, adAccount, org, user } = await setup("MANAGER");
    const d = await api.post(`${base}/drafts`).send({ name: "Diwali SP", payload: amazonDraft(adAccount.id) });
    const res = await api.post(`${base}/drafts/${d.body.id}/launch`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("LAUNCHED");
    expect(res.body.launchedAt).toBeTruthy();
    const [result] = res.body.results;
    expect(result).toMatchObject({ ok: true, platform: "AMAZON", adAccountId: adAccount.id, created: { adGroups: 1, ads: 1 } });

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: result.campaignId }, include: { adGroups: true, ads: true } });
    expect(campaign).toMatchObject({ adAccountId: adAccount.id, platform: "AMAZON", name: "Diwali SP", externalId: result.externalId });
    expect(Number(campaign.dailyBudget)).toBe(750);
    expect(campaign.adGroups).toHaveLength(1);
    expect(campaign.ads).toHaveLength(1);
    const preview = campaign.ads[0]!.preview as { platform: string; ad: Record<string, unknown> };
    expect(preview.platform).toBe("AMAZON");
    expect(preview.ad.asin).toBe("B0TESTASIN");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "campaign.created" } });
    expect(log).toMatchObject({ entityId: campaign.id, userId: user.id });

    // Launched drafts are frozen.
    expect((await api.post(`${base}/drafts/${d.body.id}/launch`)).status).toBe(409);
    expect((await api.patch(`${base}/drafts/${d.body.id}`).send({ name: "x", payload: amazonDraft(adAccount.id) })).status).toBe(409);

    // The campaign detail shows the preview.
    const today = new Date().toISOString().slice(0, 10);
    const detail = await api.get(`${base}/campaigns/${campaign.id}?from=${today}&to=${today}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ads[0].preview.platform).toBe("AMAZON");
    expect(fetchCalls).toHaveLength(0);
  });

  it("launching the same draft twice at once creates the campaign once", async () => {
    const { api, base, adAccount } = await setup();
    const d = await api.post(`${base}/drafts`).send({ name: "Double click", payload: amazonDraft(adAccount.id) });
    const results = await Promise.all(Array.from({ length: 4 }, () => api.post(`${base}/drafts/${d.body.id}/launch`)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await prisma.campaign.count({ where: { adAccountId: adAccount.id } })).toBe(1);
  });

  it("blocks hidden platforms at validate and launch", async () => {
    const { api, base, adAccount, org, workspace } = await setup("OWNER", "TIKTOK");
    const draft = await prisma.campaignDraft.create({ data: { orgId: org.id, workspaceId: workspace.id, name: "tt", payload: roughDraft("TIKTOK", adAccount.id) as object } });
    const v = await api.post(`${base}/drafts/${draft.id}/validate`);
    expect(v.body.issues[0].message).toMatch(/TikTok Ads isn't available/);
    const launch = await api.post(`${base}/drafts/${draft.id}/launch`);
    expect(launch.status).toBe(422);
    expect(launch.body.error.issues[0].message).toMatch(/isn't available/);
    expect(await prisma.campaign.count()).toBe(0);
  });

  it("answers a live platform that can't publish with 422, not 500", async () => {
    // Swiggy has no public ads API: its connector doesn't exist and its spec isn't API-creatable.
    const { api, base, adAccount, org, workspace } = await setup("OWNER", "SWIGGY", "LIVE");
    const draft = await prisma.campaignDraft.create({ data: { orgId: org.id, workspaceId: workspace.id, name: "sw", payload: roughDraft("SWIGGY", adAccount.id) as object } });
    const launch = await api.post(`${base}/drafts/${draft.id}/launch`);
    expect(launch.status).toBe(422);
    expect(await prisma.campaignDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "DRAFT" });
  });

  it("records a failed live launch on the draft instead of erroring", async () => {
    const { api, base, adAccount } = await setup("OWNER", "AMAZON", "LIVE");
    stubFetch([[/amazon/, { status: 401, json: { code: "UNAUTHORIZED", details: "Not authorized" } }]]);
    const d = await api.post(`${base}/drafts`).send({ name: "Live SP", payload: amazonDraft(adAccount.id) });
    const res = await api.post(`${base}/drafts/${d.body.id}/launch`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FAILED");
    expect(res.body.results[0]).toMatchObject({ ok: false, platform: "AMAZON" });
    expect(res.body.results[0].error).toBeTruthy();
    expect(await prisma.campaign.count()).toBe(0);
    // Every request went to Amazon's (stubbed) API, nowhere else.
    expect(fetchCalls.every((c) => /amazon/.test(c.url))).toBe(true);
  });

  it("returns 402 for launch while locked", async () => {
    const { api, base, adAccount, org } = await setup();
    const d = await api.post(`${base}/drafts`).send({ name: "x", payload: amazonDraft(adAccount.id) });
    await prisma.organization.update({ where: { id: org.id }, data: { plan: "GROWTH", subscriptionStatus: "EXPIRED" } });
    const res = await api.post(`${base}/drafts/${d.body.id}/launch`);
    expect(res.status).toBe(402);
    expect((await prisma.campaignDraft.findUniqueOrThrow({ where: { id: d.body.id } })).status).toBe("DRAFT");
  });
});
