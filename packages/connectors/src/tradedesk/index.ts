/**
 * The Trade Desk partner API. A long-lived token plus partner id, no OAuth redirect.
 * Display, video and native. CTV and audio are left for a later release.
 * Docs: https://partner.thetradedesk.com/v3/portal/api/doc
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { allPages, requestJson, type RequestOptions } from "../http";
import { apiError, requireCredentials, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens, PlatformCredentials } from "../types";
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

  /**
   * A customer's connection sends its own token. The operator's own connection
   * (no stored credentials) uses the token from config when one is set, so
   * rotating TRADEDESK_API_TOKEN takes effect at once; the copy made at connect
   * time is only its fallback.
   */
  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    const token = auth.credentials ? auth.accessToken : this.config.apiToken || auth.accessToken;
    return requestJson<T>(`${API}${path}`, { ...opts, headers: { "TTD-Auth": token, ...opts.headers } }, apiError("The Trade Desk"));
  }

  /** The connection's own partner; the operator's partner only for the operator's own connection. */
  private partnerId(auth: ConnectorAuth) {
    const id = auth.credentials ? auth.credentials.partnerId : this.config.partnerId;
    if (!id) throw new ConnectorError("NOT_CONFIGURED", "The Trade Desk partner id is missing. Reconnect with your API token and partner id.");
    return id;
  }

  /** POST …/query/… lists page with PageStartIndex/PageSize and report TotalFilteredCount. */
  private query(path: string, auth: ConnectorAuth, filter: Record<string, unknown>) {
    const size = 100;
    return allPages<Row, number>(0, async (start) => {
      const res = await this.call<{ Result?: Row[]; TotalFilteredCount?: number }>(path, auth, { method: "POST", body: { ...filter, PageStartIndex: start, PageSize: size } });
      const rows = res.Result ?? [];
      const total = Number(res.TotalFilteredCount ?? 0);
      const next = start + rows.length;
      return { items: rows, next: rows.length === size && (!total || next < total) ? next : null };
    }, `The Trade Desk ${path} list`);
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

  /** The customer's own long-lived token is the access token; Connect checks it by listing the partner's advertisers. */
  async connectWithCredentials(credentials: PlatformCredentials): Promise<OAuthTokens> {
    return { accessToken: requireCredentials(this.platform, credentials).apiToken!, scopes: [] };
  }

  async getUser(auth: ConnectorAuth) {
    const partnerId = this.partnerId(auth);
    return { id: partnerId, name: `Partner ${partnerId}` };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const rows = await this.query("/advertiser/query/partner", auth, { PartnerId: this.partnerId(auth) });
    return rows.map((a) => ({
      externalId: String(a.AdvertiserId),
      name: a.AdvertiserName ?? String(a.AdvertiserId),
      currency: a.CurrencyCode ?? "USD",
      timezone: null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = await this.query("/campaign/query/advertiser", auth, { AdvertiserId: account.externalId });
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.CampaignId);
      const groups = await this.query("/adgroup/query/campaign", auth, { CampaignId: cid });
      // Campaigns stay Available; pausing turns their ad groups off (Archived is permanent).
      const status = c.Availability === "Archived" ? "ARCHIVED" : groups.length && groups.every((g) => g.IsEnabled === false) ? "PAUSED" : "ACTIVE";
      structure.campaigns.push({
        externalId: cid,
        name: c.CampaignName,
        status,
        deliveryStatus: null,
        objective: null,
        // Budget is the campaign total; the daily cap is a separate field.
        dailyBudget: c.DailyBudget?.Amount ?? null,
        lifetimeBudget: c.Budget?.Amount ?? null,
        startDate: c.StartDate?.slice?.(0, 10) ?? null,
        endDate: c.EndDate?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      });
      for (const g of groups) {
        const budget = g.RTBAttributes?.BudgetSettings;
        structure.adGroups.push({ externalId: String(g.AdGroupId), campaignExternalId: cid, name: g.AdGroupName, status: g.IsEnabled === false ? "PAUSED" : "ACTIVE", dailyBudget: budget?.DailyBudget?.Amount ?? null, bidStrategy: null, targeting: null, raw: {} });
      }
    }
    return structure;
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  /** Pauses or resumes by switching the campaign's ad groups; the campaign itself stays Available. */
  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    const groups = await this.query("/adgroup/query/campaign", auth, { CampaignId: campaign.externalId });
    for (const g of groups) {
      await this.call("/adgroup", auth, { method: "PUT", body: { AdGroupId: g.AdGroupId, IsEnabled: status === "ACTIVE" } });
    }
  }

  /** Sets the campaign's daily cap (DailyBudget); the total Budget is left as it is. */
  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef & { currency: string }, campaign: { externalId: string }, amount: number) {
    await this.call("/campaign", auth, { method: "PUT", body: { CampaignId: campaign.externalId, DailyBudget: { Amount: amount, CurrencyCode: account.currency } } });
  }

  private api(auth: ConnectorAuth): TradeDeskApi {
    return {
      send: (path, body) => this.call(path, auth, { method: "POST", body }),
      update: (path, body) => this.call(path, auth, { method: "PUT", body }),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(_auth: ConnectorAuth, _account: AccountRef, _kind: TargetingKind, _query: string): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return tradeDeskCreateCampaign(this.api(auth), account.externalId, account.currency, draft, assets);
  }
}
