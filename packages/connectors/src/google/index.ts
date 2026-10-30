/**
 * Google Ads API connector (REST). Covers Search, Display, Shopping,
 * Performance Max and YouTube video campaigns.
 * Docs: https://developers.google.com/google-ads/api/rest/overview
 *
 * Access follows the Google Cloud project that owns the OAuth client
 * (scope https://www.googleapis.com/auth/adwords). Developer tokens were
 * sunset on 9 September 2026: a saved token is still sent, and ignored.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { googleBuilderOptions, googleCreateCampaign, googleSearchTargeting, type GoogleApi } from "./builder";
import { ConnectorError, expiredGrant } from "../errors";
import { allPages, codeFromStatus, requestJson, type RequestOptions } from "../http";
import type {
  AccountBilling,
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

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  apiVersion: string;
}

const SCOPES = ["https://www.googleapis.com/auth/adwords", "openid", "email", "profile"];

type Row = Record<string, any>;

export function mapGoogleStatus(status: string | undefined): EntityStatus {
  switch (status) {
    case "ENABLED":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "REMOVED":
      return "REMOVED";
    default:
      return "PAUSED";
  }
}

const micros = (v: unknown) => (v == null ? 0 : Number(v) / 1_000_000);


export class GoogleAdsConnector implements AdPlatformConnector {
  readonly platform = "GOOGLE" as const;

  constructor(private readonly config: GoogleConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ConnectorError("NOT_CONFIGURED", "Google Ads credentials are not configured.");
    }
  }

  private mapError = (status: number, body: unknown) => {
    const err = (Array.isArray(body) ? body[0] : body) as {
      error?: { message?: string; status?: string; details?: { errors?: { message?: string }[] }[] };
      error_description?: string;
    };
    const detail = err?.error?.details?.[0]?.errors?.[0]?.message;
    let code = codeFromStatus(status);
    if (err?.error?.status === "UNAUTHENTICATED") code = "AUTH_EXPIRED";
    if (err?.error?.status === "RESOURCE_EXHAUSTED") code = "RATE_LIMITED";
    return new ConnectorError(
      code,
      detail ?? err?.error?.message ?? err?.error_description ?? `Google Ads API error (${status})`,
      body,
    );
  };

  private ads<T>(path: string, auth: ConnectorAuth, opts: RequestOptions & { loginCustomerId?: string } = {}) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
    };
    // Optional. Google ignores this header and will reject it in a future API version.
    if (this.config.developerToken) headers["developer-token"] = this.config.developerToken;
    if (opts.loginCustomerId) headers["login-customer-id"] = opts.loginCustomerId;
    return requestJson<T>(
      `https://googleads.googleapis.com/${this.config.apiVersion}${path}`,
      { ...opts, headers: { ...headers, ...opts.headers } },
      this.mapError,
    );
  }

  /** Runs a GAQL query and follows page tokens (capped at MAX_PAGES, like every list). */
  private async search(auth: ConnectorAuth, account: AccountRef, query: string): Promise<Row[]> {
    const loginCustomerId = account.meta?.loginCustomerId as string | undefined;
    return allPages<Row, string | undefined>(
      undefined,
      async (pageToken) => {
        const res = await this.ads<{ results?: Row[]; nextPageToken?: string }>(
          `/customers/${account.externalId}/googleAds:search`,
          auth,
          { method: "POST", body: { query, pageToken }, loginCustomerId },
        );
        return { items: res.results ?? [], next: res.nextPageToken };
      },
      "Google Ads query",
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    this.assertConfigured();
    const res = await requestJson<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    }>(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        form: true,
        body: { client_id: this.config.clientId!, client_secret: this.config.clientSecret!, ...body },
      },
      this.mapError,
    );
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      expiresAt: new Date(Date.now() + res.expires_in * 1000),
      scopes: res.scope?.split(" ") ?? SCOPES,
    };
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  }

  refreshTokens(refreshToken: string) {
    // A revoked or expired refresh token is 400 invalid_grant: an expired login, not a bad request.
    return this.token({ refresh_token: refreshToken, grant_type: "refresh_token" }).catch(expiredGrant);
  }

  async revokeAccess(token: string) {
    await requestJson("https://oauth2.googleapis.com/revoke", { method: "POST", form: true, body: { token } }, this.mapError);
  }

  async getUser(auth: ConnectorAuth) {
    const info = await requestJson<{ sub: string; name?: string; email?: string }>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
      this.mapError,
    );
    return { id: info.sub, name: info.name ?? info.email ?? "Google user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const { resourceNames = [] } = await this.ads<{ resourceNames?: string[] }>(
      "/customers:listAccessibleCustomers",
      auth,
    );
    const byId = new Map<string, ExternalAdAccount>();

    for (const rn of resourceNames) {
      const rootId = rn.split("/")[1]!;
      let rows: Row[];
      try {
        // customer_client returns the account itself (level 0) plus, for
        // manager accounts, every client account underneath it.
        rows = await this.search(
          auth,
          { externalId: rootId },
          `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
                  customer_client.time_zone, customer_client.manager, customer_client.status, customer_client.level
           FROM customer_client
           WHERE customer_client.status = 'ENABLED'`,
        );
      } catch (err) {
        // Accounts that are cancelled or not yet set up reject queries (403/400); skip them.
        // Expired logins, rate limits and outages still throw so no account is silently dropped.
        if (err instanceof ConnectorError && (err.code === "PERMISSION_DENIED" || err.code === "INVALID_REQUEST")) continue;
        throw err;
      }
      for (const r of rows) {
        const c = r.customerClient;
        if (!c || c.manager) continue; // manager accounts hold no campaigns
        const id = String(c.id);
        if (byId.has(id)) continue;
        byId.set(id, {
          externalId: id,
          name: c.descriptiveName || `Google Ads ${id}`,
          currency: c.currencyCode,
          timezone: c.timeZone ?? null,
          status: c.status ?? "ENABLED",
          meta: id === rootId ? {} : { loginCustomerId: rootId },
        });
      }
    }
    return [...byId.values()];
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const [campaigns, adGroups, ads] = await Promise.all([
      this.search(
        auth,
        account,
        `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status,
                campaign.primary_status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
                campaign_budget.resource_name, campaign_budget.amount_micros,
                campaign_budget.total_amount_micros, campaign_budget.explicitly_shared
         FROM campaign WHERE campaign.status != 'REMOVED'`,
      ),
      this.search(
        auth,
        account,
        `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id
         FROM ad_group WHERE ad_group.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
      ),
      this.search(
        auth,
        account,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status,
                ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines,
                ad_group_ad.ad.responsive_search_ad.descriptions, ad_group.id, campaign.id
         FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED'`,
      ),
    ]);

    return {
      campaigns: campaigns.map((r) => {
        const c = r.campaign;
        const b = r.campaignBudget ?? {};
        return {
          externalId: String(c.id),
          name: c.name,
          status: mapGoogleStatus(c.status),
          deliveryStatus: c.primaryStatus ?? c.servingStatus ?? null,
          objective: c.advertisingChannelType ?? null,
          dailyBudget: b.amountMicros != null ? micros(b.amountMicros) : null,
          lifetimeBudget: b.totalAmountMicros != null ? micros(b.totalAmountMicros) : null,
          startDate: null,
          endDate: null,
          updatedAt: null,
          raw: {
            channelType: c.advertisingChannelType,
            biddingStrategyType: c.biddingStrategyType,
            budgetResourceName: b.resourceName,
            budgetShared: Boolean(b.explicitlyShared),
          },
        };
      }),
      adGroups: adGroups.map((r) => ({
        externalId: String(r.adGroup.id),
        campaignExternalId: String(r.campaign.id),
        name: r.adGroup.name,
        status: mapGoogleStatus(r.adGroup.status),
        dailyBudget: null,
        bidStrategy: null,
        targeting: null,
        raw: { type: r.adGroup.type },
      })),
      ads: ads.map((r) => {
        const ad = r.adGroupAd.ad;
        const rsa = ad.responsiveSearchAd;
        return {
          externalId: `${r.adGroup.id}~${ad.id}`,
          adGroupExternalId: String(r.adGroup.id),
          campaignExternalId: String(r.campaign.id),
          name: ad.name || `${(ad.type ?? "Ad").replaceAll("_", " ").toLowerCase()} #${ad.id}`,
          status: mapGoogleStatus(r.adGroupAd.status),
          headline: rsa?.headlines?.[0]?.text ?? null,
          body: rsa?.descriptions?.[0]?.text ?? null,
          thumbnailUrl: null,
          finalUrl: ad.finalUrls?.[0] ?? null,
          raw: { type: ad.type },
        };
      }),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const levels: [MetricLevel, string, string, (r: Row) => string][] = [
      ["CAMPAIGN", "campaign", "campaign.id", (r) => String(r.campaign.id)],
      ["AD_GROUP", "ad_group", "ad_group.id", (r) => String(r.adGroup.id)],
      ["AD", "ad_group_ad", "ad_group.id, ad_group_ad.ad.id", (r) => `${r.adGroup.id}~${r.adGroupAd.ad.id}`],
    ];
    const out: ExternalMetricRow[] = [];
    for (const [level, resource, idFields, idOf] of levels) {
      const base = `SELECT ${idFields}, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros,
                           metrics.conversions, metrics.conversions_value`;
      const where = `FROM ${resource} WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`;
      const rows = await this.searchWithVideoViews(auth, account, base, where);
      for (const r of rows) {
        const m = r.metrics ?? {};
        out.push({
          date: r.segments.date,
          level,
          externalId: idOf(r),
          impressions: Number(m.impressions ?? 0),
          clicks: Number(m.clicks ?? 0),
          spend: micros(m.costMicros),
          conversions: Number(m.conversions ?? 0),
          conversionValue: Number(m.conversionsValue ?? 0),
          videoViews: Number(m.videoTrueviewViews ?? m.videoViews ?? 0),
        });
      }
    }
    return out;
  }

  /**
   * YouTube view metrics were renamed across API versions
   * (video_views → video_trueview_views). Try each, then fall back to none.
   */
  private async searchWithVideoViews(auth: ConnectorAuth, account: AccountRef, base: string, where: string) {
    for (const field of ["metrics.video_trueview_views", "metrics.video_views", null]) {
      try {
        return await this.search(auth, account, `${base}${field ? `, ${field}` : ""} ${where}`);
      } catch (err) {
        if (!(err instanceof ConnectorError) || err.code !== "INVALID_REQUEST" || field === null) throw err;
      }
    }
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.ads(`/customers/${account.externalId}/campaigns:mutate`, auth, {
      method: "POST",
      loginCustomerId: account.meta?.loginCustomerId as string | undefined,
      body: {
        operations: [
          {
            update: {
              resourceName: `customers/${account.externalId}/campaigns/${campaign.externalId}`,
              status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
            },
            updateMask: "status",
          },
        ],
      },
    });
  }

  async setCampaignDailyBudget(
    auth: ConnectorAuth,
    account: AccountRef,
    campaign: { externalId: string; raw?: Record<string, unknown> | null },
    amount: number,
  ) {
    const budget = campaign.raw?.budgetResourceName as string | undefined;
    if (!budget) throw new ConnectorError("UNSUPPORTED", "This campaign has no editable budget.");
    if (campaign.raw?.budgetShared) {
      throw new ConnectorError(
        "UNSUPPORTED",
        "This campaign uses a shared budget. Changing it here would affect other campaigns, so edit it in Google Ads.",
      );
    }
    await this.ads(`/customers/${account.externalId}/campaignBudgets:mutate`, auth, {
      method: "POST",
      loginCustomerId: account.meta?.loginCustomerId as string | undefined,
      body: {
        operations: [
          {
            // Budgets must be a multiple of the currency's minimum unit (0.01 → 10,000 micros).
            update: { resourceName: budget, amountMicros: String(Math.round(amount * 100) * 10_000) },
            updateMask: "amount_micros",
          },
        ],
      },
    });
  }

  /** The account's approved account budget, if it has one (only monthly-invoiced accounts do). */
  private async accountBudget(auth: ConnectorAuth, account: AccountRef) {
    const rows = await this.search(
      auth,
      account,
      `SELECT account_budget.resource_name, account_budget.status, account_budget.approved_spending_limit_micros,
              account_budget.approved_spending_limit_type, account_budget.amount_served_micros,
              account_budget.approved_end_date_time, account_budget.billing_setup
       FROM account_budget
       WHERE account_budget.status = 'APPROVED'`,
    );
    const now = Date.now();
    // An approved budget whose end has passed no longer limits spend; take the current one.
    const live = rows.map((r) => r.accountBudget).filter((b) => b && !(b.approvedEndDateTime && Date.parse(b.approvedEndDateTime.replace(" ", "T")) < now));
    return live[0] ?? null;
  }

  /**
   * Account budget (spending limit) and account status. Accounts paid by card have no
   * account budget: they report no limit and are fine unless suspended.
   * https://developers.google.com/google-ads/api/docs/billing/account-budgets
   */
  async getBilling(auth: ConnectorAuth, account: AccountRef & { currency: string }): Promise<AccountBilling> {
    const [customer, budget] = await Promise.all([
      this.search(auth, account, "SELECT customer.status FROM customer LIMIT 1").then((r) => r[0]?.customer),
      this.accountBudget(auth, account),
    ]);
    const infinite = budget?.approvedSpendingLimitType === "INFINITE";
    const spendLimit = budget && !infinite && budget.approvedSpendingLimitMicros != null ? micros(budget.approvedSpendingLimitMicros) : null;
    const spent = budget ? micros(budget.amountServedMicros) : null;
    const status = customer?.status as string | undefined;
    let health: AccountBilling["health"] = status === "ENABLED" ? "ok" : "unknown";
    let note: string | null = null;
    if (status === "SUSPENDED") [health, note] = ["blocked", "Google suspended this account. Check billing and policy in Google Ads."];
    else if (status === "CANCELED" || status === "CLOSED") [health, note] = ["blocked", "This Google Ads account is cancelled."];
    else if (spendLimit && spent != null) {
      const used = spent / spendLimit;
      if (used >= 1) [health, note] = ["blocked", "Account budget used up. Ads stop until it's raised."];
      else if (used >= 0.9) [health, note] = ["attention", `${Math.floor(used * 100)}% of the account budget used.`];
    }
    return { spendLimit, spentTowardLimit: spent, balanceDue: null, fundsRemaining: spendLimit != null && spent != null ? Math.max(0, spendLimit - spent) : null, health, note };
  }

  /**
   * Changes the approved account budget's spending limit with an UPDATE proposal (approved
   * straight away for accounts on monthly invoicing); null makes it unlimited.
   * https://developers.google.com/google-ads/api/rest/reference/rest/v21/customers.accountBudgetProposals/mutate
   */
  async setSpendLimit(auth: ConnectorAuth, account: AccountRef & { currency: string }, amount: number | null) {
    const budget = await this.accountBudget(auth, account);
    if (!budget?.resourceName) {
      throw new ConnectorError(
        "UNSUPPORTED",
        "This Google Ads account is paid by card, so it has no account budget. Use the monthly budget in Ashniva or campaign budgets instead.",
      );
    }
    await this.ads(`/customers/${account.externalId}/accountBudgetProposals:mutate`, auth, {
      method: "POST",
      loginCustomerId: account.meta?.loginCustomerId as string | undefined,
      body: {
        operation: {
          create: {
            proposalType: "UPDATE",
            accountBudget: budget.resourceName,
            // Limits are a multiple of the currency's minimum unit (0.01 → 10,000 micros).
            ...(amount == null
              ? { proposedSpendingLimitType: "INFINITE" }
              : { proposedSpendingLimitMicros: String(Math.round(amount * 100) * 10_000) }),
          },
        },
      },
    });
  }

  /** Google Ads API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth, account: AccountRef): GoogleApi {
    const loginCustomerId = account.meta?.loginCustomerId as string | undefined;
    return {
      search: (query) => this.search(auth, account, query),
      mutate: (mutateOperations) =>
        this.ads(`/customers/${account.externalId}/googleAds:mutate`, auth, { method: "POST", loginCustomerId, body: { mutateOperations }, timeoutMs: 180_000 }),
      suggestGeo: async (q) => {
        const res = await this.ads<{ geoTargetConstantSuggestions?: Row[] }>("/geoTargetConstants:suggest", auth, {
          method: "POST",
          loginCustomerId,
          body: { locale: "en", locationNames: { names: [q] } },
        });
        return res.geoTargetConstantSuggestions ?? [];
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return googleBuilderOptions(this.builderApi(auth, account));
  }

  searchTargeting(auth: ConnectorAuth, account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return googleSearchTargeting(this.builderApi(auth, account), kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return googleCreateCampaign(this.builderApi(auth, account), account, draft, assets);
  }
}
