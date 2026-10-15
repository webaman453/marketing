import { prisma, type Membership, type Organization, type Workspace } from "@ashniva/db";
import { assertFeature, assertNotLocked } from "@ashniva/core";
import { can, hasAllWorkspaceAccess, type Feature, type Permission } from "@ashniva/shared";
import type { NextFunction, Request, Response } from "express";
import { forbidden, notFound, unauthorized } from "../lib/errors";
import { isSuperAdmin } from "../lib/serialize";
import { ACCESS_COOKIE, verifyAccess } from "../lib/session";

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

/** Requires a valid access token cookie. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (!token) throw unauthorized();
  const claims = verifyAccess(token);
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
