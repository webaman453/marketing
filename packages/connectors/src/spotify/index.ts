/**
 * Spotify Ads API. Partner OAuth, then ad account → campaign → ad set → ad.
 * Docs: https://developer.spotify.com/documentation/ads-api
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { splitBudget } from "../builder-values";
import { allPages, requestJson, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { spotifyCreateCampaign, type SpotifyApi } from "./builder";

export interface SpotifyConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api-partner.spotify.com/ads/v3";
type Row = Record<string, any>;
/** Ads API v3 list page size (the documented default and maximum `limit` is 50). */
const PAGE_SIZE = 50;

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

  /** Ads API v3 lists businesses first. A removed /ad_accounts call comes back as 403. */
  private async businesses(auth: ConnectorAuth) {
    try {
      return await this.call<{ businesses?: Row[] }>("/businesses", auth);
    } catch (err) {
      if (err instanceof ConnectorError && err.code === "PERMISSION_DENIED") {
        throw new ConnectorError(
          "PERMISSION_DENIED",
          "Spotify refused this app. In the developer dashboard choose Ads API, accept the Ads API terms for this Client ID in Ads Manager, then connect the Spotify user that manages those ads.",
          err.details,
        );
      }
      throw err;
    }
  }

  async getUser(auth: ConnectorAuth) {
    const business = (await this.businesses(auth)).businesses?.[0];
    if (!business) {
      throw new ConnectorError("PERMISSION_DENIED", "This Spotify login has no Ads Manager business. Connect the user that owns the ad account.");
    }
    return { id: String(business.id), name: business.name ?? "Spotify Ads" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const accounts: ExternalAdAccount[] = [];
    for (const business of (await this.businesses(auth)).businesses ?? []) {
      for (const account of await this.listAll(`/businesses/${business.id}/ad_accounts`, "ad_accounts", auth)) {
        accounts.push({
          externalId: String(account.id),
          name: account.name ?? String(account.id),
          currency: account.currency_code ?? account.currency ?? "USD",
          timezone: account.timezone ?? null,
          status: account.status === "INACTIVE" ? "PAUSED" : "ACTIVE",
          meta: { businessId: String(business.id) },
        });
      }
    }
    return accounts;
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, sets, ads] = await Promise.all([
      this.listAll(`/ad_accounts/${id}/campaigns`, "campaigns", auth),
      this.listAll(`/ad_accounts/${id}/ad_sets`, "ad_sets", auth),
      this.listAll(`/ad_accounts/${id}/ads`, "ads", auth),
    ]);
    return {
      campaigns: campaigns.map((c) => ({
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
      adGroups: sets.map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.campaign_id),
        name: g.name,
        status: mapStatus(g.status),
        dailyBudget: g.budget?.micro_amount != null ? Number(g.budget.micro_amount) / 1_000_000 : null,
        bidStrategy: g.bid_strategy ?? null,
        targeting: null,
        raw: {},
      })),
      ads: ads.map((a) => ({
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

  /**
   * Ads API v3 lists page with `limit`/`offset` and answer a `paging` object
   * ({ page_size, total_results, offset }); follows them to the last page.
   */
  private listAll(path: string, key: string, auth: ConnectorAuth) {
    const limit = PAGE_SIZE;
    return allPages<Row, number>(0, async (offset) => {
      const res = await this.call<Record<string, unknown> & { paging?: { total_results?: number } }>(path, auth, { query: { limit, offset } });
      const rows = (res?.[key] as Row[] | undefined) ?? [];
      const next = offset + rows.length;
      const total = res?.paging?.total_results;
      return { items: rows, next: total != null ? (next < Number(total) ? next : null) : rows.length >= limit ? next : null };
    }, `Spotify ${key} list`);
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/ad_accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, { method: "PATCH", body: { status } });
  }

  /** Budgets live on ad sets, so the campaign's daily amount is split evenly across them. */
  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    const id = account.externalId;
    const sets = (await this.listAll(`/ad_accounts/${id}/ad_sets`, "ad_sets", auth)).filter((g) => String(g.campaign_id) === campaign.externalId);
    if (!sets.length) throw new ConnectorError("INVALID_REQUEST", "This Spotify campaign has no ad sets to put the budget on.");
    const each = splitBudget(amount, sets.length);
    for (const set of sets) {
      await this.call(`/ad_accounts/${id}/ad_sets/${set.id}`, auth, { method: "PATCH", body: { budget: { micro_amount: Math.round(each * 1_000_000), type: "DAILY" } } });
    }
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
