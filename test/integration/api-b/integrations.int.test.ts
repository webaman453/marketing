/**
 * Integrations: platform catalogue, connect flows (OAuth 2, OAuth 1.0a for X,
 * Shopify, per-organization API keys), connection scoping, sync, disconnect,
 * sample data and ad-account assignment. Platform HTTP is answered by fetch stubs.
 */
import { createHmac } from "node:crypto";
import { decryptSecret, getSyncQueue } from "@ashniva/core";
import { DEMO_PLATFORMS } from "@ashniva/connectors";
import { PLATFORMS, isPlatformShown } from "@ashniva/shared";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { as } from "../../helpers/api";
import { prisma } from "../../helpers/db";
import { addMember, createOrg, createWorkspace } from "../../helpers/factories";
import { OPERATOR_EMAIL, client, configure, createConnection, createUser, fetchCalls, orgWith, resetAll, stubFetch } from "./helpers";

const WEB = "http://localhost:3100";
const STATE_SECRET = () => process.env.OAUTH_STATE_SECRET!;

beforeAll(async () => {
  await getSyncQueue().obliterate({ force: true });
});
afterAll(async () => {
  await getSyncQueue().obliterate({ force: true });
  await getSyncQueue().close();
});
beforeEach(resetAll);

/** Query params of a redirect to the web app. */
function redirectParams(res: { status: number; headers: Record<string, string> }) {
  expect(res.status).toBe(302);
  const u = new URL(res.headers.location!);
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
}

const META_KEYS = { META_APP_ID: "1234567890", META_APP_SECRET: "meta-test-secret" };

/** Meta Graph answers for a successful connect. */
function stubMetaGraph(accounts = [{ account_id: "111", name: "Acme IN", currency: "INR", timezone_name: "Asia/Kolkata", account_status: 1 }]) {
  return stubFetch([
    [
      "graph.facebook.com/v26.0/oauth/access_token",
      (c) => ({ json: c.url.includes("fb_exchange_token") ? { access_token: "long-lived-token", expires_in: 5_184_000 } : { access_token: "short-token" } }),
    ],
    ["graph.facebook.com/v26.0/me/adaccounts", { json: { data: accounts } }],
    ["graph.facebook.com/v26.0/me?", { json: { id: "fb-user-1", name: "Asha on Facebook" } }],
  ]);
}

async function authorizeMeta(user: { id: string }, orgId: string, workspaceId: string) {
  const res = await (await as(user)).post(`/api/orgs/${orgId}/connections/meta/authorize`).send({ workspaceId });
  expect(res.status).toBe(200);
  const state = new URL(res.body.url).searchParams.get("state");
  expect(state).toBeTruthy();
  return state!;
}

describe("GET /platforms", () => {
  it("lists only visible platforms with their connect flags", async () => {
    const { org, owner } = await orgWith();
    const res = await (await as(owner)).get(`/api/orgs/${org.id}/platforms`);
    expect(res.status).toBe(200);
    const ids = res.body.map((p: { id: string }) => p.id);
    expect(ids).toEqual(PLATFORMS.filter(isPlatformShown));
    for (const hidden of ["TIKTOK", "SWIGGY", "ZEPTO", "NAUKRI"]) expect(ids).not.toContain(hidden);

    const by = Object.fromEntries(res.body.map((p: { id: string }) => [p.id, p]));
    expect(by.META).toMatchObject({ supported: true, configured: false, connectsWithCredentials: false, operatorKeys: false });
    // Key-based platforms can always connect with the organization's own keys.
    expect(by.OUTBRAIN).toMatchObject({ supported: true, configured: true, connectsWithCredentials: true, operatorKeys: false });
    expect(by.SHOPIFY.supported).toBe(true);
  });

  it("reflects keys saved in the admin console", async () => {
    await configure({ ...META_KEYS, OUTBRAIN_API_TOKEN: "operator-ob-token" });
    const { org, owner } = await orgWith();
    const res = await (await as(owner)).get(`/api/orgs/${org.id}/platforms`);
    const by = Object.fromEntries(res.body.map((p: { id: string }) => [p.id, p]));
    expect(by.META.configured).toBe(true);
    expect(by.OUTBRAIN.operatorKeys).toBe(true);
  });
});

