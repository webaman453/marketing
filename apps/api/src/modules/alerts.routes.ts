/**
 * Acting on alerts: approving what a rule suggested, tuning and muting unusual-spend alerts,
 * and the one-click links inside Slack, webhook and email alerts.
 */
import {
  SuggestionError,
  approveSuggestion,
  assertNotLocked,
  audit,
  campaignWithConnection,
  changeCampaignStatus,
  dismissSuggestion,
  verifyAlertAction,
} from "@ashniva/core";
import { prisma } from "@ashniva/db";
import {
  anomalySettingsSchema,
  can,
  hasAllWorkspaceAccess,
  ruleActionSchema,
  type AlertActionInfoDTO,
  type AnomalySettingsDTO,
  type RuleSuggestionDTO,
} from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { badRequest, forbidden, notFound, parse } from "../lib/errors";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const alertsRouter = Router({ mergeParams: true });

// ───────── Rule suggestions ("ask me first" rules) ─────────

alertsRouter.get("/rule-suggestions", async (req, res) => {
  const rows = await prisma.ruleSuggestion.findMany({
    where: { workspaceId: req.workspace!.id, status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { rule: { select: { name: true } } },
  });
  res.json(
    rows.map(
      (s): RuleSuggestionDTO => ({
        id: s.id,
        ruleId: s.ruleId,
        ruleName: s.rule.name,
        campaignId: s.campaignId,
        campaignName: s.campaignName,
        platform: s.platform,
        actions: z.array(ruleActionSchema).catch([]).parse(s.actions),
        values: (s.values as Record<string, number | null>) ?? {},
        createdAt: s.createdAt.toISOString(),
      }),
    ),
  );
});

const suggestionFailure = (err: unknown) => (err instanceof SuggestionError ? badRequest(err.message) : err);

alertsRouter.post("/rule-suggestions/:id/approve", requirePermission("campaigns:edit"), async (req, res) => {
  try {
    res.json(await approveSuggestion(req.workspace!.id, req.params.id as string, req.userId!));
  } catch (err) {
    throw suggestionFailure(err);
  }
});

alertsRouter.post("/rule-suggestions/:id/dismiss", requirePermission("campaigns:edit"), async (req, res) => {
  try {
    await dismissSuggestion(req.workspace!.id, req.params.id as string, req.userId!);
    res.status(204).end();
  } catch (err) {
    throw suggestionFailure(err);
  }
});

// ───────── Unusual-spend alerts: sensitivity and mutes ─────────

const settingsOf = (w: { anomalyEnabled: boolean; anomalySpikeRatio: number; anomalyDeadDays: number }): AnomalySettingsDTO => ({
  enabled: w.anomalyEnabled,
  spikeRatio: w.anomalySpikeRatio,
  deadDays: w.anomalyDeadDays,
});

alertsRouter.get("/anomaly-settings", (req, res) => {
  res.json(settingsOf(req.workspace!));
});

alertsRouter.put("/anomaly-settings", requirePermission("workspaces:manage"), async (req, res) => {
  const input = parse(anomalySettingsSchema, req.body);
  const w = await prisma.workspace.update({
    where: { id: req.workspace!.id },
    data: { anomalyEnabled: input.enabled, anomalySpikeRatio: input.spikeRatio, anomalyDeadDays: input.deadDays },
  });
  await audit({ orgId: w.orgId, workspaceId: w.id, userId: req.userId, action: "workspace.anomaly_settings_updated", entityType: "workspace", entityId: w.id, entityName: w.name });
  res.json(settingsOf(w));
});

async function ownCampaign(workspaceId: string, campaignId: string) {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, adAccount: { workspaceId } }, select: { id: true, name: true, adAccount: { select: { orgId: true } } } });
  if (!c) throw notFound("Campaign");
  return c;
}

