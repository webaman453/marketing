/**
 * Org-level settings added in phase 4: white-label branding and API keys.
 * Mounted under /api/orgs/:orgId after loadOrg.
 */
import { SlackOAuthError, WebhookUrlError, assertFeature, assertNotLocked, exchangeSlackCode, parseWhatsAppConfig, slackAuthorizeUrl, slackConfigured, audit, deleteFile, encryptSecret, keyFromUrl, makeKey, putFile, randomToken, sendToWebhook, sha256, validateWebhookUrl } from "@ashniva/core";
import type { AlertWebhook, Organization } from "@ashniva/db";
import { prisma } from "@ashniva/db";
import { ALERT_GROUP_KEYS, can, type AlertWebhookDTO, type ApiKeyDTO } from "@ashniva/shared";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config, oauthRedirectUri } from "../config";
import { badRequest, notFound, parse } from "../lib/errors";
import { authenticateRedirect } from "./integrations.routes";
import { isPngOrJpeg, logoUpload } from "../lib/upload";
import { requireActivePlanForWrites, requirePermission } from "../middleware/auth";

export const orgExtrasRouter = Router({ mergeParams: true });
orgExtrasRouter.use(["/branding", "/api-keys", "/alert-webhooks"], requireActivePlanForWrites);

// ───────── Branding ─────────

const brandingSchema = z.object({
  brandName: z.string().trim().max(80).nullable(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #3b5bdb")
    .nullable(),
  reportFooter: z.string().trim().max(200).nullable(),
});

orgExtrasRouter.patch("/branding", requirePermission("org:update"), async (req, res) => {
  assertFeature(req.org!, "white_label");
  const input = parse(brandingSchema, req.body);
  const org = await prisma.organization.update({
    where: { id: req.org!.id },
    data: { brandName: input.brandName || null, brandColor: input.brandColor || null, reportFooter: input.reportFooter || null },
  });
  await audit({ orgId: org.id, userId: req.userId, action: "branding.updated", entityType: "organization", entityId: org.id, entityName: org.name });
  res.json({ brandName: org.brandName, brandColor: org.brandColor, brandLogoUrl: org.brandLogoUrl, reportFooter: org.reportFooter });
});

const LOGO_TYPES = ["image/png", "image/jpeg"];

/** Removes the org's current logo file from storage (S3/CDN or local). */
async function deleteLogoFile(org: Pick<Organization, "brandLogoKey" | "brandLogoUrl">) {
  const key = org.brandLogoKey ?? keyFromUrl(org.brandLogoUrl);
  if (key) await deleteFile(key).catch(() => undefined);
}

orgExtrasRouter.post("/branding/logo", requirePermission("org:update"), logoUpload.single("file"), async (req, res) => {
  assertFeature(req.org!, "white_label");
  const file = req.file;
  if (!file) throw badRequest("Choose a logo file.");
  if (!LOGO_TYPES.includes(file.mimetype) || !isPngOrJpeg(file.buffer)) throw badRequest("Logos must be PNG or JPG (used in PDF reports).");
  if (file.size > 2 * 1024 * 1024) throw badRequest("Logos must be under 2 MB.");
  const org = req.org!;
  const stored = await putFile(makeKey(`branding/${org.id}`, file.originalname), file.buffer, file.mimetype);
  const updated = await prisma.organization.update({ where: { id: org.id }, data: { brandLogoUrl: stored.url, brandLogoKey: stored.key } });
  if (org.brandLogoUrl) await deleteLogoFile(org);
  await audit({ orgId: org.id, userId: req.userId, action: "branding.logo_updated", entityType: "organization", entityId: org.id, entityName: org.name });
  res.json({ brandLogoUrl: updated.brandLogoUrl });
});

orgExtrasRouter.delete("/branding/logo", requirePermission("org:update"), async (req, res) => {
  const org = req.org!;
  await prisma.organization.update({ where: { id: org.id }, data: { brandLogoUrl: null, brandLogoKey: null } });
  await deleteLogoFile(org);
  await audit({ orgId: org.id, userId: req.userId, action: "branding.logo_removed", entityType: "organization", entityId: org.id, entityName: org.name });
  res.status(204).end();
});

// ───────── API keys ─────────

orgExtrasRouter.get("/api-keys", requirePermission("org:update"), async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { orgId: req.org!.id, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: keys.map((k) => k.createdById).filter((x): x is string => !!x) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  res.json(
    keys.map(
      (k): ApiKeyDTO => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        createdBy: k.createdById ? (nameOf.get(k.createdById) ?? null) : null,
        createdAt: k.createdAt.toISOString(),
      }),
    ),
  );
});

