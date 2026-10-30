import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../../test/helpers/db";
import { encryptSecret } from "../src/crypto";
import { addMember, createOrg, createUser, createWorkspace } from "../../../test/helpers/factories";
import { assertWithinLimit, orgUsage } from "../src/entitlements";

/** Faster than resetDb(): every tenant row cascades from organizations or users. */
const resetDb = () => prisma.$transaction([prisma.organization.deleteMany(), prisma.user.deleteMany(), prisma.platformSetting.deleteMany()]);

beforeEach(resetDb);

let seq = 0;
/** One connection with one ad account (the shared factory predates AdAccount.status). */
async function createConnection(orgId: string, opts: { mode: "DEMO" | "LIVE"; workspaceId: string | null }) {
  const n = `${Date.now().toString(36)}${seq++}`;
  const connection = await prisma.platformConnection.create({
    data: { orgId, platform: "META", mode: opts.mode, externalUserId: `u-${n}`, accessTokenEnc: encryptSecret("t"), status: "ACTIVE" },
  });
  await prisma.adAccount.create({
    data: { orgId, connectionId: connection.id, platform: "META", externalId: `act_${n}`, name: `Account ${n}`, currency: "INR", status: "ACTIVE", workspaceId: opts.workspaceId },
  });
  return connection;
}

async function starterOrg() {
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner, { plan: "STARTER", subscriptionStatus: "ACTIVE" });
  return { owner, org, workspace };
}

function invite(orgId: string, opts: { expiresAt?: Date; acceptedAt?: Date | null } = {}) {
  return prisma.invitation.create({
    data: {
      orgId,
      email: `inv-${Math.random().toString(36).slice(2)}@example.test`,
      role: "ANALYST",
      workspaceIds: [],
      tokenHash: Math.random().toString(36),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
      acceptedAt: opts.acceptedAt ?? null,
    },
  });
}

describe("orgUsage", () => {
  it("counts active workspaces, live assigned ad accounts and members plus pending invites", async () => {
    const { org, workspace } = await starterOrg();
    await createWorkspace(org.id, { archivedAt: new Date() });
    await createWorkspace(org.id);
    await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    await createConnection(org.id, { mode: "LIVE", workspaceId: null });
    await createConnection(org.id, { mode: "DEMO", workspaceId: workspace.id });
    await addMember(org.id, await createUser(), "ADMIN");
    await invite(org.id);
    await invite(org.id, { expiresAt: new Date(Date.now() - 1000) });
    await invite(org.id, { acceptedAt: new Date() });

    // Another org's data never counts.
    const other = await createOrg(await createUser());
    await createConnection(other.org.id, { mode: "LIVE", workspaceId: other.workspace.id });

    expect(await orgUsage(org.id)).toEqual({ workspaces: 2, adAccounts: 1, members: 3 });
  });
});

describe("assertWithinLimit", () => {
  it("blocks a second workspace on Starter, but archived ones free the slot", async () => {
    const { org, workspace } = await starterOrg();
    await expect(assertWithinLimit(org, "workspaces")).rejects.toMatchObject({
      code: "PLAN_LIMIT",
      message: "Your Starter plan includes up to 1 workspaces. Upgrade to add more.",
    });
    await prisma.workspace.update({ where: { id: workspace.id }, data: { archivedAt: new Date() } });
    await expect(assertWithinLimit(org, "workspaces")).resolves.toBeUndefined();
  });

  it("counts only live ad accounts assigned to a workspace; sample accounts are free", async () => {
    const { org, workspace } = await starterOrg();
    for (let i = 0; i < 5; i++) await createConnection(org.id, { mode: "DEMO", workspaceId: workspace.id });
    await createConnection(org.id, { mode: "LIVE", workspaceId: null });
    await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    await expect(assertWithinLimit(org, "adAccounts")).resolves.toBeUndefined();

    await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    await expect(assertWithinLimit(org, "adAccounts")).rejects.toMatchObject({
      code: "PLAN_LIMIT",
      message: expect.stringContaining("up to 3 connected ad accounts"),
    });
  });

  it("counts pending invitations as members", async () => {
    const { org } = await starterOrg();
    await invite(org.id, { expiresAt: new Date(Date.now() - 1000) });
    await expect(assertWithinLimit(org, "members")).resolves.toBeUndefined();
    await invite(org.id);
    await expect(assertWithinLimit(org, "members")).rejects.toMatchObject({ code: "PLAN_LIMIT", message: expect.stringContaining("2 team members") });
  });

  it("never limits Agency", async () => {
    const owner = await createUser();
    const { org, workspace } = await createOrg(owner, { plan: "AGENCY" });
    for (let i = 0; i < 4; i++) {
      await createWorkspace(org.id);
      await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
      await invite(org.id);
    }
    for (const r of ["workspaces", "adAccounts", "members"] as const) await expect(assertWithinLimit(org, r)).resolves.toBeUndefined();
  });

  it("rejects a locked organization before counting anything", async () => {
    const owner = await createUser();
    const { org } = await createOrg(owner, { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 1000) });
    await expect(assertWithinLimit(org, "members")).rejects.toMatchObject({ code: "ORG_LOCKED" });
  });

  it("allows a running trial up to the trial limits", async () => {
    const owner = await createUser();
    const { org } = await createOrg(owner, { plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    await expect(assertWithinLimit(org, "workspaces")).resolves.toBeUndefined();
  });
});