describe("POST /connections/:platform/authorize", () => {
  it("returns a consent URL with a signed state for a configured OAuth platform", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const state = await authorizeMeta(owner, org.id, workspace.id);
    const claims = jwt.verify(state, STATE_SECRET(), { issuer: "ashniva-oauth" }) as Record<string, string>;
    expect(claims).toMatchObject({ orgId: org.id, userId: owner.id, workspaceId: workspace.id, platform: "META" });
  });

  it("needs integrations:manage", async () => {
    await configure(META_KEYS);
    for (const role of ["MANAGER", "ANALYST", "CLIENT"] as const) {
      const { org, workspace, user } = await orgWith(role);
      const res = await (await as(user)).post(`/api/orgs/${org.id}/connections/meta/authorize`).send({ workspaceId: workspace.id });
      expect(res.status, role).toBe(403);
    }
  });

  it("returns 402 for a locked organization", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith("OWNER", { plan: "STARTER", subscriptionStatus: "EXPIRED" });
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/meta/authorize`).send({ workspaceId: workspace.id });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("ORG_LOCKED");
  });

  it("rejects hidden platforms", async () => {
    const { org, workspace, owner } = await orgWith();
    for (const p of ["tiktok", "swiggy", "naukri"]) {
      const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/${p}/authorize`).send({ workspaceId: workspace.id });
      expect(res.status, p).toBe(400);
    }
  });

  it("rejects a workspace from another organization and an unconfigured platform", async () => {
    const { org, owner } = await orgWith();
    const { workspace: foreign } = await orgWith();
    await configure(META_KEYS);
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/meta/authorize`).send({ workspaceId: foreign.id });
    expect(res.status).toBe(404);

    const own = await prisma.workspace.findFirstOrThrow({ where: { orgId: org.id } });
    const unconfigured = await (await as(owner)).post(`/api/orgs/${org.id}/connections/linkedin/authorize`).send({ workspaceId: own.id });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error.code).toBe("PLATFORM_NOT_CONFIGURED");
  });

  it("validates the Shopify store domain and pins it in the state", async () => {
    await configure({ SHOPIFY_CLIENT_ID: "shp-client", SHOPIFY_CLIENT_SECRET: "shp-secret" });
    const { org, workspace, owner } = await orgWith();
    const api = await as(owner);
    for (const shop of ["", "not a store!", "evil.com", "https://evil.example.com/x"]) {
      const bad = await api.post(`/api/orgs/${org.id}/connections/shopify/authorize`).send({ workspaceId: workspace.id, shop });
      expect(bad.status, shop).toBe(400);
    }
    const ok = await api.post(`/api/orgs/${org.id}/connections/shopify/authorize`).send({ workspaceId: workspace.id, shop: "https://My-Store.myshopify.com/admin" });
    expect(ok.status).toBe(200);
    const url = new URL(ok.body.url);
    expect(url.host).toBe("my-store.myshopify.com");
    const claims = jwt.verify(url.searchParams.get("state")!, STATE_SECRET(), { issuer: "ashniva-oauth" }) as { shop: string };
    expect(claims.shop).toBe("my-store.myshopify.com");
    const short = await api.post(`/api/orgs/${org.id}/connections/shopify/authorize`).send({ workspaceId: workspace.id, shop: "acme" });
    expect(new URL(short.body.url).host).toBe("acme.myshopify.com");
  });

  it("only lets the platform operator use the operator's keys for key-based platforms", async () => {
    await configure({ OUTBRAIN_API_TOKEN: "operator-ob-token" });
    const { org, workspace, owner } = await orgWith();
    const denied = await (await as(owner)).post(`/api/orgs/${org.id}/connections/outbrain/authorize`).send({ workspaceId: workspace.id });
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toMatch(/own API keys/);

    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { org: opOrg, workspace: opWs } = await createOrg(operator);
    const allowed = await (await as(operator)).post(`/api/orgs/${opOrg.id}/connections/outbrain/authorize`).send({ workspaceId: opWs.id });
    expect(allowed.status).toBe(200);
    // Outbrain has no consent screen: the "consent URL" is our own callback.
    expect(allowed.body.url).toContain("/api/oauth/outbrain/callback");
  });

  it("starts X's OAuth 1.0a sign-in and keeps the request token in an httpOnly cookie", async () => {
    await configure({ X_CONSUMER_KEY: "x-key", X_CONSUMER_SECRET: "x-secret" });
    stubFetch([["api.x.com/oauth/request_token", { text: "oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true" }]]);
    const { org, workspace, owner } = await orgWith();
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/x/authorize`).send({ workspaceId: workspace.id });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://api.x.com/oauth/authorize?oauth_token=req-token");
    const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ashniva_oauth1="));
    expect(cookie).toMatch(/HttpOnly/i);
    // The request secret is never in the cookie in clear text.
    expect(decodeURIComponent(cookie!)).not.toContain("req-secret");
    expect(fetchCalls[0]!.headers.authorization).toMatch(/^OAuth /);
  });
});

