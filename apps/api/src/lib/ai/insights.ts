/**
 * Performance analysis: a numbers-only brief of the workspace or one campaign,
 * handed to the model with instructions to cite the figures it relies on.
 */
import { todayIn } from "@ashniva/core";
import { num, prisma } from "@ashniva/db";
import { METRIC_FORMATS, PLATFORM_INFO, addDays, previousPeriod, type MetricSet } from "@ashniva/shared";
import { z } from "zod";
import { dateFilter, metricsByEntity, sumMetrics, timeseries } from "../../modules/analytics.service";
import { runAi, type AiCaller } from "./index";

const insightsSchema = z.object({
  summary: z.string(),
  insights: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      type: z.enum(["opportunity", "risk", "info"]),
      impact: z.enum(["high", "medium", "low"]),
    }),
  ),
});

const ANALYST_SYSTEM =
  "You are a performance marketing analyst reviewing a client's paid media across ad platforms. Base every statement on the numbers provided; quote the specific campaign, ad set or ad names and figures you rely on. Prioritise budget shifts, wasted spend, creative fatigue and what to scale. Write for a busy marketing manager: plain language, no jargon without explanation. Return 3 to 6 insights ordered by impact, and a two-sentence summary.";

const fmt = (m: MetricSet, currency: string) =>
  ["spend", "impressions", "clicks", "ctr", "cpc", "conversions", "cpa", "conversionValue", "roas"]
    .map((k) => `${METRIC_FORMATS[k]!.label} ${METRIC_FORMATS[k]!.format(m[k as keyof MetricSet] as number | null, currency)}`)
    .join(", ");

export async function workspaceInsights(caller: AiCaller, workspaceId: string, days: number) {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const to = todayIn(ws.timezone);
  const from = addDays(to, -(days - 1));
  const prev = previousPeriod(from, to);
  const accounts = await prisma.adAccount.findMany({ where: { workspaceId }, select: { id: true } });
  const base = { adAccountId: { in: accounts.map((a) => a.id) }, level: "CAMPAIGN" as const };
  const c = ws.currency;

  const [cur, before, byPlatformRows, byCampaign, prevByCampaign] = await Promise.all([
    sumMetrics({ ...base, date: dateFilter({ from, to }) }),
    sumMetrics({ ...base, date: dateFilter(prev) }),
    prisma.metricDaily.groupBy({ by: ["platform"], where: { ...base, date: dateFilter({ from, to }) }, _sum: { spend: true } }),
    metricsByEntity({ ...base, date: dateFilter({ from, to }) }),
    metricsByEntity({ ...base, date: dateFilter(prev) }),
  ]);
  if (byCampaign.size === 0) return null;

  const platformTotals = await Promise.all(
    byPlatformRows.map(async (p) => ({ platform: p.platform, m: await sumMetrics({ ...base, platform: p.platform, date: dateFilter({ from, to }) }) })),
  );
  const top = [...byCampaign.entries()].sort((a, b) => b[1].spend - a[1].spend).slice(0, 25);
  const campaigns = await prisma.campaign.findMany({
    where: { id: { in: top.map(([id]) => id) } },
    select: { id: true, name: true, platform: true, status: true, objective: true, dailyBudget: true },
  });
  const info = new Map(campaigns.map((x) => [x.id, x]));

  const lines = [
    `Workspace: ${ws.name}. Currency: ${c}. Period: ${from} to ${to} (${days} days), compared with ${prev.from} to ${prev.to}.`,
    "",
    `TOTAL this period: ${fmt(cur, c)}`,
    `TOTAL previous period: ${fmt(before, c)}`,
    "",
    "BY PLATFORM:",
    ...platformTotals.map((p) => `- ${PLATFORM_INFO[p.platform].name}: ${fmt(p.m, c)}`),
    "",
    "TOP CAMPAIGNS BY SPEND (this period | previous period):",
    ...top.map(([id, m]) => {
      const meta = info.get(id);
      const p = prevByCampaign.get(id);
      const budget = meta?.dailyBudget != null ? METRIC_FORMATS.spend!.format(num(meta.dailyBudget), c) : "n/a";
      return `- "${meta?.name ?? id}" [${meta ? PLATFORM_INFO[meta.platform].name : "?"}, ${meta?.status ?? "?"}, objective ${meta?.objective ?? "?"}, daily budget ${budget}]: ${fmt(m, c)}${p ? ` | prev: ${fmt(p, c)}` : " | new this period"}`;
    }),
  ];

  return runAi({ ...caller, workspaceId }, "insights.overview", {
    schema: insightsSchema,
    system: ANALYST_SYSTEM,
    prompt: lines.join("\n"),
    maxTokens: 6000,
  });
}

