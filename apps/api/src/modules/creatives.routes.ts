import { audit, deleteFile, makeKey, putFile } from "@ashniva/core";
import { prisma, type Creative } from "@ashniva/db";
import type { CreativeDTO } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { badRequest, notFound, parse } from "../lib/errors";
import { inspectFile, upload } from "../lib/upload";
import { requirePermission } from "../middleware/auth";

/** Mounted under /api/workspaces/:workspaceId after loadWorkspace. */
export const creativesRouter = Router({ mergeParams: true });

export const toCreativeDTO = (c: Creative): CreativeDTO => ({
  id: c.id,
  name: c.name,
  type: c.type,
  mimeType: c.mimeType,
  sizeBytes: c.sizeBytes,
  width: c.width,
  height: c.height,
  url: c.url,
  tags: c.tags,
  createdAt: c.createdAt.toISOString(),
});

creativesRouter.get("/creatives", async (req, res) => {
  const type = req.query.type === "IMAGE" || req.query.type === "VIDEO" ? req.query.type : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const list = await prisma.creative.findMany({
    where: {
      workspaceId: req.workspace!.id,
      ...(type ? { type } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  res.json(list.map(toCreativeDTO));
});

creativesRouter.post("/creatives", requirePermission("campaigns:edit"), upload.array("files", 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw badRequest("Choose at least one image or video to upload.");
  const ws = req.workspace!;

  // Validate everything before storing anything.
  const inspected = files.map((f) => ({ file: f, info: inspectFile(f) }));
  const created: Creative[] = [];
  for (const { file, info } of inspected) {
    const stored = await putFile(makeKey(`creatives/${ws.orgId}`, file.originalname), file.buffer, file.mimetype);
    created.push(
      await prisma.creative.create({
        data: {
          orgId: ws.orgId,
          workspaceId: ws.id,
          name: file.originalname.slice(0, 200),
          type: info.type,
          mimeType: file.mimetype,
          sizeBytes: file.size,
          width: info.width,
          height: info.height,
          storageKey: stored.key,
          url: stored.url,
          uploadedById: req.userId,
        },
      }),
    );
  }
  await audit({
    orgId: ws.orgId,
    workspaceId: ws.id,
    userId: req.userId,
    action: "creative.uploaded",
    entityType: "creative",
    entityName: created.length === 1 ? created[0]!.name : `${created.length} files`,
  });
  res.status(201).json(created.map(toCreativeDTO));
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

creativesRouter.patch("/creatives/:creativeId", requirePermission("campaigns:edit"), async (req, res) => {
  const input = parse(updateSchema, req.body);
  const c = await prisma.creative.findFirst({ where: { id: req.params.creativeId as string, workspaceId: req.workspace!.id } });
  if (!c) throw notFound("Creative");
  const updated = await prisma.creative.update({ where: { id: c.id }, data: input });
  res.json(toCreativeDTO(updated));
});

creativesRouter.delete("/creatives/:creativeId", requirePermission("campaigns:edit"), async (req, res) => {
  const c = await prisma.creative.findFirst({ where: { id: req.params.creativeId as string, workspaceId: req.workspace!.id } });
  if (!c) throw notFound("Creative");
  await prisma.creative.delete({ where: { id: c.id } });
  await deleteFile(c.storageKey);
  await audit({ orgId: c.orgId, workspaceId: c.workspaceId, userId: req.userId, action: "creative.deleted", entityType: "creative", entityId: c.id, entityName: c.name });
  res.status(204).end();
});