describe("GET /api/oauth/:platform/callback", () => {
  it("connects Meta: exchanges the code, stores the token encrypted and lists accounts into the workspace", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const state = await authorizeMeta(owner, org.id, workspace.id);
    stubMetaGraph();
    const res = await (await as(owner)).get(`/api/oauth/meta/callback?code=the-code&state=${state}`);
    const { path, params } = redirectParams(res);
    expect(path).toBe(`/w/${workspace.id}/integrations`);
    expect(params).toEqual({ connected: "META", accounts: "1" });
    expect(res.headers.location!.startsWith(WEB)).toBe(true);

    const conn = await prisma.platformConnection.findFirstOrThrow({ where: { orgId: org.id }, include: { adAccounts: true } });
    expect(conn).toMatchObject({ platform: "META", mode: "LIVE", externalUserId: "fb-user-1", status: "ACTIVE", syncStatus: "QUEUED", createdById: owner.id });
    expect(conn.accessTokenEnc).not.toContain("long-lived-token");
    expect(decryptSecret(conn.accessTokenEnc!)).toBe("long-lived-token");
    expect(conn.credentialsEnc).toBeNull();
    expect(conn.adAccounts.map((a) => [a.externalId, a.workspaceId])).toEqual([["111", workspace.id]]);
    expect(await getSyncQueue().getJob(`sync-${conn.id}`)).toBeTruthy();
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: "integration.connected", entityId: conn.id } })).toBe(1);
    // The secret travels to Meta, never anywhere else.
    expect(fetchCalls.every((c) => c.url.startsWith("https://graph.facebook.com/"))).toBe(true);
  });

  it("rejects a tampered or expired state", async () => {
    const { org, workspace, owner } = await orgWith();
    const api = await as(owner);
    const bad = redirectParams(await api.get(`/api/oauth/meta/callback?code=x&state=not-a-jwt`));
    expect(bad.params.error).toMatch(/expired/i);

    const expired = jwt.sign({ orgId: org.id, userId: owner.id, workspaceId: workspace.id, platform: "META" }, STATE_SECRET(), { expiresIn: -10, issuer: "ashniva-oauth" });
    expect(redirectParams(await api.get(`/api/oauth/meta/callback?code=x&state=${expired}`)).params.error).toMatch(/expired/i);

    const forged = jwt.sign({ orgId: org.id, userId: owner.id, workspaceId: workspace.id, platform: "META" }, "some-other-secret", { issuer: "ashniva-oauth" });
    expect(redirectParams(await api.get(`/api/oauth/meta/callback?code=x&state=${forged}`)).params.error).toMatch(/expired/i);
    expect(fetchCalls).toHaveLength(0);
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("sends an anonymous browser to sign in", async () => {
    const res = await (await import("../../helpers/api")).anon().then((a) => a.get(`/api/oauth/meta/callback?code=x&state=y`));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/login?error=session`);
  });

  it("refuses a state started by another user, or for another platform", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const admin = await createUser();
    await addMember(org.id, admin, "ADMIN");
    const state = await authorizeMeta(owner, org.id, workspace.id);
    stubMetaGraph();
    const other = redirectParams(await (await as(admin)).get(`/api/oauth/meta/callback?code=c&state=${state}`));
    expect(other.params.error).toMatch(/doesn't match your session/);
    const wrongPlatform = redirectParams(await (await as(owner)).get(`/api/oauth/google/callback?code=c&state=${state}`));
    expect(wrongPlatform.params.error).toMatch(/doesn't match your session/);
    expect(fetchCalls).toHaveLength(0);
  });

  it("re-checks permission, membership and plan when the sign-in completes", async () => {
    await configure(META_KEYS);
    const { org, workspace, user: admin } = await orgWith("ADMIN");
    stubMetaGraph();
    const api = await as(admin);

    let state = await authorizeMeta(admin, org.id, workspace.id);
    await prisma.membership.update({ where: { userId_orgId: { userId: admin.id, orgId: org.id } }, data: { role: "ANALYST" } });
    expect(redirectParams(await api.get(`/api/oauth/meta/callback?code=c&state=${state}`)).params.error).toMatch(/no longer have permission/);

    await prisma.membership.update({ where: { userId_orgId: { userId: admin.id, orgId: org.id } }, data: { role: "ADMIN" } });
    state = await authorizeMeta(admin, org.id, workspace.id);
    await prisma.organization.update({ where: { id: org.id }, data: { subscriptionStatus: "EXPIRED", plan: "STARTER" } });
    expect(redirectParams(await api.get(`/api/oauth/meta/callback?code=c&state=${state}`)).params.error).toMatch(/plan is inactive/);

    await prisma.organization.update({ where: { id: org.id }, data: { subscriptionStatus: "ACTIVE", plan: "AGENCY" } });
    state = await authorizeMeta(admin, org.id, workspace.id);
    await prisma.membership.delete({ where: { userId_orgId: { userId: admin.id, orgId: org.id } } });
    expect(redirectParams(await api.get(`/api/oauth/meta/callback?code=c&state=${state}`)).params.error).toMatch(/no longer have access/);

    expect(fetchCalls).toHaveLength(0);
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("refuses a state for a hidden platform", async () => {
    const { org, workspace, owner } = await orgWith();
    const state = jwt.sign({ orgId: org.id, userId: owner.id, workspaceId: workspace.id, platform: "TIKTOK" }, STATE_SECRET(), { expiresIn: "15m", issuer: "ashniva-oauth" });
    const { params } = redirectParams(await (await as(owner)).get(`/api/oauth/tiktok/callback?auth_code=c&state=${state}`));
    expect(params.error).toMatch(/isn't available/);
  });

  it("passes on a denied consent without calling the platform", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const state = await authorizeMeta(owner, org.id, workspace.id);
    const { params } = redirectParams(await (await as(owner)).get(`/api/oauth/meta/callback?error=access_denied&error_description=User+said+no&state=${state}`));
    expect(params.error).toBe("User said no");
    expect(fetchCalls).toHaveLength(0);
  });

  it("turns a platform failure into a redirect with the message, not a 500", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const state = await authorizeMeta(owner, org.id, workspace.id);
    stubFetch([["graph.facebook.com", { status: 400, json: { error: { message: "Invalid verification code format.", code: 100 } } }]]);
    const { params } = redirectParams(await (await as(owner)).get(`/api/oauth/meta/callback?code=bad&state=${state}`));
    expect(params.error).toBe("Invalid verification code format.");
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("connects the operator's own organization with the operator's keys, marked as such", async () => {
    await configure({ OUTBRAIN_API_TOKEN: "operator-ob-token" });
    stubFetch([["api.outbrain.com/amplify/v0.1/marketers", { json: { marketers: [{ id: "op-mk", name: "Operator marketer", currency: "INR" }] } }]]);
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const { org, workspace } = await createOrg(operator);
    const auth = await (await as(operator)).post(`/api/orgs/${org.id}/connections/outbrain/authorize`).send({ workspaceId: workspace.id });
    const callback = new URL(auth.body.url);
    const res = await (await as(operator)).get(`${callback.pathname}${callback.search}`);
    expect(redirectParams(res).params).toEqual({ connected: "OUTBRAIN", accounts: "1" });
    expect(fetchCalls.every((c) => c.headers["ob-token-v1"] === "operator-ob-token")).toBe(true);
    const conn = await prisma.platformConnection.findFirstOrThrow({ where: { orgId: org.id } });
    expect(JSON.parse(decryptSecret(conn.credentialsEnc!))).toEqual({ operatorKeys: "true" });
  });

  it("a workspace archived during the sign-in doesn't receive the new ad accounts", async () => {
    await configure(META_KEYS);
    const { org, workspace, owner } = await orgWith();
    const spare = await createWorkspace(org.id);
    const state = await authorizeMeta(owner, org.id, workspace.id);
    expect((await (await as(owner)).delete(`/api/orgs/${org.id}/workspaces/${workspace.id}`)).status).toBe(204);
    stubMetaGraph();
    await (await as(owner)).get(`/api/oauth/meta/callback?code=c&state=${state}`);
    expect(spare).toBeTruthy();
    expect(await prisma.adAccount.count({ where: { orgId: org.id, workspace: { archivedAt: { not: null } } } })).toBe(0);
  });

  it("rejects a Shopify callback whose hmac doesn't verify", async () => {
    await configure({ SHOPIFY_CLIENT_ID: "shp-client", SHOPIFY_CLIENT_SECRET: "shp-secret" });
    const { org, workspace, owner } = await orgWith();
    const api = await as(owner);
    const auth = await api.post(`/api/orgs/${org.id}/connections/shopify/authorize`).send({ workspaceId: workspace.id, shop: "my-store" });
    const state = new URL(auth.body.url).searchParams.get("state")!;
    const query = { code: "shop-code", shop: "my-store.myshopify.com", state, timestamp: "1700000000" };
    const message = Object.keys(query).sort().map((k) => `${k}=${query[k as keyof typeof query]}`).join("&");
    const wrongKey = createHmac("sha256", "not-the-secret").update(message).digest("hex");
    const res = await api.get(`/api/oauth/shopify/callback?${new URLSearchParams({ ...query, hmac: wrongKey })}`);
    const { params } = redirectParams(res);
    expect(params.error).toMatch(/signature check/);
    expect(fetchCalls).toHaveLength(0);
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("completes X's OAuth 1.0a flow with the cookie and refuses a mismatched request token", async () => {
    await configure({ X_CONSUMER_KEY: "x-key", X_CONSUMER_SECRET: "x-secret" });
    stubFetch([
      ["api.x.com/oauth/request_token", { text: "oauth_token=req-token&oauth_token_secret=req-secret&oauth_callback_confirmed=true" }],
      ["api.x.com/oauth/access_token", { text: "oauth_token=user-token&oauth_token_secret=user-secret&user_id=42&screen_name=acme" }],
      [/\/accounts(\?|$)/, { json: { data: [{ id: "18ce54d4x5t", name: "Acme X", currency: "INR", approval_status: "ACCEPTED" }] } }],
    ]);
    const { org, workspace, owner } = await orgWith();
    const start = async () => {
      const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/x/authorize`).send({ workspaceId: workspace.id });
      return (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("ashniva_oauth1="))!.split(";")[0]!;
    };

    const mismatch = await (await client(owner, await start())).get(`/api/oauth/x/callback?oauth_token=someone-elses&oauth_verifier=v`);
    expect(redirectParams(mismatch).params.error).toMatch(/doesn't match/);

    const noCookie = await (await client(owner)).get(`/api/oauth/x/callback?oauth_token=req-token&oauth_verifier=v`);
    expect(redirectParams(noCookie).params.error).toMatch(/expired/i);

    const ok = await (await client(owner, await start())).get(`/api/oauth/x/callback?oauth_token=req-token&oauth_verifier=verifier-1`);
    expect(redirectParams(ok).params).toEqual({ connected: "X", accounts: "1" });
    // The cookie is single-use.
    expect(String(ok.headers["set-cookie"])).toMatch(/ashniva_oauth1=;/);
    const accessCall = fetchCalls.find((c) => c.url.includes("access_token"))!;
    expect(accessCall.headers.authorization).toContain('oauth_token="req-token"');
    expect(accessCall.headers.authorization).toContain('oauth_verifier="verifier-1"');
    const conn = await prisma.platformConnection.findFirstOrThrow({ where: { orgId: org.id, platform: "X" } });
    expect(conn.externalUserId).toBe("42");
    expect(decryptSecret(conn.accessTokenEnc!)).toContain("user-secret");
  });
});

