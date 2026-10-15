/**
 * Public REST API (read-only), authenticated with organization API keys:
 *   Authorization: Bearer ak_live_…
 * Mounted at /api/v1.
 */
import { isOrgLocked, sha256 } from "@ashniva/core";
import { prisma, type Organization } from "@ashniva/db";
import { PLANS, campaignListQuery, dateRangeQuery, type PlanId } from "@ashniva/shared";
import { Router, type NextFunction, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import { HttpError, notFound, parse } from "../lib/errors";
import { metricsByEntity, timeseries, toCampaignRow, dateFilter } from "./analytics.service";

declare global {
  namespace Express {
    interface Request {
      apiOrg?: Organization;
    }
  }
}

export const publicApiRouter = Router();

async function apiKeyAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!secret.startsWith("ak_live_")) throw new HttpError(401, "UNAUTHORIZED", "Send your API key as `Authorization: Bearer ak_live_…`.");
  const key = await prisma.apiKey.findUnique({ where: { keyHash: sha256(secret) }, include: { org: true } });
  if (!key || key.revokedAt) throw new HttpError(401, "UNAUTHORIZED", "This API key is invalid or has been revoked.");
  if (!PLANS[key.org.plan as PlanId].features.includes("public_api")) {
    throw new HttpError(402, "FEATURE_LOCKED", "API access requires the Agency plan.");
  }
  if (isOrgLocked(key.org)) throw new HttpError(402, "ORG_LOCKED", "This organization's plan is inactive.");
  req.apiOrg = key.org;
  // Track usage at most once a minute per key.
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
    void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  }
  next();
}

publicApiRouter.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    keyGenerator: (req) => req.get("authorization")?.slice(0, 60) ?? ipKeyGenerator(req.ip ?? ""),
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Rate limit: 120 requests per minute per key." } },
  }),
  apiKeyAuth,
);

async function workspaceOf(req: Request) {
  const ws = await prisma.workspace.findFirst({ where: { id: req.params.workspaceId as string, orgId: req.apiOrg!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");
  const accounts = await prisma.adAccount.findMany({ where: { workspaceId: ws.id }, select: { id: true } });
  return { ws, accountIds: accounts.map((a) => a.id) };
}

publicApiRouter.get("/workspaces", async (req, res) => {
  const list = await prisma.workspace.findMany({ where: { orgId: req.apiOrg!.id, archivedAt: null }, orderBy: { createdAt: "asc" } });
  res.json({ data: list.map((w) => ({ id: w.id, name: w.name, currency: w.currency, timezone: w.timezone })) });
});

publicApiRouter.get("/workspaces/:workspaceId/campaigns", async (req, res) => {
  const q = parse(campaignListQuery, req.query);
  const { accountIds } = await workspaceOf(req);
  const campaigns = await prisma.campaign.findMany({
    where: {
      adAccountId: { in: accountIds },
      status: q.status ?? { not: "REMOVED" },
      ...(q.platform ? { platform: q.platform } : {}),
    },
    include: { adAccount: { select: { id: true, name: true, currency: true } } },
    orderBy: { name: "asc" },
  });
  const metrics = await metricsByEntity({ level: "CAMPAIGN", entityId: { in: campaigns.map((c) => c.id) }, date: dateFilter(q) });
  res.json({ range: { from: q.from, to: q.to }, data: campaigns.map((c) => toCampaignRow(c, metrics.get(c.id))) });
});

publicApiRouter.get("/workspaces/:workspaceId/metrics", async (req, res) => {
  const q = parse(dateRangeQuery.and(z.object({ campaignId: z.string().optional() })), req.query);
  const { accountIds } = await workspaceOf(req);
  const where = {
    level: "CAMPAIGN" as const,
    adAccountId: { in: accountIds },
    ...(q.campaignId ? { entityId: q.campaignId } : {}),
    date: dateFilter(q),
  };
  res.json({ range: { from: q.from, to: q.to }, data: await timeseries(where, q) });
});
