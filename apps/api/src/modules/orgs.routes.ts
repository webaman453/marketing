import { assertWithinLimit, audit, connectors, decryptSecret, deleteFile, keyFromUrl, randomToken, sha256 } from "@ashniva/core";
import { prisma } from "@ashniva/db";
import {
  BRAND,
  ROLE_INFO,
  canManageMember,
  createOrgSchema,
  hasAllWorkspaceAccess,
  inviteMemberSchema,
  updateMemberSchema,
  updateOrgSchema,
  workspaceSchema,
  type ArchivedWorkspaceDTO,
  type MemberDTO,
} from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { badRequest, conflict, forbidden, notFound, parse } from "../lib/errors";
import { logger } from "../lib/logger";
import { esc, sendMail } from "../lib/mailer";
import { createOwnedOrg, newOrgSlug } from "../lib/org-setup";
import { BILLABLE_STATUSES, cancelSubscription, fetchSubscription, razorpayConfigured } from "../lib/razorpay";
import { buildMe, isSuperAdmin, loadOrgsForUser, toAuditDTO, toInvitationDTO, toWorkspaceDTO } from "../lib/serialize";
import { uniqueSlug } from "../lib/slug";
import { loadOrg, requirePermission, requireVerifiedEmail } from "../middleware/auth";
import { aiWalletRouter } from "./ai-wallet.routes";
import { billingRouter } from "./billing.routes";
import { integrationsRouter } from "./integrations.routes";
import { orgExtrasRouter } from "./org-extras.routes";

export const orgsRouter = Router({ mergeParams: true });

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Starts a new organization for a signed-in user who has none, e.g. after
 * deleting their only one. Self-serve organizations stay locked until a plan
 * is paid. A super admin's own organization is complimentary.
 */
orgsRouter.post("/", async (req, res) => {
  const input = parse(createOrgSchema, req.body);
  const userId = req.userId!;
  const slug = await newOrgSlug(input.companyName);
  await prisma.$transaction(async (tx) => {
    // Serialize per user so two quick submits can't both pass the check.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    if (await tx.membership.count({ where: { userId } })) throw conflict("You're already part of an organization.");
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    await createOwnedOrg(tx, userId, input.companyName, slug, isSuperAdmin(user) ? "complimentary" : "unpaid");
  });
  res.status(201).json(await buildMe(userId));
});

orgsRouter.use("/:orgId", loadOrg);
orgsRouter.use("/:orgId", integrationsRouter, billingRouter, orgExtrasRouter, aiWalletRouter);

orgsRouter.get("/:orgId", async (req, res) => {
  const orgs = await loadOrgsForUser(req.userId!);
  res.json(orgs.find((o) => o.id === req.org!.id));
});

orgsRouter.patch("/:orgId", requirePermission("org:update"), async (req, res) => {
  const input = parse(updateOrgSchema, req.body);
  const before = req.org!;
  await prisma.organization.update({ where: { id: before.id }, data: { name: input.name } });
  await audit({
    orgId: before.id,
    userId: req.userId,
    action: "org.updated",
    entityType: "organization",
    entityId: before.id,
    entityName: input.name,
    changes: { name: { from: before.name, to: input.name } },
  });
  const orgs = await loadOrgsForUser(req.userId!);
  res.json(orgs.find((o) => o.id === before.id));
});

/**
 * Permanently deletes the organization. Only the owner can, after typing its
 * name. Billing is cancelled first so nobody is charged for a deleted org;
 * platform access is withdrawn and stored files removed on a best-effort basis.
 */
