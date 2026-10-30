/**
 * Test data with sensible defaults; pass overrides for what a test cares about.
 * Everything is created straight in the test database.
 */
import { encryptSecret, hashPassword } from "@ashniva/core";
import { prisma, type Prisma } from "@ashniva/db";
import type { Platform, Role } from "@ashniva/shared";

let seq = 0;
const next = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export const PASSWORD = "Password123";

export async function createUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      name: `User ${n}`,
      email: `user-${n}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
      ...overrides,
    },
  });
}

export interface OrgOptions {
  name?: string;
  plan?: "TRIAL" | "STARTER" | "GROWTH" | "AGENCY";
  subscriptionStatus?: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";
  trialEndsAt?: Date | null;
  aiTokenBalance?: number;
  billingSubscriptionId?: string | null;
}

/** An org with one workspace, owned by `owner`. Defaults to an active Agency plan (nothing locked). */
export async function createOrg(owner: { id: string }, opts: OrgOptions = {}) {
  const n = next();
  const name = opts.name ?? `Org ${n}`;
  const org = await prisma.organization.create({
    data: {
      name,
      slug: `org-${n}`,
      plan: opts.plan ?? "AGENCY",
      subscriptionStatus: opts.subscriptionStatus ?? "ACTIVE",
      trialEndsAt: opts.trialEndsAt ?? null,
      aiTokenBalance: opts.aiTokenBalance ?? 100_000,
      billingSubscriptionId: opts.billingSubscriptionId ?? null,
      memberships: { create: { userId: owner.id, role: "OWNER" } },
      workspaces: { create: { name, slug: `ws-${n}` } },
    },
    include: { workspaces: true },
  });
  return { org, workspace: org.workspaces[0]! };
}

export async function createWorkspace(orgId: string, overrides: Partial<Prisma.WorkspaceUncheckedCreateInput> = {}) {
  const n = next();
  return prisma.workspace.create({ data: { orgId, name: `Workspace ${n}`, slug: `ws-${n}`, ...overrides } });
}

/** Adds `user` to the org with `role`; scoped roles get the given workspaces. */
export async function addMember(orgId: string, user: { id: string }, role: Role, workspaceIds: string[] = []) {
  return prisma.membership.create({
    data: { orgId, userId: user.id, role, workspaces: { create: workspaceIds.map((workspaceId) => ({ workspaceId })) } },
  });
}

/** A platform connection (DEMO by default, so no real API is ever called) with one ad account in `workspaceId`. */
export async function createConnection(
  orgId: string,
  opts: { platform?: Platform; mode?: "DEMO" | "LIVE"; workspaceId?: string | null; currency?: string; createdById?: string } = {},
) {
  const n = next();
  const platform = opts.platform ?? "META";
  const connection = await prisma.platformConnection.create({
    data: {
      orgId,
      platform,
      mode: opts.mode ?? "DEMO",
      externalUserId: `ext-user-${n}`,
      externalUserName: `Login ${n}`,
      accessTokenEnc: encryptSecret(`token-${n}`),
      status: "ACTIVE",
      createdById: opts.createdById,
    },
  });
  const adAccount = await prisma.adAccount.create({
    data: {
      orgId,
      connectionId: connection.id,
      platform,
      externalId: `act_${n}`,
      name: `${platform} account ${n}`,
      currency: opts.currency ?? "INR",
      timezone: "Asia/Kolkata",
      status: "ACTIVE",
      workspaceId: opts.workspaceId === undefined ? null : opts.workspaceId,
    },
  });
  return { connection, adAccount };
}
