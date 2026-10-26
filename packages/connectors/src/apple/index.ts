/**
 * Apple Search Ads Campaign Management API v5.
 * Client credentials, then one connection per organization.
 * Docs: https://developer.apple.com/documentation/apple_ads
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { CLIENT_REFRESH, apiError, authHeader, formToken, mapStatus, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { appleCreateCampaign, type AppleApi } from "./builder";

export interface AppleConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api.searchads.apple.com/api/v5";
type Row = Record<string, any>;

export class AppleAdsConnector implements AdPlatformConnector {
  readonly platform = "APPLE" as const;
  constructor(private readonly config: AppleConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Apple Ads credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, account: AccountRef | null, opts: RequestOptions = {}) {
    const headers = authHeader(auth.accessToken, opts.headers);
    if (account) headers["X-AP-Context"] = `orgId=${account.externalId}`;
    return requestJson<T>(`${API}${path}`, { ...opts, headers }, apiError("Apple Ads"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    return selfRedirect(redirectUri, state);
  }

  private clientToken() {
    this.assertConfigured();
    return formToken("https://appleid.apple.com/auth/oauth2/token", {
      grant_type: "client_credentials",
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
      scope: "searchadsorg",
    }).then((t) => ({ ...t, refreshToken: CLIENT_REFRESH }));
  }

  exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    return this.clientToken();
  }

  refreshTokens(_refreshToken: string) {
    return this.clientToken();
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ data?: Row[] }>("/acls", auth, null);
    const first = res.data?.[0];
    return { id: String(first?.orgId ?? "apple"), name: first?.orgName ?? "Apple Search Ads" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ data?: Row[] }>("/acls", auth, null);
    return (res.data ?? []).map((o) => ({
      externalId: String(o.orgId),
      name: o.orgName ?? String(o.orgId),
      currency: o.currency ?? "USD",
      timezone: o.timeZone ?? null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = (await this.call<{ data?: Row[] }>("/campaigns", auth, account, { query: { limit: 100 } })).data ?? [];
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.id);
      structure.campaigns.push({
        externalId: cid,
        name: c.name,
        status: mapStatus(c.status, ["ENABLED"]),
        deliveryStatus: c.servingStatus ?? null,
        objective: c.adChannelType ?? "SEARCH",
        dailyBudget: c.dailyBudgetAmount?.amount != null ? Number(c.dailyBudgetAmount.amount) : null,
        lifetimeBudget: c.budgetAmount?.amount != null ? Number(c.budgetAmount.amount) : null,
        startDate: c.startTime?.slice?.(0, 10) ?? null,
        endDate: c.endTime?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: { adamId: c.adamId },
      });
      const groups = (await this.call<{ data?: Row[] }>(`/campaigns/${cid}/adgroups`, auth, account, { query: { limit: 100 } }).catch(() => ({ data: [] }))).data ?? [];
      for (const g of groups) {
        structure.adGroups.push({
          externalId: String(g.id),
          campaignExternalId: cid,
          name: g.name,
          status: mapStatus(g.status, ["ENABLED"]),
          dailyBudget: null,
          bidStrategy: g.pricingModel ?? null,
          targeting: null,
          raw: {},
        });
        const ads = (await this.call<{ data?: Row[] }>(`/campaigns/${cid}/adgroups/${g.id}/ads`, auth, account).catch(() => ({ data: [] }))).data ?? [];
        for (const a of ads) {
          structure.ads.push({
            externalId: String(a.id),
            adGroupExternalId: String(g.id),
            campaignExternalId: cid,
            name: a.name ?? `Ad ${a.id}`,
            status: mapStatus(a.status, ["ENABLED"]),
            headline: a.creativeType ?? null,
            body: null,
            thumbnailUrl: null,
            finalUrl: null,
            raw: { creativeType: a.creativeType },
          });
        }
      }
    }
    return structure;
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    try {
      const res = await this.call<{ data?: { reportingDataResponse?: { row?: Row[] } } }>("/reports/campaigns", auth, account, {
        method: "POST",
        body: {
          startTime: range.from,
          endTime: range.to,
          granularity: "DAILY",
          selector: { pagination: { offset: 0, limit: 1000 } },
          returnRowTotals: false,
          returnGrandTotals: false,
        },
      });
      const rows = res.data?.reportingDataResponse?.row ?? [];
      const out: ExternalMetricRow[] = [];
      for (const row of rows) {
        const id = String(row.metadata?.campaignId);
        for (const g of row.granularity ?? []) {
          out.push({
            date: String(g.date).slice(0, 10),
            level: "CAMPAIGN",
            externalId: id,
            impressions: Number(g.impressions ?? 0),
            clicks: Number(g.taps ?? 0),
            spend: Number(g.localSpend?.amount ?? 0),
            conversions: Number(g.installs ?? 0),
            conversionValue: 0,
            videoViews: 0,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/campaigns/${campaign.externalId}`, auth, account, { method: "PUT", body: { campaign: { status: status === "ACTIVE" ? "ENABLED" : "PAUSED" } } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/campaigns/${campaign.externalId}`, auth, account, { method: "PUT", body: { campaign: { dailyBudgetAmount: { amount: String(amount), currency: account.currency ?? "USD" } } } });
  }

  private api(auth: ConnectorAuth, account: AccountRef): AppleApi {
    return { send: (path, body) => this.call(path, auth, account, { method: "POST", body }) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return appleCreateCampaign(this.api(auth, account), draft, account.currency, assets);
  }
}