export async function campaignInsights(caller: AiCaller, campaignId: string, days: number) {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { adAccount: { include: { workspace: true } }, adGroups: true, ads: true },
  });
  const ws = campaign.adAccount.workspace;
  const c = campaign.adAccount.currency;
  const to = todayIn(ws?.timezone ?? "Asia/Kolkata");
  const from = addDays(to, -(days - 1));
  const prev = previousPeriod(from, to);
  const range = dateFilter({ from, to });

  const [cur, before, series, groups, ads] = await Promise.all([
    sumMetrics({ level: "CAMPAIGN", entityId: campaign.id, date: range }),
    sumMetrics({ level: "CAMPAIGN", entityId: campaign.id, date: dateFilter(prev) }),
    timeseries({ level: "CAMPAIGN", entityId: campaign.id, date: range }, { from, to }),
    metricsByEntity({ level: "AD_GROUP", campaignId: campaign.id, date: range }),
    metricsByEntity({ level: "AD", campaignId: campaign.id, date: range }),
  ]);
  if (cur.impressions === 0 && cur.spend === 0) return null;

  const terms = PLATFORM_INFO[campaign.platform].terms;
  const weekly = [];
  for (let i = 0; i < series.length; i += 7) {
    const chunk = series.slice(i, i + 7);
    const spend = chunk.reduce((s, d) => s + d.spend, 0);
    const conv = chunk.reduce((s, d) => s + d.conversions, 0);
    const value = chunk.reduce((s, d) => s + d.conversionValue, 0);
    const clicks = chunk.reduce((s, d) => s + d.clicks, 0);
    weekly.push(`${chunk[0]!.date}…${chunk.at(-1)!.date}: spend ${spend.toFixed(0)}, clicks ${clicks}, conversions ${conv.toFixed(1)}, value ${value.toFixed(0)}`);
  }

  const lines = [
    `Campaign "${campaign.name}" on ${PLATFORM_INFO[campaign.platform].name}. Status ${campaign.status}${campaign.deliveryStatus ? ` (${campaign.deliveryStatus})` : ""}. Objective ${campaign.objective ?? "n/a"}. Daily budget ${campaign.dailyBudget != null ? METRIC_FORMATS.spend!.format(num(campaign.dailyBudget), c) : "n/a"}. Currency ${c}.`,
    `Period ${from} to ${to} vs ${prev.from} to ${prev.to}.`,
    "",
    `THIS PERIOD: ${fmt(cur, c)}`,
    `PREVIOUS PERIOD: ${fmt(before, c)}`,
    "",
    "WEEKLY TREND:",
    ...weekly,
    "",
    `${terms.adGroup.toUpperCase()}S:`,
    ...campaign.adGroups.map((g) => `- "${g.name}" [${g.status}]: ${groups.get(g.id) ? fmt(groups.get(g.id)!, c) : "no delivery"}`),
    "",
    `${terms.ad.toUpperCase()}S:`,
    ...campaign.ads.slice(0, 30).map((a) => `- "${a.name}" [${a.status}]${a.headline ? ` headline "${a.headline}"` : ""}: ${ads.get(a.id) ? fmt(ads.get(a.id)!, c) : "no delivery"}`),
  ];

  return runAi(caller, "insights.campaign", {
    schema: insightsSchema,
    system: `${ANALYST_SYSTEM} This brief covers a single campaign: compare its ${terms.adGroup.toLowerCase()}s and ${terms.ad.toLowerCase()}s, call out the week-over-week trend, and suggest concrete next steps.`,
    prompt: lines.join("\n"),
    maxTokens: 5000,
  });
}
