/**
 * X Ads (Twitter) API. Every call is signed with OAuth 1.0a (HMAC-SHA1): the Ads API
 * takes no OAuth 2.0 tokens. Connect is the 3-legged flow: request token → authorize → access token.
 * Docs: https://docs.x.com/x-ads-api/fundamentals/making-authenticated-requests
 */
import type { BuilderDraft, BuilderOptions, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, noRowsUnlessFatal } from "../errors";
import { allPages, requestJson } from "../http";
import { apiError, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { ADS, assertPromotedOnly, xCreateCampaign, type XApi } from "./builder";
import { encodeParams, oauthHeader, packToken, unpackToken, type XToken } from "./oauth1";

export interface XConfig {
  /** The app's API key and secret (OAuth 1.0a consumer key/secret). */
  consumerKey?: string;
  consumerSecret?: string;
}

const OAUTH = "https://api.x.com/oauth";
type Row = Record<string, any>;
type Params = Record<string, string | number | boolean | undefined>;

interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Sent in the query string, as X's own examples do, so every parameter is signed. */
  query?: Params;
  /** A JSON body (v2 media upload); JSON bodies are not part of the signature. */
  json?: unknown;
}

export class XAdsConnector implements AdPlatformConnector {
  readonly platform = "X" as const;
  constructor(private readonly config: XConfig) {}

  isConfigured() {
    return Boolean(this.config.consumerKey && this.config.consumerSecret);
  }

