/**
 * Amazon Ads. Login with Amazon, then an advertising profile.
 * Sponsored Products, Brands and Display. DSP is not included.
 * Docs: https://advertising.amazon.com/API/docs/en-us
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { requestJson, type RequestOptions } from "../http";
import { apiError, authHeader, formToken, mapStatus } from "../oauth-flow";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";
import { amazonCreateCampaign, type AmazonApi } from "./builder";

export interface AmazonConfig {
  clientId?: string;
  clientSecret?: string;
}

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
    return requestJson<T>(
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

  private async profiles(auth: ConnectorAuth): Promise<(Row & { host: string })[]> {
    const out: (Row & { host: string })[] = [];
    for (const host of REGIONS) {
      const rows = await this.call<Row[]>(host, "/v2/profiles", auth).catch(() => []);
      for (const row of rows ?? []) out.push({ ...row, host });
    }
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
      this.call<Row>(host, "/sb/v4/campaigns/list", auth, { method: "POST", headers: { ...headers, Accept: "application/vnd.sbcampaignresource.v4+json", "Content-Type": "application/vnd.sbcampaignresource.v4+json" }, body: {} }).catch(() => ({ campaigns: [] })),
      this.call<Row[]>(host, "/sd/campaigns", auth, { headers }).catch(() => []),
    ]);
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of sp.campaigns) pushCampaign(structure, c, "SPONSORED_PRODUCTS", c.budget?.budget);
    for (const g of sp.groups) pushGroup(structure, g, g.campaignId);
    for (const a of sp.ads) pushAd(structure, a, a.adGroupId, a.campaignId, a.asin);
    for (const c of sb.campaigns ?? []) pushCampaign(structure, c, "SPONSORED_BRANDS", c.budget);
    for (const c of sd ?? []) pushCampaign(structure, c, "SPONSORED_DISPLAY", c.budget);
    return structure;
  }

  private async listSp(host: string, auth: ConnectorAuth, scope: Record<string, string>) {
    const post = (path: string, accept: string) =>
      this.call<Row>(host, path, auth, { method: "POST", headers: { ...scope, Accept: accept, "Content-Type": accept }, body: { maxResults: 100 } }).catch(() => ({}) as Row);
    const [campaigns, groups, ads] = await Promise.all([
      post("/sp/campaigns/list", "application/vnd.spCampaign.v3+json"),
      post("/sp/adGroups/list", "application/vnd.spAdGroup.v3+json"),
      post("/sp/productAds/list", "application/vnd.spProductAd.v3+json"),
    ]);
    return { campaigns: campaigns.campaigns ?? [], groups: groups.adGroups ?? [], ads: ads.productAds ?? [] };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    // Amazon's reporting API is asynchronous and often not ready in one sync.
    // Structure still lands; a later sync can be extended to poll report ids.
    return [];
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string; raw?: Record<string, unknown> | null }, status: "ACTIVE" | "PAUSED") {
    const host = this.hostOf(account);
    const headers = this.scope(account);
    const state = status === "ACTIVE" ? "ENABLED" : "PAUSED";
    const product = String(campaign.raw?.product ?? "");
    if (product === "SPONSORED_BRANDS") {
      await this.call(host, "/sb/v4/campaigns", auth, { method: "PUT", headers: { ...headers, Accept: "application/vnd.sbcampaignresource.v4+json", "Content-Type": "application/vnd.sbcampaignresource.v4+json" }, body: { campaigns: [{ campaignId: campaign.externalId, state }] } });
      return;
    }
    if (product === "SPONSORED_DISPLAY") {
      await this.call(host, "/sd/campaigns", auth, { method: "PUT", headers, body: [{ campaignId: Number(campaign.externalId), state }] });
      return;
    }
    await this.call(host, "/sp/campaigns", auth, { method: "PUT", headers: { ...headers, Accept: "application/vnd.spCampaign.v3+json", "Content-Type": "application/vnd.spCampaign.v3+json" }, body: { campaigns: [{ campaignId: campaign.externalId, state }] } });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, amount: number) {
    const host = this.hostOf(account);
    await this.call(host, "/sp/campaigns", auth, {
      method: "PUT",
      headers: { ...this.scope(account), Accept: "application/vnd.spCampaign.v3+json", "Content-Type": "application/vnd.spCampaign.v3+json" },
      body: { campaigns: [{ campaignId: campaign.externalId, budget: { budgetType: "DAILY", budget: amount } }] },
    });
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
    return amazonCreateCampaign(this.api(auth, account), draft, assets);
  }
}

function pushCampaign(structure: AccountStructure, c: Row, product: string, budget: unknown) {
  structure.campaigns.push({
    externalId: String(c.campaignId ?? c.id),
    name: c.name,
    status: mapStatus(c.state),
    deliveryStatus: c.servingStatus ?? null,
    objective: product,
    dailyBudget: typeof budget === "number" ? budget : null,
    lifetimeBudget: null,
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
    dailyBudget: g.defaultBid ?? null,
    bidStrategy: null,
    targeting: null,
    raw: {},
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
