import { prisma, type Role } from "@ashniva/db";
import type { NotificationPrefKey } from "@ashniva/shared";
import { esc, sendMail } from "./mailer";

/** Of these users, the ones who have turned the given email off. */
export async function emailOptOuts(userIds: string[], pref: NotificationPrefKey) {
  if (userIds.length === 0) return new Set<string>();
  const rows = await prisma.notificationPreference.findMany({
    where: { userId: { in: userIds }, [pref]: false },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

export interface NotificationInput {
  orgId: string;
  workspaceId?: string | null;
  type: string;
  title: string;
  body?: string;
  /** App-relative path, e.g. /w/<id>/campaigns/<id> */
  link?: string;
  /** Recipients: explicit users, or everyone in the org with one of these roles. */
  userIds?: string[];
  roles?: Role[];
  email?: boolean;
  /** The preference that lets a user opt out of this email. */
  emailPref?: NotificationPrefKey;
}

/** Creates in-app notifications (and optionally emails) for the matching members. */
export async function notify(input: NotificationInput) {
  const members = await prisma.membership.findMany({
    where: {
      orgId: input.orgId,
      OR: [
        ...(input.userIds?.length ? [{ userId: { in: input.userIds } }] : []),
        ...(input.roles?.length ? [{ role: { in: input.roles } }] : []),
      ],
    },
    include: { user: { select: { id: true, email: true } } },
  });
  if (members.length === 0) return 0;

  await prisma.notification.createMany({
    data: members.map((m) => ({
      orgId: input.orgId,
      userId: m.userId,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      title: input.title.slice(0, 200),
      body: input.body?.slice(0, 2000) ?? null,
      link: input.link ?? null,
    })),
  });

  const optedOut = input.email && input.emailPref ? await emailOptOuts(members.map((m) => m.userId), input.emailPref) : new Set<string>();
  const to = members.filter((m) => !optedOut.has(m.userId)).map((m) => m.user.email);
  if (input.email && to.length > 0) {
    const web = process.env.WEB_URL || "http://localhost:3100";
    await sendMail({
      to,
      subject: input.title,
      heading: esc(input.title),
      body: esc(input.body ?? ""),
      cta: input.link ? { label: "Open in Ashniva Ads", url: `${web}${input.link}` } : undefined,
    }).catch((err) => console.error("[notify] email failed", err));
  }
  return members.length;
}
