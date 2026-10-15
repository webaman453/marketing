import {
  assertNotLocked,
  assertWithinLimit,
  audit,
  connectors,
  createSampleConnections,
  encryptSecret,
  enqueueSync,
  refreshAdAccounts,
  removeSampleConnections,
} from "@ashniva/core";
import { prisma, type AdAccount, type PlatformConnection, type Prisma } from "@ashniva/db";
import {
  PLATFORM_INFO,
  PLATFORMS,
  assignAdAccountSchema,
  hasAllWorkspaceAccess,
  platformParam,
  type AdAccountDTO,
  type ConnectionDTO,
  type Platform,
} from "@ashniva/shared";
import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config, oauthRedirectUri } from "../config";
import { badRequest, notFound, parse } from "../lib/errors";
import { logger } from "../lib/logger";
import { ACCESS_COOKIE, rotateSession, verifyAccess } from "../lib/session";
import { requirePermission } from "../middleware/auth";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toConnectionDTO = (
  c: PlatformConnection & { _count: { adAccounts: number }; createdBy: { name: string } | null },
): ConnectionDTO => ({
  id: c.id,
  platform: c.platform,
  mode: c.mode,
  status: c.status,
  externalUserName: c.externalUserName,
  syncStatus: c.syncStatus,
  lastSyncedAt: iso(c.lastSyncedAt),
  lastSyncError: c.lastSyncError,
  adAccountCount: c._count.adAccounts,
  connectedBy: c.createdBy?.name ?? null,
  createdAt: c.createdAt.toISOString(),
});

const toAdAccountDTO = (a: AdAccount & { workspace: { name: string } | null }): AdAccountDTO => ({
  id: a.id,
  platform: a.platform,
  externalId: a.externalId,
  name: a.name,
  currency: a.currency,
  timezone: a.timezone,
  status: a.status,
  connectionId: a.connectionId,
  workspaceId: a.workspaceId,
  workspaceName: a.workspace?.name ?? null,
  lastSyncedAt: iso(a.lastSyncedAt),
});

// ───────── Org-scoped integration management ─────────

/** Mounted under /api/orgs/:orgId after loadOrg has run. */
export const integrationsRouter = Router({ mergeParams: true });

/**
 * Ad-account filter for the caller. Owners and admins see the whole org;
 * other roles only see accounts in workspaces they are assigned to, so an
 * agency's clients never see each other's accounts.
 */
async function visibleAccountFilter(req: Request): Promise<Prisma.AdAccountWhereInput> {
  const m = req.membership!;
  if (hasAllWorkspaceAccess(m.role)) return { orgId: req.org!.id };
  const access = await prisma.membershipWorkspace.findMany({ where: { membershipId: m.id }, select: { workspaceId: true } });
  return { orgId: req.org!.id, workspaceId: { in: access.map((a) => a.workspaceId) } };
}

/** Platform catalogue with availability and whether our app credentials are set. */
integrationsRouter.get("/platforms", (_req, res) => {
  const registry = connectors();
  const live = new Set(registry.livePlatforms());
  res.json(
    PLATFORMS.map((p) => ({
      ...PLATFORM_INFO[p],
      supported: live.has(p),
      configured: registry.isConfigured(p),
    })),
  );
});

integrationsRouter.get("/connections", async (req, res) => {
  const accounts = await visibleAccountFilter(req);
  const scoped = hasAllWorkspaceAccess(req.membership!.role) ? {} : { adAccounts: { some: accounts } };
  const list = await prisma.platformConnection.findMany({
    where: { orgId: req.org!.id, status: { not: "REVOKED" }, ...scoped },
    orderBy: [{ mode: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { adAccounts: true } }, createdBy: { select: { name: true } } },
  });
  res.json(list.map(toConnectionDTO));
});

const authorizeBody = z.object({ workspaceId: z.string().min(1) });

/** Returns the platform's OAuth consent URL. The state token carries who/where to attach the connection. */
integrationsRouter.post("/connections/:platform/authorize", requirePermission("integrations:manage"), async (req, res) => {
  assertNotLocked(req.org!);
  const platform = parse(platformParam, String(req.params.platform).toUpperCase());
  const { workspaceId } = parse(authorizeBody, req.body);
  const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, orgId: req.org!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");

  const state = jwt.sign(
    { orgId: req.org!.id, userId: req.userId, workspaceId, platform },
    config().OAUTH_STATE_SECRET,
    { expiresIn: "15m", issuer: "ashniva-oauth" },
  );
  const url = connectors().get(platform).getAuthUrl({ state, redirectUri: oauthRedirectUri(platform) });
  res.json({ url });
});

