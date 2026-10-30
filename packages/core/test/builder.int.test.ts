import { DEMO_ACCOUNTS, type AdPlatformConnector } from "@ashniva/connectors";
import { BUILDER_SPECS, newDraft, type BuilderDraft, type DraftResult, type Platform } from "@ashniva/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { createOrg, createUser, createWorkspace } from "../../../test/helpers/factories";
import { DraftInvalidError, inspectDraft, launchDraft } from "../src/builder";
import { connectors } from "../src/connectors";
import { encryptSecret } from "../src/crypto";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const reset = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

let orgId: string;
let workspaceId: string;
let workspaceName: string;
let userId: string;

beforeEach(async () => {
  await reset();
  const user = await createUser();
  userId = user.id;
  const { org, workspace } = await createOrg(user, { name: "Saree House" });
  orgId = org.id;
  workspaceId = workspace.id;
  workspaceName = workspace.name;
});

afterEach(() => vi.restoreAllMocks());

let n = 0;
async function account(platform: Platform, opts: { mode?: "DEMO" | "LIVE"; status?: "ACTIVE" | "REVOKED"; workspaceId?: string } = {}) {
  const connection = await prisma.platformConnection.create({
    data: { orgId, platform, mode: opts.mode ?? "DEMO", externalUserId: `u${n++}`, accessTokenEnc: encryptSecret("tok"), status: opts.status ?? "ACTIVE" },
  });
  return prisma.adAccount.create({
    data: {
      orgId,
      connectionId: connection.id,
      platform,
      externalId: DEMO_ACCOUNTS[platform]?.externalId ?? `ext-${n++}`,
      name: `${platform} account`,
      currency: "INR",
      status: "ACTIVE",
      workspaceId: opts.workspaceId ?? workspaceId,
    },
  });
}

/** A complete Microsoft Search draft, with stale values in fields the form hides. */
function searchDraft(adAccountId: string): BuilderDraft {
  const d = newDraft(BUILDER_SPECS.MICROSOFT, adAccountId, { campaignType: "SEARCH" }, "Diwali Search");
  d.campaign.budget = 500;
  d.campaign.maxCpc = 99; // hidden: bid strategy is Maximize conversions
  const g = d.adGroups[0]!;
  g.values.keywords = [{ text: "silk saree", matchType: "PHRASE" }];
  const a = g.ads[0]!;
  a.values.finalUrl = "https://sareehouse.example.test/diwali";
  a.values.headlines = [{ text: "Silk sarees", pin: null }, { text: "Diwali sale", pin: null }, { text: "Free shipping", pin: null }];
  a.values.descriptions = [{ text: "Handwoven silk.", pin: null }, { text: "Order today.", pin: null }];
  a.values.path2 = "stale"; // hidden: path1 is empty
  return d;
}

const saveDraft = (payload: unknown) =>
  prisma.campaignDraft.create({ data: { orgId, workspaceId, name: "Draft", payload: payload as object, createdById: userId } });

describe("inspectDraft", () => {
  it("passes a complete draft and loads its account", async () => {
    const acc = await account("MICROSOFT");
    const r = await inspectDraft(workspaceId, searchDraft(acc.id));
    expect(r.issues).toEqual([]);
    expect(r.account?.id).toBe(acc.id);
    expect(r.account?.connection.mode).toBe("DEMO");
    expect(r.spec).toBe(BUILDER_SPECS.MICROSOFT);
  });

  it("rejects payloads from an older builder", async () => {
    await expect(inspectDraft(workspaceId, { platform: "META" })).rejects.toBeInstanceOf(DraftInvalidError);
    await expect(inspectDraft(workspaceId, null)).rejects.toThrow(/older builder/);
  });

  it("flags an account that is no longer in this workspace", async () => {
    const other = await createWorkspace(orgId);
    const acc = await account("MICROSOFT", { workspaceId: other.id });
    const { issues, account: found } = await inspectDraft(workspaceId, searchDraft(acc.id));
    expect(found).toBeNull();
    expect(issues[0]).toEqual({ level: "setup", message: "The ad account for this draft is no longer in this workspace." });
  });

  it("flags an account on another platform", async () => {
    const acc = await account("META");
    const { issues } = await inspectDraft(workspaceId, searchDraft(acc.id));
    expect(issues[0]).toEqual({ level: "setup", message: "The ad account doesn't match the draft's platform." });
  });

  it("flags a disconnected login", async () => {
    const acc = await account("MICROSOFT", { status: "REVOKED" });
    const { issues } = await inspectDraft(workspaceId, searchDraft(acc.id));
    expect(issues[0]!.message).toMatch(/is disconnected\. Reconnect it on the Integrations page\./);
  });

  it("flags a hidden platform", async () => {
    const acc = await account("TIKTOK");
    const d = newDraft(BUILDER_SPECS.TIKTOK, acc.id, { objective: "REACH" }, "x");
    const { issues } = await inspectDraft(workspaceId, d);
    expect(issues[0]).toEqual({ level: "setup", message: "TikTok Ads isn't available." });
  });

  it("returns the field-level issues of an incomplete draft", async () => {
    const acc = await account("MICROSOFT");
    const d = searchDraft(acc.id);
    d.campaign.budget = null;
    const { issues } = await inspectDraft(workspaceId, d);
    expect(issues).toEqual([expect.objectContaining({ level: "campaign", field: "budget" })]);
  });
});

