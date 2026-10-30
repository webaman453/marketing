/**
 * Yahoo DSP traffic API. OAuth, then advertiser → campaign → line → ad.
 * Docs: https://developer.yahooinc.com/dsp/api/docs/traffic
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { allPages, requestJson, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { yahooCreateCampaign, type YahooApi } from "./builder";

export interface YahooConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://dspapi.admanagerplus.yahoo.com/traffic";
type Row = Record<string, any>;

export class YahooDspConnector implements AdPlatformConnector {
  readonly platform = "YAHOO" as const;
  constructor(private readonly config: YahooConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Yahoo DSP credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("Yahoo DSP"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL("https://api.login.yahoo.com/oauth2/request_auth");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private token(body: Record<string, string>) {
    this.assertConfigured();
    return formToken("https://api.login.yahoo.com/oauth2/get_token", {
      ...body,
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ response?: Row[] }>("/advertisers", auth);
    const first = res.response?.[0];
    return { id: String(first?.id ?? "yahoo"), name: first?.name ?? "Yahoo DSP" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ response?: Row[] }>("/advertisers", auth);
    return (res.response ?? []).map((a) => ({
      externalId: String(a.id),
      name: a.name ?? String(a.id),
      currency: a.currency ?? "USD",
      timezone: a.timezone ?? null,
      status: a.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
    }));
  }

  /**
   * Traffic API lists page with `page` (1-based) and `limit` (max 100) and are filtered by their
   * parent: campaigns by `accountId`, lines by `orderId` (the campaign), ads by `lineId`.
   */
  private listAll(path: string, auth: ConnectorAuth, filter: Record<string, string>) {
    const limit = 100;
    return allPages<Row, number>(1, async (page) => {
      const res = await this.call<{ response?: Row[] }>(path, auth, { query: { ...filter, page, limit } });
      const rows = res?.response ?? [];
      return { items: rows, next: rows.length >= limit ? page + 1 : null };
    }, `Yahoo DSP ${path.slice(1)} list`);
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = await this.listAll("/campaigns", auth, { accountId: account.externalId });
    const lines: Row[] = [];
    for (const c of campaigns) {
      for (const line of await this.listAll("/lines", auth, { orderId: String(c.id) })) lines.push({ ...line, orderId: line.orderId ?? c.id });
    }
    const ads: Row[] = [];
    for (const line of lines) {
      for (const ad of await this.listAll("/ads", auth, { lineId: String(line.id) })) ads.push({ ...ad, lineId: ad.lineId ?? line.id, campaignId: ad.campaignId ?? line.orderId });
    }
    return {
      campaigns: campaigns.map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapStatus(c.status),
        deliveryStatus: null,
        objective: c.goalType ?? null,
        dailyBudget: c.budget ?? null,
        lifetimeBudget: null,
        startDate: c.startDate?.slice?.(0, 10) ?? null,
        endDate: c.endDate?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      })),
      adGroups: lines.map((g) => ({
        externalId: String(g.id),
        // A line's parent campaign is its `orderId`.
        campaignExternalId: String(g.orderId ?? g.campaignId),
        name: g.name,
        status: mapStatus(g.status),
        dailyBudget: g.budget ?? null,
        bidStrategy: g.bidPrice != null ? "CPM" : null,
        targeting: null,
        raw: {},
      })),
      ads: ads.map((a) => ({
        externalId: String(a.id),
        adGroupExternalId: String(a.lineId),
        campaignExternalId: String(a.campaignId ?? ""),
        name: a.name,
        status: mapStatus(a.status),
        headline: a.title ?? null,
        body: a.description ?? null,
        thumbnailUrl: null,
        finalUrl: a.landingPageUrl ?? null,
        raw: { format: a.adType },
      })),
    };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/campaigns/${campaign.externalId}`, auth, { method: "PUT", body: { status } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/campaigns/${campaign.externalId}`, auth, { method: "PUT", body: { budget: amount, budgetType: "DAILY" } });
  }

  private api(auth: ConnectorAuth): YahooApi {
    return {
      send: (path, body) => this.call(path, auth, { method: "POST", body }),
      update: (path, body) => this.call(path, auth, { method: "PUT", body }),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return yahooCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}
