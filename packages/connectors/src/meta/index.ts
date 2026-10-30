/**
 * Meta (Facebook / Instagram) Marketing API connector.
 * Docs: https://developers.facebook.com/docs/marketing-apis
 *
 * Required app permissions: ads_management, ads_read, business_management.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { codeFromStatus, MAX_PAGES, requestJson, ZERO_DECIMAL_CURRENCIES, type RequestOptions } from "../http";
import { metaFetchAdMedia } from "./media";
import { metaFetchLeads } from "./leads";
import { metaBuilderOptions, metaCreateCampaign, metaSearchTargeting, type MetaApi } from "./builder";
import type {
  AccountBilling,
  AccountRef,
  AccountStructure,
  AdPlatformConnector,
  BuilderAsset,
  ConnectorAuth,
  ExternalAd,
  ExternalAdAccount,
  ExternalAdGroup,
  ExternalCampaign,
  ExternalMetricRow,
  MetricLevel,
  OAuthTokens,
} from "../types";

export interface MetaConfig {
  appId?: string;
  appSecret?: string;
  apiVersion: string;
}

/**
 * Permissions a new Meta app can grant without extra use cases.
 * `leads_retrieval` and `pages_manage_ads` are valid, but Facebook blocks the
 * login dialog for developers until those use cases are added on the app.
 * Instant Form leads stay off until the app has them.
 */
const SCOPES = [
  "ads_management",
  "ads_read",
  "business_management",
  "pages_read_engagement",
  "pages_show_list",
];

interface Paged<T> {
  data: T[];
  paging?: { next?: string };
}

interface MetaAction {
  action_type: string;
  value: string;
}

// Meta reports the same purchase under several action types; take the first
// one present so purchases are not double counted.
const PURCHASE_TYPES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

function pickAction(actions: MetaAction[] | undefined, types: string[]): number {
  if (!actions) return 0;
  for (const t of types) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function mapMetaStatus(status: string | undefined): EntityStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "ARCHIVED":
      return "ARCHIVED";
    case "DELETED":
      return "REMOVED";
    default:
      return "PAUSED";
  }
}

const ACCOUNT_STATUS: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
};

export class MetaConnector implements AdPlatformConnector {
  readonly platform = "META" as const;

  constructor(private readonly config: MetaConfig) {}

  private get graph() {
    return `https://graph.facebook.com/${this.config.apiVersion}`;
  }

  isConfigured() {
    return Boolean(this.config.appId && this.config.appSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ConnectorError("NOT_CONFIGURED", "Meta app credentials are not configured.");
    }
  }

  private call<T>(path: string, opts: RequestOptions = {}) {
    const url = path.startsWith("http") ? path : `${this.graph}${path}`;
    return requestJson<T>(url, opts, (status, body) => {
      const err = (body as { error?: { message?: string; code?: number; error_subcode?: number } })?.error;
      let code = codeFromStatus(status);
      // 190 = invalid/expired token, 4/17/32/613 = rate limiting, 10/200-299 = permissions
      if (err?.code === 190) code = "AUTH_EXPIRED";
      else if ([4, 17, 32, 613, 80004].includes(err?.code ?? -1)) code = "RATE_LIMITED";
      else if (err?.code === 10 || (err?.code && err.code >= 200 && err.code < 300)) code = "PERMISSION_DENIED";
      return new ConnectorError(code, err?.message ?? `Meta API error (${status})`, body);
    });
  }

