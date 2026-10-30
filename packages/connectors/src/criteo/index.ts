/**
 * Criteo Marketing API. Client credentials, then advertisers.
 * Docs: https://developers.criteo.com/marketing-solutions/docs
 */
import type { BuilderDraft, BuilderOptions, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError } from "../errors";
import { splitBudget } from "../builder-values";
import { requestJson, type RequestOptions } from "../http";
import { CLIENT_REFRESH, apiError, authHeader, formToken, mapStatus, requireCredentials, selfRedirect } from "../oauth-flow";
import type { AccountRef, AccountStructure, CampaignRef, AdPlatformConnector, BuilderAsset, ConnectorAuth, ExternalAdAccount, ExternalMetricRow, OAuthTokens, PlatformCredentials } from "../types";
import { criteoCreateCampaign, type CriteoApi } from "./builder";

export interface CriteoConfig {
  clientId?: string;
  clientSecret?: string;
}

const API = "https://api.criteo.com/2025-10";
type Row = Record<string, any>;

export class CriteoConnector implements AdPlatformConnector {
  readonly platform = "CRITEO" as const;
  constructor(private readonly config: CriteoConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Criteo credentials are not configured.");
  }

  private call<T>(path: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(`${API}${path}`, { ...opts, headers: authHeader(auth.accessToken, opts.headers) }, apiError("Criteo"));
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    return selfRedirect(redirectUri, state);
  }

  /**
   * Client-credentials token from the connection's own client id and secret, or
   * the operator's from config for the operator's own connection.
   */
  private async clientToken(credentials?: PlatformCredentials | null) {
    const keys = credentials ? requireCredentials(this.platform, credentials) : this.operatorKeys();
    return formToken("https://api.criteo.com/oauth2/token", {
      grant_type: "client_credentials",
      client_id: keys.clientId!,
      client_secret: keys.clientSecret!,
    }).then((t) => ({ ...t, refreshToken: CLIENT_REFRESH }));
  }

  private operatorKeys(): PlatformCredentials {
    this.assertConfigured();
    return { clientId: this.config.clientId!, clientSecret: this.config.clientSecret! };
  }

  exchangeCode(_params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens> {
    return this.clientToken();
  }

  refreshTokens(_refreshToken: string, credentials?: PlatformCredentials | null) {
    return this.clientToken(credentials);
  }

  connectWithCredentials(credentials: PlatformCredentials) {
    return this.clientToken(credentials);
  }

  /** The advertiser portfolio this login can reach: GET /{version}/advertisers/me. */
  private async portfolio(auth: ConnectorAuth) {
    return (await this.call<{ data?: Row[] }>("/advertisers/me", auth)).data ?? [];
  }

  async getUser(auth: ConnectorAuth) {
    const first = (await this.portfolio(auth))[0];
    return { id: String(first?.id ?? "criteo"), name: first?.attributes?.advertiserName ?? first?.attributes?.name ?? "Criteo" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    return (await this.portfolio(auth)).map((a) => ({
      externalId: String(a.id),
      name: a.attributes?.advertiserName ?? a.attributes?.name ?? String(a.id),
      currency: a.attributes?.currency ?? "USD",
      timezone: null,
      status: "ACTIVE",
    }));
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const sets = await this.adSets(auth, account);
    const campaigns = new Map<string, Row>();
    for (const set of sets) {
      const cid = String(set.attributes?.campaignId ?? set.id);
      const known = campaigns.get(cid);
      if (known) known.adSetIds.push(String(set.id));
      else campaigns.set(cid, { id: cid, name: set.attributes?.campaignName ?? set.attributes?.name ?? cid, status: adSetStatus(set), adSetIds: [String(set.id)] });
    }
    return {
      campaigns: [...campaigns.values()].map((c) => ({
        externalId: String(c.id),
        name: c.name,
        status: mapStatus(c.status),
        deliveryStatus: null,
        objective: null,
        dailyBudget: null,
        lifetimeBudget: null,
        startDate: null,
        endDate: null,
        updatedAt: null,
        // Status and budget live on the ad sets; keep their ids for setCampaignStatus/Budget.
        raw: { adSetIds: c.adSetIds },
      })),
      adGroups: sets.map((g) => ({
        externalId: String(g.id),
        campaignExternalId: String(g.attributes?.campaignId ?? g.id),
        name: g.attributes?.name ?? String(g.id),
        status: mapStatus(adSetStatus(g)),
        dailyBudget: adSetBudget(g),
        bidStrategy: g.attributes?.bidding?.type ?? null,
        targeting: null,
        raw: {},
      })),
      ads: [],
    };
  }

  async fetchMetrics(): Promise<ExternalMetricRow[]> {
    return [];
  }

  /** POST /{version}/marketing-solutions/ad-sets/search, filtered to the advertiser. */
  private async adSets(auth: ConnectorAuth, account: AccountRef) {
    const res = await this.call<{ data?: Row[]; errors?: Row[] }>("/marketing-solutions/ad-sets/search", auth, {
      method: "POST",
      body: { filters: { advertiserIds: [account.externalId] } },
    });
    return res.data ?? [];
  }

  /** The ad sets behind a campaign: from its synced raw, else looked up (a fresh campaign, an old row). */
  private async adSetIdsOf(auth: ConnectorAuth, account: AccountRef, campaign: CampaignRef) {
    const saved = campaign.raw?.adSetIds;
    if (Array.isArray(saved) && saved.length) return saved.map(String);
    const ids = (await this.adSets(auth, account))
      .filter((set) => String(set.attributes?.campaignId ?? set.id) === campaign.externalId)
      .map((set) => String(set.id));
    if (!ids.length) throw new ConnectorError("INVALID_REQUEST", "No Criteo ad set was found for this campaign.");
    return ids;
  }

  /** Ad sets are switched on and off with POST /marketing-solutions/ad-sets/start | stop. */
  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: CampaignRef, status: "ACTIVE" | "PAUSED") {
    await startStop((path, body) => this.call(path, auth, { method: "POST", body }), await this.adSetIdsOf(auth, account, campaign), status);
  }

  /** A campaign's daily budget is split evenly over its ad sets (one, for campaigns made here). */
  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef, campaign: CampaignRef, amount: number) {
    const ids = await this.adSetIdsOf(auth, account, campaign);
    const each = splitBudget(amount, ids.length);
    for (const id of ids) {
      await this.call(`/ad-sets/${id}`, auth, { method: "PATCH", body: { data: { type: "AdSet", id, attributes: { budget: { amount: each, type: "DAILY" } } } } });
    }
  }

