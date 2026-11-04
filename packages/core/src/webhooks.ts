import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma, type AlertWebhook } from "@ashniva/db";
import { alertGroupOf } from "@ashniva/shared";
import { decryptSecret } from "./crypto";

/** Slack incoming webhooks only live on these hosts. */
const SLACK_HOSTS = ["hooks.slack.com", "hooks.slack-gov.com"];
const TIMEOUT_MS = 8000;

export interface AlertPayload {
  orgId: string;
  workspaceId?: string | null;
  type: string;
  title: string;
  body?: string;
  /** App-relative path, e.g. /w/<id>/campaigns/<id> */
  link?: string;
  /** One-click links (absolute URLs), e.g. "Pause this campaign". */
  actions?: { label: string; url: string }[];
}

export class WebhookUrlError extends Error {}

/** True for loopback, private, link-local, carrier-grade NAT and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1" || a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd")) return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return true;
}

/** Checks the URL syntactically (https, Slack host for Slack). Throws WebhookUrlError. */
export function validateWebhookUrl(raw: string, kind: "SLACK" | "WEBHOOK"): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebhookUrlError("Enter a full URL, starting with https://");
  }
  if (url.protocol !== "https:") throw new WebhookUrlError("The URL must start with https://");
  if (url.username || url.password) throw new WebhookUrlError("Remove the username and password from the URL.");
  if (kind === "SLACK" && !SLACK_HOSTS.includes(url.hostname)) {
    throw new WebhookUrlError("Use the incoming webhook URL from Slack (it starts with https://hooks.slack.com/services/).");
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw new WebhookUrlError("That address is private. Use a public URL.");
  }
  if (/^localhost$|\.local$|\.internal$/i.test(url.hostname)) throw new WebhookUrlError("That address is private. Use a public URL.");
  return url;
}

/** Resolves the host and refuses private addresses, so a public name can't point inside our network. */
async function assertPublicHost(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  const addresses = await lookup(host, { all: true }).catch(() => {
    throw new WebhookUrlError("Couldn't find that host.");
  });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw new WebhookUrlError("That address is private. Use a public URL.");
}

// ───────── WhatsApp (Meta's WhatsApp Business Cloud API) ─────────

const WHATSAPP_API = "https://graph.facebook.com/v26.0";

export interface WhatsAppConfig {
  phoneNumberId: string;
  /** Recipient numbers as digits with country code, no "+". */
  to: string[];
  /** An approved message template whose body is a single variable, e.g. "Ashniva alert: {{1}}". */
  template: string;
  language: string;
}

/** Checks and normalizes what a person typed in. Throws WebhookUrlError with a message to show. */
export function parseWhatsAppConfig(input: { phoneNumberId: string; recipients: string[]; template: string; language?: string }): WhatsAppConfig {
  const phoneNumberId = input.phoneNumberId.trim();
  if (!/^\d{5,20}$/.test(phoneNumberId)) throw new WebhookUrlError("The phone number ID is the long number from WhatsApp Manager (digits only), not the phone number itself.");
  const to = [...new Set(input.recipients.map((r) => r.replace(/[\s\-()]/g, "").replace(/^\+/, "")).filter(Boolean))];
  if (to.length === 0) throw new WebhookUrlError("Add at least one phone number to send alerts to.");
  if (to.length > 5) throw new WebhookUrlError("You can send to up to 5 numbers.");
  if (to.some((n) => !/^[1-9]\d{7,14}$/.test(n))) throw new WebhookUrlError("Write each number with its country code, like +91 98765 43210.");
  const template = input.template.trim();
  if (!/^[a-z0-9_]{1,512}$/.test(template)) throw new WebhookUrlError("Template names use lowercase letters, numbers and underscores, like ashniva_alert.");
  const language = (input.language ?? "en").trim() || "en";
  if (!/^[a-z]{2,3}(_[A-Za-z]{2})?$/.test(language)) throw new WebhookUrlError("Use a language code like en or en_US.");
  return { phoneNumberId, to, template, language };
}

/** Template variables can't hold line breaks, tabs or long runs of spaces. */
export function whatsappText(p: AlertPayload): string {
  const parts = [p.title, p.body, p.link ? `${webBase()}${p.link}` : ""].filter(Boolean).join(" · ");
  return parts.replace(/\s*[\r\n\t]+\s*/g, " · ").replace(/ {2,}/g, " ").slice(0, 900);
}

