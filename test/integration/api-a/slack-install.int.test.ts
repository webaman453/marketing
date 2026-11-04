/**
 * "Add to Slack": the authorize step, and the callback that stores the webhook Slack hands back.
 * Slack itself is stubbed; the rest is the real app and database.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, resetDb } from "../../helpers/db";
import { signedIn, seedTeam, type Team } from "./_support";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let t: Team;
beforeAll(async () => {
  await resetDb();
  t = await seedTeam();
}, 180_000);

beforeEach(() => {
  process.env.SLACK_CLIENT_ID = "111.222";
  process.env.SLACK_CLIENT_SECRET = "shh";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
});

/** Slack answers the code exchange; anything else (the first message to the channel) just succeeds. */
function stubSlack(reply: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => (String(url).includes("oauth.v2.access") ? new Response(JSON.stringify(reply)) : new Response("ok"))));
}
/** The message shown on the alerts page after Slack sends people back. */
const slackError = (res: { headers: { location?: string } }) => new URL(res.headers.location!).searchParams.get("slack_error");
const goodReply = { ok: true, team: { name: "Ashniva Marketing" }, incoming_webhook: { url: "https://hooks.slack.com/services/T0/B0/secret", channel: "#ads-alerts" } };

const authorize = async (user: { id: string }, body: Record<string, unknown> = {}) => {
  const c = await signedIn(user);
  const res = await c.post(`/api/orgs/${t.org.id}/alert-webhooks/slack/authorize`).send({ returnWorkspaceId: t.workspace.id, ...body });
  return { c, res, state: res.body.url ? new URL(res.body.url).searchParams.get("state")! : "" };
};

describe("Add to Slack", () => {
  it("is refused until the platform owner has added the Slack app's keys", async () => {
    delete process.env.SLACK_CLIENT_SECRET;
    const { res } = await authorize(t.owner);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/isn't switched on/);
    const c = await signedIn(t.owner);
    expect((await c.get(`/api/orgs/${t.org.id}/alert-webhooks/options`)).body).toEqual({ slackOAuth: false });
  });

  it("sends the owner to Slack with a signed state, and only owners and admins may", async () => {
    const { res } = await authorize(t.owner);
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("scope")).toBe("incoming-webhook");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/oauth\/slack\/callback$/);
    expect((await authorize(t.users.ANALYST)).res.status).toBe(403);
  });

  it("will not point a channel at a workspace of another organization", async () => {
    const stranger = await seedTeam();
    expect((await authorize(t.owner, { workspaceIds: [stranger.workspace.id] })).res.status).toBe(400);
  });

  it("stores the webhook Slack returns, limited as asked, and says so on the way back", async () => {
    stubSlack(goodReply);
    const { c, state } = await authorize(t.owner, { workspaceIds: [t.workspace.id], events: ["anomalies"] });
    const back = await c.get(`/api/oauth/slack/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    expect(back.headers.location).toContain(`/w/${t.workspace.id}/settings/alerts?slack=added`);

    const hook = await prisma.alertWebhook.findFirstOrThrow({ where: { orgId: t.org.id } });
    expect(hook).toMatchObject({ kind: "SLACK", name: "#ads-alerts · Ashniva Marketing", urlHint: "hooks.slack.com", workspaceIds: [t.workspace.id], events: ["anomalies"], createdById: t.owner.id });
    // The URL is a secret: stored encrypted, never in the clear.
    expect(hook.urlEnc).not.toContain("hooks.slack.com");
    const list = await c.get(`/api/orgs/${t.org.id}/alert-webhooks`);
    expect(JSON.stringify(list.body)).not.toContain("secret");
    await prisma.alertWebhook.deleteMany();
  });

  it("explains Slack's refusal and a cancelled sign-in, and stores nothing", async () => {
    stubSlack({ ok: false, error: "bad_redirect_uri" });
    const { c, state } = await authorize(t.owner);
    const refused = await c.get(`/api/oauth/slack/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(slackError(refused)).toMatch(/redirect URL/);
    const cancelled = await c.get(`/api/oauth/slack/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(slackError(cancelled)).toMatch(/cancelled adding Slack/);
    expect(await prisma.alertWebhook.count()).toBe(0);
  });

  it("rejects a callback from a different person than the one who started it, and a forged state", async () => {
    stubSlack(goodReply);
    const { state } = await authorize(t.owner);
    const other = await signedIn(t.users.ADMIN);
    const mismatch = await other.get(`/api/oauth/slack/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(slackError(mismatch)).toMatch(/doesn't match your session/);
    const forged = await other.get("/api/oauth/slack/callback?code=abc&state=not-a-token");
    expect(slackError(forged)).toMatch(/expired/);
    expect(await prisma.alertWebhook.count()).toBe(0);
  });
});
