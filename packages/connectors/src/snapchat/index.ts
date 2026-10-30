/**
 * Snapchat Marketing API connector.
 * Docs: https://developers.snap.com/api/marketing-api
 *
 * Money values are in micro-currency. Updates require the full object, so the
 * current entity is read before changing it.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { allPages, codeFromStatus, requestJson, type RequestOptions } from "../http";
import { builderZone, zoneOffsetMs, zonedTimeToUtc } from "../builder-values";
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
import { snapBuilderOptions, snapCreateCampaign, snapSearchTargeting, type SnapApi } from "./builder";

export interface SnapchatConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://adsapi.snapchat.com/v1";
const MICRO = 1_000_000;

type Row = Record<string, any>;

/** An instant as ISO 8601 with the zone's offset, e.g. 2026-10-01T00:00:00.000-07:00. */
function localIso(d: Date, timeZone: string) {
  const offset = zoneOffsetMs(d.getTime(), timeZone);
  const wall = new Date(d.getTime() + offset).toISOString().slice(0, 23);
  const mins = Math.round(Math.abs(offset) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  return `${wall}${sign}${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export const mapSnapStatus = (s: string | undefined): EntityStatus => (s === "ACTIVE" ? "ACTIVE" : s === "DELETED" ? "REMOVED" : "PAUSED");

export class SnapchatConnector implements AdPlatformConnector {
  readonly platform = "SNAPCHAT" as const;

  constructor(private readonly config: SnapchatConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private mapError = (status: number, body: unknown) => {
    const b = body as { debug_message?: string; display_message?: string; error_description?: string };
    return new ConnectorError(codeFromStatus(status), b?.display_message ?? b?.debug_message ?? b?.error_description ?? `Snapchat API error (${status})`, body);
  };

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    const url = path.startsWith("http") ? path : `${API}${path}`;
    return requestJson<T>(url, { ...opts, headers: { Authorization: `Bearer ${auth.accessToken}`, ...opts.headers } }, this.mapError);
  }

  /** Follows `paging.next_link` (capped at MAX_PAGES like every list), collecting `key[].<entity>` objects. */
  private all(path: string, auth: ConnectorAuth, key: string, entity: string) {
    return allPages<Row, string>(
      path,
      async (next) => {
        const res: Row = await this.call<Row>(next, auth, next === path ? { query: { limit: 1000 } } : {});
        const items = ((res[key] ?? []) as Row[]).map((item) => item[entity]).filter(Boolean) as Row[];
        return { items, next: res.paging?.next_link as string | undefined };
      },
      `Snapchat ${key} list`,
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Snapchat app credentials are not configured.");
    const u = new URL("https://accounts.snapchat.com/login/oauth2/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", "snapchat-marketing-api");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await requestJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      "https://accounts.snapchat.com/login/oauth2/access_token",
      { method: "POST", form: true, body: { client_id: this.config.clientId!, client_secret: this.config.clientSecret!, ...body } },
      this.mapError,
    );
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
      scopes: res.scope ? [res.scope] : ["snapchat-marketing-api"],
    };
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ me: Row }>("/me", auth);
    return { id: String(res.me.id), name: res.me.display_name ?? res.me.email ?? "Snapchat user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ organizations?: { organization: Row }[] }>("/me/organizations", auth, {
      query: { with_ad_accounts: "true" },
    });
    return (res.organizations ?? []).flatMap(({ organization: org }) =>
      (org.ad_accounts ?? []).map((a: Row) => ({
        externalId: String(a.id),
        name: a.name,
        currency: a.currency,
        timezone: a.timezone ?? null,
        status: a.status ?? "ACTIVE",
        meta: { organizationId: org.id },
      })),
    );
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, squads, ads] = await Promise.all([
      this.all(`/adaccounts/${id}/campaigns`, auth, "campaigns", "campaign"),
      this.all(`/adaccounts/${id}/adsquads`, auth, "adsquads", "adsquad"),
      this.all(`/adaccounts/${id}/ads`, auth, "ads", "ad"),
    ]);
    const campaignOfSquad = new Map(squads.map((s) => [String(s.id), String(s.campaign_id)]));
    return {
      campaigns: campaigns.map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapSnapStatus(c.status),
        deliveryStatus: c.delivery_status?.[0] ?? null,
        objective: c.objective ?? null,
        dailyBudget: c.daily_budget_micro != null ? c.daily_budget_micro / MICRO : null,
        lifetimeBudget: c.lifetime_spend_cap_micro != null ? c.lifetime_spend_cap_micro / MICRO : null,
        startDate: c.start_time?.slice(0, 10) ?? null,
        endDate: c.end_time?.slice(0, 10) ?? null,
        updatedAt: c.updated_at ? new Date(c.updated_at) : null,
        raw: {},
      })),
      adGroups: squads.map((s) => ({
        externalId: String(s.id),
        campaignExternalId: String(s.campaign_id),
        name: s.name,
        status: mapSnapStatus(s.status),
        dailyBudget: s.daily_budget_micro != null ? s.daily_budget_micro / MICRO : null,
        bidStrategy: s.bid_strategy ?? null,
        targeting: null,
        raw: {},
      })),
      ads: ads
        .filter((a) => campaignOfSquad.has(String(a.ad_squad_id)))
        .map((a) => ({
          externalId: String(a.id),
          adGroupExternalId: String(a.ad_squad_id),
          campaignExternalId: campaignOfSquad.get(String(a.ad_squad_id))!,
          name: a.name,
          status: mapSnapStatus(a.status),
          headline: null,
          body: null,
          thumbnailUrl: null,
          finalUrl: null,
          raw: { creative_id: a.creative_id },
        })),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const levels: [MetricLevel, string][] = [
      ["CAMPAIGN", "campaign"],
      ["AD_GROUP", "adsquad"],
      ["AD", "ad"],
    ];
    // DAY stats must start and end at midnight in the ad account's timezone (measurement doc):
    // from local midnight of the first day to local midnight after the last one.
    const zone = builderZone(account);
    const [fy, fm, fd] = range.from.split("-").map(Number) as [number, number, number];
    const [ty, tm, td] = range.to.split("-").map(Number) as [number, number, number];
    const after = new Date(Date.UTC(ty, tm - 1, td + 1));
    const startTime = localIso(zonedTimeToUtc(fy, fm, fd, 0, 0, 0, zone), zone);
    const endTime = localIso(zonedTimeToUtc(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate(), 0, 0, 0, zone), zone);
    const out: ExternalMetricRow[] = [];
    for (const [level, breakdown] of levels) {
      const res = await this.call<Row>(`/adaccounts/${account.externalId}/stats`, auth, {
        query: {
          breakdown,
          granularity: "DAY",
          start_time: startTime,
          end_time: endTime,
          fields: "impressions,swipes,spend,conversion_purchases,conversion_purchases_value,video_views",
        },
      });
      for (const ts of res.timeseries_stats ?? []) {
        for (const entity of ts.timeseries_stat?.breakdown_stats?.[breakdown] ?? []) {
          for (const day of entity.timeseries ?? []) {
            const s = day.stats ?? {};
            out.push({
              date: String(day.start_time).slice(0, 10),
              level,
              externalId: String(entity.id),
              impressions: Number(s.impressions ?? 0),
              clicks: Number(s.swipes ?? 0),
              spend: Number(s.spend ?? 0) / MICRO,
              conversions: Number(s.conversion_purchases ?? 0),
              conversionValue: Number(s.conversion_purchases_value ?? 0) / MICRO,
              videoViews: Number(s.video_views ?? 0),
            });
          }
        }
      }
    }
    return out;
  }

  private async updateCampaign(auth: ConnectorAuth, account: AccountRef, campaignId: string, patch: Row) {
    const res = await this.call<{ campaigns: { campaign: Row }[] }>(`/campaigns/${campaignId}`, auth);
    const current = res.campaigns?.[0]?.campaign;
    if (!current) throw new ConnectorError("INVALID_REQUEST", "Campaign not found on Snapchat.");
    await this.call(`/adaccounts/${account.externalId}/campaigns`, auth, {
      method: "PUT",
      body: { campaigns: [{ ...current, ...patch }] },
    });
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.updateCampaign(auth, account, campaign.externalId, { status });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.updateCampaign(auth, account, campaign.externalId, { daily_budget_micro: Math.round(amount * MICRO) });
  }

  /** API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth): SnapApi {
    return {
      get: (path, query) => this.call(path, auth, { query }),
      post: (path, body) => this.call(path, auth, { method: "POST", body }),
      upload: async (path, form) => {
        const res = await fetch(`${API}${path}`, { method: "POST", headers: { Authorization: `Bearer ${auth.accessToken}` }, body: form, signal: AbortSignal.timeout(10 * 60_000) });
        const body = (await res.json().catch(() => null)) as Row | null;
        if (!res.ok) throw this.mapError(res.status, body);
        return body as never;
      },
      del: async (path) => {
        await this.call(path, auth, { method: "DELETE" });
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return snapBuilderOptions(this.builderApi(auth), account.externalId, account.meta?.organizationId as string | undefined);
  }

  searchTargeting(auth: ConnectorAuth, _account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return snapSearchTargeting(this.builderApi(auth), kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return snapCreateCampaign(this.builderApi(auth), account, draft, assets);
  }
}
