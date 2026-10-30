import {
  assertNotLocked,
  assertWithinLimit,
  audit,
  connectors,
  createSampleConnections,
  decryptSecret,
  encryptConnectionCredentials,
  encryptSecret,
  enqueueSync,
  isOrgLocked,
  refreshAdAccounts,
  removeSampleConnections,
} from "@ashniva/core";
import { isConnectorError, type ExternalUser, type OAuthTokens, type PlatformCredentials } from "@ashniva/connectors";
import { prisma, type AdAccount, type PlatformConnection, type Prisma } from "@ashniva/db";
import {
  CONNECT_CREDENTIALS,
  PLATFORM_INFO,
  PLATFORMS,
  connectsWithCredentials,
  isPlatformShown,
  assignAdAccountSchema,
  can,
  hasAllWorkspaceAccess,
  platformParam,
  type AdAccountDTO,
  type ConnectionDTO,
  type Platform,
} from "@ashniva/shared";
import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config, isProd, oauthRedirectUri } from "../config";
import { badRequest, forbidden, notFound, parse } from "../lib/errors";
import { isSuperAdmin } from "../lib/serialize";
import { logger } from "../lib/logger";
import { ACCESS_COOKIE, rotateSession, verifyAccess } from "../lib/session";
import { requirePermission } from "../middleware/auth";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Holds an OAuth 1.0a (X) sign-in between authorize and the callback. */
const OAUTH1_COOKIE = "ashniva_oauth1";

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

/**
 * Platform catalogue with availability and whether it can be connected. Key-based
 * platforms always can (each organization brings its own keys); `operatorKeys`
 * says the operator's own keys are also set, for the operator's own organization.
 */
integrationsRouter.get("/platforms", (_req, res) => {
  const registry = connectors();
  const live = new Set(registry.livePlatforms());
  res.json(
    PLATFORMS.filter(isPlatformShown).map((p) => {
      const withKeys = connectsWithCredentials(p);
      return {
        ...PLATFORM_INFO[p],
        supported: live.has(p),
        configured: withKeys || registry.isConfigured(p),
        connectsWithCredentials: withKeys,
        operatorKeys: withKeys && registry.isConfigured(p),
      };
    }),
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

const authorizeBody = z.object({ workspaceId: z.string().min(1), shop: z.string().trim().optional() });

/** "your-store", a URL, or your-store.myshopify.com. */
function shopifyDomain(raw: string) {
  let shop = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (shop && !shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw badRequest("Enter the store domain, like your-store.myshopify.com.");
  }
  return shop;
}

/**
 * Key-based platforms connect with the organization's own keys (POST …/credentials).
 * Connecting one through the redirect flow uses the operator's keys from the admin
 * console, which reach every account the operator manages, so only the platform
 * operator may do that, for the operator's own organization.
 */
async function assertMayUseOperatorKeys(platform: Platform, userId: string) {
  if (!connectsWithCredentials(platform)) return;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, isSuperAdmin: true, emailVerifiedAt: true } });
  if (!user || !isSuperAdmin(user)) {
    throw forbidden(`Connect ${PLATFORM_INFO[platform].name} with your own API keys.`);
  }
}

/** Returns the platform's OAuth consent URL. The state token carries who/where to attach the connection. */
integrationsRouter.post("/connections/:platform/authorize", requirePermission("integrations:manage"), async (req, res) => {
  assertNotLocked(req.org!);
  const platform = parse(platformParam, String(req.params.platform).toUpperCase());
  if (!isPlatformShown(platform)) throw badRequest(`${PLATFORM_INFO[platform].name} isn't available.`);
  await assertMayUseOperatorKeys(platform, req.userId!);
  const { workspaceId, shop: shopInput } = parse(authorizeBody, req.body);
  const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, orgId: req.org!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");
  const shop = platform === "SHOPIFY" ? shopifyDomain(shopInput ?? "") : undefined;

  const state = jwt.sign(
    { orgId: req.org!.id, userId: req.userId, workspaceId, platform, ...(shop ? { shop } : {}) },
    config().OAUTH_STATE_SECRET,
    { expiresIn: "15m", issuer: "ashniva-oauth" },
  );
  const connector = connectors().get(platform);
  if (connector.startOAuth1) {
    // OAuth 1.0a (X) brings no state back to the callback, so it waits in a cookie with the request token secret.
    const { url, requestToken, requestSecret } = await connector.startOAuth1({ redirectUri: oauthRedirectUri(platform) });
    const pending = jwt.sign({ state, token: requestToken, secret: encryptSecret(requestSecret) }, config().OAUTH_STATE_SECRET, {
      expiresIn: "15m",
      issuer: "ashniva-oauth1",
    });
    res.cookie(OAUTH1_COOKIE, pending, { httpOnly: true, secure: isProd(), sameSite: "lax", path: "/", maxAge: 15 * 60 * 1000 });
    return res.json({ url });
  }
  const url = connector.getAuthUrl({ state, redirectUri: oauthRedirectUri(platform) });
  res.json({ url });
});

