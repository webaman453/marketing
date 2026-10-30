/**
 * LinkedIn Marketing API connector (versioned REST API).
 * Docs: https://learn.microsoft.com/linkedin/marketing/
 *
 * Hierarchy mapping: LinkedIn campaign group → our campaign,
 * LinkedIn campaign → our ad group, LinkedIn creative → our ad.
 * Query strings use Rest.li syntax, so they are built by hand: the
 * structural characters ( ) : , must not be percent-encoded.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { ConnectorError, expiredGrant, noRowsUnlessFatal } from "../errors";
import { allPages, codeFromStatus, requestJson, type RequestOptions } from "../http";
import type {
  AccountRef,
  AccountStructure,
  AdPlatformConnector,
  BuilderAsset,
  ConnectorAuth,
  ExternalAdAccount,
  ExternalMetricRow,
  OAuthTokens,
} from "../types";
import { linkedinBuilderOptions, linkedinCreateCampaign, linkedinSearchTargeting, type LinkedInApi } from "./builder";

export interface LinkedInConfig {
  clientId?: string;
  clientSecret?: string;
  /** YYYYMM, e.g. 202609 */
  apiVersion: string;
}

const REST = "https://api.linkedin.com/rest";
const SCOPES = ["r_ads", "rw_ads", "r_ads_reporting", "openid", "profile"];

type Row = Record<string, any>;

export function mapLinkedInStatus(status: string | undefined): EntityStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "ARCHIVED":
    case "COMPLETED":
      return "ARCHIVED";
    case "CANCELED":
    case "REMOVED":
      return "REMOVED";
    default:
      return "PAUSED";
  }
}

const idFromUrn = (urn: string) => String(urn).split(":").pop()!;
const ymd = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `(year:${y},month:${m},day:${d})`;
};
const pad = (n: number) => String(n).padStart(2, "0");

export class LinkedInConnector implements AdPlatformConnector {
  readonly platform = "LINKEDIN" as const;

  constructor(private readonly config: LinkedInConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private mapError = (status: number, body: unknown) =>
    new ConnectorError(
      codeFromStatus(status),
      (body as { message?: string; error_description?: string })?.message ??
        (body as { error_description?: string })?.error_description ??
        `LinkedIn API error (${status})`,
      body,
    );

  /** `pathAndQuery` must already be Rest.li-encoded. */
  private rest<T>(pathAndQuery: string, auth: ConnectorAuth, opts: RequestOptions = {}) {
    return requestJson<T>(
      `${REST}${pathAndQuery}`,
      {
        ...opts,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "LinkedIn-Version": this.config.apiVersion,
          "X-Restli-Protocol-Version": "2.0.0",
          ...opts.headers,
        },
      },
      this.mapError,
    );
  }