orgExtrasRouter.post("/api-keys", requirePermission("org:update"), async (req, res) => {
  assertFeature(req.org!, "public_api");
  const { name } = parse(z.object({ name: z.string().trim().min(2, "Name the key").max(60) }), req.body);
  const secret = `ak_live_${randomToken(30)}`;
  const key = await prisma.apiKey.create({
    data: { orgId: req.org!.id, name, prefix: secret.slice(0, 15), keyHash: sha256(secret), createdById: req.userId },
  });
  await audit({ orgId: key.orgId, userId: req.userId, action: "api_key.created", entityType: "api_key", entityId: key.id, entityName: name });
  // The full secret is shown exactly once.
  res.status(201).json({ id: key.id, name, prefix: key.prefix, secret, createdAt: key.createdAt.toISOString() });
});

orgExtrasRouter.delete("/api-keys/:keyId", requirePermission("org:update"), async (req, res) => {
  const key = await prisma.apiKey.findFirst({ where: { id: req.params.keyId as string, orgId: req.org!.id, revokedAt: null } });
  if (!key) throw notFound("API key");
  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  await audit({ orgId: key.orgId, userId: req.userId, action: "api_key.revoked", entityType: "api_key", entityId: key.id, entityName: key.name });
  res.status(204).end();
});

// ───────── Slack and webhook alerts ─────────

const MAX_WEBHOOKS = 5;

const webhookDTO = (h: AlertWebhook): AlertWebhookDTO => ({
  id: h.id,
  name: h.name,
  kind: h.kind,
  urlHint: h.urlHint,
  isActive: h.isActive,
  workspaceIds: h.workspaceIds,
  events: h.events,
  signed: h.kind === "WEBHOOK" && Boolean(h.secretEnc),
  lastSentAt: h.lastSentAt?.toISOString() ?? null,
  lastStatus: h.lastStatus,
  lastError: h.lastError,
  createdAt: h.createdAt.toISOString(),
});

const checkUrl = (raw: string, kind: "SLACK" | "WEBHOOK") => {
  try {
    return validateWebhookUrl(raw, kind);
  } catch (err) {
    if (err instanceof WebhookUrlError) throw badRequest(err.message);
    throw err;
  }
};

const scopeSchema = {
  workspaceIds: z.array(z.string().max(50)).max(100).optional(),
  events: z.array(z.enum(ALERT_GROUP_KEYS)).optional(),
};

/** Keeps only workspaces of this organization, so a channel can't be pointed at someone else's. */
async function ownWorkspaceIds(orgId: string, ids: string[] | undefined) {
  if (!ids?.length) return [];
  const found = await prisma.workspace.findMany({ where: { orgId, id: { in: ids } }, select: { id: true } });
  if (found.length !== new Set(ids).size) throw badRequest("One of the selected workspaces isn't part of this organization.");
  return found.map((w) => w.id);
}

/** What can be added here, for the Add channel dialog. */
orgExtrasRouter.get("/alert-webhooks/options", requirePermission("org:update"), (_req, res) => {
  res.json({ slackOAuth: slackConfigured() });
});

const slackState = z.object({ orgId: z.string(), userId: z.string(), workspaceIds: z.array(z.string()), events: z.array(z.string()), returnWorkspaceId: z.string() });

/** Starts "Add to Slack": returns Slack consent URL. The state carries who asked and what the channel should receive. */
orgExtrasRouter.post("/alert-webhooks/slack/authorize", requirePermission("org:update"), async (req, res) => {
  if (!slackConfigured()) throw badRequest("Add to Slack isn't switched on yet. Ask your Ashniva administrator, or paste a Slack webhook URL instead.");
  assertNotLocked(req.org!);
  const input = parse(z.object({ returnWorkspaceId: z.string().min(1), ...scopeSchema }), req.body);
  if ((await prisma.alertWebhook.count({ where: { orgId: req.org!.id } })) >= MAX_WEBHOOKS) throw badRequest(`You can add up to ${MAX_WEBHOOKS} alert channels.`);
  // Both lists are checked to belong to this organization before they go into the signed state.
  const returnWorkspaceId = (await ownWorkspaceIds(req.org!.id, [input.returnWorkspaceId]))[0]!;
  const workspaceIds = await ownWorkspaceIds(req.org!.id, input.workspaceIds);
  const state = jwt.sign(
    { orgId: req.org!.id, userId: req.userId, workspaceIds, events: [...new Set(input.events ?? [])], returnWorkspaceId },
    config().OAUTH_STATE_SECRET,
    { expiresIn: "15m", issuer: "ashniva-slack" },
  );
  res.json({ url: slackAuthorizeUrl({ redirectUri: oauthRedirectUri("slack"), state }) });
});

