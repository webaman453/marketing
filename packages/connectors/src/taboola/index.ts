/**
 * Taboola Backstage. Client credentials, then account → campaign → item.
 * Docs: https://developers.taboola.com/backstage-api/reference
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, noRowsUnlessFatal } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { CLIENT_REFRESH, apiError, authHeader, formToken, mapStatus, requireCredentials, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens, PlatformCredentials } from "../types";
import { taboolaCreateCampaign, type TaboolaApi } from "./builder";

export interface TaboolaConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://backstage.taboola.com/backstage/api/1.0";
type Row = Record<string, any>;

export class TaboolaConnector implements AdPlatformConnector {
  readonly platform = "TABOOLA" as const;
  constructor(private readonly config: TaboolaConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Taboola app credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    return requestJson<T>(url, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("Taboola"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    return selfRedirect(redirectUri, state);
  }

  /**
   * Client-credentials token from the connection's own client id and secret, or
   * the operator's from config for the operator's own connection.
   */
  private async clientToken(credentials?: PlatformCredentials | null) {
    const keys = credentials ? requireCredentials(this.platform, credentials) : this.operatorKeys();
    return formToken("https://backstage.taboola.com/backstage/oauth/token", {
      client_id: keys.clientId!,
      client_secret: keys.clientSecret!,
      grant_type: "client_credentials",
    }).then((t) => ({ ...t, refreshToken: t.refreshToken ?? CLIENT_REFRESH }));
  }

  private operatorKeys(): PlatformCredentials {
    this.assertConfigured();
    return { clientId: this.config.clientId!, clientSecret: this.config.clientSecret! };
  }

  exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    return this.clientToken();
  }

  refreshTokens(_refreshToken: string, credentials?: PlatformCredentials | null) {
    return this.clientToken(credentials);
  }

  connectWithCredentials(credentials: PlatformCredentials) {
    return this.clientToken(credentials);
  }

  async getUser(auth: ConnectorAuth) {
    const account = await this.call<Row>("/users/current/account", auth);
    return { id: String(account.account_id ?? account.id ?? "taboola"), name: account.name ?? account.account_id ?? "Taboola" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ results?: Row[] }>("/users/current/allowed-accounts", auth);
    return (res.results ?? []).map((a) => ({
      externalId: String(a.account_id),
      name: a.name ?? String(a.account_id),
      currency: a.currency ?? "USD",
      timezone: a.time_zone_name ?? null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = encodeURIComponent(account.externalId);
    const campaigns = (await this.call<{ results?: Row[] }>(`/${id}/campaigns/`, auth)).results ?? [];
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.id);
      structure.campaigns.push({
        externalId: cid,
        name: c.name,
        status: c.is_active === false ? "PAUSED" : mapStatus(c.status, ["RUNNING", "APPROVED"]),
        deliveryStatus: c.status ?? null,
        objective: c.marketing_objective ?? null,
        dailyBudget: c.daily_cap ?? null,
        lifetimeBudget: c.spending_limit ?? null,
        startDate: c.start_date?.slice?.(0, 10) ?? null,
        endDate: c.end_date?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      });
      const gid = `${cid}:items`;
      structure.adGroups.push({ externalId: gid, campaignExternalId: cid, name: "Items", status: "ACTIVE", dailyBudget: null, bidStrategy: c.bid_strategy ?? null, targeting: null, raw: {} });
      // A campaign whose items cannot be listed (a 4xx about that campaign) has no ads here, but an
      // expired token, missing permission, rate limit or outage fails the sync instead of saving it without ads.
      const items = (await this.call<{ results?: Row[] }>(`/${id}/campaigns/${encodeURIComponent(cid)}/items/`, auth).catch((err) => ({ results: noRowsUnlessFatal<Row>(err) }))).results ?? [];
      for (const item of items) {
        structure.ads.push({
          externalId: String(item.id),
          adGroupExternalId: gid,
          campaignExternalId: cid,
          name: item.title ?? `Item ${item.id}`,
          status: item.is_active === false ? "PAUSED" : "ACTIVE",
          headline: item.title ?? null,
          body: item.description ?? null,
          thumbnailUrl: item.thumbnail_url ?? null,
          finalUrl: item.url ?? null,
          raw: {},
        });
      }
    }
    return structure;
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    const id = encodeURIComponent(account.externalId);
    const res = await this.call<{ results?: Row[] }>(`/${id}/reports/campaign-summary/dimensions/campaign_day_breakdown`, auth, {
      query: { start_date: range.from, end_date: range.to },
    }).catch((err) => ({ results: noRowsUnlessFatal<Row>(err) }));
    return (res.results ?? []).map((r) => ({
      date: String(r.date).slice(0, 10),
      level: "CAMPAIGN" as const,
      externalId: String(r.campaign),
      impressions: Number(r.impressions ?? r.visible_impressions ?? 0),
      clicks: Number(r.clicks ?? 0),
      spend: Number(r.spent ?? 0),
      conversions: Number(r.cpa_actions_num ?? 0),
      conversionValue: Number(r.conversions_value ?? 0),
      videoViews: 0,
    }));
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    const id = encodeURIComponent(account.externalId);
    await this.call(`/${id}/campaigns/${campaign.externalId}/`, auth, { method: "POST", body: { is_active: status === "ACTIVE" } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    const id = encodeURIComponent(account.externalId);
    await this.call(`/${id}/campaigns/${campaign.externalId}/`, auth, { method: "POST", body: { daily_cap: amount } });
  }

  private api(auth: ConnectorAuth): TaboolaApi {
    return {
      send: (path, body) => this.call(path, auth, { method: "POST", body }),
      upload: (path, file, filename, mime) => uploadTaboola(auth.accessToken, path, file, filename, mime),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(_auth: ConnectorAuth, _account: AccountRef, _kind: TargetingKind, _query: string): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return taboolaCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}

async function uploadTaboola(token: string, path: string, file: Buffer, filename: string, mime: string) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(file)], { type: mime }), filename);
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(120_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError("Taboola")(res.status, body);
  return body as Row;
}