integrationsRouter.post("/connections/:connectionId/sync", requirePermission("integrations:manage"), async (req, res) => {
  assertNotLocked(req.org!);
  const conn = await prisma.platformConnection.findFirst({
    where: { id: req.params.connectionId as string, orgId: req.org!.id, status: { not: "REVOKED" } },
  });
  if (!conn) throw notFound("Connection");
  if (conn.syncStatus !== "RUNNING") {
    await prisma.platformConnection.update({ where: { id: conn.id }, data: { syncStatus: "QUEUED" } });
  }
  await enqueueSync(conn.id, "manual");
  res.status(202).json({ queued: true });
});

integrationsRouter.delete("/connections/:connectionId", requirePermission("integrations:manage"), async (req, res) => {
  const conn = await prisma.platformConnection.findFirst({
    where: { id: req.params.connectionId as string, orgId: req.org!.id },
  });
  if (!conn) throw notFound("Connection");
  // Deleting cascades to its ad accounts, campaigns and metrics.
  await prisma.platformConnection.delete({ where: { id: conn.id } });
  await audit({
    orgId: req.org!.id,
    userId: req.userId,
    action: "integration.disconnected",
    entityType: "connection",
    entityId: conn.id,
    entityName: `${PLATFORM_INFO[conn.platform].name}${conn.externalUserName ? ` · ${conn.externalUserName}` : ""}`,
  });
  res.status(204).end();
});

integrationsRouter.get("/ad-accounts", async (req, res) => {
  const accounts = await prisma.adAccount.findMany({
    where: { ...(await visibleAccountFilter(req)), connection: { status: { not: "REVOKED" } } },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
    include: { workspace: { select: { name: true } } },
  });
  res.json(accounts.map(toAdAccountDTO));
});

integrationsRouter.patch("/ad-accounts/:adAccountId", requirePermission("integrations:manage"), async (req, res) => {
  const { workspaceId } = parse(assignAdAccountSchema, req.body);
  const orgId = req.org!.id;
  const account = await prisma.adAccount.findFirst({ where: { id: req.params.adAccountId as string, orgId } });
  if (!account) throw notFound("Ad account");
  if (workspaceId) {
    const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, orgId, archivedAt: null } });
    if (!ws) throw notFound("Workspace");
    // Moving an already-assigned account doesn't add to the count; sample accounts never do.
    const conn = await prisma.platformConnection.findUnique({ where: { id: account.connectionId }, select: { mode: true } });
    if (!account.workspaceId && conn?.mode === "LIVE") await assertWithinLimit(req.org!, "adAccounts");
  }
  const updated = await prisma.adAccount.update({
    where: { id: account.id },
    data: { workspaceId },
    include: { workspace: { select: { name: true } } },
  });
  await audit({
    orgId,
    workspaceId,
    userId: req.userId,
    action: workspaceId ? "ad_account.assigned" : "ad_account.unassigned",
    entityType: "ad_account",
    entityId: account.id,
    entityName: account.name,
    changes: { workspace: { from: account.workspaceId, to: workspaceId } },
  });
  // Newly assigned accounts need their first sync.
  if (workspaceId && !account.lastSyncedAt) await enqueueSync(account.connectionId, "manual");
  res.json(toAdAccountDTO(updated));
});

integrationsRouter.post("/sample-data", requirePermission("integrations:manage"), async (req, res) => {
  const { workspaceId } = parse(authorizeBody, req.body);
  const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, orgId: req.org!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");
  const ids = await createSampleConnections(req.org!.id, ws.id, req.userId!);
  await prisma.platformConnection.updateMany({ where: { id: { in: ids } }, data: { syncStatus: "QUEUED" } });
  for (const id of ids) await enqueueSync(id, "sample");
  await audit({ orgId: req.org!.id, workspaceId: ws.id, userId: req.userId, action: "sample_data.added", entityType: "workspace", entityId: ws.id, entityName: ws.name });
  res.status(202).json({ connections: ids.length });
});