orgsRouter.delete("/:orgId", requirePermission("org:delete"), async (req, res) => {
  const org = req.org!;
  const { confirmName } = parse(z.object({ confirmName: z.string() }), req.body ?? {});
  if (confirmName.trim() !== org.name.trim()) throw badRequest("Type the organization name exactly as shown to confirm.");

  if (org.billingProvider === "razorpay" && org.billingSubscriptionId) {
    if (!razorpayConfigured()) {
      throw badRequest("Your subscription can't be cancelled right now because online billing is offline. Contact support to delete this organization.");
    }
    const sub = await fetchSubscription(org.billingSubscriptionId);
    if (BILLABLE_STATUSES.includes(sub.status)) await cancelSubscription(sub.id, { immediately: true });
  }

  const [connections, creatives] = await Promise.all([
    prisma.platformConnection.findMany({ where: { orgId: org.id, mode: "LIVE", status: { not: "REVOKED" } } }),
    prisma.creative.findMany({ where: { orgId: org.id }, select: { storageKey: true } }),
  ]);
  let revoked = 0;
  for (const c of connections) {
    const token = c.refreshTokenEnc ?? c.accessTokenEnc;
    if (!token) continue;
    try {
      const connector = connectors().get(c.platform);
      if (!connector.revokeAccess) continue;
      await connector.revokeAccess(decryptSecret(token));
      revoked++;
    } catch (err) {
      // The tokens are deleted with the org either way; the user can also remove the app on the platform.
      logger.warn({ err, orgId: org.id, connectionId: c.id, platform: c.platform }, "Couldn't revoke platform access during org deletion");
    }
  }

  // Every org-owned table cascades from organizations (see schema.prisma).
  await prisma.organization.delete({ where: { id: org.id } });

  const keys = [...creatives.map((c) => c.storageKey), org.brandLogoKey ?? keyFromUrl(org.brandLogoUrl)].filter((k): k is string => !!k);
  await Promise.all(keys.map((k) => deleteFile(k).catch(() => undefined)));

  // The org's audit log is deleted with it, so the record lives in the server log.
  logger.warn(
    {
      audit: "org.deleted",
      orgId: org.id,
      orgName: org.name,
      plan: org.plan,
      userId: req.userId,
      subscriptionId: org.billingSubscriptionId,
      connections: connections.length,
      revoked,
      files: keys.length,
    },
    "Organization deleted",
  );
  res.status(204).end();
});

// ───────── Members ─────────

orgsRouter.get("/:orgId/members", async (req, res) => {
  // Clients are external; they don't get the agency's staff directory.
  if (req.membership!.role === "CLIENT") throw forbidden();
  const members = await prisma.membership.findMany({
    where: { orgId: req.org!.id },
    orderBy: { createdAt: "asc" },
    include: { user: true, workspaces: { select: { workspaceId: true } } },
  });
  res.json(
    members.map(
      (m): MemberDTO => ({
        id: m.id,
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        avatarUrl: m.user.avatarUrl,
        role: m.role,
        workspaceIds: m.workspaces.map((w) => w.workspaceId),
        joinedAt: m.createdAt.toISOString(),
      }),
    ),
  );
});

