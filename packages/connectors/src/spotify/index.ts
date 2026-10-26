/**
 * Spotify Ads API. Partner OAuth, then ad account → campaign → ad set → ad.
 * Docs: https://developer.spotify.com/documentation/ads-api
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { spotifyCreateCampaign, type SpotifyApi } from "./builder";

export interface SpotifyConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api-partner.spotify.com/ads/v3";
type Row = Record<string, any>;

export class SpotifyAdsConnector implements AdPlatformConnector {
  readonly platform = "SPOTIFY" as const;
  constructor(private readonly config: SpotifyConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Spotify Ads credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("Spotify Ads"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL("https://accounts.spotify.com/authorize");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  private token(body: Record<string, string>) {
    this.assertConfigured();
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    return formToken("https://accounts.spotify.com/api/token", body, { Authorization: `Basic ${basic}` });
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(auth: ConnectorAuth) {
    const me = await this.call<Row>("/me", auth).catch(async () => this.call<Row>("/ad_accounts?limit=1", auth));
    return { id: String(me.id ?? "spotify"), name: me.name ?? "Spotify Ads" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ ad_accounts?: Row[]; items?: Row[] }>("/ad_accounts", auth);
    return (res.ad_accounts ?? res.items ?? []).map((a) => ({
      externalId: String(a.id),
      name: a.name ?? String(a.id),
      currency: a.currency ?? "USD",
      timezone: a.timezone ?? null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, sets, ads] = await Promise.all([
      this.call<{ campaigns?: Row[] }>(`/ad_accounts/${id}/campaigns`, auth).catch(() => ({ campaigns: [] })),
      this.call<{ ad_sets?: Row[] }>(`/ad_accounts/${id}/ad_sets`, auth).catch(() => ({ ad_sets: [] })),
      this.call<{ ads?: Row[] }>(`/ad_accounts/${id}/ads`, auth).catch(() => ({ ads: [] })),
    ]);
    return {
      campaigns: (campaigns.campaigns ?? []).map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapStatus(c.status),
        deliveryStatus: null,
        objective: c.objective ?? null,
        dailyBudget: null,
        lifetimeBudget: null,
        startDate: c.start_date?.slice?.(0, 10) ?? null,
        endDate: c.end_date?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      })),
      adGroups: (sets.ad_sets ?? []).map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.campaign_id),
        name: g.name,
        status: mapStatus(g.status),
        dailyBudget: g.budget?.micro_amount != null ? Number(g.budget.micro_amount) / 1_000_000 : null,
        bidStrategy: g.bid_strategy ?? null,
        targeting: null,
        raw: {},
      })),
      ads: (ads.ads ?? []).map((a) => ({
        externalId: String(a.id),
        adGroupExternalId: String(a.ad_set_id),
        campaignExternalId: String(a.campaign_id ?? ""),
        name: a.name,
        status: mapStatus(a.status),
        headline: a.assets?.headline ?? null,
        body: a.assets?.tagline ?? null,
        thumbnailUrl: null,
        finalUrl: a.assets?.click_url ?? null,
        raw: { format: a.format },
      })),
    };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/ad_accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, { method: "PATCH", body: { status } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/ad_accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, { method: "PATCH", body: { budget: { micro_amount: Math.round(amount * 1_000_000), type: "DAILY" } } });
  }

  private api(auth: ConnectorAuth): SpotifyApi {
    return { send: (path, method, body) => this.call(path, auth, { method, body }) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return spotifyCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}
