import { prisma, type Membership, type Organization, type Workspace } from "@ashniva/db";
import { assertFeature, assertNotLocked } from "@ashniva/core";
import { can, hasAllWorkspaceAccess, type Feature, type Permission } from "@ashniva/shared";
import type { NextFunction, Request, Response } from "express";
import { forbidden, HttpError, notFound, unauthorized } from "../lib/errors";
import { isSuperAdmin } from "../lib/serialize";
import { ACCESS_COOKIE, clearSessionCookies, verifyAccess } from "../lib/session";

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      membership?: Membership;
      org?: Organization;
      workspace?: Workspace;
    }
  }
}

/**
 * Requires a valid access token cookie whose session still exists and is not revoked.
 * A deleted user's sessions are gone with them (cascade), so their still-unexpired
 * token gets a 401 (cookies cleared, so the app goes to sign-in) instead of failing later.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) throw unauthorized();
  const claims = verifyAccess(token);
  const session = await prisma.session.findUnique({ where: { id: claims.sid }, select: { userId: true, revokedAt: true } });
  if (!session || session.userId !== claims.sub || session.revokedAt) {
    clearSessionCookies(res);
    throw unauthorized("Your session has ended. Please sign in again.");
  }
  req.userId = claims.sub;
  req.sessionId = claims.sid;
  next();
}

/** Loads the org from :orgId and confirms the caller is a member. */
export async function loadOrg(req: Request, _res: Response, next: NextFunction) {
  const orgId = req.params.orgId as string;
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.userId!, orgId } },
    include: { org: true },
  });
  if (!membership) throw notFound("Organization");
  const { org, ...m } = membership;
  req.membership = m;
  req.org = org;
  next();
}

/** Loads the workspace from :workspaceId and confirms the caller can access it. */
export async function loadWorkspace(req: Request, _res: Response, next: NextFunction) {
  const workspaceId = req.params.workspaceId as string;
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, archivedAt: null },
    include: { org: true },
  });
  if (!workspace) throw notFound("Workspace");

  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId: req.userId!, orgId: workspace.orgId } },
    include: { workspaces: { where: { workspaceId } } },
  });
  if (!membership) throw notFound("Workspace");
  if (!hasAllWorkspaceAccess(membership.role) && membership.workspaces.length === 0) throw notFound("Workspace");

  const { org, ...ws } = workspace;
  const { workspaces: _, ...m } = membership;
  req.workspace = ws;
  req.org = org;
  req.membership = m;
  next();
}

export const requirePermission =
  (permission: Permission) => (req: Request, _res: Response, next: NextFunction) => {
    if (!req.membership || !can(req.membership.role, permission)) throw forbidden();
    next();
  };

/** Blocks changes (non-GET requests) while the org's trial or subscription is inactive. */
export function requireActivePlanForWrites(req: Request, _res: Response, next: NextFunction) {
  if (req.method !== "GET" && req.org) assertNotLocked(req.org);
  next();
}

export const requireFeature = (feature: Feature) => (req: Request, _res: Response, next: NextFunction) => {
  assertFeature(req.org!, feature);
  next();
};

export async function requireSuperAdmin(req: Request, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !isSuperAdmin(user)) throw forbidden();
  next();
}

/** For actions that email other people on the user's behalf (team invites), so an unproven address can't send them. */
export async function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { emailVerifiedAt: true } });
  if (!user?.emailVerifiedAt) {
    throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email address first. Use the link we emailed you, or resend it from the banner at the top.");
  }
  next();
}