alertsRouter.get("/campaigns/:campaignId/anomaly-snooze", async (req, res) => {
  const c = await ownCampaign(req.workspace!.id, req.params.campaignId as string);
  const s = await prisma.anomalySnooze.findUnique({ where: { campaignId: c.id } });
  res.json({ until: s && s.until > new Date() ? s.until.toISOString() : null });
});

alertsRouter.post("/campaigns/:campaignId/anomaly-snooze", requirePermission("campaigns:edit"), async (req, res) => {
  const { days } = parse(z.object({ days: z.number().int().min(1).max(30) }), req.body);
  const c = await ownCampaign(req.workspace!.id, req.params.campaignId as string);
  const until = new Date(Date.now() + days * 86_400_000);
  await prisma.anomalySnooze.upsert({
    where: { campaignId: c.id },
    create: { campaignId: c.id, orgId: c.adAccount.orgId, until, createdById: req.userId },
    update: { until, createdById: req.userId },
  });
  res.json({ until: until.toISOString() });
});

alertsRouter.delete("/campaigns/:campaignId/anomaly-snooze", requirePermission("campaigns:edit"), async (req, res) => {
  const c = await ownCampaign(req.workspace!.id, req.params.campaignId as string);
  await prisma.anomalySnooze.deleteMany({ where: { campaignId: c.id } });
  res.status(204).end();
});

// ───────── One-click links in alerts ─────────

/** Mounted at /api/alert-actions after requireAuth. */
export const alertActionsRouter = Router();

/** The campaign a link points at, once the caller is known to be allowed to change it. */
async function resolveAction(token: string, userId: string) {
  const claims = verifyAlertAction(token);
  if (!claims) throw badRequest("This link has expired or isn't valid. Open the campaign in Ashniva Ads instead.");
  const campaign = await prisma.campaign.findUnique({
    where: { id: claims.c },
    include: { ...campaignWithConnection, adAccount: { include: { workspace: true, org: true, connection: true } } },
  });
  const workspace = campaign?.adAccount.workspace;
  if (!campaign || !workspace || workspace.archivedAt || campaign.adAccount.orgId !== claims.o) throw notFound("Campaign");
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId: claims.o } },
    include: { workspaces: { where: { workspaceId: workspace.id } } },
  });
  // Same answer as a missing campaign, so a link doesn't confirm that someone else's campaign exists.
  if (!membership || (!hasAllWorkspaceAccess(membership.role) && membership.workspaces.length === 0)) throw notFound("Campaign");
  if (!can(membership.role, "campaigns:edit")) throw forbidden();
  return { claims, campaign, workspace, org: campaign.adAccount.org };
}

alertActionsRouter.get("/:token", async (req, res) => {
  const { claims, campaign, workspace } = await resolveAction(req.params.token as string, req.userId!);
  const alreadyPaused = claims.a === "pause" && campaign.status !== "ACTIVE";
  const info: AlertActionInfoDTO = {
    action: claims.a,
    campaignName: campaign.name,
    platform: campaign.platform,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    days: claims.a === "snooze" ? (claims.d ?? 7) : null,
    available: !alreadyPaused,
    note: alreadyPaused ? "This campaign isn't running, so there's nothing to pause." : null,
  };
  res.json(info);
});

alertActionsRouter.post("/:token", async (req, res) => {
  const { claims, campaign, workspace, org } = await resolveAction(req.params.token as string, req.userId!);
  if (claims.a === "pause") {
    assertNotLocked(org);
    await changeCampaignStatus(campaign, "PAUSED", { orgId: org.id, workspaceId: workspace.id, userId: req.userId!, via: "Alert link" });
    res.json({ done: "paused" });
    return;
  }
  const days = Math.min(30, Math.max(1, claims.d ?? 7));
  const until = new Date(Date.now() + days * 86_400_000);
  await prisma.anomalySnooze.upsert({
    where: { campaignId: campaign.id },
    create: { campaignId: campaign.id, orgId: org.id, until, createdById: req.userId },
    update: { until, createdById: req.userId },
  });
  res.json({ done: "muted", until: until.toISOString() });
});
