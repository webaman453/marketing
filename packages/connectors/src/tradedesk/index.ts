/**
 * The Trade Desk partner API. A long-lived token plus partner id, no OAuth redirect.
 * Display, video and native. CTV and audio are left for a later release.
 * Docs: https://partner.thetradedesk.com/v3/portal/api/doc
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { apiError, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { tradeDeskCreateCampaign, type TradeDeskApi } from "./builder";

export interface TradeDeskConfig {
  apiToken?: string;
  partnerId?: string;
}

const API = "https://api.thetradedesk.com/v3";
type Row = Record<string, any>;

export class TradeDeskConnector implements AdPlatformConnector {
  readonly platform = "TRADEDESK" as const;
  constructor(private readonly config: TradeDeskConfig) {}

  isConfigured() {
    return Boolean(this.config.apiToken && this.config.partnerId);
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: { "TTD-Auth": auth.accessToken, ...opts.headers } }, apiError("The Trade Desk"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "The Trade Desk token and partner id are not configured.");
    return selfRedirect(redirectUri, state, "saved-token");
  }

  async exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    if (!this.config.apiToken) throw new ConnectorError("NOT_CONFIGURED", "The Trade Desk API token is not configured.");
    return { accessToken: this.config.apiToken, scopes: [] };
  }

  async refreshTokens(_refreshToken: string) {
    return null;
  }

  async getUser(auth: ConnectorAuth) {
    return { id: this.config.partnerId ?? "ttd", name: `Partner ${this.config.partnerId ?? ""}`.trim() };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ Result?: Row[] }>("/advertiser/query/partner", auth, {
      method: "POST",
      body: { PartnerId: this.config.partnerId, PageStartIndex: 0, PageSize: 100 },
    });
    return (res.Result ?? []).map((a) => ({
      externalId: String(a.AdvertiserId),
      name: a.AdvertiserName ?? String(a.AdvertiserId),
      currency: a.CurrencyCode ?? "USD",
      timezone: null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = (await this.call<{ Result?: Row[] }>("/campaign/query/advertiser", auth, { method: "POST", body: { AdvertiserId: account.externalId, PageStartIndex: 0, PageSize: 100 } }).catch(() => ({ Result: [] }))).Result ?? [];
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.CampaignId);
      structure.campaigns.push({
        externalId: cid,
        name: c.CampaignName,
        status: c.Availability === "Available" ? "ACTIVE" : "PAUSED",
        deliveryStatus: null,
        objective: null,
        dailyBudget: c.Budget?.Amount ?? null,
        lifetimeBudget: null,
        startDate: c.StartDate?.slice?.(0, 10) ?? null,
        endDate: c.EndDate?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      });
      const groups = (await this.call<{ Result?: Row[] }>("/adgroup/query/campaign", auth, { method: "POST", body: { CampaignId: cid, PageStartIndex: 0, PageSize: 100 } }).catch(() => ({ Result: [] }))).Result ?? [];
      for (const g of groups) {
        structure.adGroups.push({ externalId: String(g.AdGroupId), campaignExternalId: cid, name: g.AdGroupName, status: g.IsEnabled === false ? "PAUSED" : "ACTIVE", dailyBudget: g.RTBAttributes?.BudgetSettings?.Budget?.Amount ?? null, bidStrategy: null, targeting: null, raw: {} });
      }
    }
    return structure;
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call("/campaign", auth, { method: "PUT", body: { CampaignId: campaign.externalId, Availability: status === "ACTIVE" ? "Available" : "Archived" } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call("/campaign", auth, { method: "PUT", body: { CampaignId: campaign.externalId, Budget: { Amount: amount, CurrencyCode: "USD" } } });
  }

  private api(auth: ConnectorAuth): TradeDeskApi {
    return { send: (path, body) => this.call(path, auth, { method: "POST", body }) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(_auth: ConnectorAuth, _account: AccountRef, _kind: TargetingKind, _query: string): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return tradeDeskCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}
