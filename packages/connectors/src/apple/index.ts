/**
 * Apple Search Ads Campaign Management API v5.
 * Client credentials, then one connection per organization.
 * Docs: https://developer.apple.com/documentation/apple_ads
 */
import { createPrivateKey, sign } from "node:crypto";
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, noRowsUnlessFatal } from "../errors";
import { allPages, requestJson, type RequestOptions } from "../http";
import { CLIENT_REFRESH, apiError, authHeader, formToken, mapStatus, requireCredentials, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens, PlatformCredentials } from "../types";
import { builderZone } from "../builder-values";
import { appleCreateCampaign, type AppleApi } from "./builder";

export interface AppleConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api.searchads.apple.com/api/v5";
type Row = Record<string, any>;

export class AppleAdsConnector implements AdPlatformConnector {
  readonly platform = "APPLE" as const;
  constructor(private readonly config: AppleConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Apple Ads credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, account: AccountRef | null, opts: RequestOptions = {}) {
    const headers = authHeader(auth.accessToken, opts.headers);
    if (account) headers["X-AP-Context"] = `orgId=${account.externalId}`;
    return requestJson<T>(`${API}${path}`, { ...opts, headers }, apiError("Apple Ads"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    return selfRedirect(redirectUri, state);
  }

  /**
   * Access token for the connection's own API user, or the operator's from
   * config (a pre-signed client secret) for the operator's own connection.
   */
  private async clientToken(credentials?: PlatformCredentials | null) {
    let clientId: string;
    let clientSecret: string;
    if (credentials) {
      const keys = requireCredentials(this.platform, credentials);
      clientId = keys.clientId!;
      clientSecret = appleClientSecret({ clientId, teamId: keys.teamId!, keyId: keys.keyId!, privateKey: keys.privateKey! });
    } else {
      this.assertConfigured();
      clientId = this.config.clientId!;
      clientSecret = this.config.clientSecret!;
    }
    return formToken("https://appleid.apple.com/auth/oauth2/token", {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "searchadsorg",
    }).then((t) => ({ ...t, refreshToken: CLIENT_REFRESH }));
  }

  exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    return this.clientToken();
  }

  /** Signs a fresh client secret on every refresh, so Apple's 180-day secret limit never runs out. */
  refreshTokens(_refreshToken: string, credentials?: PlatformCredentials | null) {
    return this.clientToken(credentials);
  }

  async connectWithCredentials(credentials: PlatformCredentials) {
    return this.clientToken(credentials);
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.call<{ data?: Row[] }>("/acls", auth, null);
    const first = res.data?.[0];
    return { id: String(first?.orgId ?? "apple"), name: first?.orgName ?? "Apple Search Ads" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.call<{ data?: Row[] }>("/acls", auth, null);
    return (res.data ?? []).map((o) => ({
      externalId: String(o.orgId),
      name: o.orgName ?? String(o.orgId),
      currency: o.currency ?? "USD",
      timezone: o.timeZone ?? null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const campaigns = await this.listAll("/campaigns", auth, account);
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of campaigns) {
      const cid = String(c.id);
      structure.campaigns.push({
        externalId: cid,
        name: c.name,
        status: mapStatus(c.status, ["ENABLED"]),
        deliveryStatus: c.servingStatus ?? null,
        objective: c.adChannelType ?? "SEARCH",
        dailyBudget: c.dailyBudgetAmount?.amount != null ? Number(c.dailyBudgetAmount.amount) : null,
        lifetimeBudget: c.budgetAmount?.amount != null ? Number(c.budgetAmount.amount) : null,
        startDate: c.startTime?.slice?.(0, 10) ?? null,
        endDate: c.endTime?.slice?.(0, 10) ?? null,
        updatedAt: null,
        raw: { adamId: c.adamId },
      });
      const groups = await this.listAll(`/campaigns/${cid}/adgroups`, auth, account);
      for (const g of groups) {
        structure.adGroups.push({
          externalId: String(g.id),
          campaignExternalId: cid,
          name: g.name,
          status: mapStatus(g.status, ["ENABLED"]),
          dailyBudget: null,
          bidStrategy: g.pricingModel ?? null,
          targeting: null,
          raw: {},
        });
        // Ads are optional here: campaign types without ad variations answer 4xx, and ads are not
        // removed by a sync, so a missing list only leaves them as last seen. Auth/rate limits still throw.
        const ads = await this.listAll(`/campaigns/${cid}/adgroups/${g.id}/ads`, auth, account).catch(noRowsUnlessFatal<Row>);
        for (const a of ads) {
          structure.ads.push({
            externalId: String(a.id),
            adGroupExternalId: String(g.id),
            campaignExternalId: cid,
            name: a.name ?? `Ad ${a.id}`,
            status: mapStatus(a.status, ["ENABLED"]),
            headline: a.creativeType ?? null,
            body: null,
            thumbnailUrl: null,
            finalUrl: null,
            raw: { creativeType: a.creativeType },
          });
        }
      }
    }
    return structure;
  }

  /** v5 lists page with offset/limit and report pagination.totalResults. */
  private listAll(path: string, auth: ConnectorAuth, account: AccountRef) {
    const limit = 1000;
    return allPages<Row, number>(0, async (offset) => {
      const res = await this.call<{ data?: Row[]; pagination?: { totalResults?: number } }>(path, auth, account, { query: { offset, limit } });
      const rows = res.data ?? [];
      const total = Number(res.pagination?.totalResults ?? 0);
      const next = offset + rows.length;
      return { items: rows, next: total ? (next < total ? next : null) : rows.length === limit ? next : null };
    }, "Apple Ads list");
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }): Promise<ExternalMetricRow[]> {
    const res = await this.call<{ data?: { reportingDataResponse?: { row?: Row[] } } }>("/reports/campaigns", auth, account, {
      method: "POST",
      body: {
        startTime: range.from,
        endTime: range.to,
        granularity: "DAILY",
        selector: { pagination: { offset: 0, limit: 1000 } },
        returnRowTotals: false,
        returnGrandTotals: false,
      },
    }).catch((err) => ({ data: { reportingDataResponse: { row: noRowsUnlessFatal<Row>(err) } } }));
    const rows = res.data?.reportingDataResponse?.row ?? [];
    const out: ExternalMetricRow[] = [];
    for (const row of rows) {
      const id = String(row.metadata?.campaignId);
      for (const g of row.granularity ?? []) {
        out.push({
          date: String(g.date).slice(0, 10),
          level: "CAMPAIGN",
          externalId: id,
          impressions: Number(g.impressions ?? 0),
          clicks: Number(g.taps ?? 0),
          spend: Number(g.localSpend?.amount ?? 0),
          // v5 SpendRow: totalInstalls = tapInstalls + viewInstalls (there is no plain `installs`).
          conversions: Number(g.totalInstalls ?? Number(g.tapInstalls ?? 0) + Number(g.viewInstalls ?? 0)),
          conversionValue: 0,
          videoViews: 0,
        });
      }
    }
    return out;
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.call(`/campaigns/${campaign.externalId}`, auth, account, { method: "PUT", body: { campaign: { status: status === "ACTIVE" ? "ENABLED" : "PAUSED" } } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    await this.call(`/campaigns/${campaign.externalId}`, auth, account, { method: "PUT", body: { campaign: { dailyBudgetAmount: { amount: String(amount), currency: account.currency ?? "USD" } } } });
  }

  private api(auth: ConnectorAuth, account: AccountRef): AppleApi {
    return {
      send: (path, body) => this.call(path, auth, account, { method: "POST", body }),
      put: (path, body) => this.call(path, auth, account, { method: "PUT", body }),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return appleCreateCampaign(this.api(auth, account), draft, account.currency, assets, builderZone(account));
  }
}

/** Apple accepts client secrets valid for up to 180 days; ours are signed per token request, so one hour is plenty. */
const CLIENT_SECRET_TTL_S = 60 * 60;

/**
 * The ES256 JWT Apple takes as client_secret, signed with the API user's private key.
 * Docs: https://developer.apple.com/documentation/apple_ads/implementing-oauth-for-the-apple-search-ads-api
 */
export function appleClientSecret(keys: { clientId: string; teamId: string; keyId: string; privateKey: string }, now = Date.now()) {
  let key;
  try {
    // A key pasted from a .env file may carry literal "\n" instead of line breaks.
    key = createPrivateKey(keys.privateKey.replace(/\\n/g, "\n"));
  } catch {
    throw new ConnectorError("INVALID_REQUEST", "The Apple Ads private key isn't a valid PEM key. Paste the whole file, including the BEGIN and END lines.");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new ConnectorError("INVALID_REQUEST", "The Apple Ads private key must be an ES256 (P-256) key, as created with openssl ecparam -name prime256v1.");
  }
  const iat = Math.floor(now / 1000);
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${part({ alg: "ES256", kid: keys.keyId })}.${part({ sub: keys.clientId, aud: "https://appleid.apple.com", iat, exp: iat + CLIENT_SECRET_TTL_S, iss: keys.teamId })}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${input}.${signature}`;
}