describe("launchDraft", () => {
  it("creates the campaign on a sample account and mirrors it locally with previews", async () => {
    const acc = await account("MICROSOFT");
    const row = await saveDraft(searchDraft(acc.id));
    const launched = await launchDraft(row.id, userId);

    expect(launched.status).toBe("LAUNCHED");
    expect(launched.launchedAt).toBeInstanceOf(Date);
    const [result] = launched.results as unknown as DraftResult[];
    const campaign = await prisma.campaign.findFirstOrThrow({ where: { adAccountId: acc.id } });
    expect(result).toEqual({
      adAccountId: acc.id,
      platform: "MICROSOFT",
      ok: true,
      campaignId: campaign.id,
      externalId: campaign.externalId,
      created: { adGroups: 1, ads: 1 },
    });
    expect(campaign).toMatchObject({ name: "Diwali Search", status: "PAUSED", platform: "MICROSOFT" });
    expect(Number(campaign.dailyBudget)).toBe(500);

    const ad = await prisma.ad.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const preview = ad.preview as Record<string, any>;
    expect(preview.platform).toBe("MICROSOFT");
    expect(preview.setup).toEqual({ campaignType: "SEARCH" });
    expect(preview.ad.finalUrl).toBe("https://sareehouse.example.test/diwali");
    expect(preview.ad).not.toHaveProperty("path2");
    expect(preview.campaign).not.toHaveProperty("maxCpc");
    expect(preview.identity).toEqual({ name: workspaceName });
    expect(preview.media).toEqual({});

    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "campaign.created" } });
    expect(log).toMatchObject({ orgId, workspaceId, userId, entityType: "campaign", entityId: campaign.id, entityName: expect.stringContaining("Diwali Search (") });
    expect(log.changes).toEqual({ status: { from: null, to: "PAUSED" }, dailyBudget: { from: null, to: 500 } });
  });

  it("only sends visible values to the connector", async () => {
    const acc = await account("MICROSOFT");
    const demo = connectors().get("MICROSOFT", "DEMO");
    const spy = vi.spyOn(demo, "createCampaign" as never);
    const row = await saveDraft(searchDraft(acc.id));
    await launchDraft(row.id, userId);

    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]![2] as unknown as BuilderDraft;
    expect(sent.campaign).not.toHaveProperty("maxCpc");
    expect(sent.campaign.budget).toBe(500);
    expect(sent.adGroups[0]!.ads[0]!.values).not.toHaveProperty("path2");
    // Performance Max asset-group fields are hidden on a Search ad group.
    expect(sent.adGroups[0]!.values).not.toHaveProperty("longHeadlines");
    expect(sent.adGroups[0]!.values.keywords).toEqual([{ text: "silk saree", matchType: "PHRASE" }]);
  });

  it("refuses an invalid draft without touching it", async () => {
    const acc = await account("MICROSOFT");
    const d = searchDraft(acc.id);
    d.adGroups[0]!.ads[0]!.values.finalUrl = "";
    const row = await saveDraft(d);
    await expect(launchDraft(row.id, userId)).rejects.toBeInstanceOf(DraftInvalidError);
    expect((await prisma.campaignDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DRAFT");
    expect(await prisma.campaign.count()).toBe(0);
  });

  it("refuses a live platform whose connector can't be loaded", async () => {
    const acc = await account("MICROSOFT", { mode: "LIVE" });
    vi.spyOn(connectors(), "get").mockImplementation(() => {
      throw new Error("MICROSOFT integration is coming soon.");
    });
    const row = await saveDraft(searchDraft(acc.id));
    const err = await launchDraft(row.id, userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftInvalidError);
    expect((err as DraftInvalidError).issues[0]!.message).toMatch(/^Creating .* campaigns isn't available yet\.$/);
    expect((await prisma.campaignDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DRAFT");
  });

  it("refuses a live connector that can't create campaigns", async () => {
    const acc = await account("MICROSOFT", { mode: "LIVE" });
    vi.spyOn(connectors(), "get").mockReturnValue({ platform: "MICROSOFT" } as unknown as AdPlatformConnector);
    const row = await saveDraft(searchDraft(acc.id));
    await expect(launchDraft(row.id, userId)).rejects.toThrow(/isn't available yet/);
  });

  it("refuses a live setup the platform API can't create", async () => {
    const acc = await account("MICROSOFT", { mode: "LIVE" });
    const createCampaign = vi.fn();
    vi.spyOn(connectors(), "get").mockReturnValue({ platform: "MICROSOFT", createCampaign } as unknown as AdPlatformConnector);
    const spec = BUILDER_SPECS.MICROSOFT;
    const original = spec.apiCreatable;
    spec.apiCreatable = () => "Search campaigns need approval first.";
    try {
      const row = await saveDraft(searchDraft(acc.id));
      await expect(launchDraft(row.id, userId)).rejects.toThrow("Search campaigns need approval first.");
      spec.apiCreatable = () => false;
      await expect(launchDraft(row.id, userId)).rejects.toThrow("This campaign type can't be created through the platform's API.");
    } finally {
      spec.apiCreatable = original;
    }
    expect(createCampaign).not.toHaveBeenCalled();
  });

  it("records a platform failure on the draft", async () => {
    const acc = await account("MICROSOFT", { mode: "LIVE" });
    const createCampaign = vi.fn().mockRejectedValue(new Error("Budget below minimum"));
    vi.spyOn(connectors(), "get").mockReturnValue({ platform: "MICROSOFT", createCampaign } as unknown as AdPlatformConnector);
    const row = await saveDraft(searchDraft(acc.id));
    const failed = await launchDraft(row.id, userId);
    expect(failed.status).toBe("FAILED");
    expect(failed.results).toEqual([{ adAccountId: acc.id, platform: "MICROSOFT", ok: false, error: "Budget below minimum" }]);
    expect(createCampaign).toHaveBeenCalledWith({ accessToken: "tok", credentials: null }, expect.objectContaining({ externalId: acc.externalId }), expect.anything(), expect.any(Map));
  });

  it("passes creatives as uploadable assets and caches their platform ref", async () => {
    const acc = await account("MICROSOFT", { mode: "LIVE" });
    const creative = await prisma.creative.create({
      data: { orgId, workspaceId, name: "banner.png", type: "IMAGE", mimeType: "image/png", sizeBytes: 3, width: 1200, height: 628, storageKey: "creatives/missing.png", url: "/api/files/creatives/missing.png" },
    });
    const d = newDraft(BUILDER_SPECS.MICROSOFT, acc.id, { campaignType: "AUDIENCE" }, "Diwali Audience");
    d.campaign.budget = 800;
    Object.assign(d.adGroups[0]!.ads[0]!.values, {
      finalUrl: "https://sareehouse.example.com/diwali",
      businessName: "Saree House",
      headlines: ["Silk sarees"],
      longHeadlines: ["Handwoven silk sarees for Diwali"],
      descriptions: ["Free shipping"],
      landscapeImages: [creative.id],
    });
    let loadError: unknown;
    const createCampaign = vi.fn(async (_auth: unknown, _ref: unknown, _draft: unknown, assets: Map<string, { load: () => Promise<Buffer>; onUploaded: (r: string) => Promise<void>; cachedRef?: string }>) => {
      const asset = assets.get(creative.id)!;
      expect(asset.cachedRef).toBeUndefined();
      loadError = await asset.load().catch((e: unknown) => e);
      await asset.onUploaded("img-hash-1");
      return {
        campaigns: [{ externalId: "live-c", name: "Diwali Search", status: "PAUSED", deliveryStatus: null, objective: null, dailyBudget: null, lifetimeBudget: null, startDate: null, endDate: null, updatedAt: null, raw: {} }],
        adGroups: [],
        ads: [],
        warnings: ["Keyword limit reached"],
      };
    });
    vi.spyOn(connectors(), "get").mockReturnValue({ platform: "MICROSOFT", createCampaign } as unknown as AdPlatformConnector);
    const row = await saveDraft(d);
    const launched = await launchDraft(row.id, userId);
    expect(createCampaign).toHaveBeenCalledTimes(1);
    expect(loadError).toBeInstanceOf(Error);
    expect((loadError as Error).message).toContain("file is missing");
    expect((await prisma.creative.findUniqueOrThrow({ where: { id: creative.id } })).platformAssets).toEqual({ [acc.id]: { ref: "img-hash-1" } });
    expect((launched.results as unknown as DraftResult[])[0]).toMatchObject({ ok: true, warnings: ["Keyword limit reached"] });
  });
});