async function sendWhatsApp(hook: Pick<AlertWebhook, "urlEnc" | "secretEnc">, payload: AlertPayload): Promise<SendResult> {
  if (!hook.secretEnc) return { ok: false, status: null, error: "The access token is missing." };
  const config = JSON.parse(decryptSecret(hook.urlEnc)) as WhatsAppConfig;
  const token = decryptSecret(hook.secretEnc);
  const failures: string[] = [];
  let status: number | null = null;
  for (const to of config.to) {
    const res = await fetch(`${WHATSAPP_API}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: config.template, language: { code: config.language }, components: [{ type: "body", parameters: [{ type: "text", text: whatsappText(payload) }] }] },
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      failures.push(`+${to.slice(0, 2)}…${to.slice(-3)}: ${detail?.error?.message ?? `answered ${res.status}`}`);
    }
  }
  return failures.length === 0 ? { ok: true, status, error: null } : { ok: false, status, error: failures.join("; ").slice(0, 300) };
}

const webBase = () => (process.env.WEB_URL || "http://localhost:3100").replace(/\/$/, "");

const slackEscape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackBody(p: AlertPayload) {
  const lines = [`*${slackEscape(p.title)}*`];
  if (p.body) lines.push(slackEscape(p.body));
  if (p.link) lines.push(`<${webBase()}${p.link}|Open in Ashniva Ads>`);
  for (const a of p.actions ?? []) lines.push(`<${a.url}|${slackEscape(a.label)}>`);
  return { text: lines.join("\n") };
}

export function genericBody(p: AlertPayload, now = new Date()) {
  return {
    event: p.type,
    title: p.title,
    body: p.body ?? null,
    url: p.link ? `${webBase()}${p.link}` : null,
    actions: p.actions ?? [],
    orgId: p.orgId,
    workspaceId: p.workspaceId ?? null,
    sentAt: now.toISOString(),
  };
}

/** `sha256=<hex>` over `<timestamp>.<body>`, so receivers can reject forged or replayed calls. */
export function signPayload(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** Posts one alert to one webhook. Never throws. */
export async function sendToWebhook(hook: Pick<AlertWebhook, "kind" | "urlEnc" | "secretEnc">, payload: AlertPayload): Promise<SendResult> {
  try {
    if (hook.kind === "WHATSAPP") return await sendWhatsApp(hook, payload);
    const url = validateWebhookUrl(decryptSecret(hook.urlEnc), hook.kind);
    await assertPublicHost(url);
    const now = new Date();
    const body = JSON.stringify(hook.kind === "SLACK" ? slackBody(payload) : genericBody(payload, now));
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "AshnivaAds-Webhook/1" };
    if (hook.kind === "WEBHOOK") {
      const ts = String(Math.floor(now.getTime() / 1000));
      headers["X-Ashniva-Timestamp"] = ts;
      if (hook.secretEnc) headers["X-Ashniva-Signature"] = signPayload(decryptSecret(hook.secretEnc), ts, body);
    }
    // Redirects could lead somewhere private, so they are not followed.
    const res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.status >= 200 && res.status < 300 ? { ok: true, status: res.status, error: null } : { ok: false, status: res.status, error: `The receiver answered ${res.status}.` };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? "The receiver didn't answer in time." : err.message) : String(err);
    return { ok: false, status: null, error: message.slice(0, 300) };
  }
}

/**
 * Whether a channel should get this alert. A channel limited to some workspaces never gets alerts
 * that belong to no workspace or to another one, so one client's numbers can't reach another client's channel.
 */
export function channelWants(hook: Pick<AlertWebhook, "workspaceIds" | "events">, payload: Pick<AlertPayload, "workspaceId" | "type">): boolean {
  if (hook.workspaceIds.length > 0 && !(payload.workspaceId && hook.workspaceIds.includes(payload.workspaceId))) return false;
  if (hook.events.length > 0) {
    const group = alertGroupOf(payload.type);
    if (!group || !hook.events.includes(group)) return false;
  }
  return true;
}

/** Sends an alert to every active webhook of the organization and records how each one went. Never throws. */
export async function deliverToWebhooks(payload: AlertPayload) {
  try {
    const hooks = (await prisma.alertWebhook.findMany({ where: { orgId: payload.orgId, isActive: true } })).filter((h) => channelWants(h, payload));
    await Promise.all(
      hooks.map(async (hook) => {
        const result = await sendToWebhook(hook, payload);
        await prisma.alertWebhook
          .update({ where: { id: hook.id }, data: { lastSentAt: new Date(), lastStatus: result.status, lastError: result.error } })
          .catch(() => undefined);
      }),
    );
    return hooks.length;
  } catch (err) {
    console.error("[webhooks] delivery failed", err);
    return 0;
  }
}