orgExtrasRouter.get("/alert-webhooks", requirePermission("org:update"), async (req, res) => {
  const hooks = await prisma.alertWebhook.findMany({ where: { orgId: req.org!.id }, orderBy: { createdAt: "asc" } });
  res.json(hooks.map(webhookDTO));
});

orgExtrasRouter.post("/alert-webhooks", requirePermission("org:update"), async (req, res) => {
  const input = parse(
    z.object({
      name: z.string().trim().min(2, "Name the channel").max(60),
      kind: z.enum(["SLACK", "WEBHOOK", "WHATSAPP"]),
      url: z.string().trim().max(2000).optional(),
      // WhatsApp (Meta's Cloud API): which number sends, who receives, which approved template carries the text.
      phoneNumberId: z.string().trim().max(40).optional(),
      accessToken: z.string().trim().max(1000).optional(),
      recipients: z.array(z.string().trim().max(30)).max(10).optional(),
      template: z.string().trim().max(512).optional(),
      language: z.string().trim().max(10).optional(),
      ...scopeSchema,
    }),
    req.body,
  );
  if ((await prisma.alertWebhook.count({ where: { orgId: req.org!.id } })) >= MAX_WEBHOOKS) throw badRequest(`You can add up to ${MAX_WEBHOOKS} alert channels.`);

  let urlEnc: string;
  let urlHint: string;
  let secretEnc: string | null = null;
  let secret: string | null = null;
  if (input.kind === "WHATSAPP") {
    if (!input.accessToken) throw badRequest("Paste the WhatsApp access token.");
    try {
      const config = parseWhatsAppConfig({ phoneNumberId: input.phoneNumberId ?? "", recipients: input.recipients ?? [], template: input.template ?? "", language: input.language });
      urlEnc = encryptSecret(JSON.stringify(config));
      urlHint = `WhatsApp · ${config.to.length === 1 ? `+…${config.to[0]!.slice(-4)}` : `${config.to.length} numbers`}`;
    } catch (err) {
      if (err instanceof WebhookUrlError) throw badRequest(err.message);
      throw err;
    }
    secretEnc = encryptSecret(input.accessToken);
  } else {
    if (!input.url || input.url.length < 8) throw badRequest("Enter the URL.");
    const url = checkUrl(input.url, input.kind);
    urlEnc = encryptSecret(url.toString());
    urlHint = url.hostname;
    // Generic webhooks are signed; the secret is shown once, like an API key.
    if (input.kind === "WEBHOOK") {
      secret = `whsec_${randomToken(24)}`;
      secretEnc = encryptSecret(secret);
    }
  }
  const hook = await prisma.alertWebhook.create({
    data: {
      orgId: req.org!.id,
      name: input.name,
      kind: input.kind,
      urlEnc,
      urlHint,
      secretEnc,
      workspaceIds: await ownWorkspaceIds(req.org!.id, input.workspaceIds),
      events: [...new Set(input.events ?? [])],
      createdById: req.userId,
    },
  });
  await audit({ orgId: hook.orgId, userId: req.userId, action: "alert_webhook.created", entityType: "alert_webhook", entityId: hook.id, entityName: hook.name });
  res.status(201).json({ ...webhookDTO(hook), secret });
});

orgExtrasRouter.patch("/alert-webhooks/:hookId", requirePermission("org:update"), async (req, res) => {
  const hook = await prisma.alertWebhook.findFirst({ where: { id: req.params.hookId as string, orgId: req.org!.id } });
  if (!hook) throw notFound("Alert channel");
  const input = parse(z.object({ isActive: z.boolean().optional(), name: z.string().trim().min(2).max(60).optional(), ...scopeSchema }), req.body);
  const updated = await prisma.alertWebhook.update({
    where: { id: hook.id },
    data: {
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.workspaceIds ? { workspaceIds: await ownWorkspaceIds(req.org!.id, input.workspaceIds) } : {}),
      ...(input.events ? { events: [...new Set(input.events)] } : {}),
    },
  });
  res.json(webhookDTO(updated));
});

