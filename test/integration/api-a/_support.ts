/**
 * Shared helpers for the api-a integration suites (not a test file itself).
 * - Each test client gets its own X-Forwarded-For address, so /api/auth's per-IP rate
 *   limiter (20 per 15 min) never trips in a run. The app trusts one proxy hop.
 * - Mail is captured by swapping mailTransport.deliver.
 * - Seeds create rows straight in the test database with a precomputed password hash.
 */
import { encryptSecret, hashPassword, randomToken, sha256 } from "@ashniva/core";
import { prisma, type Prisma } from "@ashniva/db";
import type { Platform, Role } from "@ashniva/shared";
import request from "supertest";
import { expect } from "vitest";
import { app, sessionCookie } from "../../helpers/api";
import { addMember, createOrg, createWorkspace, PASSWORD, type OrgOptions } from "../../helpers/factories";

export { PASSWORD };

let ipSeq = 0;
/** A fresh client address (10.x.y.z) for the rate limiters. */
export function nextIp() {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

/** A cookie-keeping supertest agent with its own client IP. */
export async function agent() {
  const a = request.agent(await app());
  a.set("X-Forwarded-For", nextIp());
  return a;
}

/** Anonymous requests from a fresh IP each time. */
export async function anonymous() {
  const server = await app();
  const wrap = (method: "get" | "post" | "put" | "patch" | "delete") => (url: string) =>
    request(server)[method](url).set("X-Forwarded-For", nextIp());
  return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

/** Like helpers/api `as`, plus a fresh client IP per request. */
export async function signedIn(user: { id: string }) {
  const cookie = await sessionCookie(user);
  const server = await app();
  const wrap = (method: "get" | "post" | "put" | "patch" | "delete") => (url: string) =>
    request(server)[method](url).set("Cookie", cookie).set("X-Forwarded-For", nextIp());
  return { cookie, get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}
export type Client = Awaited<ReturnType<typeof signedIn>>;

// ───────── Database ─────────

/**
 * Empties every table like helpers/db resetDb(), but with DELETE under
 * session_replication_role=replica in one statement: ~0.1 s instead of the
 * ~1.5 s TRUNCATE takes on this machine, which matters for a few hundred tests.
 * Files still call resetDb() once in beforeAll.
 */
export async function fastReset() {
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("fastReset only runs against a test database");
  await prisma.$executeRawUnsafe(`DO $$ DECLARE r record; BEGIN
    SET LOCAL session_replication_role = replica;
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' LOOP
      EXECUTE 'DELETE FROM ' || quote_ident(r.tablename);
    END LOOP;
  END $$;`);
}

// ───────── Mail capture ─────────

export interface CapturedMail {
  to: string[];
  subject: string;
  html: string;
}
export const outbox: CapturedMail[] = [];

export async function captureMail() {
  const { mailTransport } = await import("../../../apps/api/src/lib/mailer");
  mailTransport.deliver = async (mail: CapturedMail) => {
    outbox.push(mail);
    return true;
  };
}

/** Token from the newest email to `to` whose link contains `marker` followed by the token. */
export function tokenFromMail(to: string, marker: "/reset-password?token=" | "/verify-email?token=" | "/invite/") {
  const mail = outbox.findLast((m) => m.to.includes(to) && m.html.includes(marker));
  expect(mail, `no ${marker} email to ${to}`).toBeDefined();
  const escaped = marker.replace(/[?]/g, "\\?");
  const token = new RegExp(`${escaped}([\\w-]+)`).exec(mail!.html)?.[1];
  expect(token, `no token in ${marker} email`).toBeDefined();
  return token!;
}

// ───────── Cookies ─────────

/** name → value of the Set-Cookie headers on a response. */
export function setCookies(res: { headers: Record<string, unknown> }) {
  const raw = (res.headers["set-cookie"] as string[] | undefined) ?? [];
  const out: Record<string, string> = {};
  for (const c of raw) {
    const [pair] = c.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = pair!.slice(i + 1);
  }
  return out;
}

// ───────── Seeds ─────────

let hash: string | null = null;
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A verified user (password PASSWORD), created without re-hashing each time. */
export async function quickUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  hash ??= await hashPassword(PASSWORD);
  const n = uid();
  return prisma.user.create({
    data: { name: `User ${n}`, email: `qa-${n}@example.test`, passwordHash: hash, emailVerifiedAt: new Date(), ...overrides },
  });
}

/**
 * Same as helpers/factories createConnection, which currently fails: AdAccount.status
 * is a required column it doesn't set.
 */
export async function createConnection(
  orgId: string,
  opts: { platform?: Platform; mode?: "DEMO" | "LIVE"; workspaceId?: string | null; createdById?: string; status?: "ACTIVE" | "REVOKED" } = {},
) {
  const n = uid();
  const platform = opts.platform ?? "META";
  const connection = await prisma.platformConnection.create({
    data: {
      orgId,
      platform,
      mode: opts.mode ?? "DEMO",
      externalUserId: `ext-user-${n}`,
      externalUserName: `Login ${n}`,
      accessTokenEnc: encryptSecret(`token-${n}`),
      status: opts.status ?? "ACTIVE",
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
      currency: "INR",
      timezone: "Asia/Kolkata",
      status: "ACTIVE",
      workspaceId: opts.workspaceId === undefined ? null : opts.workspaceId,
    },
  });
  return { connection, adAccount };
}

const draftPayload = (adAccountId: string, platform = "META") => ({ version: 2, platform, adAccountId, adGroups: [] });
export { draftPayload };

export const reportConfig = { metrics: ["spend", "clicks"], dimension: "campaign", datePreset: "30d", platforms: [], compare: false, chartMetric: "spend" };

export const ruleBody = (name = "Pause expensive") => ({
  name,
  scope: { platforms: [], campaignIds: [], minSpend: 0 },
  conditions: [{ metric: "spend", operator: "gt", value: 100 }],
  actions: [{ type: "NOTIFY" }],
});

/**
 * One workspace's worth of everything the id-taking routes look up:
 * a DEMO connection + ad account, campaign/ad group/ad, lead, creative, draft, report, rule.
 */
export async function seedWorkspaceContent(orgId: string, workspaceId: string, createdById?: string) {
  const n = uid();
  const { connection, adAccount } = await createConnection(orgId, { workspaceId, createdById });
  const campaign = await prisma.campaign.create({
    data: { adAccountId: adAccount.id, platform: "META", externalId: `c_${n}`, name: `Campaign ${n}`, status: "ACTIVE", dailyBudget: 500 },
  });
  const adGroup = await prisma.adGroup.create({
    data: { adAccountId: adAccount.id, campaignId: campaign.id, externalId: `g_${n}`, name: `Group ${n}`, status: "ACTIVE" },
  });
  const ad = await prisma.ad.create({
    data: { adAccountId: adAccount.id, campaignId: campaign.id, adGroupId: adGroup.id, externalId: `a_${n}`, name: `Ad ${n}`, status: "ACTIVE" },
  });
  const lead = await prisma.lead.create({
    data: {
      orgId,
      workspaceId,
      connectionId: connection.id,
      platform: "META",
      externalId: `l_${n}`,
      name: `Lead ${n}`,
      email: `lead-${n}@example.test`,
      phone: "+91 98765 43210",
      campaignId: campaign.id,
      campaignName: campaign.name,
      fields: { full_name: [`Lead ${n}`] },
      createdTime: new Date(),
    },
  });
  const creative = await prisma.creative.create({
    data: {
      orgId,
      workspaceId,
      name: `creative-${n}.png`,
      type: "IMAGE",
      mimeType: "image/png",
      sizeBytes: 10,
      storageKey: `creatives/${orgId}/${n}.png`,
      url: `/api/files/creatives/${orgId}/${n}.png`,
    },
  });
  const draft = await prisma.campaignDraft.create({
    data: { orgId, workspaceId, name: `Draft ${n}`, payload: draftPayload(adAccount.id), createdById },
  });
  const report = await prisma.report.create({
    data: {
      orgId,
      workspaceId,
      name: `Report ${n}`,
      config: reportConfig,
      recipients: ["boss@example.test"],
      scheduleFrequency: "WEEKLY",
      nextRunAt: new Date(Date.now() + 86_400_000),
      shareToken: randomToken(24),
      createdById,
    },
  });
  const rule = await prisma.rule.create({
    data: {
      orgId,
      workspaceId,
      name: `Rule ${n}`,
      isActive: true,
      scope: { platforms: [], campaignIds: [], minSpend: 0 },
      conditions: [{ metric: "spend", operator: "gt", value: 100 }],
      actions: [{ type: "NOTIFY" }],
      nextRunAt: new Date(),
      createdById,
    },
  });
  return { connection, adAccount, campaign, adGroup, ad, lead, creative, draft, report, rule };
}
export type WorkspaceContent = Awaited<ReturnType<typeof seedWorkspaceContent>>;

/** An API key for the org; returns the row and its secret. */
export async function seedApiKey(orgId: string, createdById?: string) {
  const secret = `ak_live_${randomToken(30)}`;
  const key = await prisma.apiKey.create({ data: { orgId, name: "Seeded key", prefix: secret.slice(0, 15), keyHash: sha256(secret), createdById } });
  return { key, secret };
}

/** A pending invitation; returns the row and its raw token. */
export async function seedInvitation(
  orgId: string,
  opts: { email?: string; role?: Role; workspaceIds?: string[]; invitedById?: string; expiresAt?: Date } = {},
) {
  const token = randomToken();
  const invite = await prisma.invitation.create({
    data: {
      orgId,
      email: opts.email ?? `invitee-${uid()}@example.test`,
      role: opts.role ?? "MANAGER",
      workspaceIds: opts.workspaceIds ?? [],
      tokenHash: sha256(token),
      invitedById: opts.invitedById,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    },
  });
  return { invite, token };
}

export const SCOPED: Role[] = ["MANAGER", "ANALYST", "CLIENT"];

/**
 * An org with one member per role. Scoped roles are assigned to `workspace` only; `other`
 * is a second workspace none of them is assigned to. `outsider` belongs to no org here.
 */
export async function seedTeam(opts: OrgOptions = {}) {
  const owner = await quickUser({ name: "Olivia Owner" });
  const { org, workspace } = await createOrg(owner, opts);
  const other = await createWorkspace(org.id, { name: "Other workspace" });
  const users = { OWNER: owner } as Record<Role, Awaited<ReturnType<typeof quickUser>>>;
  const members = {} as Record<Role, { id: string }>;
  members.OWNER = (await prisma.membership.findFirstOrThrow({ where: { orgId: org.id, userId: owner.id } }))!;
  for (const role of ["ADMIN", "MANAGER", "ANALYST", "CLIENT"] as Role[]) {
    const u = await quickUser({ name: `${role[0]}${role.slice(1).toLowerCase()} User` });
    users[role] = u;
    members[role] = await addMember(org.id, u, role, role === "ADMIN" ? [] : [workspace.id]);
  }
  const outsider = await quickUser({ name: "Outsider" });
  return { org, workspace, other, users, members, outsider, owner };
}
export type Team = Awaited<ReturnType<typeof seedTeam>>;

/** A tiny valid 1x1 PNG. */
export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Today and 30 days ago as yyyy-mm-dd, for date-range queries. */
export function range() {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 86_400_000);
  return `from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`;
}
