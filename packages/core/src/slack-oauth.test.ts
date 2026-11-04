import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ashniva/db", () => ({ prisma: {} }));

const { SlackOAuthError, exchangeSlackCode, slackAuthorizeUrl, slackConfigured } = await import("./slack-oauth");

beforeEach(() => {
  process.env.SLACK_CLIENT_ID = "111.222";
  process.env.SLACK_CLIENT_SECRET = "shh";
});
afterEach(() => {
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.SLACK_CLIENT_SECRET;
});

const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe("Add to Slack", () => {
  it("is on only when both keys are set", () => {
    expect(slackConfigured()).toBe(true);
    delete process.env.SLACK_CLIENT_SECRET;
    expect(slackConfigured()).toBe(false);
  });

  it("builds Slack's consent URL with just the incoming-webhook scope", () => {
    const url = new URL(slackAuthorizeUrl({ redirectUri: "https://ads.example.com/api/oauth/slack/callback", state: "abc" }));
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "111.222", scope: "incoming-webhook", redirect_uri: "https://ads.example.com/api/oauth/slack/callback", state: "abc" });
  });

  it("returns the webhook, channel and workspace Slack hands back", async () => {
    const seen: { body?: string } = {};
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
      seen.body = String(init?.body);
      return new Response(JSON.stringify({ ok: true, team: { name: "Ashniva Marketing" }, incoming_webhook: { url: "https://hooks.slack.com/services/T0/B0/xyz", channel: "#ads-alerts" } }));
    }) as unknown as typeof fetch;
    const install = await exchangeSlackCode({ code: "c0de", redirectUri: "https://ads.example.com/cb" }, fetchImpl);
    expect(install).toEqual({ url: "https://hooks.slack.com/services/T0/B0/xyz", channel: "#ads-alerts", team: "Ashniva Marketing" });
    expect(new URLSearchParams(seen.body)).toMatchObject({});
    expect(new URLSearchParams(seen.body).get("code")).toBe("c0de");
    expect(new URLSearchParams(seen.body).get("client_secret")).toBe("shh");
  });

  it.each([
    [{ ok: false, error: "bad_redirect_uri" }, /redirect URL/],
    [{ ok: false, error: "invalid_code" }, /already used or expired/],
    [{ ok: false, error: "something_new" }, /something_new/],
    [{ ok: true, team: { name: "T" } }, /incoming-webhook scope/],
  ])("explains a failure: %j", async (body, message) => {
    await expect(exchangeSlackCode({ code: "x", redirectUri: "https://a.example/cb" }, reply(body))).rejects.toThrow(message);
    await expect(exchangeSlackCode({ code: "x", redirectUri: "https://a.example/cb" }, reply(body))).rejects.toBeInstanceOf(SlackOAuthError);
  });

  it("refuses a webhook that is not on Slack", async () => {
    await expect(
      exchangeSlackCode({ code: "x", redirectUri: "https://a.example/cb" }, reply({ ok: true, incoming_webhook: { url: "https://evil.example.com/hook", channel: "#x" } })),
    ).rejects.toThrow(/incoming webhook URL from Slack/);
  });
});
