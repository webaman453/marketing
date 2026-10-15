import { prisma } from "@ashniva/db";
import { DEFAULT_NOTIFICATION_PREFS, notificationPrefsSchema, type NotificationDTO, type NotificationPrefsDTO } from "@ashniva/shared";
import { Router } from "express";
import { z } from "zod";
import { parse } from "../lib/errors";

/** Current user's notifications. Mounted at /api/notifications behind requireAuth. */
export const notificationsRouter = Router();

notificationsRouter.get("/", async (req, res) => {
  const orgId = typeof req.query.orgId === "string" ? req.query.orgId : undefined;
  const where = { userId: req.userId!, ...(orgId ? { orgId } : {}) };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  res.json({
    unread,
    items: items.map(
      (n): NotificationDTO => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      }),
    ),
  });
});

notificationsRouter.post("/read", async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).max(200).optional() }), req.body ?? {});
  await prisma.notification.updateMany({
    where: { userId: req.userId!, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { readAt: new Date() },
  });
  res.status(204).end();
});

// ───────── Email preferences ─────────

const toPrefsDTO = (p: NotificationPrefsDTO | null): NotificationPrefsDTO =>
  p
    ? { ruleAlerts: p.ruleAlerts, reportCopies: p.reportCopies, lowAiBalance: p.lowAiBalance, syncFailures: p.syncFailures }
    : { ...DEFAULT_NOTIFICATION_PREFS };

notificationsRouter.get("/preferences", async (req, res) => {
  const prefs = await prisma.notificationPreference.findUnique({ where: { userId: req.userId! } });
  res.json(toPrefsDTO(prefs));
});

notificationsRouter.put("/preferences", async (req, res) => {
  const input = parse(notificationPrefsSchema, req.body);
  const prefs = await prisma.notificationPreference.upsert({
    where: { userId: req.userId! },
    create: { userId: req.userId!, ...input },
    update: input,
  });
  res.json(toPrefsDTO(prefs));
});
