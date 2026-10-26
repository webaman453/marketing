/**
 * Outbrain Amplify. A marketer API token, not a user OAuth redirect.
 * Docs: https://developer.outbrain.com/home-page/amplify-api/
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { apiError, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { outbrainCreateCampaign, type OutbrainApi } from "./builder";

export interface OutbrainConfig {
  apiToken?: string;
}

const API = "https://api.outbrain.com/amplify/v0.1";
type Row = Record<string, any>;

export class OutbrainConnector implements AdPlatformConnector {
  readonly platform = "OUTBRAIN" as const;
  constructor(private readonly config: OutbrainConfig) {}

  isConfigured() {
    return Boolean(this.config.apiToken);
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(
      `${API}${path}`,
      { ...opts, headers: { "OB-TOKEN-V1": auth.accessToken, ...opts.headers } },
      apiError("Outbrain"),
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Outbrain API token is not configured.");
    return selfRedirect(redirectUri, state, "saved-token");
  }

  async exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    if (!this.config.apiToken) throw new ConnectorError("NOT_CONFIGURED", "Outbrain API token is not configured.");
    return { accessToken: this.config.apiToken, scopes: [] };
  }

  async refreshTokens(_refreshToken: string) {
    return null;
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ marketers?: Row[] }>("/marketers", auth);
    const first = res.marketers?.[0];
    return { id: String(first?.id ?? "outbrain"), name: first?.name ?? "Outbrain" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ marketers?: Row[] }>("/marketers", auth);
    return (res.marketers ?? []).map((m) => ({
      externalId: String(m.id),
      name: m.name ?? String(m.id),
      currency: m.currency ?? "USD",
      timezone: null,
      status: m.enabled === false ? "PAUSED" : "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = (await this.call<{ campaigns?: Row[] }>(`/marketers/${account.externalId}/campaigns`, auth)).campaigns ?? [];
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.id);
      structure.campaigns.push({
        externalId: cid,
        name: c.name,
        status: c.enabled === false ? "PAUSED" : "ACTIVE",
        deliveryStatus: null,
        objective: c.objective ?? null,
        dailyBudget: c.budget?.amount ?? c.budget?.dailyTarget ?? null,
        lifetimeBudget: null,
        startDate: null,
        endDate: null,
        updatedAt: null,
        raw: {},
      });
      const gid = `${cid}:links`;
      structure.adGroups.push({ externalId: gid, campaignExternalId: cid, name: "Promoted links", status: "ACTIVE", dailyBudget: null, bidStrategy: c.cpc != null ? "CPC" : null, targeting: null, raw: {} });
      const links = (await this.call<{ promotedLinks?: Row[] }>(`/campaigns/${cid}/promotedLinks`, auth, { query: { limit: 100 } }).catch(() => ({ promotedLinks: [] }))).promotedLinks ?? [];
      for (const link of links) {
        structure.ads.push({
          externalId: String(link.id),
          adGroupExternalId: gid,
          campaignExternalId: cid,
          name: link.text ?? `Link ${link.id}`,
          status: link.enabled === false ? "PAUSED" : "ACTIVE",
          headline: link.text ?? null,
          body: null,
          thumbnailUrl: link.imageMetadata?.url ?? link.cachedImageUrl ?? null,
          finalUrl: link.url ?? null,
          raw: {},
        });
      }
    }
    return structure;
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    try {
      const res = await this.call<{ results?: Row[] }>(`/reports/marketers/${account.externalId}/campaigns`, auth, {
        query: { from: range.from, to: range.to, limit: 500 },
      });
      return (res.results ?? []).map((r) => ({
        date: range.to,
        level: "CAMPAIGN" as const,
        externalId: String(r.campaignId ?? r.metadata?.id),
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        spend: Number(r.metrics?.spend ?? 0),
        conversions: Number(r.metrics?.conversions ?? 0),
        conversionValue: Number(r.metrics?.sumValue ?? 0),
        videoViews: 0,
      }));
    } catch {
      return [];
    }
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/campaigns/${campaign.externalId}`, auth, { method: "PUT", body: { enabled: status === "ACTIVE" } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/campaigns/${campaign.externalId}`, auth, { method: "PUT", body: { budget: { amount, type: "DAILY" } } });
  }

  private api(auth: ConnectorAuth): OutbrainApi {
    return { send: (path, method, body) => this.call(path, auth, { method, body }) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return outbrainCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}
