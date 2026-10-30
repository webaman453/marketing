/**
 * Amazon Ads. Login with Amazon, then an advertising profile.
 * Sponsored Products, Brands and Display. DSP is not included.
 * Docs: https://advertising.amazon.com/API/docs/en-us
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { allPages, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { builderZone } from "../builder-values";
import { amazonCreateCampaign, createdIds, sdIds, type AmazonApi } from "./builder";

export interface AmazonConfig {
  clientId?: string;
  clientSecret?: string;
}

const SB = "application/vnd.sbcampaignresource.v4+json";
const SP = "application/vnd.spCampaign.v3+json";
const REGIONS = ["https://advertising-api.amazon.com", "https://advertising-api-eu.amazon.com", "https://advertising-api-fe.amazon.com"];
type Row = Record<string, any>;

export class AmazonAdsConnector implements AdPlatformConnector {
  readonly platform = "AMAZON" as const;
  constructor(private readonly config: AmazonConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Amazon Ads credentials are not configured.");
  }

  private call<T>(host: string, path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return amazonRequest<T>(
      `${host}${path}`,
      {
        ...opts,
        headers: authHeader(auth.accessToken, {
          "Amazon-Advertising-API-ClientId": this.config.clientId!,
          ...opts.headers,
        }),
      },
      apiError("Amazon Ads"),
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const u = new URL("https://www.amazon.com/ap/oa");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("scope", "advertising::campaign_management");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    this.assertConfigured();
    return formToken("https://api.amazon.com/auth/o2/token", {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
  }

  refreshTokens(refreshToken: string) {
    this.assertConfigured();
    return formToken("https://api.amazon.com/auth/o2/token", {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
    });
  }

  async getUser(auth: ConnectorAuth) {
    const profiles = await this.profiles(auth);
    const first = profiles[0];
    return { id: String(first?.accountInfo?.id ?? first?.profileId ?? "amazon"), name: first?.accountInfo?.name ?? "Amazon Ads" };
  }

  /** Profiles from every region. A region the login has no access to fails alone; all failing is an error. */
  private async profiles(auth: ConnectorAuth): Promise<(Row & { host: string })[]> {
    const out: (Row & { host: string })[] = [];
    const errors: unknown[] = [];
    for (const host of REGIONS) {
      try {
        const rows = await this.call<Row[]>(host, "/v2/profiles", auth);
        for (const row of rows ?? []) out.push({ ...row, host });
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === REGIONS.length) throw errors[0];
    return out;
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const profiles = await this.profiles(auth);
    return profiles.map((p) => ({
      externalId: String(p.profileId),
      name: [p.accountInfo?.name, p.countryCode].filter(Boolean).join(" · ") || String(p.profileId),
      currency: p.currencyCode ?? "USD",
      timezone: p.timezone ?? null,
      status: "ACTIVE",
      meta: { host: p.host, country: p.countryCode },
    }));
  }

  private hostOf(account: AccountRef) {
    return String(account.meta?.host ?? REGIONS[0]);
  }

  private scope(account: AccountRef) {
    return { "Amazon-Advertising-API-Scope": account.externalId };
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const host = this.hostOf(account);
    const headers = this.scope(account);
    const [sp, sb, sd] = await Promise.all([
      this.listSp(host, auth, headers),
      this.optionalProduct(this.listByToken(host, auth, "/sb/v4/campaigns/list", SB, headers, "campaigns")),
      this.optionalProduct(this.listSd(host, auth, headers)),
    ]);
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of sp.campaigns) pushCampaign(structure, c, "SPONSORED_PRODUCTS", c.budget?.budget, c.budget?.budgetType);
    for (const g of sp.groups) pushGroup(structure, g, g.campaignId);
    for (const a of sp.ads) pushAd(structure, a, a.adGroupId, a.campaignId, a.asin);
    for (const c of sb) pushCampaign(structure, c, "SPONSORED_BRANDS", c.budget, c.budgetType);
    for (const c of sd) pushCampaign(structure, c, "SPONSORED_DISPLAY", c.budget, c.budgetType);
    return structure;
  }

  /**
   * Sponsored Brands needs Brand Registry and Sponsored Display is not offered in
   * every marketplace; such profiles get 403 for that product and have no campaigns
   * of it. Anything else (expired login, rate limit, outage) still fails the sync.
   */
  private optionalProduct(list: Promise<Row[]>) {
    return list.catch((err) => {
      if (err instanceof ConnectorError && err.code === "PERMISSION_DENIED") return [] as Row[];
      throw err;
    });
  }

  /** SP v3 / SB v4 list calls page with nextToken. */
  private listByToken(host: string, auth: ConnectorAuth, path: string, accept: string, scope: Record<string, string>, key: string) {
    return allPages<Row, string | undefined>(undefined, async (nextToken) => {
      const res = await this.call<Row>(host, path, auth, { method: "POST", headers: { ...scope, Accept: accept, "Content-Type": accept }, body: { maxResults: 100, nextToken } });
      return { items: (res?.[key] as Row[] | undefined) ?? [], next: res?.nextToken };
    }, `Amazon ${key} list`);
  }

  /** Sponsored Display (v3) pages with startIndex/count. */
  private listSd(host: string, auth: ConnectorAuth, headers: Record<string, string>) {
    const count = 100;
    return allPages<Row, number>(0, async (startIndex) => {
      const rows = (await this.call<Row[]>(host, "/sd/campaigns", auth, { headers, query: { startIndex, count } })) ?? [];
      return { items: rows, next: rows.length < count ? null : startIndex + count };
    }, "Amazon Sponsored Display campaign list");
  }

  private async listSp(host: string, auth: ConnectorAuth, scope: Record<string, string>) {
    const [campaigns, groups, ads] = await Promise.all([
      this.listByToken(host, auth, "/sp/campaigns/list", SP, scope, "campaigns"),
      this.listByToken(host, auth, "/sp/adGroups/list", "application/vnd.spAdGroup.v3+json", scope, "adGroups"),
      this.listByToken(host, auth, "/sp/productAds/list", "application/vnd.spProductAd.v3+json", scope, "productAds"),
    ]);
    return { campaigns, groups, ads };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    // Amazon's reporting API is asynchronous and often not ready in one sync.
    // Structure still lands; a later sync can be extended to poll report ids.
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string; raw?: Record<string, unknown> | null }, status: "ACTIVE" | "PAUSED") {
    const state = status === "ACTIVE" ? "ENABLED" : "PAUSED";
    await this.updateCampaign(auth, account, campaign, { state }, { state: state.toLowerCase() }, "Campaign status");
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string; raw?: Record<string, unknown> | null }, amount: number) {
    // SP v3 nests the budget with its type; SB v4 and SD v3 take a flat amount (their budget type is fixed at creation).
    const product = String(campaign.raw?.product ?? "");
    const fields = product === "SPONSORED_BRANDS" ? { budget: amount } : { budget: { budgetType: "DAILY", budget: amount } };
    await this.updateCampaign(auth, account, campaign, fields, { budget: amount }, "Campaign budget");
  }

  /**
   * PUTs one campaign update to its product's endpoint. SP v3 / SB v4 answer 207 multi-status
   * and SD v3 an array of `{ code }`: an item error there is a failed update, not a success.
   */
  private async updateCampaign(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string; raw?: Record<string, unknown> | null }, fields: Row, sdFields: Row, what: string) {
    const host = this.hostOf(account);
    const headers = this.scope(account);
    const product = String(campaign.raw?.product ?? "");
    if (product === "SPONSORED_DISPLAY") {
      const res = await this.call<Row[]>(host, "/sd/campaigns", auth, { method: "PUT", headers, body: [{ campaignId: Number(campaign.externalId), ...sdFields }] });
      sdIds(res, "campaignId", what);
      return;
    }
    const type = product === "SPONSORED_BRANDS" ? SB : SP;
    const path = product === "SPONSORED_BRANDS" ? "/sb/v4/campaigns" : "/sp/campaigns";
    const res = await this.call<Row>(host, path, auth, { method: "PUT", headers: { ...headers, Accept: type, "Content-Type": type }, body: { campaigns: [{ campaignId: campaign.externalId, ...fields }] } });
    createdIds(res, "campaigns", what);
  }

  private api(auth: ConnectorAuth, account: AccountRef): AmazonApi {
    const host = this.hostOf(account);
    const headers = this.scope(account);
    return {
      send: (path, method, body, accept) =>
        this.call(host, path, auth, { method, headers: { ...headers, ...(accept ? { Accept: accept, "Content-Type": accept } : {}) }, body }),
    };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return amazonCreateCampaign(this.api(auth, account), draft, assets, builderZone(account));
  }
}

