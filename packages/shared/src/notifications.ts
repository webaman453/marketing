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
  {
    key: "spendAlerts",
    label: "Spend and billing alerts",
    description: "When an ad account nears or reaches its monthly budget, or its platform reports a payment problem.",
  },
  {
    key: "anomalyAlerts",
    label: "Unusual spend or tracking",
    description: "When a campaign's spend suddenly jumps, or it keeps spending but stops recording conversions.",
  },
] as const;

export type NotificationPrefKey = (typeof NOTIFICATION_PREFS)[number]["key"];
export type NotificationPrefsDTO = Record<NotificationPrefKey, boolean>;

export const notificationPrefsSchema = z.object({
  ruleAlerts: z.boolean(),
  reportCopies: z.boolean(),
  lowAiBalance: z.boolean(),
  syncFailures: z.boolean(),
  spendAlerts: z.boolean(),
  anomalyAlerts: z.boolean(),
}) satisfies z.ZodType<NotificationPrefsDTO>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsDTO = {
  ruleAlerts: true,
  reportCopies: true,
  lowAiBalance: true,
  syncFailures: true,
  spendAlerts: true,
  anomalyAlerts: true,
};

/** What a Slack or webhook channel can be limited to. A notification type's prefix picks its group. */
export const ALERT_GROUPS = [
  { key: "rules", label: "Automation rules", description: "A rule paused, changed or flagged campaigns.", prefix: "rule." },
  { key: "anomalies", label: "Unusual spend or tracking", description: "Spend spikes and campaigns spending without conversions.", prefix: "anomaly." },
  { key: "sync", label: "Sync and connections", description: "A platform login expired or a sync failed.", prefix: "integration." },
  { key: "spend", label: "Spend and billing", description: "Monthly budgets and platform payment problems.", prefix: "spend." },
  { key: "account", label: "Account", description: "Low AI token balance and similar organization notices.", prefix: "ai." },
] as const;

export type AlertGroupKey = (typeof ALERT_GROUPS)[number]["key"];
export const ALERT_GROUP_KEYS = ALERT_GROUPS.map((g) => g.key) as [AlertGroupKey, ...AlertGroupKey[]];

/** The group an alert type belongs to; null for types no channel filter knows (those go to channels that take everything). */
export function alertGroupOf(type: string): AlertGroupKey | null {
  return ALERT_GROUPS.find((g) => type.startsWith(g.prefix))?.key ?? null;
}

/** Per-workspace tuning of the unusual-spend alerts. */
export const ANOMALY_SPIKE_RATIOS = [1.5, 2, 3] as const;
export const ANOMALY_DEAD_DAYS = [2, 3, 5, 7] as const;
export const anomalySettingsSchema = z.object({
  enabled: z.boolean(),
  spikeRatio: z.number().refine((v) => (ANOMALY_SPIKE_RATIOS as readonly number[]).includes(v), "Pick one of the listed sensitivities"),
  deadDays: z.number().int().refine((v) => (ANOMALY_DEAD_DAYS as readonly number[]).includes(v), "Pick one of the listed day counts"),
});
