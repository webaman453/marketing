/**
 * Owner-only settings: integration credentials and the public price list.
 * Mounted on the admin router (requireAuth + requireSuperAdmin).
 */
import {
  credentialStatus,
  envDefaultCatalog,
  loadPlatformSettings,
  resetCatalog,
  saveCatalog,
  saveCredentials,
  sendMail,
} from "@ashniva/core";
import { prisma } from "@ashniva/db";
import {
  BRAND,
  CREDENTIAL_GROUPS,
  PLATFORMS,
  catalogSchema,
  currentCatalog,
  saveCredentialsSchema,
  type CredentialGroupId,
  type CredentialsDTO,
  type Platform,
} from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { config, oauthRedirectUri } from "../config";
import { generateJson } from "../lib/ai/client";
import { badRequest, notFound, parse } from "../lib/errors";
import { logger } from "../lib/logger";
import { testRazorpay } from "../lib/razorpay";

export const adminSettingsRouter = Router();

const publicBase = () => config().OAUTH_REDIRECT_BASE ?? config().WEB_URL;

adminSettingsRouter.get("/credentials", async (_req, res) => {
  await loadPlatformSettings(true);
  const body: CredentialsDTO = {
    redirectUrls: Object.fromEntries(PLATFORMS.map((p) => [p, oauthRedirectUri(p)])) as Partial<Record<Platform, string>>,
    webhookUrl: `${publicBase()}/api/billing/webhook/razorpay`,
    groups: credentialStatus(),
  };
  res.json(body);
});

adminSettingsRouter.put("/credentials", async (req, res) => {
  const { values } = parse(saveCredentialsSchema, req.body);
  await saveCredentials(values, req.userId ?? null);
  logger.info({ userId: req.userId, keys: Object.keys(values) }, "Platform credentials updated");
  res.json({ groups: credentialStatus() });
});

/** Checks saved keys where the platform allows it without a customer login. */
adminSettingsRouter.post("/credentials/:group/test", async (req, res) => {
  const group = CREDENTIAL_GROUPS.find((g) => g.id === (req.params.group as CredentialGroupId));
  if (!group) throw notFound("Integration");
  if (!group.testable) throw badRequest(`${group.title} can only be checked by connecting an account on the Integrations page.`);
  await loadPlatformSettings(true);
  try {
    const message = await runTest(group.id, req.userId!);
    res.json({ ok: true, message });
  } catch (err) {
    res.json({ ok: false, message: err instanceof Error ? err.message : "The check failed." });
  }
});

async function runTest(id: CredentialGroupId, userId: string): Promise<string> {
  switch (id) {
    case "META": {
      const appId = process.env.META_APP_ID;
      const secret = process.env.META_APP_SECRET;
      if (!appId || !secret) throw new Error("Add the App ID and App secret first.");
      const version = process.env.META_API_VERSION || "v26.0";
      const r = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(appId)}?fields=name&access_token=${encodeURIComponent(`${appId}|${secret}`)}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await r.json().catch(() => ({}))) as { name?: string; error?: { message?: string } };
      if (!r.ok) throw new Error(data.error?.message ?? `Meta answered with ${r.status}.`);
      return `Connected to the Meta app “${data.name ?? appId}”.`;
    }
    case "AI": {
      const r = await generateJson({
        schema: z.object({ ok: z.boolean() }),
        system: "You are a health check. Answer with the JSON requested.",
        prompt: 'Return {"ok": true}.',
        maxTokens: 200,
      });
      return `The AI key works (${r.model}, ${r.inputTokens + r.outputTokens} tokens used).`;
    }
    case "RAZORPAY":
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error("Add the Key ID and Key secret first.");
      await testRazorpay();
      return process.env.RAZORPAY_KEY_ID.startsWith("rzp_test_")
        ? "Razorpay keys work (test mode: no real money is charged)."
        : "Razorpay keys work (live mode).";
    case "EMAIL": {
      if (!process.env.RESEND_API_KEY) throw new Error("Add the Resend API key first.");
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      await sendMail({
        to: user.email,
        subject: `${BRAND.name} test email`,
        heading: "Email is working",
        body: "This test was sent from the admin console. Invitations, password resets and reports will be delivered the same way.",
      });
      return `Test email sent to ${user.email}.`;
    }
    default:
      throw new Error("This integration can't be checked from here.");
  }
}

adminSettingsRouter.get("/catalog", async (_req, res) => {
  await loadPlatformSettings(true);
  const saved = await prisma.platformSetting.findUnique({ where: { key: "catalog" }, select: { updatedAt: true } });
  res.json({ catalog: currentCatalog(), defaults: envDefaultCatalog(), custom: Boolean(saved), updatedAt: saved?.updatedAt.toISOString() ?? null });
});

adminSettingsRouter.put("/catalog", async (req, res) => {
  const catalog = parse(catalogSchema, req.body);
  const ids = catalog.tokenPacks.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw badRequest("Each token pack needs its own ID.");
  await saveCatalog(catalog, req.userId ?? null);
  logger.info({ userId: req.userId }, "Price list updated");
  res.json({ catalog: currentCatalog(), custom: true });
});

adminSettingsRouter.delete("/catalog", async (req, res) => {
  await resetCatalog();
  logger.info({ userId: req.userId }, "Price list reset to defaults");
  res.json({ catalog: currentCatalog(), custom: false });
});
