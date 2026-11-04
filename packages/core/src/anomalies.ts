/**
 * Anomaly alerts, checked by the worker every hour from the synced daily metrics:
 *  - spend spike: the latest day's spend is at least twice the campaign's recent daily average
 *  - lost conversions: the campaign keeps spending but recorded nothing for days, after a stretch that did
 * One notification per workspace and kind (at most one a day), listing the worst campaigns.
 */
import { prisma } from "@ashniva/db";
import { PLATFORM_INFO, money } from "@ashniva/shared";
import { isOrgLocked } from "./entitlements";
import { alertActionUrl } from "./alert-actions";
import { notify } from "./notifications";

export interface DailyPoint {
  /** YYYY-MM-DD */
  date: string;
  spend: number;
  conversions: number;
}

export const ANOMALY = {
  /** Latest day vs. the average of the days before it. */
  spikeRatio: 2,
  /** Days of history needed before a spike counts. */
  spikeHistoryDays: 3,
  /** The history window for the average. */
  spikeWindow: 7,
  /** Days in a row with spend and no conversions. */
  deadDays: 3,
  /** The earlier stretch that must have had conversions. */
  deadHistoryDays: 7,
  /** Newest data older than this many days is not reported on. */
  maxAgeDays: 2,
} as const;

const dayMs = 86_400_000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / dayMs);

export interface SpikeFinding {
  latest: number;
  average: number;
  ratio: number;
}

/** `points` are one campaign's daily rows, oldest first. */
export function detectSpendSpike(points: DailyPoint[], today: string, spikeRatio: number = ANOMALY.spikeRatio): SpikeFinding | null {
  const latest = points.at(-1);
  if (!latest || dayDiff(today, latest.date) > ANOMALY.maxAgeDays) return null;
  const history = points.slice(-1 - ANOMALY.spikeWindow, -1);
  if (history.length < ANOMALY.spikeHistoryDays) return null;
  const average = history.reduce((s, p) => s + p.spend, 0) / history.length;
  if (average <= 0) return null;
  const ratio = latest.spend / average;
  return ratio >= spikeRatio ? { latest: latest.spend, average, ratio } : null;
}

export interface LostConversionsFinding {
  days: number;
  spend: number;
  earlierConversions: number;
}

export function detectLostConversions(points: DailyPoint[], today: string, deadDays: number = ANOMALY.deadDays): LostConversionsFinding | null {
  const latest = points.at(-1);
  if (!latest || dayDiff(today, latest.date) > ANOMALY.maxAgeDays) return null;
  const recent = points.slice(-deadDays);
  const earlier = points.slice(-deadDays - ANOMALY.deadHistoryDays, -deadDays);
  if (recent.length < deadDays || earlier.length < 3) return null;
  // The days must be consecutive and every one of them must have spent money without a conversion.
  if (!recent.every((p, i) => i === 0 || dayDiff(p.date, recent[i - 1]!.date) === 1)) return null;
  if (!recent.every((p) => p.spend > 0 && p.conversions === 0)) return null;
  const earlierConversions = earlier.reduce((s, p) => s + p.conversions, 0);
  if (earlierConversions <= 0) return null;
  return { days: recent.length, spend: recent.reduce((s, p) => s + p.spend, 0), earlierConversions };
}

const ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;
const SHOWN = 5;

export interface AnomalyRun {
  checked: number;
  alerts: number;
}

