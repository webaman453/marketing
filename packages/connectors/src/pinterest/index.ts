/**
 * Pinterest API v5 connector (ads).
 * Docs: https://developers.pinterest.com/docs/api/v5/
 *
 * Money values are in micro-currency. Analytics accept up to 250 ids and a
 * 90-day window per request, so both are chunked.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { addDays } from "@ashniva/shared";
import { ConnectorError } from "../errors";
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
import { pinterestBuilderOptions, pinterestCreateCampaign, pinterestSearchTargeting, type PinterestApi } from "./builder";

export interface PinterestConfig {
  appId?: string;
  appSecret?: string;
}

const API = "https://api.pinterest.com/v5";
const SCOPES = ["ads:read", "ads:write", "user_accounts:read", "pins:read", "pins:write", "boards:read", "boards:write"];
const MICRO = 1_000_000;

type Row = Record<string, any>;

export const mapPinterestStatus = (s: string | undefined): EntityStatus =>
  s === "ACTIVE" ? "ACTIVE" : s === "ARCHIVED" ? "ARCHIVED" : s === "DELETED_DRAFT" ? "REMOVED" : "PAUSED";

function* chunks<T>(arr: T[], size: number) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

export class PinterestConnector implements AdPlatformConnector {
  readonly platform = "PINTEREST" as const;

  constructor(private readonly config: PinterestConfig) {}

  isConfigured() {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  private mapError = (status: number, body: unknown) =>
    new ConnectorError(codeFromStatus(status), (body as { message?: string })?.message ?? `Pinterest API error (${status})`, body);

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${auth.accessToken}`, ...opts.headers } }, this.mapError);
  }

  private async all(path: string, auth: ConnectorAuth, query: Record<string, string | number> = {}) {
    const out: Row[] = [];
    let bookmark: string | undefined;
    do {
      const res = await this.call<{ items: Row[]; bookmark?: string | null }>(path, auth, {
        query: { ...query, page_size: 250, bookmark },
      });
      out.push(...(res.items ?? []));
      bookmark = res.bookmark ?? undefined;
    } while (bookmark);
    return out;
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Pinterest app credentials are not configured.");
    const u = new URL("https://www.pinterest.com/oauth/");
    u.searchParams.set("client_id", this.config.appId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const basic = Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString("base64");
    const res = await requestJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      `${API}/oauth/token`,
      { method: "POST", form: true, headers: { Authorization: `Basic ${basic}` }, body },
      this.mapError,
    );
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
      scopes: res.scope?.split(",") ?? SCOPES,
    };
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(auth: ConnectorAuth) {
    const u = await this.call<{ username?: string; id?: string; business_name?: string }>("/user_account", auth);
    return { id: String(u.id ?? u.username ?? "pinterest"), name: u.business_name ?? u.username ?? "Pinterest user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const accounts = await this.all("/ad_accounts", auth);
    return accounts.map((a) => ({
      externalId: String(a.id),
      name: a.name,
      currency: a.currency ?? "USD",
      timezone: null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, groups, ads] = await Promise.all([
      this.all(`/ad_accounts/${id}/campaigns`, auth),
      this.all(`/ad_accounts/${id}/ad_groups`, auth),
      this.all(`/ad_accounts/${id}/ads`, auth),
    ]);
    const micro = (v: unknown) => (v == null ? null : Number(v) / MICRO);
    const date = (unix: unknown) => (unix ? new Date(Number(unix) * 1000).toISOString().slice(0, 10) : null);
    return {
      campaigns: campaigns.map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapPinterestStatus(c.status),
        deliveryStatus: c.summary_status ?? null,
        objective: c.objective_type ?? null,
        dailyBudget: micro(c.daily_spend_cap),
        lifetimeBudget: micro(c.lifetime_spend_cap),
        startDate: date(c.start_time),
        endDate: date(c.end_time),
        updatedAt: c.updated_time ? new Date(Number(c.updated_time) * 1000) : null,
        raw: {},
      })),
      adGroups: groups.map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.campaign_id),
        name: g.name,
        status: mapPinterestStatus(g.status),
        dailyBudget: g.budget_type === "DAILY" ? micro(g.budget_in_micro_currency) : null,
        bidStrategy: g.bid_strategy_type ?? null,
        targeting: null,
        raw: {},
      })),
      ads: ads.map((a) => ({
        externalId: String(a.id),
        adGroupExternalId: String(a.ad_group_id),
        campaignExternalId: String(a.campaign_id),
        name: a.name ?? `Pin ${a.pin_id}`,
        status: mapPinterestStatus(a.status),
        headline: null,
        body: null,
        thumbnailUrl: null,
        finalUrl: a.destination_url ?? null,
        raw: { pin_id: a.pin_id },
      })),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const structure = await this.fetchStructure(auth, account);
    const levels: [MetricLevel, string, string, string, string[]][] = [
      ["CAMPAIGN", "campaigns", "campaign_ids", "CAMPAIGN_ID", structure.campaigns.map((c) => c.externalId)],
      ["AD_GROUP", "ad_groups", "ad_group_ids", "AD_GROUP_ID", structure.adGroups.map((g) => g.externalId)],
      ["AD", "ads", "ad_ids", "AD_ID", structure.ads.map((a) => a.externalId)],
    ];
    const columns = "SPEND_IN_MICRO_DOLLAR,IMPRESSION_1,CLICKTHROUGH_1,TOTAL_CONVERSIONS,TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR,VIDEO_3SEC_VIEWS_2";
    const out: ExternalMetricRow[] = [];

    for (const [level, resource, idParam, idCol, ids] of levels) {
      for (const idChunk of chunks(ids, 250)) {
        // Pinterest limits analytics windows to 90 days.
        for (let start = range.from; start <= range.to; start = addDays(start, 90)) {
          const end = addDays(start, 89) < range.to ? addDays(start, 89) : range.to;
          const rows = await this.call<Row[]>(`/ad_accounts/${account.externalId}/${resource}/analytics`, auth, {
            query: { start_date: start, end_date: end, [idParam]: idChunk.join(","), columns, granularity: "DAY" },
          });
          for (const r of rows ?? []) {
            out.push({
              date: String(r.DATE),
              level,
              externalId: String(r[idCol]),
              impressions: Number(r.IMPRESSION_1 ?? 0),
              clicks: Number(r.CLICKTHROUGH_1 ?? 0),
              spend: Number(r.SPEND_IN_MICRO_DOLLAR ?? 0) / MICRO,
              conversions: Number(r.TOTAL_CONVERSIONS ?? 0),
              conversionValue: Number(r.TOTAL_CHECKOUT_VALUE_IN_MICRO_DOLLAR ?? 0) / MICRO,
              videoViews: Number(r.VIDEO_3SEC_VIEWS_2 ?? 0),
            });
          }
        }
      }
    }
    return out;
  }

  private patchCampaign(auth: ConnectorAuth, account: AccountRef, body: Row) {
    return this.call(`/ad_accounts/${account.externalId}/campaigns`, auth, { method: "PATCH", body: [body] });
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.patchCampaign(auth, account, { id: campaign.externalId, status });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.patchCampaign(auth, account, { id: campaign.externalId, daily_spend_cap: Math.round(amount * MICRO) });
  }

  /** API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth): PinterestApi {
    return {
      get: (path, query) => this.call(path, auth, { query }),
      send: (path, method, body) => this.call(path, auth, { method, body }),
      uploadToS3: async (url, fields, file, filename) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        form.set("file", file, filename);
        const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok) throw new ConnectorError("PLATFORM_ERROR", `Pinterest video upload failed (${res.status}).`);
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return pinterestBuilderOptions(this.builderApi(auth), account.externalId);
  }

  searchTargeting(auth: ConnectorAuth, _account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return pinterestSearchTargeting(this.builderApi(auth), kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return pinterestCreateCampaign(this.builderApi(auth), account, draft, assets);
  }
}