  /**
   * Follows `paging.next` cursors until all pages are read, capped at MAX_PAGES like allPages
   * so a cursor that never ends fails the sync instead of reading forever.
   */
  private async all<T>(path: string, auth: ConnectorAuth, query: Record<string, string | number>) {
    const out: T[] = [];
    let page = await this.call<Paged<T>>(path, { query: { ...query, access_token: auth.accessToken } });
    out.push(...(page.data ?? []));
    for (let n = 1; page.paging?.next; n++) {
      if (n >= MAX_PAGES) {
        throw new ConnectorError("PLATFORM_ERROR", `The Meta list ${path} has more than ${MAX_PAGES} pages; stopped so a partial list is not saved as the whole account.`);
      }
      page = await this.call<Paged<T>>(page.paging.next);
      out.push(...(page.data ?? []));
    }
    return out;
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL(`https://www.facebook.com/${this.config.apiVersion}/dialog/oauth`);
    u.searchParams.set("client_id", this.config.appId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(","));
    return u.toString();
  }

  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<OAuthTokens> {
    this.assertConfigured();
    const short = await this.call<{ access_token: string }>("/oauth/access_token", {
      query: {
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        redirect_uri: redirectUri,
        code,
      },
    });
    // Swap the short-lived token (~1h) for a long-lived one (~60 days).
    const long = await this.call<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
      query: {
        grant_type: "fb_exchange_token",
        client_id: this.config.appId,
        client_secret: this.config.appSecret,
        fb_exchange_token: short.access_token,
      },
    });
    return {
      accessToken: long.access_token,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : undefined,
      scopes: SCOPES,
    };
  }

  async refreshTokens() {
    // Meta user tokens cannot be refreshed without the user; they must reconnect.
    return null;
  }

  async revokeAccess(token: string) {
    await this.call("/me/permissions", { method: "DELETE", query: { access_token: token } });
  }

  async getUser(auth: ConnectorAuth) {
    const me = await this.call<{ id: string; name: string }>("/me", {
      query: { fields: "id,name", access_token: auth.accessToken },
    });
    return { id: me.id, name: me.name };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const rows = await this.all<{
      account_id: string;
      name: string;
      currency: string;
      timezone_name?: string;
      account_status: number;
      business?: { id: string; name: string };
    }>("/me/adaccounts", auth, {
      fields: "account_id,name,currency,timezone_name,account_status,business{id,name}",
      limit: 200,
    });
    return rows.map((r) => ({
      externalId: r.account_id,
      name: r.name,
      currency: r.currency,
      timezone: r.timezone_name ?? null,
      status: ACCOUNT_STATUS[r.account_status] ?? String(r.account_status),
      meta: r.business ? { businessId: r.business.id, businessName: r.business.name } : undefined,
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef) {
    const act = `/act_${account.externalId}`;
    const currency = account.currency ?? "";
    const money = (v?: string) => (v ? fromMinor(Number(v), currency) : null);

    const [campaigns, adsets, ads] = await Promise.all([
      this.all<Record<string, string>>(`${act}/campaigns`, auth, {
        fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,updated_time,buying_type",
        limit: 500,
      }),
      this.all<Record<string, unknown>>(`${act}/adsets`, auth, {
        fields: "id,name,campaign_id,status,effective_status,daily_budget,bid_strategy,optimization_goal,targeting",
        limit: 500,
      }),
      this.all<Record<string, unknown>>(`${act}/ads`, auth, {
        fields: "id,name,adset_id,campaign_id,status,effective_status,creative{title,body,thumbnail_url,object_url,link_url}",
        limit: 500,
      }),
    ]);

    const structure: AccountStructure = {
      campaigns: campaigns.map(
        (c): ExternalCampaign => ({
          externalId: c.id!,
          name: c.name ?? "Untitled campaign",
          status: mapMetaStatus(c.status),
          deliveryStatus: c.effective_status ?? null,
          objective: c.objective ?? null,
          dailyBudget: money(c.daily_budget),
          lifetimeBudget: money(c.lifetime_budget),
          startDate: c.start_time?.slice(0, 10) ?? null,
          endDate: c.stop_time?.slice(0, 10) ?? null,
          updatedAt: c.updated_time ? new Date(c.updated_time) : null,
          raw: c,
        }),
      ),
      adGroups: adsets.map(
        (s): ExternalAdGroup => ({
          externalId: String(s.id),
          campaignExternalId: String(s.campaign_id),
          name: String(s.name ?? "Untitled ad set"),
          status: mapMetaStatus(s.status as string),
          dailyBudget: money(s.daily_budget as string | undefined),
          bidStrategy: (s.bid_strategy as string) ?? null,
          targeting: (s.targeting as Record<string, unknown>) ?? null,
          raw: { optimization_goal: s.optimization_goal, effective_status: s.effective_status },
        }),
      ),
      ads: ads.map((a): ExternalAd => {
        const creative = (a.creative ?? {}) as Record<string, string | undefined>;
        return {
          externalId: String(a.id),
          adGroupExternalId: String(a.adset_id),
          campaignExternalId: String(a.campaign_id),
          name: String(a.name ?? "Untitled ad"),
          status: mapMetaStatus(a.status as string),
          headline: creative.title ?? null,
          body: creative.body ?? null,
          thumbnailUrl: creative.thumbnail_url ?? null,
          finalUrl: creative.link_url ?? creative.object_url ?? null,
          raw: { effective_status: a.effective_status },
        };
      }),
    };
    return structure;
  }

  async fetchMetrics(
    auth: ConnectorAuth,
    account: { externalId: string },
    range: { from: string; to: string },
  ): Promise<ExternalMetricRow[]> {
    const levels: [MetricLevel, "campaign" | "adset" | "ad", string][] = [
      ["CAMPAIGN", "campaign", "campaign_id"],
      ["AD_GROUP", "adset", "adset_id"],
      ["AD", "ad", "ad_id"],
    ];
    const out: ExternalMetricRow[] = [];
    for (const [level, metaLevel, idField] of levels) {
      const rows = await this.all<Record<string, unknown>>(`/act_${account.externalId}/insights`, auth, {
        level: metaLevel,
        time_increment: 1,
        time_range: JSON.stringify({ since: range.from, until: range.to }),
        fields: `${idField},date_start,impressions,clicks,spend,actions,action_values`,
        limit: 500,
      });
      for (const r of rows) {
        const actions = r.actions as MetaAction[] | undefined;
        const values = r.action_values as MetaAction[] | undefined;
        out.push({
          date: String(r.date_start),
          level,
          externalId: String(r[idField]),
          impressions: Number(r.impressions ?? 0),
          clicks: Number(r.clicks ?? 0),
          spend: Number(r.spend ?? 0),
          conversions: pickAction(actions, PURCHASE_TYPES) + pickAction(actions, LEAD_TYPES),
          conversionValue: pickAction(values, PURCHASE_TYPES),
          videoViews: pickAction(actions, ["video_view"]),
        });
      }
    }
    return out;
  }

  fetchLeads(auth: ConnectorAuth, params: { since: Date | null }) {
    return metaFetchLeads(
      (path, token, query) => this.all<Record<string, any>>(path, { accessToken: token }, query),
      (path, token, query) => this.call<Record<string, any>>(path, { query: { ...query, access_token: token } }),
      auth.accessToken,
      params.since,
    );
  }

  fetchAdMedia(auth: ConnectorAuth, account: AccountRef, ad: { externalId: string }) {
    return metaFetchAdMedia(this.api(auth), account.externalId, ad.externalId);
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: unknown, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/${campaign.externalId}`, {
      method: "POST",
      form: true,
      body: { status, access_token: auth.accessToken },
    });
  }

  async setCampaignDailyBudget(
    auth: ConnectorAuth,
    account: { currency: string },
    campaign: { externalId: string; raw?: Record<string, unknown> | null },
    amount: number,
  ) {
    if (campaign.raw && !campaign.raw.daily_budget) {
      throw new ConnectorError(
        "UNSUPPORTED",
        "This campaign's budget is managed at the ad set level. Edit the ad set budgets instead.",
      );
    }
    await this.call(`/${campaign.externalId}`, {
      method: "POST",
      form: true,
      body: { daily_budget: String(toMinor(amount, account.currency)), access_token: auth.accessToken },
    });
  }

  /**
   * Spend cap, what is spent toward it and the unpaid balance. Graph returns these as
   * strings in the currency's minor unit (paise, cents); a spend_cap of "0" means no cap.
   * https://developers.facebook.com/docs/marketing-api/reference/ad-account/
   */
  async getBilling(auth: ConnectorAuth, account: AccountRef & { currency: string }): Promise<AccountBilling> {
    const r = await this.call<{
      spend_cap?: string;
      amount_spent?: string;
      balance?: string;
      account_status?: number;
      disable_reason?: number;
      currency?: string;
    }>(`/act_${account.externalId}`, {
      query: { fields: "spend_cap,amount_spent,balance,account_status,disable_reason,currency", access_token: auth.accessToken },
    });
    const currency = r.currency || account.currency;
    const money = (v?: string) => (v == null || v === "" ? null : fromMinor(Number(v), currency));
    const cap = money(r.spend_cap);
    const spendLimit = cap && cap > 0 ? cap : null;
    const spent = money(r.amount_spent);
    return {
      spendLimit,
      spentTowardLimit: spent,
      balanceDue: money(r.balance),
      fundsRemaining: null,
      ...metaBillingHealth(r.account_status, spendLimit, spent),
    };
  }

  /**
   * Sets the account spend cap, or removes it (null). Unlike the read, the write takes the
   * currency's basic unit (rupees, dollars); `spend_cap_action=delete` removes the cap.
   */
  async setSpendLimit(auth: ConnectorAuth, account: AccountRef & { currency: string }, amount: number | null) {
    const body: Record<string, string> =
      amount == null
        ? { spend_cap_action: "delete", access_token: auth.accessToken }
        : {
            spend_cap: ZERO_DECIMAL_CURRENCIES.has(account.currency) ? String(Math.round(amount)) : amount.toFixed(2),
            access_token: auth.accessToken,
          };
    await this.call(`/act_${account.externalId}`, { method: "POST", form: true, body });
  }

  /** Graph API calls used by the campaign builder. */
  private api(auth: ConnectorAuth): MetaApi {
    const token = auth.accessToken;
    return {
      get: (path, query = {}) => this.call(path, { query: { ...query, access_token: token } }),
      post: (path, body) => {
        const form: Record<string, string> = { access_token: token };
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined || v === null) continue;
          form[k] = typeof v === "string" ? v : JSON.stringify(v);
        }
        return this.call(path, { method: "POST", form: true, body: form });
      },
      upload: async (path, form, timeoutMs) => {
        form.set("access_token", token);
        const res = await fetch(`${this.graph}${path}`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs ?? 120_000) });
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        if (!res.ok) throw new ConnectorError(codeFromStatus(res.status), body?.error?.message ?? `Meta upload failed (${res.status})`, body);
        return body as never;
      },
      del: async (path) => {
        await this.call(path, { method: "DELETE", query: { access_token: token } });
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return metaBuilderOptions(this.api(auth), `/act_${account.externalId}`);
  }

  searchTargeting(auth: ConnectorAuth, _account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return metaSearchTargeting(this.api(auth), kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return metaCreateCampaign(this.api(auth), account, draft, assets);
  }
}

/** Billing health from account_status, and how close the account is to its spend cap. */
export function metaBillingHealth(status: number | undefined, spendLimit: number | null, spent: number | null): Pick<AccountBilling, "health" | "note"> {
  switch (status) {
    case 3:
    case 8:
      return { health: "blocked", note: "Payment failed. Ads stop until the balance is paid." };
    case 2:
      return { health: "blocked", note: "This ad account is disabled." };
    case 100:
    case 101:
      return { health: "blocked", note: "This ad account is closed." };
    case 9:
      return { health: "attention", note: "Payment overdue (grace period)." };
    case 7:
      return { health: "attention", note: "Meta is reviewing this account." };
  }
  if (spendLimit && spent != null) {
    const used = spent / spendLimit;
    if (used >= 1) return { health: "blocked", note: "Spending limit reached. Ads are paused until it's raised." };
    if (used >= 0.9) return { health: "attention", note: `${Math.floor(used * 100)}% of the spending limit used.` };
  }
  return status === 1 ? { health: "ok", note: null } : { health: "unknown", note: null };
}

/** Meta expresses budgets in the currency's minor unit (paise, cents). */
const fromMinor = (v: number, currency: string) => (ZERO_DECIMAL_CURRENCIES.has(currency) ? v : v / 100);
const toMinor = (v: number, currency: string) =>
  ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(v) : Math.round(v * 100);