export async function checkAnomalies(now = new Date()): Promise<AnomalyRun> {
  const today = now.toISOString().slice(0, 10);
  // Enough history for the longest "no conversions" setting plus the stretch that had them.
  const since = new Date(now.getTime() - (Math.max(ANOMALY.spikeWindow, 7 + ANOMALY.deadHistoryDays) + 2) * dayMs);

  const accounts = (
    await prisma.adAccount.findMany({
      where: { workspaceId: { not: null }, workspace: { archivedAt: null }, campaigns: { some: { status: "ACTIVE" } } },
      select: {
        id: true,
        orgId: true,
        workspaceId: true,
        currency: true,
        workspace: { select: { anomalyEnabled: true, anomalySpikeRatio: true, anomalyDeadDays: true } },
        org: { select: { plan: true, trialEndsAt: true, subscriptionStatus: true, currentPeriodEnd: true } },
      },
    })
  ).filter((a) => !isOrgLocked(a.org, now) && a.workspace?.anomalyEnabled !== false);
  if (accounts.length === 0) return { checked: 0, alerts: 0 };

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const campaigns = await prisma.campaign.findMany({
    where: { adAccountId: { in: accounts.map((a) => a.id) }, status: "ACTIVE" },
    select: { id: true, name: true, platform: true, adAccountId: true },
  });
  // Campaigns whose alerts a person muted for a while.
  const muted = new Set(
    (await prisma.anomalySnooze.findMany({ where: { campaignId: { in: campaigns.map((c) => c.id) }, until: { gt: now } }, select: { campaignId: true } })).map((m) => m.campaignId),
  );
  const rows = await prisma.metricDaily.findMany({
    where: { level: "CAMPAIGN", adAccountId: { in: accounts.map((a) => a.id) }, date: { gte: since } },
    orderBy: { date: "asc" },
    select: { entityId: true, date: true, spend: true, conversions: true },
  });
  const byCampaign = new Map<string, DailyPoint[]>();
  for (const r of rows) {
    const list = byCampaign.get(r.entityId) ?? [];
    list.push({ date: r.date.toISOString().slice(0, 10), spend: Number(r.spend), conversions: Number(r.conversions) });
    byCampaign.set(r.entityId, list);
  }

  type Line = { text: string; weight: number; campaign: { id: string; name: string } };
  const spikes = new Map<string, Line[]>();
  const lost = new Map<string, Line[]>();
  const add = (m: Map<string, Line[]>, ws: string, line: Line) => m.set(ws, [...(m.get(ws) ?? []), line]);

  for (const c of campaigns) {
    const account = accountById.get(c.adAccountId);
    const points = byCampaign.get(c.id);
    if (!account?.workspaceId || !points || muted.has(c.id)) continue;
    const label = `${c.name} (${PLATFORM_INFO[c.platform].name})`;
    const settings = account.workspace;
    const spike = detectSpendSpike(points, today, settings?.anomalySpikeRatio ?? ANOMALY.spikeRatio);
    if (spike) {
      add(spikes, account.workspaceId, {
        campaign: c,
        weight: spike.latest - spike.average,
        text: `${label}: ${money(spike.latest, account.currency)} on ${points.at(-1)!.date}, ${spike.ratio.toFixed(1)}× its recent daily average of ${money(spike.average, account.currency)}`,
      });
    }
    const dead = detectLostConversions(points, today, settings?.anomalyDeadDays ?? ANOMALY.deadDays);
    if (dead) {
      add(lost, account.workspaceId, {
        campaign: c,
        weight: dead.spend,
        text: `${label}: ${money(dead.spend, account.currency)} spent over ${dead.days} days with no conversions (it had ${Math.round(dead.earlierConversions)} in the days before). Check the pixel or conversion tracking.`,
      });
    }
  }

  const orgOf = new Map(accounts.map((a) => [a.workspaceId!, a.orgId]));
  let alerts = 0;
  const send = async (found: Map<string, Line[]>, type: string, title: (n: number) => string, tail: string) => {
    for (const [workspaceId, lines] of found) {
      const orgId = orgOf.get(workspaceId)!;
      // One alert a day per workspace and kind keeps a long-running problem from becoming spam.
      const recent = await prisma.notification.findFirst({ where: { orgId, workspaceId, type, createdAt: { gte: new Date(now.getTime() - dayMs) } }, select: { id: true } });
      if (recent) continue;
      const top = lines.sort((a, b) => b.weight - a.weight).slice(0, SHOWN);
      const more = lines.length > top.length ? `\n…and ${lines.length - top.length} more.` : "";
      // One-click links for the worst few, so the alert can be acted on without opening the app first.
      const actions = top.slice(0, 4).flatMap((l) => [
        { label: `Pause: ${l.campaign.name}`, url: alertActionUrl({ a: "pause", c: l.campaign.id, o: orgId }, now) },
        { label: `Mute 7 days: ${l.campaign.name}`, url: alertActionUrl({ a: "snooze", c: l.campaign.id, o: orgId, d: 7 }, now) },
      ]);
      await notify({
        orgId,
        workspaceId,
        type,
        title: title(lines.length),
        body: `${top.map((l) => l.text).join("\n")}${more}\n${tail}`,
        link: `/w/${workspaceId}/campaigns`,
        ctaLabel: "Open campaigns",
        actions,
        roles: [...ROLES],
        email: true,
        emailPref: "anomalyAlerts",
      });
      alerts++;
    }
  };
  await send(spikes, "anomaly.spend_spike", (n) => `Spend jumped on ${n} campaign${n === 1 ? "" : "s"}`, "Check budgets and bids before it keeps going.");
  await send(lost, "anomaly.lost_conversions", (n) => `${n} campaign${n === 1 ? " is" : "s are"} spending without conversions`, "Conversions may be going untracked.");
  return { checked: campaigns.length, alerts };
}