orgExtrasRouter.post("/alert-webhooks/:hookId/test", requirePermission("org:update"), async (req, res) => {
  const hook = await prisma.alertWebhook.findFirst({ where: { id: req.params.hookId as string, orgId: req.org!.id } });
  if (!hook) throw notFound("Alert channel");
  const result = await sendToWebhook(hook, {
    orgId: hook.orgId,
    type: "test",
    title: "Test alert from Ashniva Ads",
    body: "If you can read this, alerts will reach this channel.",
  });
  const updated = await prisma.alertWebhook.update({ where: { id: hook.id }, data: { lastSentAt: new Date(), lastStatus: result.status, lastError: result.error } });
  res.json({ ...result, webhook: webhookDTO(updated) });
});

orgExtrasRouter.delete("/alert-webhooks/:hookId", requirePermission("org:update"), async (req, res) => {
  const hook = await prisma.alertWebhook.findFirst({ where: { id: req.params.hookId as string, orgId: req.org!.id } });
  if (!hook) throw notFound("Alert channel");
  await prisma.alertWebhook.delete({ where: { id: hook.id } });
  await audit({ orgId: hook.orgId, userId: req.userId, action: "alert_webhook.deleted", entityType: "alert_webhook", entityId: hook.id, entityName: hook.name });
  res.status(204).end();
});

/** Where Slack sends people back after "Add to Slack". Mounted at /api/oauth/slack, ahead of the platform callbacks. */
export const slackCallbackRouter = Router();

slackCallbackRouter.get("/callback", async (req, res) => {
  const web = config().WEB_URL;
  const userId = await authenticateRedirect(req, res);
  if (!userId) return res.redirect(`${web}/login?error=session`);

  let state: z.infer<typeof slackState>;
  try {
    state = slackState.parse(jwt.verify(String(req.query.state ?? ""), config().OAUTH_STATE_SECRET, { issuer: "ashniva-slack" }));
  } catch {
    return res.redirect(`${web}/app?${new URLSearchParams({ slack_error: "The Add to Slack request expired. Please try again." })}`);
  }
  const back = (params: Record<string, string>) => res.redirect(`${web}/w/${state.returnWorkspaceId}/settings/alerts?${new URLSearchParams(params)}`);

  // The browser finishing the flow must belong to the person who started it.
  if (state.userId !== userId) return back({ slack_error: "This request doesn't match your session. Please try again." });
  if (req.query.error) return back({ slack_error: req.query.error === "access_denied" ? "You cancelled adding Slack." : "Slack didn't grant access." });
  const code = String(req.query.code ?? "");
  if (!code) return back({ slack_error: "Slack didn't send a sign-in code. Please try again." });

  // Re-check at completion: the role or plan may have changed during the sign-in.
  const membership = await prisma.membership.findUnique({ where: { userId_orgId: { userId, orgId: state.orgId } }, include: { org: true } });
  if (!membership || !can(membership.role, "org:update")) return back({ slack_error: "You no longer have permission to add alert channels." });
  try {
    assertNotLocked(membership.org);
  } catch {
    return back({ slack_error: "Your plan is inactive. Update billing to add alert channels." });
  }
  if ((await prisma.alertWebhook.count({ where: { orgId: state.orgId } })) >= MAX_WEBHOOKS) return back({ slack_error: `You can add up to ${MAX_WEBHOOKS} alert channels.` });

  let install;
  try {
    install = await exchangeSlackCode({ code, redirectUri: oauthRedirectUri("slack") });
  } catch (err) {
    return back({ slack_error: err instanceof SlackOAuthError || err instanceof WebhookUrlError ? err.message : "Could not reach Slack. Please try again." });
  }

  const hook = await prisma.alertWebhook.create({
    data: {
      orgId: state.orgId,
      name: `${install.channel} · ${install.team}`.slice(0, 60),
      kind: "SLACK",
      urlEnc: encryptSecret(install.url),
      urlHint: new URL(install.url).hostname,
      workspaceIds: await ownWorkspaceIds(state.orgId, state.workspaceIds),
      events: state.events.filter((e): e is (typeof ALERT_GROUP_KEYS)[number] => (ALERT_GROUP_KEYS as readonly string[]).includes(e)),
      createdById: userId,
    },
  });
  await audit({ orgId: hook.orgId, userId, action: "alert_webhook.created", entityType: "alert_webhook", entityId: hook.id, entityName: hook.name });
  // A first message right away shows it works; the channel is already added if it cannot be sent.
  const sent = await sendToWebhook(hook, { orgId: hook.orgId, type: "test", title: "Ashniva Ads is connected", body: "Alerts for your campaigns will appear here." });
  await prisma.alertWebhook.update({ where: { id: hook.id }, data: { lastSentAt: new Date(), lastStatus: sent.status, lastError: sent.error } });
  return back({ slack: "added", channel: install.channel });
});
