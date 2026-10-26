/**
 * Criteo Marketing API. Client credentials, then advertisers.
 * Docs: https://developers.criteo.com/marketing-solutions/docs
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { CLIENT_REFRESH, apiError, authHeader, formToken, mapStatus, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { criteoCreateCampaign, type CriteoApi } from "./builder";

export interface CriteoConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api.criteo.com/2025-10";
type Row = Record<string, any>;

export class CriteoConnector implements AdPlatformConnector {
  readonly platform = "CRITEO" as const;
  constructor(private readonly config: CriteoConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Criteo credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("Criteo"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    return selfRedirect(redirectUri, state);
  }

  private clientToken() {
    this.assertConfigured();
    return formToken("https://api.criteo.com/oauth2/token", {
      grant_type: "client_credentials",
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    }).then((t) => ({ ...t, refreshToken: CLIENT_REFRESH }));
  }

  exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    return this.clientToken();
  }

  refreshTokens(_refreshToken: string) {
    return this.clientToken();
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ data?: Row[] }>("/advertisers", auth);
    const first = res.data?.[0];
    return { id: String(first?.id ?? "criteo"), name: first?.attributes?.name ?? "Criteo" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ data?: Row[] }>("/advertisers", auth);
    return (res.data ?? []).map((a) => ({
      externalId: String(a.id),
      name: a.attributes?.advertiserName ?? a.attributes?.name ?? String(a.id),
      currency: a.attributes?.currency ?? "USD",
      timezone: null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const res = await this.call<{ data?: Row[] }>(`/advertisers/${account.externalId}/ad-sets`, auth).catch(() => ({ data: [] as Row[] }));
    const sets = res.data ?? [];
    const campaigns = new Map<string, Row>();
    for (const set of sets) {
      const cid = String(set.attributes?.campaignId ?? set.id);
      if (!campaigns.has(cid)) campaigns.set(cid, { id: cid, name: set.attributes?.campaignName ?? set.attributes?.name ?? cid, status: set.attributes?.status });
    }
    return {
      campaigns: [...campaigns.values()].map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapStatus(c.status),
        deliveryStatus: null,
        objective: null,
        dailyBudget: null,
        lifetimeBudget: null,
        startDate: null,
        endDate: null,
        updatedAt: null,
        raw: {},
      })),
      adGroups: sets.map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.attributes?.campaignId ?? g.id),
        name: g.attributes?.name ?? String(g.id),
        status: mapStatus(g.attributes?.status),
        dailyBudget: g.attributes?.budget?.amount ?? null,
        bidStrategy: g.attributes?.bidding?.type ?? null,
        targeting: null,
        raw: {},
      })),
      ads: [],
    };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/ad-sets/${campaign.externalId}`, auth, { method: "PATCH", body: { data: { type: "AdSet", id: campaign.externalId, attributes: { status } } } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/ad-sets/${campaign.externalId}`, auth, { method: "PATCH", body: { data: { type: "AdSet", id: campaign.externalId, attributes: { budget: { amount, type: "DAILY" } } } } });
  }

  private api(auth: ConnectorAuth): CriteoApi {
    return { send: (path, body) => this.call(path, auth, { method: "POST", body }) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return criteoCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}