const credentialsBody = z.object({
  workspaceId: z.string().min(1),
  credentials: z.record(z.string(), z.string().max(10_000)),
});

/**
 * Connects a key-based platform with the organization's own API keys. The keys
 * are checked with a harmless read (who they belong to and which ad accounts
 * they reach) before anything is saved, then stored encrypted on the connection.
 */
integrationsRouter.post("/connections/:platform/credentials", requirePermission("integrations:manage"), async (req, res) => {
  assertNotLocked(req.org!);
  const platform = parse(platformParam, String(req.params.platform).toUpperCase());
  const spec = CONNECT_CREDENTIALS[platform];
  if (!isPlatformShown(platform) || !spec) throw badRequest(`${PLATFORM_INFO[platform].name} doesn't connect with API keys.`);
  const body = parse(credentialsBody, req.body);
  const ws = await prisma.workspace.findFirst({ where: { id: body.workspaceId, orgId: req.org!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");

  const credentials: PlatformCredentials = {};
  const missing: Record<string, string[]> = {};
  for (const field of spec.fields) {
    const value = body.credentials[field.key]?.trim();
    if (value) credentials[field.key] = value;
    else missing[field.key] = [`Enter the ${field.label}.`];
  }
  if (Object.keys(missing).length) throw badRequest(`Enter every ${PLATFORM_INFO[platform].name} key.`, missing);

  const connector = connectors().get(platform);
  let tokens: OAuthTokens;
  let user: ExternalUser;
  let found: number;
  try {
    tokens = await connector.connectWithCredentials!(credentials);
    const auth = { accessToken: tokens.accessToken, credentials };
    user = await connector.getUser(auth);
    found = (await connector.listAdAccounts(auth)).length;
  } catch (err) {
    throw badRequest(credentialsError(platform, err));
  }
  if (found === 0) {
    throw badRequest(`These ${PLATFORM_INFO[platform].name} keys work, but they can't see any ad accounts. Give them access to an account and try again.`);
  }

  const { count } = await saveConnection({ orgId: req.org!.id, userId: req.userId!, workspaceId: ws.id, platform, tokens, user, credentials });
  res.status(201).json({ connected: platform, accounts: count });
});

/** Why the platform turned the keys down, in words the person who pasted them can act on. */
function credentialsError(platform: Platform, err: unknown) {
  const name = PLATFORM_INFO[platform].name;
  const message = err instanceof Error ? err.message.slice(0, 200) : "Unknown error";
  if (!isConnectorError(err)) return `Couldn't check the ${name} keys: ${message}`;
  // Our own checks (a missing field, a malformed private key) carry no platform reply.
  if (err.details === undefined) return message;
  if (err.code === "RATE_LIMITED" || err.code === "PLATFORM_ERROR") return `${name} couldn't check these keys right now (${message}). Try again in a minute.`;
  return `${name} didn't accept these keys: ${message}. Check them and try again.`;
}

/**
 * Saves (or refreshes) the organization's connection for this login, lists its
 * ad accounts into the workspace while the plan has room, and queues the first sync.
 */
async function saveConnection(params: {
  orgId: string;
  userId: string;
  workspaceId: string;
  platform: Platform;
  tokens: OAuthTokens;
  user: ExternalUser;
  /** The organization's own API keys; null for OAuth platforms and the operator's own keys. */
  credentials: PlatformCredentials | null;
}) {
  const { orgId, userId, workspaceId, platform, tokens, user, credentials } = params;
  const data = {
    externalUserName: user.name,
    accessTokenEnc: encryptSecret(tokens.accessToken),
    credentialsEnc: encryptConnectionCredentials(platform, credentials),
    tokenExpiresAt: tokens.expiresAt ?? null,
    scopes: tokens.scopes,
    status: "ACTIVE" as const,
    syncStatus: "QUEUED" as const,
    lastSyncError: null,
    ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
  };
  const connection = await prisma.platformConnection.upsert({
    where: { orgId_platform_externalUserId: { orgId, platform, externalUserId: user.id } },
    create: { ...data, orgId, platform, externalUserId: user.id, createdById: userId },
    update: data,
  });

  // New accounts land in the workspace only while the plan has room and the workspace still exists (it may have
  // been archived during the sign-in, and archiving frees its accounts); otherwise they wait unassigned.
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const roomLeft = await assertWithinLimit(org, "adAccounts").then(() => true, () => false);
  const target = workspaceId ? await prisma.workspace.findFirst({ where: { id: workspaceId, orgId, archivedAt: null }, select: { id: true } }) : null;
  const count = await refreshAdAccounts(connection, { accessToken: tokens.accessToken, credentials }, roomLeft && target ? target.id : undefined);
  await enqueueSync(connection.id, "connect");
  await audit({
    orgId,
    workspaceId: target?.id ?? null,
    userId,
    action: "integration.connected",
    entityType: "connection",
    entityId: connection.id,
    entityName: `${PLATFORM_INFO[platform].name} · ${user.name}`,
  });
  return { connection, count };
}

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
  shop?: string;
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

/** The state and encrypted request token secret of an OAuth 1.0a sign-in, read once. */
function takeOAuth1(req: Request, res: Response): { state: string; token: string; secret: string } | null {
  const raw = req.cookies?.[OAUTH1_COOKIE] as string | undefined;
  if (!raw) return null;
  res.clearCookie(OAUTH1_COOKIE, { path: "/" });
  try {
    return jwt.verify(raw, config().OAUTH_STATE_SECRET, { issuer: "ashniva-oauth1" }) as { state: string; token: string; secret: string };
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

  // OAuth 1.0a (X) returns oauth_token and oauth_verifier (or denied=…) without a state.
  const oauth1 = req.query.state ? null : takeOAuth1(req, res);
  try {
    state = jwt.verify(String(req.query.state ?? oauth1?.state ?? ""), config().OAUTH_STATE_SECRET, {
      issuer: "ashniva-oauth",
    }) as OAuthState;
  } catch {
    return back({ error: "The connection request expired. Please try again." });
  }
  // The browser finishing the flow must belong to the user who started it.
  if (state.platform !== platform || state.userId !== userId) {
    return back({ error: "This connection request doesn't match your session." });
  }
  if (req.query.error || req.query.denied) {
    return back({ error: String(req.query.error_description ?? "Access was not granted.") });
  }
  if (oauth1 && req.query.oauth_token !== oauth1.token) {
    return back({ error: "This connection request doesn't match your session." });
  }
  // TikTok returns `auth_code`, OAuth 1.0a `oauth_verifier`; everyone else uses the standard `code`.
  const code = String(req.query.code ?? req.query.auth_code ?? req.query.oauth_verifier ?? "");
  if (!code) throw badRequest("Missing authorization code.");

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: state.userId, orgId: state.orgId } },
  });
  if (!membership) return back({ error: "You no longer have access to this organization." });
  // Re-check at completion: the role or plan may have changed during the sign-in.
  if (!can(membership.role, "integrations:manage")) return back({ error: "You no longer have permission to connect platforms." });
  if (!isPlatformShown(state.platform)) return back({ error: `${PLATFORM_INFO[state.platform].name} isn't available.` });
  const owner = await prisma.organization.findUniqueOrThrow({ where: { id: state.orgId } });
  if (isOrgLocked(owner)) return back({ error: "Your plan is inactive. Update billing to connect platforms." });
  try {
    await assertMayUseOperatorKeys(state.platform, state.userId);
  } catch (err) {
    return back({ error: err instanceof Error ? err.message : "You can't connect this platform." });
  }

  try {
    const connector = connectors().get(state.platform);
    const tokens = await connector.exchangeCode({
      code,
      redirectUri: oauthRedirectUri(state.platform),
      state: String(req.query.state ?? ""),
      query: req.query as Record<string, unknown>,
      requestSecret: oauth1 ? decryptSecret(oauth1.secret) : undefined,
    });
    const user = await connector.getUser({ accessToken: tokens.accessToken });
    const { count } = await saveConnection({
      orgId: state.orgId,
      userId: state.userId,
      workspaceId: state.workspaceId,
      platform: state.platform,
      tokens,
      user,
      credentials: null,
    });
    return back({ connected: state.platform, accounts: String(count) });
  } catch (err) {
    logger.error({ err, platform }, "OAuth callback failed");
    const message = err instanceof Error ? err.message : "Could not complete the connection.";
    return back({ error: message.slice(0, 200) });
  }
});
