import { isOrgLocked } from "@ashniva/core";
import { prisma, type AuditLog, type Invitation, type User, type Workspace } from "@ashniva/db";
import {
  hasAllWorkspaceAccess,
  type AuditLogDTO,
  type InvitationDTO,
  type MeResponse,
  type OrgDTO,
  type UserDTO,
  type WorkspaceDTO,
} from "@ashniva/shared";
import { unauthorized } from "./errors";

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Platform operators: flagged in the database, or listed in SUPER_ADMIN_EMAILS once they've
 * verified that address (otherwise whoever signed up first with it would be an admin).
 */
export function isSuperAdmin(u: Pick<User, "email" | "isSuperAdmin" | "emailVerifiedAt">) {
  const list = (process.env.SUPER_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return u.isSuperAdmin || (Boolean(u.emailVerifiedAt) && list.includes(u.email.toLowerCase()));
}

export const toUserDTO = (u: User): UserDTO => ({
  id: u.id,
  name: u.name,
  email: u.email,
  avatarUrl: u.avatarUrl,
  emailVerified: Boolean(u.emailVerifiedAt),
  isSuperAdmin: isSuperAdmin(u),
  trialUsed: Boolean(u.trialUsedAt),
  createdAt: u.createdAt.toISOString(),
});

export const toWorkspaceDTO = (w: Workspace & { _count?: { adAccounts: number } }): WorkspaceDTO => ({
  id: w.id,
  orgId: w.orgId,
  name: w.name,
  slug: w.slug,
  currency: w.currency,
  timezone: w.timezone,
  adAccountCount: w._count?.adAccounts ?? 0,
  createdAt: w.createdAt.toISOString(),
});

/** Orgs the user belongs to, each with the workspaces that user can see. */
export async function loadOrgsForUser(userId: string): Promise<OrgDTO[]> {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    include: {
      org: {
        include: {
          workspaces: {
            where: { archivedAt: null },
            orderBy: { createdAt: "asc" },
            include: { _count: { select: { adAccounts: true } } },
          },
        },
      },
      workspaces: { select: { workspaceId: true } },
    },
  });
  return memberships.map((m) => {
    const allowed = new Set(m.workspaces.map((w) => w.workspaceId));
    const workspaces = m.org.workspaces.filter((w) => hasAllWorkspaceAccess(m.role) || allowed.has(w.id));
    return {
      id: m.org.id,
      name: m.org.name,
      slug: m.org.slug,
      plan: m.org.plan,
      trialEndsAt: iso(m.org.trialEndsAt),
      subscriptionStatus: m.org.subscriptionStatus,
      currentPeriodEnd: iso(m.org.currentPeriodEnd),
      locked: isOrgLocked(m.org),
      branding: {
        brandName: m.org.brandName,
        brandColor: m.org.brandColor,
        brandLogoUrl: m.org.brandLogoUrl,
        reportFooter: m.org.reportFooter,
      },
      role: m.role,
      workspaces: workspaces.map(toWorkspaceDTO),
    };
  });
}

export async function buildMe(userId: string): Promise<MeResponse> {
  // Read-only: an operator's own org gets complimentary access when it's created (createOwnedOrg),
  // not silently on every page load (which also upgraded orgs handed to them later).
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // A user deleted mid-session: the caller must sign in again, not see a server error.
  if (!user) throw unauthorized();
  return { user: toUserDTO(user), orgs: await loadOrgsForUser(userId) };
}

export const toInvitationDTO = (i: Invitation & { invitedBy?: { name: string } | null }): InvitationDTO => ({
  id: i.id,
  email: i.email,
  role: i.role,
  workspaceIds: i.workspaceIds,
  invitedBy: i.invitedBy?.name ?? null,
  expiresAt: i.expiresAt.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

export const toAuditDTO = (a: AuditLog & { user?: { id: string; name: string } | null }): AuditLogDTO => ({
  id: a.id,
  action: a.action,
  entityType: a.entityType,
  entityId: a.entityId,
  entityName: a.entityName,
  actor: a.user ? { id: a.user.id, name: a.user.name } : null,
  changes: (a.changes as AuditLogDTO["changes"]) ?? null,
  createdAt: a.createdAt.toISOString(),
});
