/**
 * Org-level settings added in phase 4: white-label branding and API keys.
 * Mounted under /api/orgs/:orgId after loadOrg.
 */
import { assertFeature, audit, deleteFile, keyFromUrl, makeKey, putFile, randomToken, sha256 } from "@ashniva/core";
import type { Organization } from "@ashniva/db";
import { prisma } from "@ashniva/db";
import type { ApiKeyDTO } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { badRequest, notFound, parse } from "../lib/errors";
import { isPngOrJpeg, logoUpload } from "../lib/upload";
import { requireActivePlanForWrites, requirePermission } from "../middleware/auth";

export const orgExtrasRouter = Router({ mergeParams: true });
orgExtrasRouter.use(["/branding", "/api-keys"], requireActivePlanForWrites);

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