  private keys() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "X Ads credentials are not configured.");
    return { consumerKey: this.config.consumerKey!, consumerSecret: this.config.consumerSecret! };
  }

  /** One signed request. `token` is the user's (or, during Connect, the request token). */
  private signed<T>(url: string, token: { token?: string; secret?: string }, opts: CallOptions & { oauth?: Record<string, string> } = {}) {
    const method = opts.method ?? "GET";
    const qs = encodeParams(opts.query ?? {});
    const full = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
    const Authorization = oauthHeader({ method, url: full, ...this.keys(), token: token.token, tokenSecret: token.secret, oauth: opts.oauth });
    return requestJson<T>(full, { method, body: opts.json, headers: { Authorization } }, apiError("X Ads"));
  }

  private async call<T>(url: string, auth: ConnectorAuth, opts: CallOptions = {}): Promise<T> {
    assertPromotedOnly(url, opts.query ?? {});
    return this.signed<T>(url, unpackToken(auth.accessToken), opts);
  }

  /** X connects with OAuth 1.0a, which needs a request token first: see startOAuth1. */
  getAuthUrl(): string {
    throw new ConnectorError("UNSUPPORTED", "X connects with OAuth 1.0a: start with a request token.");
  }

  async startOAuth1({ redirectUri }: { redirectUri: string }) {
    const res = form(await this.signed<string>(`${OAUTH}/request_token`, {}, { method: "POST", oauth: { oauth_callback: redirectUri } }));
    const token = res.get("oauth_token");
    const secret = res.get("oauth_token_secret");
    if (!token || !secret || res.get("oauth_callback_confirmed") !== "true") {
      throw new ConnectorError("PLATFORM_ERROR", "X did not issue a request token. Check that the redirect URL is registered as a callback URL on the X app.");
    }
    return { url: `${OAUTH}/authorize?oauth_token=${encodeURIComponent(token)}`, requestToken: token, requestSecret: secret };
  }

  /** `code` is the oauth_verifier; the request token comes back as `oauth_token`. */
  async exchangeCode({ code, query, requestSecret }: { code: string; redirectUri: string; query?: Record<string, unknown>; requestSecret?: string }): Promise<OAuthTokens> {
    const requestToken = typeof query?.oauth_token === "string" ? query.oauth_token : "";
    if (!requestToken || !requestSecret) throw new ConnectorError("INVALID_REQUEST", "The X sign-in is missing its request token. Please try again.");
    const res = form(await this.signed<string>(`${OAUTH}/access_token`, { token: requestToken, secret: requestSecret }, { method: "POST", oauth: { oauth_verifier: code } }));
    const token = res.get("oauth_token");
    const secret = res.get("oauth_token_secret");
    if (!token || !secret) throw new ConnectorError("PLATFORM_ERROR", "X did not return an access token.");
    const user: XToken = { token, secret, userId: res.get("user_id") ?? undefined, screenName: res.get("screen_name") ?? undefined };
    // OAuth 1.0a user tokens do not expire, so there is nothing to refresh.
    return { accessToken: packToken(user), scopes: [] };
  }

  refreshTokens() {
    return Promise.resolve(null);
  }

  async getUser(auth: ConnectorAuth) {
    const t = unpackToken(auth.accessToken);
    if (t.userId) return { id: t.userId, name: t.screenName ? `@${t.screenName}` : t.userId };
    const me = await this.call<{ data?: Row }>("https://api.x.com/2/users/me", auth);
    return { id: String(me.data?.id ?? "x"), name: me.data?.name ?? me.data?.username ?? "X user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    // GET /accounts pages with cursor → next_cursor like every other Ads API list.
    const accounts = await this.listAll(`${ADS}/accounts`, auth);
    return accounts.map((a) => ({
      externalId: String(a.id),
      name: a.name ?? String(a.id),
      currency: a.currency ?? "USD",
      timezone: a.timezone ?? null,
      status: a.approval_status === "ACCEPTED" ? "ACTIVE" : a.approval_status ?? "ACTIVE",
      meta: { timezone: a.timezone ?? null },
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [campaigns, lines, promoted] = await Promise.all([
      this.listAll(`${ADS}/accounts/${id}/campaigns`, auth),
      this.listAll(`${ADS}/accounts/${id}/line_items`, auth),
      this.listAll(`${ADS}/accounts/${id}/promoted_tweets`, auth),
    ]);
    return {
      campaigns: campaigns.map((c) => ({
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
      adGroups: lines.map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.campaign_id),
        name: g.name,
        status: mapStatus(g.entity_status),
        dailyBudget: g.daily_budget_amount_local_micro != null ? Number(g.daily_budget_amount_local_micro) / 1_000_000 : null,
        bidStrategy: g.bid_type ?? null,
        targeting: null,
        raw: {},
      })),
      ads: promoted.map((a) => ({
        externalId: String(a.id),
        adGroupExternalId: String(a.line_item_id),
        campaignExternalId: String(lines.find((g) => g.id === a.line_item_id)?.campaign_id ?? ""),
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

  /** X lists page with cursor → next_cursor. */
  private listAll(url: string, auth: ConnectorAuth) {
    return allPages<Row, string | undefined>(undefined, async (cursor) => {
      const res = await this.call<{ data?: Row[]; next_cursor?: string | null }>(url, auth, { query: { count: 1000, cursor } });
      return { items: res.data ?? [], next: res.next_cursor };
    }, "X Ads list");
  }

  /**
   * Daily stats per campaign. The synchronous stats endpoint takes at most 20
   * entity ids and 7 days per call, and DAY granularity needs start/end at
   * midnight in the ad account's timezone, with an exclusive end.
   */
  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    const ids = (await this.listAll(`${ADS}/accounts/${account.externalId}/campaigns`, auth)).map((c) => String(c.id));
    const tz = account.timezone || String(account.meta?.timezone ?? "") || "UTC";
    const out: ExternalMetricRow[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      for (let from = range.from; from <= range.to; from = addDay(from, 7)) {
        const last = minDay(addDay(from, 6), range.to);
        const res = await this.call<{ data?: Row[] }>(`${ADS}/stats/accounts/${account.externalId}`, auth, {
          query: {
            entity: "CAMPAIGN",
            entity_ids: batch.join(","),
            start_time: midnightIn(from, tz),
            end_time: midnightIn(addDay(last, 1), tz),
            granularity: "DAY",
            metric_groups: "ENGAGEMENT,BILLING,VIDEO",
            placement: "ALL_ON_TWITTER",
          },
        }).catch((err) => ({ data: noRowsUnlessFatal<Row>(err) }));
        for (const row of res.data ?? []) {
          const metrics = row.id_data?.[0]?.metrics ?? {};
          const length = Math.max(...["impressions", "clicks", "billed_charge_local_micro", "video_total_views"].map((k) => (Array.isArray(metrics[k]) ? metrics[k].length : 0)));
          for (let d = 0; d < length; d++) {
            out.push({
              date: addDay(from, d),
              level: "CAMPAIGN",
              externalId: String(row.id),
              impressions: Number(metrics.impressions?.[d] ?? 0),
              clicks: Number(metrics.clicks?.[d] ?? 0),
              spend: Number(metrics.billed_charge_local_micro?.[d] ?? 0) / 1_000_000,
              conversions: 0,
              conversionValue: 0,
              videoViews: Number(metrics.video_total_views?.[d] ?? 0),
            });
          }
        }
      }
    }
    return out;
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`${ADS}/accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, {
      method: "PUT",
      query: { entity_status: status === "ACTIVE" ? "ACTIVE" : "PAUSED" },
    });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`${ADS}/accounts/${account.externalId}/campaigns/${campaign.externalId}`, auth, {
      method: "PUT",
      query: { daily_budget_amount_local_micro: Math.round(amount * 1_000_000) },
    });
  }

  /** Exposed for tests: every write the builder makes goes through here. */
  api(auth: ConnectorAuth): XApi {
    return {
      get: (url, query) => this.call(url, auth, { query }),
      post: (url, query) => this.call(url, auth, { method: "POST", query }),
      postJson: (url, json) => this.call(url, auth, { method: "POST", json }),
      del: (url) => this.call(url, auth, { method: "DELETE" }),
      userId: unpackToken(auth.accessToken).userId,
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

/** The OAuth endpoints answer form-encoded text, not JSON. */
function form(body: unknown) {
  return new URLSearchParams(typeof body === "string" ? body : "");
}

function addDay(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const minDay = (a: string, b: string) => (a < b ? a : b);

/** Offset of `tz` from UTC at instant `t`, in ms. */
function tzOffset(t: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!) - t;
}

/**
 * Midnight of `day` in `tz` as a UTC timestamp (e.g. 2026-10-01 in Asia/Kolkata →
 * 2026-09-30T18:30:00Z). Falls back to UTC for an unknown zone.
 * RISK: X asks for whole hours; zones with a :30/:45 offset may be rejected.
 */
export function midnightIn(day: string, tz: string) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  let t = guess;
  try {
    t = guess - tzOffset(guess, tz);
    t = guess - tzOffset(t, tz); // second pass lands DST-change days correctly
  } catch {
    t = guess;
  }
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}
