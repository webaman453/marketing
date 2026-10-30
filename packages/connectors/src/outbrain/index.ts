/**
 * Outbrain Amplify. A marketer API token, not a user OAuth redirect.
 * Docs: https://developer.outbrain.com/home-page/amplify-api/
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, noRowsUnlessFatal } from "../errors";
import { allPages, requestJson, type RequestOptions } from "../http";
import { apiError, requireCredentials, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens, PlatformCredentials } from "../types";
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

  /**
   * A customer's connection sends its own token. The operator's own connection
   * (no stored credentials) uses the token from config when one is set, so a
   * rotated OUTBRAIN_API_TOKEN takes effect at once; the copy made at connect
   * time is only its fallback.
   */
  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    const token = auth.credentials ? auth.accessToken : this.config.apiToken || auth.accessToken;
    return requestJson<T>(
      `${API}${path}`,
      { ...opts, headers: { "OB-TOKEN-V1": token, ...opts.headers } },
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

  /** The customer's own Amplify token is the access token; Connect checks it by listing marketers. */
  async connectWithCredentials(credentials: PlatformCredentials): Promise<OAuthTokens> {
    return { accessToken: requireCredentials(this.platform, credentials).apiToken!, scopes: [] };
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
      // A campaign whose links cannot be listed (a 4xx about it) has no ads here; an expired token,
      // missing permission, rate limit or outage fails the sync instead of saving it without ads.
      const links = await this.promotedLinks(auth, cid).catch(noRowsUnlessFatal<Row>);
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

  /** Every promoted link of a campaign: pages of `limit` with `offset`, until `totalCount` (or a short page). */
  private promotedLinks(auth: ConnectorAuth, campaignId: string) {
    const limit = 100;
    return allPages<Row, number>(0, async (offset) => {
      const res = await this.call<{ promotedLinks?: Row[]; totalCount?: number }>(`/campaigns/${encodeURIComponent(campaignId)}/promotedLinks`, auth, { query: { limit, offset } });
      const rows = res.promotedLinks ?? [];
      const next = offset + rows.length;
      const total = res.totalCount;
      return { items: rows, next: total != null ? (next < Number(total) ? next : null) : rows.length >= limit ? next : null };
    }, "Outbrain promoted link list");
  }

  /**
   * Daily rows per campaign from the periodic report (breakdown=daily). Only days
   * the report returns are recorded; a range total is never written onto one day.
   * RISK: endpoint and response shape (campaignResults[].results[].metadata.id = day)
   * follow Outbrain's Amplify docs but are not verified against a live account.
   */
  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    const res = await this.call<{ campaignResults?: Row[] }>(`/reports/marketers/${account.externalId}/campaigns/periodic`, auth, {
      query: { from: range.from, to: range.to, breakdown: "daily", limit: 500 },
    }).catch((err) => ({ campaignResults: noRowsUnlessFatal<Row>(err) }));
    const out: ExternalMetricRow[] = [];
    for (const campaign of res.campaignResults ?? []) {
      const id = campaign.campaignId ?? campaign.metadata?.id;
      if (id == null) continue;
      for (const r of campaign.results ?? []) {
        const date = /^\d{4}-\d{2}-\d{2}/.exec(String(r.metadata?.id ?? r.metadata?.fromDate ?? ""))?.[0];
        if (!date) continue;
        out.push({
          date,
          level: "CAMPAIGN",
          externalId: String(id),
          impressions: Number(r.metrics?.impressions ?? 0),
          clicks: Number(r.metrics?.clicks ?? 0),
          spend: Number(r.metrics?.spend ?? 0),
          conversions: Number(r.metrics?.conversions ?? 0),
          conversionValue: Number(r.metrics?.sumValue ?? 0),
          videoViews: 0,
        });
      }
    }
    return out;
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