integrationsRouter.delete("/sample-data", requirePermission("integrations:manage"), async (req, res) => {
  const removed = await removeSampleConnections(req.org!.id);
  await audit({ orgId: req.org!.id, userId: req.userId, action: "sample_data.removed", entityType: "organization", entityId: req.org!.id, entityName: req.org!.name });
  res.json({ removed });
});

// ───────── OAuth callback (browser redirect from the platform) ─────────

export const oauthRouter = Router();

interface OAuthState {
  orgId: string;
  userId: string;
  workspaceId: string;
  platform: Platform;
}

/**
 * The consent screen can take a while, so the short-lived access cookie may
 * have expired by the time the platform redirects back. Fall back to the
 * refresh cookie instead of failing the connection.
 */
async function authenticateRedirect(req: Request, res: Response): Promise<string | null> {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (token) {
    try {
      return verifyAccess(token).sub;
    } catch {
      /* fall through to refresh */
    }
  }
  try {
    return (await rotateSession(req, res)).userId;
  } catch {
    return null;
  }
}

oauthRouter.get("/:platform/callback", async (req, res) => {
  const userId = await authenticateRedirect(req, res);
  if (!userId) return res.redirect(`${config().WEB_URL}/login?error=session`);
  const web = config().WEB_URL;
  const platform = String(req.params.platform).toUpperCase();
  let state: OAuthState | undefined;

  const back = (params: Record<string, string>) => {
    const target = state ? `/w/${state.workspaceId}/integrations` : "/";
    res.redirect(`${web}${target}?${new URLSearchParams(params)}`);
  };

  try {
    state = jwt.verify(String(req.query.state ?? ""), config().OAUTH_STATE_SECRET, {
      issuer: "ashniva-oauth",
    }) as OAuthState;
  } catch {
    return back({ error: "The connection request expired. Please try again." });
  }
  // The browser finishing the flow must belong to the user who started it.
  if (state.platform !== platform || state.userId !== userId) {
    return back({ error: "This connection request doesn't match your session." });
  }
  if (req.query.error) {
    return back({ error: String(req.query.error_description ?? "Access was not granted.") });
  }
  // TikTok returns `auth_code`; everyone else uses the standard `code`.
  const code = String(req.query.code ?? req.query.auth_code ?? "");
  if (!code) throw badRequest("Missing authorization code.");

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: state.userId, orgId: state.orgId } },
  });
  if (!membership) return back({ error: "You no longer have access to this organization." });

  try {
    const connector = connectors().get(state.platform);
    const tokens = await connector.exchangeCode({ code, redirectUri: oauthRedirectUri(state.platform) });
    const user = await connector.getUser({ accessToken: tokens.accessToken });

    const data = {
      externalUserName: user.name,
      accessTokenEnc: encryptSecret(tokens.accessToken),
      tokenExpiresAt: tokens.expiresAt ?? null,
      scopes: tokens.scopes,
      status: "ACTIVE" as const,
      syncStatus: "QUEUED" as const,
      lastSyncError: null,
      ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
    };
    const connection = await prisma.platformConnection.upsert({
      where: { orgId_platform_externalUserId: { orgId: state.orgId, platform: state.platform, externalUserId: user.id } },
      create: { ...data, orgId: state.orgId, platform: state.platform, externalUserId: user.id, createdById: state.userId },
      update: data,
    });

    // New accounts land in the workspace only while the plan has room; otherwise they wait unassigned.
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: state.orgId } });
    const roomLeft = await assertWithinLimit(org, "adAccounts").then(() => true, () => false);
    const count = await refreshAdAccounts(connection, tokens.accessToken, roomLeft ? state.workspaceId : undefined);
    await enqueueSync(connection.id, "connect");
    await audit({
      orgId: state.orgId,
      workspaceId: state.workspaceId,
      userId: state.userId,
      action: "integration.connected",
      entityType: "connection",
      entityId: connection.id,
      entityName: `${PLATFORM_INFO[state.platform].name} · ${user.name}`,
    });
    return back({ connected: state.platform, accounts: String(count) });
  } catch (err) {
    logger.error({ err, platform }, "OAuth callback failed");
    const message = err instanceof Error ? err.message : "Could not complete the connection.";
    return back({ error: message.slice(0, 200) });
  }
});