  /**
   * Reads a search/criteria finder to its last page. Since 202401 these page by cursor:
   * pageSize + pageToken in, metadata.nextPageToken out (no token = last page); start/count
   * are no longer paging parameters. Capped at MAX_PAGES like every list.
   */
  private all(path: string, auth: ConnectorAuth, pageSize = 500) {
    const sep = path.includes("?") ? "&" : "?";
    return allPages<Row, string | undefined>(
      undefined,
      async (pageToken) => {
        const token = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await this.rest<{ elements?: Row[]; metadata?: { nextPageToken?: string } }>(`${path}${sep}pageSize=${pageSize}${token}`, auth);
        return { items: res.elements ?? [], next: res.metadata?.nextPageToken };
      },
      `LinkedIn ${path.split("?")[0]} list`,
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "LinkedIn app credentials are not configured.");
    const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", SCOPES.join(" "));
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await requestJson<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }>(
      "https://www.linkedin.com/oauth/v2/accessToken",
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
      scopes: res.scope?.split(/[ ,]/) ?? SCOPES,
    };
  }

  exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }) {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    // A revoked or expired refresh token is 400 invalid_grant: an expired login, not a bad request.
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }).catch(expiredGrant);
  }

  /** OpenID userinfo; it lives at /v2/userinfo, not under the versioned /rest API. */
  private getUserinfo(auth: ConnectorAuth) {
    return requestJson<{ sub: string; name?: string; email?: string }>(
      "https://api.linkedin.com/v2/userinfo",
      { headers: { Authorization: `Bearer ${auth.accessToken}` } },
      this.mapError,
    );
  }

  async getUser(auth: ConnectorAuth) {
    const info = await this.getUserinfo(auth);
    return { id: info.sub, name: info.name ?? info.email ?? "LinkedIn user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const accounts = await this.all("/adAccounts?q=search", auth);
    return accounts
      .filter((a) => a.status !== "REMOVED" && a.status !== "CANCELED")
      .map((a) => ({
        externalId: String(a.id),
        name: a.name ?? `LinkedIn ${a.id}`,
        currency: a.currency ?? "USD",
        timezone: null,
        status: a.status ?? "ACTIVE",
      }));
  }

  private async campaignsOf(auth: ConnectorAuth, accountId: string) {
    return this.all(`/adAccounts/${accountId}/adCampaigns?q=search`, auth);
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const id = account.externalId;
    const [groups, campaigns, creatives] = await Promise.all([
      this.all(`/adAccounts/${id}/adCampaignGroups?q=search`, auth),
      this.campaignsOf(auth, id),
      // Creatives page at most 100 per request. A creative list the account cannot run gives no
      // ads, but an expired login, rate limit or outage still fails the sync.
      this.all(`/adAccounts/${id}/creatives?q=criteria`, auth, 100).catch(noRowsUnlessFatal<Row>),
    ]);
    const groupOfCampaign = new Map(campaigns.map((c) => [String(c.id), idFromUrn(c.campaignGroup)]));

    return {
      campaigns: groups.map((g) => ({
        externalId: String(g.id),
        name: g.name,
        status: mapLinkedInStatus(g.status),
        deliveryStatus: g.status ?? null,
        objective: g.objective ?? null,
        dailyBudget: null,
        lifetimeBudget: g.totalBudget?.amount != null ? Number(g.totalBudget.amount) : null,
        startDate: g.runSchedule?.start ? new Date(g.runSchedule.start).toISOString().slice(0, 10) : null,
        endDate: g.runSchedule?.end ? new Date(g.runSchedule.end).toISOString().slice(0, 10) : null,
        updatedAt: null,
        raw: {},
      })),
      adGroups: campaigns.map((c) => ({
        externalId: String(c.id),
        campaignExternalId: idFromUrn(c.campaignGroup),
        name: c.name,
        status: mapLinkedInStatus(c.status),
        dailyBudget: c.dailyBudget?.amount != null ? Number(c.dailyBudget.amount) : null,
        bidStrategy: c.costType ?? null,
        targeting: null,
        raw: { objectiveType: c.objectiveType, type: c.type },
      })),
      ads: creatives
        .map((cr) => {
          const campaignId = idFromUrn(cr.campaign);
          const group = groupOfCampaign.get(campaignId);
          if (!group) return null;
          const creativeId = idFromUrn(cr.id);
          return {
            externalId: creativeId,
            adGroupExternalId: campaignId,
            campaignExternalId: group,
            name: cr.name ?? `Creative ${creativeId}`,
            status: mapLinkedInStatus(cr.intendedStatus),
            headline: null,
            body: null,
            thumbnailUrl: null,
            finalUrl: null,
            raw: {},
          };
        })
        .filter((a) => a !== null),
    };
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const accountUrn = encodeURIComponent(`urn:li:sponsoredAccount:${account.externalId}`);
    const fields = "impressions,clicks,costInLocalCurrency,externalWebsiteConversions,conversionValueInLocalCurrency,videoViews,pivotValues,dateRange";
    const query = (pivot: string) =>
      `/adAnalytics?q=analytics&pivot=${pivot}&timeGranularity=DAILY&dateRange=(start:${ymd(range.from)},end:${ymd(range.to)})&accounts=List(${accountUrn})&fields=${fields}`;

    const [byCampaign, byCreative, campaigns] = await Promise.all([
      this.rest<{ elements?: Row[] }>(query("CAMPAIGN"), auth),
      this.rest<{ elements?: Row[] }>(query("CREATIVE"), auth).catch((err) => ({ elements: noRowsUnlessFatal<Row>(err) })),
      this.campaignsOf(auth, account.externalId),
    ]);
    const groupOf = new Map(campaigns.map((c) => [String(c.id), idFromUrn(c.campaignGroup)]));

    const toRow = (el: Row, level: ExternalMetricRow["level"], externalId: string): ExternalMetricRow => {
      const s = el.dateRange.start;
      return {
        date: `${s.year}-${pad(s.month)}-${pad(s.day)}`,
        level,
        externalId,
        impressions: Number(el.impressions ?? 0),
        clicks: Number(el.clicks ?? 0),
        spend: Number(el.costInLocalCurrency ?? 0),
        conversions: Number(el.externalWebsiteConversions ?? 0),
        conversionValue: Number(el.conversionValueInLocalCurrency ?? 0),
        videoViews: Number(el.videoViews ?? 0),
      };
    };

    const out: ExternalMetricRow[] = [];
    const groupTotals = new Map<string, ExternalMetricRow>();
    for (const el of byCampaign.elements ?? []) {
      const campaignId = idFromUrn(el.pivotValues[0]);
      const row = toRow(el, "AD_GROUP", campaignId);
      out.push(row);
      // Campaign groups aren't a reporting pivot together with creatives, so roll campaigns up.
      const group = groupOf.get(campaignId);
      if (!group) continue;
      const key = `${group}|${row.date}`;
      const acc = groupTotals.get(key) ?? { ...row, level: "CAMPAIGN", externalId: group, impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0, videoViews: 0 };
      acc.impressions += row.impressions;
      acc.clicks += row.clicks;
      acc.spend += row.spend;
      acc.conversions += row.conversions;
      acc.conversionValue += row.conversionValue;
      acc.videoViews += row.videoViews;
      groupTotals.set(key, acc);
    }
    out.push(...groupTotals.values());
    for (const el of byCreative.elements ?? []) out.push(toRow(el, "AD", idFromUrn(el.pivotValues[0])));
    return out;
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.rest(`/adAccounts/${account.externalId}/adCampaignGroups/${campaign.externalId}`, auth, {
      method: "POST",
      headers: { "X-RestLi-Method": "PARTIAL_UPDATE" },
      body: { patch: { $set: { status } } },
    });
  }

  async setCampaignDailyBudget(): Promise<void> {
    throw new ConnectorError(
      "UNSUPPORTED",
      "LinkedIn sets daily budgets on each campaign inside a campaign group. Edit them in the campaign's ad groups.",
    );
  }

  /** API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth): LinkedInApi {
    const headers = { Authorization: `Bearer ${auth.accessToken}`, "LinkedIn-Version": this.config.apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
    const send = async (pathAndQuery: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => {
      const res = await fetch(`${REST}${pathAndQuery}`, {
        method: init.method,
        headers: { ...headers, "Content-Type": "application/json", ...init.headers },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      const body = text ? (JSON.parse(text) as Row) : null;
      if (!res.ok) throw this.mapError(res.status, body);
      return { res, body };
    };
    return {
      get: (pathAndQuery) => this.rest(pathAndQuery, auth),
      post: async (pathAndQuery, body) => (await send(pathAndQuery, { method: "POST", body })).body as never,
      putJson: async (pathAndQuery, body) => {
        await send(pathAndQuery, { method: "PUT", body });
      },
      userinfo: () => this.getUserinfo(auth),
      create: async (pathAndQuery, body) => {
        const { res, body: out } = await send(pathAndQuery, { method: "POST", body });
        const id = res.headers.get("x-restli-id") ?? (out?.value?.creative as string | undefined) ?? (out?.id as string | undefined);
        if (!id) throw new ConnectorError("PLATFORM_ERROR", "LinkedIn didn't return the new id.");
        return decodeURIComponent(id);
      },
      patch: async (pathAndQuery, set) => {
        await send(pathAndQuery, { method: "POST", body: { patch: { $set: set } }, headers: { "X-RestLi-Method": "PARTIAL_UPDATE" } });
      },
      put: async (url, data, contentType) => {
        const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": contentType }, body: new Uint8Array(data), signal: AbortSignal.timeout(10 * 60_000) });
        if (!res.ok) throw new ConnectorError(codeFromStatus(res.status), `LinkedIn upload failed (${res.status})`);
        return res.headers.get("etag");
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return linkedinBuilderOptions(this.builderApi(auth), account.externalId);
  }

  searchTargeting(auth: ConnectorAuth, _account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return linkedinSearchTargeting(this.builderApi(auth), kind, query);
  }

  createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    return linkedinCreateCampaign(this.builderApi(auth), account, draft, assets);
  }
}
