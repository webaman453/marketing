import { validateWebhookUrl } from "./webhooks";

/**
 * "Add to Slack": Slack's OAuth v2 flow with the `incoming-webhook` scope. The person picks a
 * workspace and a channel on Slack's own screen, and Slack hands back a webhook URL for that
 * channel, so nobody has to create or copy one.
 */
const AUTHORIZE = "https://slack.com/oauth/v2/authorize";
const ACCESS = "https://slack.com/api/oauth.v2.access";

export const slackConfigured = () => Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);

export function slackAuthorizeUrl(params: { redirectUri: string; state: string; clientId?: string }): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_id", params.clientId ?? process.env.SLACK_CLIENT_ID ?? "");
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

export interface SlackInstall {
  /** The incoming webhook URL for the chosen channel. */
  url: string;
  /** "#ads-alerts", or the person's name for a direct message. */
  channel: string;
  team: string;
}

export class SlackOAuthError extends Error {}

/** Slack's error codes in words a person can act on. */
const REASONS: Record<string, string> = {
  invalid_code: "That sign-in link was already used or expired. Please try Add to Slack again.",
  code_already_used: "That sign-in link was already used. Please try Add to Slack again.",
  bad_redirect_uri: "Slack doesn't recognise our redirect URL. The platform owner needs to add it in the Slack app's OAuth & Permissions page.",
  invalid_client_id: "The Slack app's Client ID isn't right. The platform owner needs to check it in Admin → API keys.",
  bad_client_secret: "The Slack app's Client Secret isn't right. The platform owner needs to check it in Admin → API keys.",
  invalid_client: "The Slack app's keys aren't right. The platform owner needs to check them in Admin → API keys.",
};

export async function exchangeSlackCode(params: { code: string; redirectUri: string }, fetchImpl: typeof fetch = fetch): Promise<SlackInstall> {
  const res = await fetchImpl(ACCESS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID ?? "",
      client_secret: process.env.SLACK_CLIENT_SECRET ?? "",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    team?: { name?: string };
    incoming_webhook?: { url?: string; channel?: string };
  } | null;
  if (!body?.ok) throw new SlackOAuthError(REASONS[body?.error ?? ""] ?? `Slack didn't accept the sign-in${body?.error ? ` (${body.error})` : ""}. Please try again.`);
  const hook = body.incoming_webhook;
  if (!hook?.url) throw new SlackOAuthError("Slack didn't return a webhook. Make sure the app has the incoming-webhook scope.");
  // Whatever Slack returns still has to look like a Slack webhook before we store it.
  validateWebhookUrl(hook.url, "SLACK");
  return { url: hook.url, channel: hook.channel ?? "a channel", team: body.team?.name ?? "Slack" };
}
