/**
 * X Ads (Twitter) API. OAuth 2.0 with PKCE derived from the login state.
 * Docs: https://docs.x.com/x-ads-api
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus, pkce } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { xCreateCampaign, type XApi } from "./builder";

export interface XConfig {
  clientId?: string;
  clientSecret?: string;
}

const ADS = "https://ads-api.x.com/12";
const SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access", "ads.read", "ads.write"];
type Row = Record<string, any>;

export class XAdsConnector implements AdPlatformConnector {
  readonly platform = "X" as const;
  constructor(private readonly config: XConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "X Ads credentials are not configured.");
  }

  private call<T>(url: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(url, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("X Ads"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL("https://twitter.com/i/oauth2/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", pkce(this.config.clientSecret!, state).challenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  private token(body: Record<string, string>) {
    this.assertConfigured();
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    return formToken("https://api.x.com/2/oauth2/token", body, { Authorization: `Basic ${basic}` });
  }

  exchangeCode({ code, redirectUri, state }: { code: string; redirectUri: string; state?: string }) {
    return this.token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce(this.config.clientSecret!, state ?? "").verifier,
      client_id: this.config.clientId!,
    });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.config.clientId! });
  }

  async getUser(auth: ConnectorAuth) {
    const me = await this.call<{ data?: Row }>("https://api.x.com/2/users/me", auth);
    return { id: String(me.data?.id ?? "x"), name: me.data?.name ?? me.data?.username ?? "X user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ data?: Row[] }>(`${ADS}/accounts`, auth);
    return (res.data ?? []).map((a) => ({
      externalId: String(a.id),
      name: a.name ?? String(a.id),
      currency: a.currency ?? "USD",
      timezone: a.timezone ?? null,
      status: a.approval_status === "ACCEPTED" ? "ACTIVE" : a.approval_status ?? "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, lines, promoted] = await Promise.all([
      this.call<{ data?: Row[] }>(`${ADS}/accounts/${id}/campaigns`, auth),
      this.call<{ data?: Row[] }>(`${ADS}/accounts/${id}/line_items`, auth),
      this.call<{ data?: Row[] }>(`${ADS}/accounts/${id}/promoted_tweets`, auth).catch(() => ({ data: [] })),
    ]);
    return {
      campaigns: (campaigns.data ?? []).map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapStatus(c.entity_status),
        deliveryStatus: c.servable === false ? "NOT_SERVABLE" : null,
        objective: c.objective ?? null,
        dailyBudget: c.daily_budget_amount_local_micro != null ? Number(c.daily_budget_amount_local_micro) / 1_000_000 : null,
        lifetimeBudget: c.total_budget_amount_local_micro != null ? Number(c.total_budget_amount_local_micro) / 1_000_000 : null,
        startDate: c.start_time?.slice?.(0, 10) ?? null,
        endDate: c.end_time?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: {},
      })),
      adGroups: (lines.data ?? []).map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.campaign_id),
        name: g.name,
        status: mapStatus(g.entity_status),
        dailyBudget: g.daily_budget_amount_local_micro != null ? Number(g.daily_budget_amount_local_micro) / 1_000_000 : null,
        bidStrategy: g.bid_type ?? null,
        targeting: null,
        raw: {},
      })),
      ads: (promoted.data ?? []).map((a) => ({
        externalId: String(a.id),
        adGroupExternalId: String(a.line_item_id),
        campaignExternalId: String(lines.data?.find((g) => g.id === a.line_item_id)?.campaign_id ?? ""),
        name: a.tweet_id ? `Post ${a.tweet_id}` : String(a.id),
        status: mapStatus(a.entity_status),
        headline: null,
        body: null,
        thumbnailUrl: null,
        finalUrl: null,
        raw: { tweet_id: a.tweet_id },
      })),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    try {
      const structure = await this.fetchStructure(auth, account);
      const ids = structure.campaigns.map((c) => c.externalId).slice(0, 20);
      if (!ids.length) return [];
      const res = await this.call<{ data?: Row[] }>(`${ADS}/stats/accounts/${account.externalId}`, auth, {
        query: {
          entity: "CAMPAIGN",
          entity_ids: ids.join(","),
          start_time: `${range.from}T00:00:00Z`,
          end_time: `${range.to}T00:00:00Z`,
          granularity: "DAY",
          metric_groups: "ENGAGEMENT,BILLING",
          placement: "ALL_ON_TWITTER",
        },
      });
      const out: ExternalMetricRow[] = [];
      for (const row of res.data ?? []) {
        const id = String(row.id);
        const metrics = row.id_data?.[0]?.metrics ?? {};
        const days: string[] = metrics.impressions ? Array.from({ length: metrics.impressions.length }, (_, i) => i).map((i) => addDay(range.from, i)) : [];
        days.forEach((date, i) => {
          out.push({
            date,
            level: "CAMPAIGN",
            externalId: id,
            impressions: Number(metrics.impressions?.[i] ?? 0),
            clicks: Number(metrics.clicks?.[i] ?? 0),
            spend: Number(metrics.billed_charge_local_micro?.[i] ?? 0) / 1_000_000,
            conversions: 0,
            conversionValue: 0,
            videoViews: Number(metrics.video_total_views?.[i] ?? 0),
          });
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`${ADS}/accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, {
      method: "PUT",
      form: true,
      body: { entity_status: status === "ACTIVE" ? "ACTIVE" : "PAUSED" },
    });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`${ADS}/accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, {
      method: "PUT",
      form: true,
      body: { daily_budget_amount_local_micro: Math.round(amount * 1_000_000) },
    });
  }

  private api(auth: ConnectorAuth): XApi {
    return {
      send: (url, body, form) => this.call(url, auth, form ? { method: "POST", form: true, body: body as Record<string, string> } : { method: "POST", body }),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return xCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}

function addDay(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
