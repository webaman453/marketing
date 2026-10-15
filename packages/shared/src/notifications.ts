import { z } from "zod";

/** Emails a user can turn off. In-app notifications are always shown. */
export const NOTIFICATION_PREFS = [
  {
    key: "ruleAlerts",
    label: "Automation rule alerts",
    description: "When a rule with “Notify” and email turned on acts on campaigns.",
  },
  {
    key: "reportCopies",
    label: "Scheduled report copies",
    description: "Scheduled report PDFs sent to your email address. Recipients outside your team aren't affected.",
  },
  {
    key: "lowAiBalance",
    label: "Low AI token balance",
    description: "When your organization's AI tokens are running low. Owners and admins only.",
  },
  {
    key: "syncFailures",
    label: "Sync failures",
    description: "When an ad platform connection stops syncing or its access expires. Owners and admins only.",
  },
] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREFS)[number]["key"];
export type NotificationPrefsDTO = Record<NotificationPrefKey, boolean>;

export const notificationPrefsSchema = z.object({
  ruleAlerts: z.boolean(),
  reportCopies: z.boolean(),
  lowAiBalance: z.boolean(),
  syncFailures: z.boolean(),
}) satisfies z.ZodType<NotificationPrefsDTO>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsDTO = {
  ruleAlerts: true,
  reportCopies: true,
  lowAiBalance: true,
  syncFailures: true,
};
