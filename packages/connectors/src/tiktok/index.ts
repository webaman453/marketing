/**
 * TikTok Business (Marketing) API v1.3 connector.
 * Docs: https://business-api.tiktok.com/portal/docs
 *
 * TikTok returns HTTP 200 for most errors with a non-zero `code` in the body,
 * so every response is checked for it.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, type ConnectorErrorCode } from "../errors";
import { codeFromStatus, requestJson, type RequestOptions } from "../http";
import type {
  AccountRef,
  AccountStructure,
  AdPlatformConnector,
  BuilderAsset,
  ConnectorAuth,
  ExternalAdAccount,
  ExternalMetricRow,
  MetricLevel,
  OAuthTokens,
} from "../types";

import { tiktokBuilderOptions, tiktokCreateCampaign, tiktokSearchTargeting, type TikTokApi } from "./builder";

export interface TikTokConfig {
  appId?: string;
  appSecret?: string;
}

const BASE = "https://business-api.tiktok.com/open_api/v1.3";

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

type Row = Record<string, any>;

export function mapTikTokStatus(status: string | undefined): EntityStatus {
  if (status === "ENABLE") return "ACTIVE";
  if (status === "DELETE") return "REMOVED";
  return "PAUSED";
}

function errorCode(code: number): ConnectorErrorCode {
  if ([40102, 40104, 40105].includes(code)) return "AUTH_EXPIRED";
  if (code === 40100 || code === 40133 || code === 50002) return "RATE_LIMITED";
  if (code === 40001 || code === 40007) return "PERMISSION_DENIED";
  if (code >= 40000 && code < 50000) return "INVALID_REQUEST";
  return "PLATFORM_ERROR";
}

export class TikTokConnector implements AdPlatformConnector {
  readonly platform = "TIKTOK" as const;

  constructor(private readonly config: TikTokConfig) {}

  isConfigured() {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  private async call<T>(path: string, auth: ConnectorAuth | null, opts: RequestOptions = {}): Promise<T> {
    const query: Record<string, string | number | undefined> = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) query[k] = v;
    const res = await requestJson<Envelope<T>>(
      `${BASE}${path}`,
      { ...opts, query, headers: { ...(auth ? { "Access-Token": auth.accessToken } : {}), ...opts.headers } },
      (status, body) =>
        new ConnectorError(codeFromStatus(status), (body as Envelope<unknown>)?.message ?? `TikTok API error (${status})`, body),
    );
    if (res.code !== 0) throw new ConnectorError(errorCode(res.code), res.message || `TikTok error ${res.code}`, res);
    return res.data;
  }

  /** Reads every page of a list endpoint. */
  private async all(path: string, auth: ConnectorAuth, query: Record<string, string | number>) {
    const out: Row[] = [];
    for (let page = 1; ; page++) {
      const data = await this.call<{ list: Row[]; page_info?: { total_page?: number } }>(path, auth, {
        query: { ...query, page, page_size: 1000 },
      });
      out.push(...(data.list ?? []));
      if (!data.page_info?.total_page || page >= data.page_info.total_page) return out;
    }
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "TikTok app credentials are not configured.");
    const u = new URL("https://business-api.tiktok.com/portal/auth");
    u.searchParams.set("app_id", this.config.appId!);
    u.searchParams.set("state", state);
    u.searchParams.set("redirect_uri", redirectUri);
    return u.toString();
  }

  async exchangeCode({ code }: { code: string }): Promise<OAuthTokens> {
    const data = await this.call<{ access_token: string; scope?: number[] }>("/oauth2/access_token/", null, {
      method: "POST",
      body: { app_id: this.config.appId, secret: this.config.appSecret, auth_code: code },
    });
    // TikTok advertiser tokens do not expire unless revoked.
    return { accessToken: data.access_token, scopes: (data.scope ?? []).map(String) };
  }

  async refreshTokens() {
    return null;
  }

  async getUser(auth: ConnectorAuth) {
    const data = await this.call<{ core_user_id?: string; id?: string; display_name?: string; email?: string }>(
      "/user/info/",
      auth,
    );
    return { id: String(data.core_user_id ?? data.id ?? "tiktok"), name: data.display_name ?? data.email ?? "TikTok user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const list = await this.call<{ list: { advertiser_id: string; advertiser_name: string }[] }>("/oauth2/advertiser/get/", auth, {
      query: { app_id: this.config.appId, secret: this.config.appSecret },
    });
    const ids = list.list.map((a) => a.advertiser_id);
    if (ids.length === 0) return [];
    const info = await this.call<{ list: Row[] }>("/advertiser/info/", auth, {
      query: { advertiser_ids: JSON.stringify(ids), fields: JSON.stringify(["advertiser_id", "name", "currency", "timezone", "status"]) },
    });
    return info.list.map((a) => ({
      externalId: String(a.advertiser_id),
      name: a.name,
      currency: a.currency,
      timezone: a.timezone ?? null,
      status: a.status ?? "STATUS_ENABLE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const q = { advertiser_id: account.externalId };
    const [campaigns, groups, ads] = await Promise.all([
      this.all("/campaign/get/", auth, q),
      this.all("/adgroup/get/", auth, q),
      this.all("/ad/get/", auth, q),
    ]);
    const dayBudget = (r: Row) => (r.budget_mode === "BUDGET_MODE_DAY" ? Number(r.budget) : null);
    return {
      campaigns: campaigns.map((c) => ({
        externalId: String(c.campaign_id),
        name: c.campaign_name,
        status: mapTikTokStatus(c.operation_status),
        deliveryStatus: c.secondary_status ?? null,
        objective: c.objective_type ?? null,
        dailyBudget: dayBudget(c),
        lifetimeBudget: c.budget_mode === "BUDGET_MODE_TOTAL" ? Number(c.budget) : null,
        startDate: null,
        endDate: null,
        updatedAt: c.modify_time ? new Date(`${c.modify_time}Z`) : null,
        raw: { budget_mode: c.budget_mode },
      })),
      adGroups: groups.map((g) => ({
        externalId: String(g.adgroup_id),
        campaignExternalId: String(g.campaign_id),
        name: g.adgroup_name,
        status: mapTikTokStatus(g.operation_status),
        dailyBudget: dayBudget(g),
        bidStrategy: g.bid_type ?? null,
        targeting: null,
        raw: { placement_type: g.placement_type },
      })),
      ads: ads.map((a) => ({
        externalId: String(a.ad_id),
        adGroupExternalId: String(a.adgroup_id),
        campaignExternalId: String(a.campaign_id),
        name: a.ad_name,
        status: mapTikTokStatus(a.operation_status),
        headline: a.ad_name ?? null,
        body: a.ad_text ?? null,
        thumbnailUrl: null,
        finalUrl: a.landing_page_url ?? null,
        raw: { video_id: a.video_id },
      })),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const levels: [MetricLevel, string, string][] = [
      ["CAMPAIGN", "AUCTION_CAMPAIGN", "campaign_id"],
      ["AD_GROUP", "AUCTION_ADGROUP", "adgroup_id"],
      ["AD", "AUCTION_AD", "ad_id"],
    ];
    const out: ExternalMetricRow[] = [];
    for (const [level, dataLevel, idField] of levels) {
      const rows = await this.all("/report/integrated/get/", auth, {
        advertiser_id: account.externalId,
        report_type: "BASIC",
        data_level: dataLevel,
        dimensions: JSON.stringify([idField, "stat_time_day"]),
        metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "complete_payment_roas", "video_play_actions"]),
        start_date: range.from,
        end_date: range.to,
      });
      for (const r of rows) {
        const m = r.metrics ?? {};
        const spend = Number(m.spend ?? 0);
        out.push({
          date: String(r.dimensions.stat_time_day).slice(0, 10),
          level,
          externalId: String(r.dimensions[idField]),
          impressions: Number(m.impressions ?? 0),
          clicks: Number(m.clicks ?? 0),
          spend,
          conversions: Number(m.conversion ?? 0),
          conversionValue: Number(m.complete_payment_roas ?? 0) * spend,
          videoViews: Number(m.video_play_actions ?? 0),
        });
      }
    }
    return out;
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call("/campaign/status/update/", auth, {
      method: "POST",
      body: {
        advertiser_id: account.externalId,
        campaign_ids: [campaign.externalId],
        operation_status: status === "ACTIVE" ? "ENABLE" : "DISABLE",
      },
    });
  }

  async setCampaignDailyBudget(
    auth: ConnectorAuth,
    account: AccountRef,
    campaign: { externalId: string; raw?: Record<string, unknown> | null },
    amount: number,
  ) {
    if (campaign.raw?.budget_mode && campaign.raw.budget_mode !== "BUDGET_MODE_DAY") {
      throw new ConnectorError("UNSUPPORTED", "This TikTok campaign doesn't use a daily budget. Edit its ad group budgets instead.");
    }
    await this.call("/campaign/update/", auth, {
      method: "POST",
      body: { advertiser_id: account.externalId, campaign_id: campaign.externalId, budget: amount },
    });
  }

  /** API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth): TikTokApi {
    return {
      get: (path, query) => this.call(path, auth, { query }),
      post: (path, body) => this.call(path, auth, { method: "POST", body }),
      upload: async (path, form) => {
        const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Access-Token": auth.accessToken }, body: form, signal: AbortSignal.timeout(10 * 60_000) });
        const body = (await res.json().catch(() => null)) as Envelope<never> | null;
        if (!res.ok || !body || body.code !== 0) throw new ConnectorError(body ? errorCode(body.code) : codeFromStatus(res.status), body?.message ?? `TikTok upload failed (${res.status})`, body);
        return body.data;
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return tiktokBuilderOptions(this.builderApi(auth), account.externalId);
  }

  searchTargeting(auth: ConnectorAuth, account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return tiktokSearchTargeting(this.builderApi(auth), account.externalId, kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return tiktokCreateCampaign(this.builderApi(auth), account, draft, assets);
  }
}