/** SB v4 / SD v3 campaigns carry `budgetType` DAILY or LIFETIME (SD spells it in lower case). */
function pushCampaign(structure: AccountStructure, c: Row, product: string, budget: unknown, budgetType: unknown) {
  const amount = typeof budget === "number" ? budget : null;
  const lifetime = String(budgetType ?? "DAILY").toUpperCase() === "LIFETIME";
  structure.campaigns.push({
    externalId: String(c.campaignId ?? c.id),
    name: c.name,
    status: mapStatus(c.state),
    deliveryStatus: c.servingStatus ?? null,
    objective: product,
    dailyBudget: lifetime ? null : amount,
    lifetimeBudget: lifetime ? amount : null,
    startDate: c.startDate ?? null,
    endDate: c.endDate ?? null,
    updatedAt: null,
    raw: { product },
  });
}

function pushGroup(structure: AccountStructure, g: Row, campaignId: unknown) {
  structure.adGroups.push({
    externalId: String(g.adGroupId ?? g.id),
    campaignExternalId: String(campaignId),
    name: g.name,
    status: mapStatus(g.state),
    // Amazon ad groups have no budget; defaultBid is the per-click bid for their targets.
    dailyBudget: null,
    bidStrategy: null,
    targeting: null,
    raw: g.defaultBid != null ? { defaultBid: g.defaultBid } : {},
  });
}

function pushAd(structure: AccountStructure, a: Row, groupId: unknown, campaignId: unknown, label: unknown) {
  structure.ads.push({
    externalId: String(a.adId ?? a.id),
    adGroupExternalId: String(groupId),
    campaignExternalId: String(campaignId),
    name: a.name ?? String(label ?? a.adId),
    status: mapStatus(a.state),
    headline: null,
    body: null,
    thumbnailUrl: null,
    finalUrl: null,
    raw: { asin: a.asin, sku: a.sku },
  });
}

/**
 * requestJson for Amazon: SP v3 and SB v4 need their versioned media type in Content-Type
 * as well as Accept (else 415), and the shared helper always sends application/json for a
 * JSON body. A Content-Type passed in `opts.headers` is kept here.
 */
async function amazonRequest<T>(url: string, opts: RequestOptions, mapError: (status: number, body: unknown) => ConnectorError): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) u.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(u, { method: opts.method ?? "GET", headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch (err) {
    throw new ConnectorError("PLATFORM_ERROR", `Network error calling ${u.hostname}`, String(err));
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw mapError(res.status, json);
  return json as T;
}
