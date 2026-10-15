/**
 * Sample-data connector. Produces realistic, deterministic campaigns and
 * daily metrics so new workspaces can explore the product before their ad
 * platform API access is approved. Same input → same numbers on every sync.
 */
import {
  addDays,
  eachDay,
  toISODate,
  type BuilderDraft,
  type BuilderOptions,
  type Platform,
  type TargetingKind,
  type TargetingSearchResult,
} from "@ashniva/shared";
import { ConnectorError } from "../errors";
import type {
  AccountRef,
  AccountStructure,
  AdPlatformConnector,
  ExternalAdAccount,
  ExternalMetricRow,
  OAuthTokens,
} from "../types";
import { demoBuilderOptions, demoCreateCampaign, demoSearchTargeting } from "./builder";
import { DEMO_ACCOUNTS, type DemoAccountSpec, type DemoCampaignSpec } from "./catalog";

export { DEMO_ACCOUNTS } from "./catalog";

/** Platforms that have sample data. */
export const DEMO_PLATFORMS = Object.keys(DEMO_ACCOUNTS) as Platform[];

// ── deterministic randomness ──
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Uniform number in [0, 1) derived from the key. */
const rand = (key: string) => {
  let t = (hash(key) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const between = (key: string, min: number, max: number) => min + rand(key) * (max - min);

const ids = (account: DemoAccountSpec, c: DemoCampaignSpec) => ({
  campaign: `${account.externalId}-${c.key}`,
  group: (gi: number) => `${account.externalId}-${c.key}-g${gi}`,
  ad: (gi: number, ai: number) => `${account.externalId}-${c.key}-g${gi}-a${ai}`,
});

function findAccount(externalId: string): DemoAccountSpec {
  const acc = Object.values(DEMO_ACCOUNTS).find((a) => a?.externalId === externalId);
  if (!acc) throw new ConnectorError("INVALID_REQUEST", `Unknown sample account ${externalId}`);
  return acc;
}

/** Spend multiplier for a date: weekly rhythm, gentle growth and a festive bump. */
function dayFactor(date: string, key: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const weekly = [0.86, 1.02, 1.04, 1.03, 1.06, 1.1, 0.92][dow]!;
  const daysAgo = (Date.now() - d.getTime()) / 86_400_000;
  const growth = 1 + Math.max(0, 90 - daysAgo) * 0.0025;
  const noise = between(`${key}|${date}|n`, 0.84, 1.16);
  return weekly * growth * noise;
}

interface DayMetrics {
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  videoViews: number;
}

function campaignDay(c: DemoCampaignSpec, campaignId: string, date: string, today: string): DayMetrics | null {
  const start = addDays(today, -c.startedDaysAgo);
  if (date < start || date > today) return null;
  // Paused sample campaigns stopped delivering 12 days ago.
  if (c.status === "PAUSED" && date > addDays(today, -12)) return null;

  const spend = Math.round(c.dailyBudget * between(`${campaignId}|${date}|pace`, 0.78, 0.99) * dayFactor(date, campaignId) * 100) / 100;
  const cpm = c.cpm * between(`${campaignId}|${date}|cpm`, 0.88, 1.14);
  const impressions = Math.round((spend / cpm) * 1000);
  const clicks = Math.round(impressions * c.ctr * between(`${campaignId}|${date}|ctr`, 0.85, 1.15));
  const conversions = Math.round(clicks * c.cvr * between(`${campaignId}|${date}|cvr`, 0.7, 1.3) * 10) / 10;
  const conversionValue = Math.round(conversions * c.aov * between(`${campaignId}|${date}|aov`, 0.85, 1.2));
  const videoViews = Math.round(impressions * (c.videoRate ?? 0) * between(`${campaignId}|${date}|vv`, 0.85, 1.1));
  return { impressions, clicks, spend, conversions, conversionValue, videoViews };
}

/** Splits a day's totals across children by weight, keeping integer metrics whole and sums exact. */
function split(total: DayMetrics, weights: number[]): DayMetrics[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map(() => ({ impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 }));
  for (const key of Object.keys(total) as (keyof DayMetrics)[]) {
    const round = key === "impressions" || key === "clicks" || key === "videoViews"
      ? Math.round
      : (v: number) => Math.round(v * 100) / 100;
    let assigned = 0;
    weights.forEach((w, i) => {
      // The last child takes the remainder so children always sum to the parent.
      const v = i === weights.length - 1 ? round(total[key] - assigned) : round((total[key] * w) / sum);
      parts[i]![key] = Math.max(0, v);
      assigned += v;
    });
  }
  return parts;
}

export function generateDemoStructure(accountExternalId: string): AccountStructure {
  const account = findAccount(accountExternalId);
  const today = toISODate(new Date());
  const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };

  for (const c of account.campaigns) {
    const id = ids(account, c);
    structure.campaigns.push({
      externalId: id.campaign,
      name: c.name,
      status: c.status,
      deliveryStatus: c.status === "ACTIVE" ? "ACTIVE" : "CAMPAIGN_PAUSED",
      objective: c.objective,
      dailyBudget: c.dailyBudget,
      lifetimeBudget: null,
      startDate: addDays(today, -c.startedDaysAgo),
      endDate: null,
      updatedAt: null,
      raw: { daily_budget: c.dailyBudget, sample: true },
    });
    c.groups.forEach((g, gi) => {
      structure.adGroups.push({
        externalId: id.group(gi),
        campaignExternalId: id.campaign,
        name: g,
        status: c.status,
        dailyBudget: null,
        bidStrategy: "LOWEST_COST",
        targeting: null,
        raw: { sample: true },
      });
      c.ads.forEach((ad, ai) => {
        structure.ads.push({
          externalId: id.ad(gi, ai),
          adGroupExternalId: id.group(gi),
          campaignExternalId: id.campaign,
          name: ad.name,
          status: c.status,
          headline: ad.headline,
          body: ad.body,
          thumbnailUrl: null,
          finalUrl: "https://example.com/collections/festive",
          raw: { sample: true },
        });
      });
    });
  }
  return structure;
}

export function generateDemoMetrics(accountExternalId: string, range: { from: string; to: string }): ExternalMetricRow[] {
  const account = findAccount(accountExternalId);
  const today = toISODate(new Date());
  const rows: ExternalMetricRow[] = [];

  for (const c of account.campaigns) {
    const id = ids(account, c);
    for (const date of eachDay(range.from, range.to)) {
      const day = campaignDay(c, id.campaign, date, today);
      if (!day) continue;
      rows.push({ date, level: "CAMPAIGN", externalId: id.campaign, ...day });

      const groupWeights = c.groups.map((_, gi) => between(`${id.group(gi)}|w`, 0.6, 1.4) * between(`${id.group(gi)}|${date}`, 0.85, 1.15));
      split(day, groupWeights).forEach((g, gi) => {
        rows.push({ date, level: "AD_GROUP", externalId: id.group(gi), ...g });
        const adWeights = c.ads.map((_, ai) => between(`${id.ad(gi, ai)}|w`, 0.4, 1.6));
        split(g, adWeights).forEach((a, ai) => {
          rows.push({ date, level: "AD", externalId: id.ad(gi, ai), ...a });
        });
      });
    }
  }
  return rows;
}

export class DemoConnector implements AdPlatformConnector {
  constructor(readonly platform: Platform) {}

  isConfigured() {
    return Boolean(DEMO_ACCOUNTS[this.platform]);
  }

  getAuthUrl(): string {
    throw new ConnectorError("UNSUPPORTED", "Sample accounts do not use OAuth.");
  }

  async exchangeCode(): Promise<OAuthTokens> {
    throw new ConnectorError("UNSUPPORTED", "Sample accounts do not use OAuth.");
  }

  async refreshTokens() {
    return null;
  }

  async getUser() {
    return { id: `sample-${this.platform.toLowerCase()}`, name: "Sample data" };
  }

  async listAdAccounts(): Promise<ExternalAdAccount[]> {
    const a = DEMO_ACCOUNTS[this.platform];
    if (!a) return [];
    return [{ externalId: a.externalId, name: a.name, currency: a.currency, timezone: a.timezone, status: "ACTIVE", meta: { sample: true } }];
  }

  async fetchStructure(_auth: unknown, account: AccountRef) {
    return generateDemoStructure(account.externalId);
  }

  async fetchMetrics(_auth: unknown, account: AccountRef, range: { from: string; to: string }) {
    return generateDemoMetrics(account.externalId, range);
  }

  // Changes to sample campaigns are applied to our database only.
  async setCampaignStatus() {}
  async setCampaignDailyBudget() {}

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve(demoBuilderOptions(this.platform));
  }

  searchTargeting(_auth: unknown, _account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return Promise.resolve(demoSearchTargeting(kind, query));
  }

  /** Sample campaigns are created locally only; nothing is sent to an ad platform. */
  createCampaign(_auth: unknown, account: AccountRef, draft: BuilderDraft): Promise<AccountStructure> {
    return Promise.resolve(demoCreateCampaign(account.externalId, draft));
  }
}