describe("POST /connections/:platform/credentials (organization's own keys)", () => {
  const marketers = { json: { marketers: [{ id: "mk-1", name: "Acme Marketer", currency: "INR", enabled: true }] } };

  it("checks the keys with a read, stores them encrypted and lists accounts", async () => {
    stubFetch([["api.outbrain.com/amplify/v0.1/marketers", marketers]]);
    const { org, workspace, owner } = await orgWith();
    const res = await (await as(owner))
      .post(`/api/orgs/${org.id}/connections/outbrain/credentials`)
      .send({ workspaceId: workspace.id, credentials: { apiToken: "  org-ob-token  ", ignored: "x" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ connected: "OUTBRAIN", accounts: 1 });
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.every((c) => c.method === "GET" && c.headers["ob-token-v1"] === "org-ob-token")).toBe(true);

    const conn = await prisma.platformConnection.findFirstOrThrow({ where: { orgId: org.id }, include: { adAccounts: true } });
    expect(conn.credentialsEnc).not.toContain("org-ob-token");
    expect(JSON.parse(decryptSecret(conn.credentialsEnc!))).toEqual({ apiToken: "org-ob-token" });
    expect(conn.adAccounts.map((a) => [a.externalId, a.workspaceId])).toEqual([["mk-1", workspace.id]]);

    // Another organization sees none of it.
    const { org: orgB, owner: ownerB } = await orgWith();
    const apiB = await as(ownerB);
    expect((await apiB.get(`/api/orgs/${orgB.id}/ad-accounts`)).body).toEqual([]);
    expect((await apiB.get(`/api/orgs/${orgB.id}/connections`)).body).toEqual([]);
    expect((await apiB.get(`/api/orgs/${org.id}/ad-accounts`)).status).toBe(404);
  });

  it("asks for every missing field", async () => {
    const { org, workspace, owner } = await orgWith();
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/tradedesk/credentials`).send({ workspaceId: workspace.id, credentials: { apiToken: "t", partnerId: "  " } });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details)).toEqual(["partnerId"]);
    expect(fetchCalls).toHaveLength(0);
  });

  it("explains rejected keys and keys that see no accounts, saving nothing", async () => {
    const { org, workspace, owner } = await orgWith();
    const api = await as(owner);
    stubFetch([["api.outbrain.com", { status: 401, json: { message: "Unauthorized token" } }]]);
    const rejected = await api.post(`/api/orgs/${org.id}/connections/outbrain/credentials`).send({ workspaceId: workspace.id, credentials: { apiToken: "bad" } });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toMatch(/Outbrain didn't accept these keys/);

    stubFetch([["api.outbrain.com", { json: { marketers: [] } }]]);
    const empty = await api.post(`/api/orgs/${org.id}/connections/outbrain/credentials`).send({ workspaceId: workspace.id, credentials: { apiToken: "lonely" } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toMatch(/can't see any ad accounts/);
    expect(await prisma.platformConnection.count()).toBe(0);
  });

  it("is only for key-based, visible platforms and needs integrations:manage", async () => {
    const { org, workspace, owner } = await orgWith();
    const api = await as(owner);
    expect((await api.post(`/api/orgs/${org.id}/connections/meta/credentials`).send({ workspaceId: workspace.id, credentials: {} })).status).toBe(400);
    expect((await api.post(`/api/orgs/${org.id}/connections/tiktok/credentials`).send({ workspaceId: workspace.id, credentials: {} })).status).toBe(400);
    const { org: o2, workspace: w2, user: manager } = await orgWith("MANAGER");
    expect((await (await as(manager)).post(`/api/orgs/${o2.id}/connections/outbrain/credentials`).send({ workspaceId: w2.id, credentials: { apiToken: "t" } })).status).toBe(403);
  });
});

describe("connections, sync and disconnect", () => {
  async function twoWorkspaces() {
    const { org, workspace: ws1, owner } = await orgWith();
    const ws2 = await createWorkspace(org.id);
    const a = await createConnection(org.id, { platform: "META", workspaceId: ws1.id });
    const b = await createConnection(org.id, { platform: "GOOGLE", workspaceId: ws2.id });
    return { org, ws1, ws2, owner, a, b };
  }

  it("scopes the connection and ad-account lists to a member's workspaces", async () => {
    const { org, ws1, owner, a, b } = await twoWorkspaces();
    const manager = await createUser();
    await addMember(org.id, manager, "MANAGER", [ws1.id]);
    const client = await createUser();
    await addMember(org.id, client, "CLIENT", []);

    const ownerList = (await (await as(owner)).get(`/api/orgs/${org.id}/connections`)).body.map((c: { id: string }) => c.id);
    expect(ownerList.sort()).toEqual([a.connection.id, b.connection.id].sort());
    const managerApi = await as(manager);
    expect((await managerApi.get(`/api/orgs/${org.id}/connections`)).body.map((c: { id: string }) => c.id)).toEqual([a.connection.id]);
    expect((await managerApi.get(`/api/orgs/${org.id}/ad-accounts`)).body.map((x: { id: string }) => x.id)).toEqual([a.adAccount.id]);
    const clientApi = await as(client);
    expect((await clientApi.get(`/api/orgs/${org.id}/connections`)).body).toEqual([]);
    expect((await clientApi.get(`/api/orgs/${org.id}/ad-accounts`)).body).toEqual([]);
  });

  it("queues a manual sync", async () => {
    const { org, owner, a } = await twoWorkspaces();
    const res = await (await as(owner)).post(`/api/orgs/${org.id}/connections/${a.connection.id}/sync`);
    expect(res.status).toBe(202);
    expect((await prisma.platformConnection.findUniqueOrThrow({ where: { id: a.connection.id } })).syncStatus).toBe("QUEUED");
    const job = await getSyncQueue().getJob(`sync-${a.connection.id}`);
    expect(job?.data).toEqual({ connectionId: a.connection.id, trigger: "manual" });
  });

  it("refuses to sync another organization's connection, while locked, or without permission", async () => {
    const { org, owner, a } = await twoWorkspaces();
    const other = await orgWith();
    expect((await (await as(other.owner)).post(`/api/orgs/${other.org.id}/connections/${a.connection.id}/sync`)).status).toBe(404);
    const analyst = await createUser();
    await addMember(org.id, analyst, "ANALYST");
    expect((await (await as(analyst)).post(`/api/orgs/${org.id}/connections/${a.connection.id}/sync`)).status).toBe(403);
    await prisma.organization.update({ where: { id: org.id }, data: { plan: "STARTER", subscriptionStatus: "CANCELLED" } });
    expect((await (await as(owner)).post(`/api/orgs/${org.id}/connections/${a.connection.id}/sync`)).status).toBe(402);
  });

  it("disconnects with an audit entry and cascades to its accounts", async () => {
    const { org, owner, a, b } = await twoWorkspaces();
    const analyst = await createUser();
    await addMember(org.id, analyst, "ANALYST");
    expect((await (await as(analyst)).delete(`/api/orgs/${org.id}/connections/${a.connection.id}`)).status).toBe(403);
    const res = await (await as(owner)).delete(`/api/orgs/${org.id}/connections/${a.connection.id}`);
    expect(res.status).toBe(204);
    expect(await prisma.adAccount.findUnique({ where: { id: a.adAccount.id } })).toBeNull();
    expect(await prisma.adAccount.findUnique({ where: { id: b.adAccount.id } })).not.toBeNull();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "integration.disconnected" } });
    expect(log).toMatchObject({ entityId: a.connection.id, userId: owner.id });
  });
});

describe("sample data", () => {
  it("adds sample connections for visible demo platforms only and removes only sample data", async () => {
    const { org, workspace, owner } = await orgWith();
    const live = await createConnection(org.id, { platform: "META", mode: "LIVE", workspaceId: workspace.id });
    const api = await as(owner);
    const res = await api.post(`/api/orgs/${org.id}/sample-data`).send({ workspaceId: workspace.id });
    expect(res.status).toBe(202);
    const expected = DEMO_PLATFORMS.filter(isPlatformShown);
    expect(expected).not.toContain("TIKTOK");
    expect(res.body.connections).toBe(expected.length);
    const demo = await prisma.platformConnection.findMany({ where: { orgId: org.id, mode: "DEMO" }, include: { adAccounts: true } });
    expect(demo.map((c) => c.platform).sort()).toEqual([...expected].sort());
    expect(demo.every((c) => c.syncStatus === "QUEUED" && c.adAccounts.length > 0 && c.adAccounts.every((x) => x.workspaceId === workspace.id))).toBe(true);
    expect(await prisma.adAccount.count({ where: { orgId: org.id, platform: "TIKTOK" } })).toBe(0);

    // Adding twice doesn't duplicate.
    await api.post(`/api/orgs/${org.id}/sample-data`).send({ workspaceId: workspace.id });
    expect(await prisma.platformConnection.count({ where: { orgId: org.id, mode: "DEMO" } })).toBe(expected.length);

    const removed = await api.delete(`/api/orgs/${org.id}/sample-data`);
    expect(removed.body).toEqual({ removed: expected.length });
    expect(await prisma.platformConnection.findMany({ where: { orgId: org.id }, select: { id: true } })).toEqual([{ id: live.connection.id }]);
    expect(await prisma.auditLog.count({ where: { orgId: org.id, action: { in: ["sample_data.added", "sample_data.removed"] } } })).toBe(3);
  });

  it("needs integrations:manage", async () => {
    const { org, workspace, user } = await orgWith("MANAGER");
    expect((await (await as(user)).post(`/api/orgs/${org.id}/sample-data`).send({ workspaceId: workspace.id })).status).toBe(403);
    expect((await (await as(user)).delete(`/api/orgs/${org.id}/sample-data`)).status).toBe(403);
  });
});

describe("PATCH /ad-accounts/:id (assign to a workspace)", () => {
  it("enforces the plan's ad-account limit for live accounts only", async () => {
    const { org, workspace, owner } = await orgWith("OWNER", { plan: "STARTER" }); // up to 3 ad accounts
    for (let i = 0; i < 3; i++) await createConnection(org.id, { mode: "LIVE", workspaceId: workspace.id });
    const extra = await createConnection(org.id, { mode: "LIVE", workspaceId: null });
    const sample = await createConnection(org.id, { mode: "DEMO", workspaceId: null });
    const api = await as(owner);

    const blocked = await api.patch(`/api/orgs/${org.id}/ad-accounts/${extra.adAccount.id}`).send({ workspaceId: workspace.id });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe("PLAN_LIMIT");

    const demo = await api.patch(`/api/orgs/${org.id}/ad-accounts/${sample.adAccount.id}`).send({ workspaceId: workspace.id });
    expect(demo.status).toBe(200);
    expect(demo.body.workspaceId).toBe(workspace.id);

    const freed = await prisma.adAccount.findFirstOrThrow({ where: { orgId: org.id, workspaceId: workspace.id, connection: { mode: "LIVE" } } });
    const unassign = await api.patch(`/api/orgs/${org.id}/ad-accounts/${freed.id}`).send({ workspaceId: null });
    expect(unassign.status).toBe(200);
    const now = await api.patch(`/api/orgs/${org.id}/ad-accounts/${extra.adAccount.id}`).send({ workspaceId: workspace.id });
    expect(now.status).toBe(200);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { orgId: org.id, action: "ad_account.assigned", entityId: extra.adAccount.id } });
    expect(log.changes).toEqual({ workspace: { from: null, to: workspace.id } });
    // A never-synced account gets its first sync.
    expect(await getSyncQueue().getJob(`sync-${extra.connection.id}`)).toBeTruthy();
  });

  it("refuses a workspace of another organization", async () => {
    const { org, owner } = await orgWith();
    const { workspace: foreign } = await orgWith();
    const { adAccount } = await createConnection(org.id, { workspaceId: null });
    const res = await (await as(owner)).patch(`/api/orgs/${org.id}/ad-accounts/${adAccount.id}`).send({ workspaceId: foreign.id });
    expect(res.status).toBe(404);
  });
});
