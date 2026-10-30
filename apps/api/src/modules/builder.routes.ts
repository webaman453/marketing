import { assertFeature, connectors, getConnectorAuth, inspectDraft, launchDraft } from "@ashniva/core";
import { prisma, type CampaignDraft, type Prisma } from "@ashniva/db";
import {
  COUNTRIES,
  LANGUAGES,
  TARGETING_KINDS,
  draftSchema,
  isBuilderDraft,
  type BuilderOptions,
  type DraftDTO,
  type DraftResult,
  type TargetingKind,
  type TargetingSearchResult,
} from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { badRequest, conflict, notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const builderRouter = Router({ mergeParams: true });

const toDraftDTO = (d: CampaignDraft & { createdByName?: string | null }): DraftDTO => ({
  id: d.id,
  name: d.name,
  status: d.status,
  payload: d.payload as Record<string, unknown>,
  results: (d.results as DraftResult[] | null) ?? null,
  createdBy: d.createdByName ?? null,
  launchedAt: d.launchedAt?.toISOString() ?? null,
  updatedAt: d.updatedAt.toISOString(),
});

async function accountFor(workspaceId: string, adAccountId: string) {
  const account = await prisma.adAccount.findFirst({ where: { id: adAccountId, workspaceId }, include: { connection: true } });
  if (!account) throw notFound("Ad account");
  const connector = connectors().get(account.platform, account.connection.mode);
  const ref = { externalId: account.externalId, currency: account.currency, meta: account.meta as Record<string, unknown> | null };
  return { account, connector, ref };
}

/** Pages, pixels, identities and other account assets the builder offers. */
builderRouter.get("/builder/options", requirePermission("campaigns:edit"), async (req, res) => {
  const { account, connector, ref } = await accountFor(req.workspace!.id, String(req.query.adAccountId ?? ""));
  if (!connector.getBuilderOptions) {
    res.json({} satisfies BuilderOptions);
    return;
  }
  res.json(await connector.getBuilderOptions(await getConnectorAuth(account.connection), ref));
});

/** Typeahead for locations, interests, job titles and similar. */
builderRouter.get("/builder/targeting", requirePermission("campaigns:edit"), async (req, res) => {
  const q = parse(
    z.object({ adAccountId: z.string(), kind: z.enum(TARGETING_KINDS), q: z.string().trim().max(100).default("") }),
    req.query,
  );
  const { account, connector, ref } = await accountFor(req.workspace!.id, q.adAccountId);
  const kind = q.kind as TargetingKind;
  let results: TargetingSearchResult[] = [];
  if (connector.searchTargeting) {
    results = await connector.searchTargeting(await getConnectorAuth(account.connection), ref, kind, q.q);
  }
  // Countries and languages always work, even before a platform search is available.
  if (results.length === 0 && kind === "location") {
    const needle = q.q.toLowerCase();
    results = COUNTRIES.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.code.toLowerCase() === needle)
      .slice(0, 25)
      .map((c) => ({ id: c.code, name: c.name, type: "country", detail: "Country" }));
  }
  if (results.length === 0 && kind === "language") {
    const needle = q.q.toLowerCase();
    results = LANGUAGES.filter((l) => !needle || l.name.toLowerCase().includes(needle)).map((l) => ({ id: l.code, name: l.name }));
  }
  res.json(results);
});

builderRouter.get("/drafts", async (req, res) => {
  const drafts = await prisma.campaignDraft.findMany({
    where: { workspaceId: req.workspace!.id },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const users = await prisma.user.findMany({
    where: { id: { in: drafts.map((d) => d.createdById).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  res.json(drafts.filter((d) => isBuilderDraft(d.payload)).map((d) => toDraftDTO({ ...d, createdByName: d.createdById ? nameOf.get(d.createdById) : null })));
});

async function assertPayload(workspaceId: string, payload: unknown) {
  if (!isBuilderDraft(payload)) throw badRequest("This doesn't look like a campaign draft.");
  const account = await prisma.adAccount.findFirst({ where: { id: payload.adAccountId, workspaceId }, select: { platform: true } });
  if (!account) throw badRequest("Choose an ad account from this workspace.");
  if (account.platform !== payload.platform) throw badRequest("The ad account doesn't match the draft's platform.");
}

builderRouter.post("/drafts", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(draftSchema, req.body);
  await assertPayload(req.workspace!.id, input.payload);
  const draft = await prisma.campaignDraft.create({
    data: {
      orgId: req.org!.id,
      workspaceId: req.workspace!.id,
      name: input.name || "Untitled campaign",
      payload: input.payload as Prisma.InputJsonValue,
      createdById: req.userId,
    },
  });
  res.status(201).json(toDraftDTO(draft));
});

async function findDraft(workspaceId: string, id: string) {
  const d = await prisma.campaignDraft.findFirst({ where: { id, workspaceId } });
  if (!d) throw notFound("Draft");
  return d;
}

builderRouter.get("/drafts/:draftId", async (req, res) => {
  res.json(toDraftDTO(await findDraft(req.workspace!.id, req.params.draftId as string)));
});

builderRouter.patch("/drafts/:draftId", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(draftSchema, req.body);
  const d = await findDraft(req.workspace!.id, req.params.draftId as string);
  if (d.status === "LAUNCHING" || d.status === "LAUNCHED") throw conflict("This campaign has already been launched.");
  await assertPayload(req.workspace!.id, input.payload);
  const updated = await prisma.campaignDraft.update({
    where: { id: d.id },
    // Editing a failed draft makes it a draft again.
    data: { name: input.name || d.name, payload: input.payload as Prisma.InputJsonValue, status: "DRAFT" },
  });
  res.json(toDraftDTO(updated));
});

builderRouter.post("/drafts/:draftId/duplicate", requirePermission("campaigns:edit"), async (req, res) => {
  const d = await findDraft(req.workspace!.id, req.params.draftId as string);
  const copy = await prisma.campaignDraft.create({
    data: {
      orgId: d.orgId,
      workspaceId: d.workspaceId,
      name: `${d.name} (copy)`,
      payload: { ...(d.payload as Record<string, unknown>), campaign: { ...((d.payload as { campaign?: Record<string, unknown> }).campaign ?? {}), name: `${d.name} (copy)` } } as Prisma.InputJsonValue,
      createdById: req.userId,
    },
  });
  res.status(201).json(toDraftDTO(copy));
});

builderRouter.delete("/drafts/:draftId", requirePermission("campaigns:edit"), async (req, res) => {
  const d = await findDraft(req.workspace!.id, req.params.draftId as string);
  if (d.status === "LAUNCHING") throw conflict("This campaign is being launched right now.");
  await prisma.campaignDraft.delete({ where: { id: d.id } });
  res.status(204).end();
});

/** Every problem in the saved draft, so the review step can list them. */
builderRouter.post("/drafts/:draftId/validate", requirePermission("campaigns:edit"), async (req, res) => {
  const d = await findDraft(req.workspace!.id, req.params.draftId as string);
  const { issues } = await inspectDraft(req.workspace!.id, d.payload).catch((err: { issues?: unknown[] }) => ({ issues: err.issues ?? [] }));
  res.json({ ok: issues.length === 0, issues });
});

builderRouter.post("/drafts/:draftId/launch", requirePermission("campaigns:edit"), async (req, res) => {
  assertFeature(req.org!, "campaign_builder");
  const d = await findDraft(req.workspace!.id, req.params.draftId as string);
  if (d.status === "LAUNCHING" || d.status === "LAUNCHED") throw conflict("This campaign has already been launched.");
  const launched = await launchDraft(d.id, req.userId!);
  res.json(toDraftDTO(launched));
});
