/**
 * Helpers for the api-b integration suites. Platform HTTP never leaves the
 * machine: `blockFetch()` (run in beforeEach) makes every unexpected fetch
 * throw, and `stubFetch()` answers only the routes a test lists.
 */
import { encryptSecret, hashPassword, loadPlatformSettings, resetConnectors, saveCredentials } from "@ashniva/core";
import { prisma, type AdAccount, type Prisma } from "@ashniva/db";
import type { Platform, Role } from "@ashniva/shared";
import request from "supertest";
import { vi, type MockInstance } from "vitest";
import { app, sessionCookie } from "../../helpers/api";
import { resetDb } from "../../helpers/db";
import { PASSWORD, addMember, createOrg, type OrgOptions } from "../../helpers/factories";

export const OPERATOR_EMAIL = "operator@example.test"; // SUPER_ADMIN_EMAILS in test/setup/env.ts

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply = Response | { status?: number; json?: unknown; text?: string };
type Route = [match: string | RegExp, reply: Reply | ((call: FetchCall) => Reply | Promise<Reply>)];

let fetchSpy: MockInstance<typeof fetch> | null = null;
export const fetchCalls: FetchCall[] = [];

function toCall(input: Parameters<typeof fetch>[0], init?: RequestInit): FetchCall {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
  const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined;
  return { url, method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), headers, body };
}

function toResponse(r: Reply): Response {
  if (r instanceof Response) return r;
  if (r.text !== undefined) return new Response(r.text, { status: r.status ?? 200, headers: { "Content-Type": "text/plain" } });
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
}

/** Answers fetches whose URL contains (or matches) a route; anything else throws. */
export function stubFetch(routes: Route[]) {
  fetchSpy?.mockRestore();
  fetchCalls.length = 0;
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = toCall(input, init);
    fetchCalls.push(call);
    const hit = routes.find(([m]) => (typeof m === "string" ? call.url.includes(m) : m.test(call.url)));
    if (!hit) throw new Error(`Unexpected fetch in test: ${call.method} ${call.url}`);
    const reply = typeof hit[1] === "function" ? await hit[1](call) : hit[1];
    return toResponse(reply);
  });
  return fetchSpy;
}

/** No outbound HTTP at all. */
export const blockFetch = () => stubFetch([]);

let tables: string[] | null = null;

/**
 * Same result as the shared resetDb() (every table empty, migrations kept), using
 * DELETE in one transaction with FK triggers off instead of TRUNCATE. TRUNCATE
 * recreates every table's files and, with many suites hitting the same Postgres,
 * took longer than the 60 s hook timeout; this takes milliseconds.
 * Set API_B_TRUNCATE=1 to use the shared resetDb() instead.
 */
export async function resetDbFast() {
  if (process.env.API_B_TRUNCATE) return resetDb();
  if (!(process.env.DATABASE_URL ?? "").includes("_test")) throw new Error("resetDbFast only runs against a test database");
  tables ??= (
    await prisma.$queryRaw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations'`
  ).map((t) => `"${t.tablename}"`);
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`set local session_replication_role = replica`),
    ...tables.map((t) => prisma.$executeRawUnsafe(`delete from ${t}`)),
  ]);
}

/**
 * Empties the database and drops console credentials loaded by an earlier
 * test, so process.env and the connector registry match the empty settings table.
 */
export async function resetAll() {
  // Load the app and hash the shared password up front, so the first test isn't charged for it.
  await app();
  hashed ??= hashPassword(PASSWORD);
  await hashed;
  await resetDbFast();
  await loadPlatformSettings(true);
  resetConnectors();
  blockFetch();
}

/** Saves admin-console values (META_APP_ID, RAZORPAY_KEY_ID…) the way the owner would. */
export async function configure(values: Record<string, string | null>) {
  await saveCredentials(values, null);
  resetConnectors();
}

/** Supertest client with the session cookie plus extra cookies. */
export async function client(user: { id: string }, extraCookie = "") {
  const cookie = [await sessionCookie(user), extraCookie].filter(Boolean).join("; ");
  const server = await app();
  const wrap = (method: "get" | "post" | "put" | "patch" | "delete") => (url: string) => request(server)[method](url).set("Cookie", cookie);
  return { get: wrap("get"), post: wrap("post"), put: wrap("put"), patch: wrap("patch"), delete: wrap("delete") };
}

/** An org (owned by a fresh user) plus a member with `role` scoped to the first workspace. */
export async function orgWith(role: Role | "OWNER" = "OWNER", opts: OrgOptions = {}) {
  const owner = await createUser();
  const { org, workspace } = await createOrg(owner, opts);
  if (role === "OWNER") return { org, workspace, owner, user: owner };
  const user = await createUser();
  await addMember(org.id, user, role, [workspace.id]);
  return { org, workspace, owner, user };
}

let seq = 0;
const next = () => `${Date.now().toString(36)}b${(seq++).toString(36)}`;
let hashed: Promise<string> | null = null;

/** Like the shared createUser (password "Password123", verified) but hashes the password once per file. */
export async function createUser(overrides: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  hashed ??= hashPassword(PASSWORD);
  const n = next();
  return prisma.user.create({
    data: { name: `User ${n}`, email: `user-${n}@example.test`, passwordHash: await hashed, emailVerifiedAt: new Date(), ...overrides },
  });
}

/** A platform connection (DEMO by default) with one ad account in `workspaceId` (null = unassigned). */
export async function createConnection(
  orgId: string,
  opts: { platform?: Platform; mode?: "DEMO" | "LIVE"; workspaceId?: string | null; currency?: string; createdById?: string; externalId?: string } = {},
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
      externalId: opts.externalId ?? `act_${n}`,
      name: `${platform} account ${n}`,
      currency: opts.currency ?? "INR",
      timezone: "Asia/Kolkata",
      status: "ACTIVE",
      workspaceId: opts.workspaceId ?? null,
    },
  });
  return { connection, adAccount };
}

export const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** A campaign (with one ad group and ad) on `account` and one day of campaign-level metrics. */
export async function seedCampaign(
  account: Pick<AdAccount, "id" | "platform">,
  opts: { name?: string; spend?: number; impressions?: number; clicks?: number; date?: string; status?: "ACTIVE" | "PAUSED"; dailyBudget?: number } = {},
) {
  const n = Math.random().toString(36).slice(2, 8);
  const campaign = await prisma.campaign.create({
    data: {
      adAccountId: account.id,
      platform: account.platform,
      externalId: `c-${n}`,
      name: opts.name ?? `Campaign ${n}`,
      status: opts.status ?? "ACTIVE",
      dailyBudget: opts.dailyBudget ?? 1000,
    },
  });
  const adGroup = await prisma.adGroup.create({
    data: { adAccountId: account.id, campaignId: campaign.id, externalId: `g-${n}`, name: `Group ${n}`, status: "ACTIVE" },
  });
  const ad = await prisma.ad.create({
    data: { adAccountId: account.id, campaignId: campaign.id, adGroupId: adGroup.id, externalId: `a-${n}`, name: `Ad ${n}`, status: "ACTIVE" },
  });
  if (opts.spend !== undefined) {
    await prisma.metricDaily.create({
      data: {
        date: new Date(`${opts.date ?? isoDay(-1)}T00:00:00Z`),
        level: "CAMPAIGN",
        entityId: campaign.id,
        adAccountId: account.id,
        campaignId: campaign.id,
        platform: account.platform,
        spend: opts.spend,
        impressions: opts.impressions ?? 1000,
        clicks: opts.clicks ?? 10,
      },
    });
  }
  return { campaign, adGroup, ad };
}