  private api(auth: ConnectorAuth): CriteoApi {
    const send: CriteoApi["send"] = (path, body) => this.call(path, auth, { method: "POST", body });
    return { send, setStatus: (ids, status) => startStop(send, ids, status) };
  }

  getBuilderOptions(): Promise<BuilderOptions> {
    return Promise.resolve({});
  }

  searchTargeting(): Promise<TargetingSearchResult[]> {
    return Promise.resolve([]);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef, draft: BuilderDraft, assets: Map<string, BuilderAsset>) {
    return criteoCreateCampaign(this.api(auth), account.externalId, draft, assets);
  }
}

/** Starts or stops ad sets; the reply lists per-id `errors`, which fail the call. */
async function startStop(send: (path: string, body: unknown) => Promise<unknown>, ids: string[], status: "ACTIVE" | "PAUSED") {
  const res = (await send(`/marketing-solutions/ad-sets/${status === "ACTIVE" ? "start" : "stop"}`, { data: ids.map((id) => ({ type: "AdSetId", id })) })) as { errors?: Row[] } | null;
  const err = res?.errors?.[0];
  if (err) throw new ConnectorError("INVALID_REQUEST", err.detail ?? err.title ?? err.message ?? "Criteo did not change the ad set status.", res);
}

/**
 * Status of a searched ad set: documented as schedule.activationStatus ("on" / "off"),
 * with a plain `status` taken as it is when present.
 */
function adSetStatus(set: Row) {
  const a = set.attributes ?? {};
  if (a.status) return String(a.status);
  const on = a.schedule?.activationStatus;
  if (on === "on") return "ACTIVE";
  if (on === "off") return "PAUSED";
  return undefined;
}

/** Daily amount of an ad set budget: `amount`, or the documented budgetAmount.value when it renews daily. */
function adSetBudget(set: Row): number | null {
  const b = set.attributes?.budget;
  if (!b) return null;
  if (typeof b.amount === "number") return b.amount;
  const value = b.budgetAmount?.value ?? b.budgetAmount;
  if (typeof value !== "number") return null;
  return !b.budgetRenewal || String(b.budgetRenewal).toLowerCase() === "daily" ? value : null;
}
