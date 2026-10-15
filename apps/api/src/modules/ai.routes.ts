import { prisma } from "@ashniva/db";
import { PRICING, type AiInsightsResponse, type AiStatusDTO } from "@ashniva/shared";
import { Router, type Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aiAvailable, type AiCaller } from "../lib/ai";
import { campaignInsights, workspaceInsights } from "../lib/ai/insights";
import { notFound, parse } from "../lib/errors";
import { requireActivePlanForWrites } from "../middleware/auth";
import { aiBuilderRouter } from "./ai-builder.routes";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const aiRouter = Router({ mergeParams: true });

// AI calls are slow and billed; keep one user from flooding them.
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  keyGenerator: (req) => req.userId ?? ipKeyGenerator(req.ip ?? ""),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "You've reached the hourly AI limit. Try again later." } },
});

export const callerOf = (req: Request): AiCaller => ({ orgId: req.org!.id, userId: req.userId, workspaceId: req.workspace!.id });

aiRouter.get("/ai/status", async (req, res) => {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.org!.id }, select: { aiTokenBalance: true } });
  const body: AiStatusDTO = {
    available: aiAvailable(),
    balance: org.aiTokenBalance,
    canUse: aiAvailable() && org.aiTokenBalance >= PRICING.aiMinBalance,
  };
  res.json(body);
});

// Everything below spends tokens, so a locked (expired) organization can't use it.
aiRouter.use("/ai", aiLimiter, requireActivePlanForWrites);

const empty = (summary: string): AiInsightsResponse => ({ summary, insights: [], generatedAt: new Date().toISOString() });

aiRouter.post("/ai/insights", async (req, res) => {
  const { days } = parse(z.object({ days: z.number().int().min(7).max(90).default(30) }), req.body ?? {});
  const result = await workspaceInsights(callerOf(req), req.workspace!.id, days);
  res.json(result ? { ...result, generatedAt: new Date().toISOString() } : empty("There isn't enough campaign data in this period to analyse yet."));
});

aiRouter.post("/ai/campaigns/:campaignId/insights", async (req, res) => {
  const { days } = parse(z.object({ days: z.number().int().min(7).max(90).default(30) }), req.body ?? {});
  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.campaignId as string, adAccount: { workspaceId: req.workspace!.id } },
    select: { id: true },
  });
  if (!campaign) throw notFound("Campaign");
  const result = await campaignInsights(callerOf(req), campaign.id, days);
  res.json(result ? { ...result, generatedAt: new Date().toISOString() } : empty("This campaign hasn't delivered in the period yet, so there's nothing to analyse."));
});

aiRouter.use(aiBuilderRouter);