orgsRouter.patch("/:orgId/members/:memberId", requirePermission("members:manage"), async (req, res) => {
  const input = parse(updateMemberSchema, req.body);
  const target = await prisma.membership.findFirst({
    where: { id: req.params.memberId as string, orgId: req.org!.id },
    include: { user: true },
  });
  if (!target) throw notFound("Member");
  if (target.role === "OWNER") throw forbidden("The owner's role can't be changed.");
  if (target.userId === req.userId) throw forbidden("You can't change your own role.");
  if (!canManageMember(req.membership!.role, target.role)) throw forbidden("Only the owner can change an admin's role or access.");
  if (!hasAllWorkspaceAccess(input.role)) {
    const count = input.workspaceIds
      ? await prisma.workspace.count({ where: { id: { in: input.workspaceIds }, orgId: req.org!.id, archivedAt: null } })
      : await prisma.membershipWorkspace.count({ where: { membershipId: target.id, workspace: { archivedAt: null } } });
    if (count === 0) throw badRequest(`Choose at least one workspace for ${target.user.name}; a ${ROLE_INFO[input.role].label} only sees assigned workspaces.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({ where: { id: target.id }, data: { role: input.role } });
    if (input.workspaceIds) {
      const valid = await tx.workspace.findMany({
        where: { id: { in: input.workspaceIds }, orgId: req.org!.id, archivedAt: null },
        select: { id: true },
      });
      await tx.membershipWorkspace.deleteMany({ where: { membershipId: target.id } });
      await tx.membershipWorkspace.createMany({ data: valid.map((w) => ({ membershipId: target.id, workspaceId: w.id })) });
    }
  });
  await audit({
    orgId: req.org!.id,
    userId: req.userId,
    action: "member.updated",
    entityType: "member",
    entityId: target.id,
    entityName: target.user.name,
    changes: target.role !== input.role ? { role: { from: target.role, to: input.role } } : undefined,
  });
  res.status(204).end();
});

orgsRouter.delete("/:orgId/members/:memberId", async (req, res) => {
  const target = await prisma.membership.findFirst({
    where: { id: req.params.memberId as string, orgId: req.org!.id },
    include: { user: true },
  });
  if (!target) throw notFound("Member");
  const leaving = target.userId === req.userId;
  if (target.role === "OWNER") throw forbidden("The owner can't be removed. Transfer ownership first.");
  if (!leaving && !canManageMember(req.membership!.role, target.role)) {
    throw forbidden(target.role === "ADMIN" ? "Only the owner can remove an admin." : undefined);
  }

  await prisma.membership.delete({ where: { id: target.id } });
  await audit({
    orgId: req.org!.id,
    userId: req.userId,
    action: leaving ? "member.left" : "member.removed",
    entityType: "member",
    entityId: target.id,
    entityName: target.user.name,
  });
  res.status(204).end();
});

/** Leave an organization you're a member of (owners transfer ownership first). */
orgsRouter.post("/:orgId/leave", async (req, res) => {
  const m = req.membership!;
  if (m.role === "OWNER") throw forbidden("Owners can't leave. Make someone else the owner on the Team page first.");
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { name: true } });
  await prisma.membership.delete({ where: { id: m.id } });
  await audit({ orgId: req.org!.id, userId: req.userId, action: "member.left", entityType: "member", entityId: m.id, entityName: user.name });
  res.status(204).end();
});

// ───────── Invitations ─────────

orgsRouter.get("/:orgId/invitations", requirePermission("members:manage"), async (req, res) => {
  const invites = await prisma.invitation.findMany({
    where: { orgId: req.org!.id, acceptedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    include: { invitedBy: { select: { name: true } } },
  });
  res.json(invites.map(toInvitationDTO));
});

async function sendInvite(orgName: string, inviterName: string, email: string, role: keyof typeof ROLE_INFO, token: string) {
  await sendMail({
    to: email,
    subject: `${inviterName} invited you to ${orgName} on ${BRAND.name}`,
    heading: `Join ${esc(orgName)} on ${BRAND.name}`,
    body: `${esc(inviterName)} has invited you to join <strong>${esc(orgName)}</strong> as ${ROLE_INFO[role].label}. ${BRAND.name} brings all your ad platforms into one place. This invitation expires in 7 days.`,
    cta: { label: "Accept invitation", url: `${config().WEB_URL}/invite/${token}` },
  });
}

orgsRouter.post("/:orgId/invitations", requirePermission("members:manage"), requireVerifiedEmail, async (req, res) => {
  const input = parse(inviteMemberSchema, req.body);
  const orgId = req.org!.id;

  const alreadyMember = await prisma.membership.findFirst({ where: { orgId, user: { email: input.email } } });
  if (alreadyMember) throw conflict(`${input.email} is already a member of this organization.`);
  const workspaces = await prisma.workspace.findMany({ where: { id: { in: input.workspaceIds }, orgId, archivedAt: null }, select: { id: true } });
  if (input.role !== "ADMIN" && workspaces.length === 0) throw badRequest("Choose at least one workspace.");

  // Re-inviting the same email replaces the pending invite, so it mustn't count against the limit.
  const pending = await prisma.invitation.findMany({ where: { orgId, email: input.email, acceptedAt: null } });
  await prisma.invitation.deleteMany({ where: { id: { in: pending.map((p) => p.id) } } });
  try {
    await assertWithinLimit(req.org!, "members");
  } catch (err) {
    if (pending.length) await prisma.invitation.createMany({ data: pending });
    throw err;
  }

  const token = randomToken();
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  const invite = await prisma.invitation.create({
    data: {
      orgId,
      email: input.email,
      role: input.role,
      workspaceIds: workspaces.map((w) => w.id),
      tokenHash: sha256(token),
      invitedById: inviter.id,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    include: { invitedBy: { select: { name: true } } },
  });
  await sendInvite(req.org!.name, inviter.name, input.email, input.role, token);
  await audit({ orgId, userId: req.userId, action: "member.invited", entityType: "invitation", entityId: invite.id, entityName: input.email });
  res.status(201).json(toInvitationDTO(invite));
});

orgsRouter.post("/:orgId/invitations/:inviteId/resend", requirePermission("members:manage"), requireVerifiedEmail, async (req, res) => {
  const invite = await prisma.invitation.findFirst({
    where: { id: req.params.inviteId as string, orgId: req.org!.id, acceptedAt: null },
  });
  if (!invite) throw notFound("Invitation");
  const token = randomToken();
  await prisma.invitation.update({
    where: { id: invite.id },
    data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
  await sendInvite(req.org!.name, inviter.name, invite.email, invite.role, token);
  res.status(204).end();
});

orgsRouter.delete("/:orgId/invitations/:inviteId", requirePermission("members:manage"), async (req, res) => {
  const invite = await prisma.invitation.findFirst({ where: { id: req.params.inviteId as string, orgId: req.org!.id } });
  if (!invite) throw notFound("Invitation");
  await prisma.invitation.delete({ where: { id: invite.id } });
  await audit({ orgId: req.org!.id, userId: req.userId, action: "member.invite_revoked", entityType: "invitation", entityId: invite.id, entityName: invite.email });
  res.status(204).end();
});

/** The owner hands the organization to an existing member, and becomes an Admin. */
orgsRouter.post("/:orgId/transfer-ownership", requirePermission("org:delete"), async (req, res) => {
  const { memberId } = parse(z.object({ memberId: z.string().min(1) }), req.body);
  const orgId = req.org!.id;
  const target = await prisma.membership.findFirst({ where: { id: memberId, orgId }, include: { user: true } });
  if (!target) throw notFound("Member");
  if (target.userId === req.userId) throw badRequest("You're already the owner.");
  if (target.role === "CLIENT") throw badRequest("Clients can't own the organization. Make them an Admin first.");
  await prisma.$transaction([
    prisma.membership.update({ where: { id: req.membership!.id }, data: { role: "ADMIN" } }),
    prisma.membership.update({ where: { id: target.id }, data: { role: "OWNER" } }),
  ]);
  await audit({
    orgId,
    userId: req.userId,
    action: "org.ownership_transferred",
    entityType: "member",
    entityId: target.id,
    entityName: target.user.name,
    changes: { role: { from: target.role, to: "OWNER" } },
  });
  res.status(204).end();
});

// ───────── Workspaces ─────────

orgsRouter.post("/:orgId/workspaces", requirePermission("workspaces:manage"), async (req, res) => {
  const input = parse(workspaceSchema, req.body);
  const orgId = req.org!.id;
  await assertWithinLimit(req.org!, "workspaces");
  const slug = await uniqueSlug(input.name, async (s) =>
    Boolean(await prisma.workspace.findUnique({ where: { orgId_slug: { orgId, slug: s } } })),
  );
  const ws = await prisma.workspace.create({ data: { ...input, orgId, slug } });
  await audit({ orgId, workspaceId: ws.id, userId: req.userId, action: "workspace.created", entityType: "workspace", entityId: ws.id, entityName: ws.name });
  res.status(201).json(toWorkspaceDTO(ws));
});

orgsRouter.patch("/:orgId/workspaces/:workspaceId", requirePermission("workspaces:manage"), async (req, res) => {
  const parsed = parse(workspaceSchema.partial(), req.body);
  // zod applies the schema's defaults (INR, Asia/Kolkata) even inside .partial(), so keep only the fields that were sent;
  // otherwise a rename would reset the currency and timezone.
  const sent = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const input = Object.fromEntries(Object.entries(parsed).filter(([k]) => sent[k] !== undefined)) as typeof parsed;
  const ws = await prisma.workspace.findFirst({ where: { id: req.params.workspaceId as string, orgId: req.org!.id, archivedAt: null } });
  if (!ws) throw notFound("Workspace");
  const updated = await prisma.workspace.update({
    where: { id: ws.id },
    data: input,
    include: { _count: { select: { adAccounts: true } } },
  });
  await audit({ orgId: ws.orgId, workspaceId: ws.id, userId: req.userId, action: "workspace.updated", entityType: "workspace", entityId: ws.id, entityName: updated.name });
  res.json(toWorkspaceDTO(updated));
});

orgsRouter.delete("/:orgId/workspaces/:workspaceId", requirePermission("workspaces:manage"), async (req, res) => {
  const orgId = req.org!.id;
  const ws = await prisma.workspace.findFirst({ where: { id: req.params.workspaceId as string, orgId, archivedAt: null } });
  if (!ws) throw notFound("Workspace");
  const remaining = await prisma.workspace.count({ where: { orgId, archivedAt: null } });
  if (remaining <= 1) throw badRequest("You need at least one workspace.");

  await prisma.$transaction([
    // Free its ad accounts so they can be assigned elsewhere.
    prisma.adAccount.updateMany({ where: { workspaceId: ws.id }, data: { workspaceId: null } }),
    // Nothing keeps running for an archived workspace: rules pause, scheduled reports stop and share links die.
    prisma.rule.updateMany({ where: { workspaceId: ws.id }, data: { isActive: false } }),
    prisma.report.updateMany({ where: { workspaceId: ws.id }, data: { scheduleFrequency: null, nextRunAt: null, shareToken: null } }),
    prisma.workspace.update({ where: { id: ws.id }, data: { archivedAt: new Date() } }),
  ]);
  await audit({ orgId, userId: req.userId, action: "workspace.archived", entityType: "workspace", entityId: ws.id, entityName: ws.name });
  res.status(204).end();
});

orgsRouter.get("/:orgId/workspaces/archived", requirePermission("workspaces:manage"), async (req, res) => {
  const list = await prisma.workspace.findMany({
    where: { orgId: req.org!.id, archivedAt: { not: null } },
    orderBy: { archivedAt: "desc" },
  });
  res.json(list.map((w): ArchivedWorkspaceDTO => ({ ...toWorkspaceDTO(w), archivedAt: w.archivedAt!.toISOString() })));
});

/**
 * Brings an archived workspace back. Its rules stay paused and its reports
 * unscheduled until someone turns them on again; ad accounts were released
 * on archive and need to be reassigned.
 */
orgsRouter.post("/:orgId/workspaces/:workspaceId/restore", requirePermission("workspaces:manage"), async (req, res) => {
  const orgId = req.org!.id;
  const ws = await prisma.workspace.findFirst({ where: { id: req.params.workspaceId as string, orgId, archivedAt: { not: null } } });
  if (!ws) throw notFound("Archived workspace");
  await assertWithinLimit(req.org!, "workspaces");
  const restored = await prisma.workspace.update({
    where: { id: ws.id },
    data: { archivedAt: null },
    include: { _count: { select: { adAccounts: true } } },
  });
  await audit({ orgId, workspaceId: ws.id, userId: req.userId, action: "workspace.restored", entityType: "workspace", entityId: ws.id, entityName: ws.name });
  res.json(toWorkspaceDTO(restored));
});

// ───────── Activity log ─────────

orgsRouter.get("/:orgId/audit-logs", requirePermission("audit:view"), async (req, res) => {
  const take = Math.min(Number(req.query.limit ?? 50), 100);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
  const logs = await prisma.auditLog.findMany({
    where: { orgId: req.org!.id, ...(workspaceId ? { workspaceId } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, name: true } } },
  });
  const hasMore = logs.length > take;
  const page = logs.slice(0, take);
  res.json({ items: page.map(toAuditDTO), nextCursor: hasMore ? page.at(-1)!.id : null });
});
