/**
 * Microsoft Advertising (Bing Ads) connector using the v13 REST (JSON) endpoints.
 * Docs: https://learn.microsoft.com/advertising/guides/
 *
 * Reporting is asynchronous: submit a report request, poll until it is ready,
 * then download a zipped CSV.
 */
import type { BuilderDraft, BuilderOptions, EntityStatus, TargetingKind, TargetingSearchResult } from "@ashniva/shared";
import { unzipSync, strFromU8 } from "fflate";
import { ConnectorError } from "../errors";
import { codeFromStatus, requestJson } from "../http";
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
import { microsoftBuilderOptions, microsoftCreateCampaign, microsoftSearchTargeting, type MicrosoftApi } from "./builder";

export interface MicrosoftConfig {
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  /** Azure AD tenant; "common" supports both work and personal Microsoft accounts. */
  tenant: string;
}

const SCOPES = ["https://ads.microsoft.com/msads.manage", "offline_access"];
const CAMPAIGN_API = "https://campaign.api.bingads.microsoft.com/CampaignManagement/v13";
const CUSTOMER_API = "https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13";
const REPORTING_API = "https://reporting.api.bingads.microsoft.com/Reporting/v13";

type Row = Record<string, any>;

export function mapMicrosoftStatus(status: string | undefined): EntityStatus {
  switch (status) {
    case "Active":
      return "ACTIVE";
    case "Deleted":
      return "REMOVED";
    default:
      return "PAUSED";
  }
}

/** Minimal CSV parser for Microsoft's report files (quoted fields, no embedded newlines). */
function parseCsv(text: string): Row[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const split = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const [header, ...rows] = lines;
  if (!header) return [];
  const cols = split(header);
  return rows.map((l) => Object.fromEntries(split(l).map((v, i) => [cols[i], v])));
}

const num = (v: unknown) => Number(String(v ?? "0").replace(/,/g, "")) || 0;

export class MicrosoftAdsConnector implements AdPlatformConnector {
  readonly platform = "MICROSOFT" as const;

  constructor(private readonly config: MicrosoftConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.developerToken);
  }

  private mapError = (status: number, body: unknown) => {
    const b = body as { Errors?: { Message?: string }[]; error_description?: string; Message?: string };
    return new ConnectorError(
      codeFromStatus(status),
      b?.Errors?.[0]?.Message ?? b?.Message ?? b?.error_description ?? `Microsoft Advertising error (${status})`,
      body,
    );
  };

  private api<T>(url: string, auth: ConnectorAuth, body: unknown, account?: AccountRef, method: "POST" | "PUT" | "DELETE" = "POST") {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      DeveloperToken: this.config.developerToken ?? "",
    };
    if (account) {
      headers.CustomerAccountId = account.externalId;
      if (account.meta?.customerId) headers.CustomerId = String(account.meta.customerId);
    }
    return requestJson<T>(url, { method, headers, body }, this.mapError);
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Microsoft Advertising credentials are not configured.");
    const u = new URL(`https://login.microsoftonline.com/${this.config.tenant}/oauth2/v2.0/authorize`);
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("scope", SCOPES.join(" "));
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(body: Record<string, string>): Promise<OAuthTokens> {
    const res = await requestJson<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(
      `https://login.microsoftonline.com/${this.config.tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        form: true,
        body: { client_id: this.config.clientId!, client_secret: this.config.clientSecret!, scope: SCOPES.join(" "), ...body },
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
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  refreshTokens(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.api<{ User?: Row }>(`${CUSTOMER_API}/User/Query`, auth, { UserId: null });
    const u = res.User ?? {};
    return { id: String(u.Id ?? "microsoft"), name: [u.Name?.FirstName, u.Name?.LastName].filter(Boolean).join(" ") || u.UserName || "Microsoft user" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const info = await this.api<{ AccountsInfo?: Row[] }>(`${CUSTOMER_API}/AccountsInfo/Query`, auth, {
      CustomerId: null,
      OnlyParentAccounts: false,
    });
    const out: ExternalAdAccount[] = [];
    for (const a of info.AccountsInfo ?? []) {
      const detail = await this.api<{ Account?: Row }>(`${CUSTOMER_API}/Account/Query`, auth, { AccountId: a.Id }).catch(() => ({ Account: undefined }));
      const acc = detail.Account ?? {};
      out.push({
        externalId: String(a.Id),
        name: a.Name ?? acc.Name ?? `Microsoft Ads ${a.Id}`,
        currency: acc.CurrencyCode ?? "USD",
        timezone: acc.TimeZone ?? null,
        status: a.AccountLifeCycleStatus ?? "Active",
        meta: { customerId: acc.ParentCustomerId ?? null, number: a.Number },
      });
    }
    return out;
  }

  async fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure> {
    const accountId = Number(account.externalId);
    const { Campaigns = [] } = await this.api<{ Campaigns?: Row[] }>(
      `${CAMPAIGN_API}/Campaigns/QueryByAccountId`,
      auth,
      { AccountId: accountId, CampaignType: "Search Shopping Audience PerformanceMax" },
      account,
    );
    const structure: AccountStructure = { campaigns: [], adGroups: [], ads: [] };
    for (const c of Campaigns) {
      structure.campaigns.push({
        externalId: String(c.Id),
        name: c.Name,
        status: mapMicrosoftStatus(c.Status),
        deliveryStatus: c.Status ?? null,
        objective: c.CampaignType ?? null,
        dailyBudget: c.BudgetType?.startsWith("Daily") ? num(c.DailyBudget) : null,
        lifetimeBudget: null,
        startDate: null,
        endDate: null,
        updatedAt: null,
        raw: { budgetType: c.BudgetType, budgetId: c.BudgetId ?? null },
      });
      const { AdGroups = [] } = await this.api<{ AdGroups?: Row[] }>(
        `${CAMPAIGN_API}/AdGroups/QueryByCampaignId`,
        auth,
        { CampaignId: c.Id },
        account,
      );
      for (const g of AdGroups) {
        structure.adGroups.push({
          externalId: String(g.Id),
          campaignExternalId: String(c.Id),
          name: g.Name,
          status: mapMicrosoftStatus(g.Status),
          dailyBudget: null,
          bidStrategy: g.BiddingScheme?.Type ?? null,
          targeting: null,
          raw: {},
        });
        const { Ads = [] } = await this.api<{ Ads?: Row[] }>(
          `${CAMPAIGN_API}/Ads/QueryByAdGroupId`,
          auth,
          { AdGroupId: g.Id, AdTypes: ["ResponsiveSearch", "ExpandedText", "ResponsiveAd"] },
          account,
        ).catch(() => ({ Ads: [] as Row[] }));
        for (const ad of Ads) {
          structure.ads.push({
            externalId: `${g.Id}~${ad.Id}`,
            adGroupExternalId: String(g.Id),
            campaignExternalId: String(c.Id),
            name: ad.Headlines?.[0]?.Asset?.Text ?? `${ad.Type ?? "Ad"} #${ad.Id}`,
            status: mapMicrosoftStatus(ad.Status),
            headline: ad.Headlines?.[0]?.Asset?.Text ?? null,
            body: ad.Descriptions?.[0]?.Asset?.Text ?? null,
            thumbnailUrl: null,
            finalUrl: ad.FinalUrls?.[0] ?? null,
            raw: { type: ad.Type },
          });
        }
      }
    }
    return structure;
  }

  /** Submits a report, waits for it, and returns its rows. */
  private async runReport(auth: ConnectorAuth, account: AccountRef, type: string, columns: string[], range: { from: string; to: string }) {
    const [fy, fm, fd] = range.from.split("-").map(Number);
    const [ty, tm, td] = range.to.split("-").map(Number);
    const submit = await this.api<{ ReportRequestId: string }>(
      `${REPORTING_API}/GenerateReport/Submit`,
      auth,
      {
        ReportRequest: {
          Type: type,
          Format: "Csv",
          ExcludeReportHeader: true,
          ExcludeReportFooter: true,
          ReturnOnlyCompleteData: false,
          Aggregation: "Daily",
          Columns: columns,
          Scope: { AccountIds: [Number(account.externalId)] },
          Time: {
            CustomDateRangeStart: { Year: fy, Month: fm, Day: fd },
            CustomDateRangeEnd: { Year: ty, Month: tm, Day: td },
          },
        },
      },
      account,
    );

    for (let attempt = 0; attempt < 30; attempt++) {
      const poll = await this.api<{ ReportRequestStatus: { Status: string; ReportDownloadUrl?: string } }>(
        `${REPORTING_API}/GenerateReport/Poll`,
        auth,
        { ReportRequestId: submit.ReportRequestId },
        account,
      );
      const s = poll.ReportRequestStatus;
      if (s.Status === "Success") {
        if (!s.ReportDownloadUrl) return []; // no data in range
        const res = await fetch(s.ReportDownloadUrl, { signal: AbortSignal.timeout(60_000) });
        const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
        const first = Object.values(files)[0];
        return first ? parseCsv(strFromU8(first)) : [];
      }
      if (s.Status === "Error") throw new ConnectorError("PLATFORM_ERROR", "Microsoft Advertising report failed.");
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new ConnectorError("PLATFORM_ERROR", "Microsoft Advertising report timed out.");
  }

  async fetchMetrics(auth: ConnectorAuth, account: AccountRef, range: { from: string; to: string }) {
    const base = ["TimePeriod", "Impressions", "Clicks", "Spend", "Conversions", "Revenue"];
    const reports: [MetricLevel, string, string[], (r: Row) => string][] = [
      ["CAMPAIGN", "CampaignPerformanceReportRequest", ["CampaignId", ...base], (r) => r.CampaignId],
      ["AD_GROUP", "AdGroupPerformanceReportRequest", ["AdGroupId", ...base], (r) => r.AdGroupId],
      ["AD", "AdPerformanceReportRequest", ["AdGroupId", "AdId", ...base], (r) => `${r.AdGroupId}~${r.AdId}`],
    ];
    const out: ExternalMetricRow[] = [];
    for (const [level, type, columns, idOf] of reports) {
      const rows = await this.runReport(auth, account, type, columns, range);
      for (const r of rows) {
        out.push({
          date: String(r.TimePeriod).slice(0, 10),
          level,
          externalId: String(idOf(r)),
          impressions: num(r.Impressions),
          clicks: num(r.Clicks),
          spend: num(r.Spend),
          conversions: num(r.Conversions),
          conversionValue: num(r.Revenue),
          videoViews: 0,
        });
      }
    }
    return out;
  }

  private updateCampaign(auth: ConnectorAuth, account: AccountRef, campaign: Row) {
    return this.api(`${CAMPAIGN_API}/Campaigns`, auth, { AccountId: Number(account.externalId), Campaigns: [campaign] }, account, "PUT");
  }

  async setCampaignStatus(auth: ConnectorAuth, account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.updateCampaign(auth, account, { Id: Number(campaign.externalId), Status: status === "ACTIVE" ? "Active" : "Paused" });
  }

  async setCampaignDailyBudget(
    auth: ConnectorAuth,
    account: AccountRef,
    campaign: { externalId: string; raw?: Record<string, unknown> | null },
    amount: number,
  ) {
    if (campaign.raw?.budgetId) {
      throw new ConnectorError("UNSUPPORTED", "This campaign uses a shared budget. Edit it in Microsoft Advertising.");
    }
    await this.updateCampaign(auth, account, { Id: Number(campaign.externalId), DailyBudget: amount });
  }

  /** API calls used by the campaign builder. */
  private builderApi(auth: ConnectorAuth, account: AccountRef): MicrosoftApi {
    return {
      call: (path, body, method = "POST") => this.api(`${CAMPAIGN_API}${path}`, auth, body, account, method),
      download: async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new ConnectorError("PLATFORM_ERROR", `Couldn't download Microsoft's locations file (${res.status}).`);
        return res.text();
      },
    };
  }

  getBuilderOptions(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions> {
    return microsoftBuilderOptions(this.builderApi(auth, account), account.externalId);
  }

  searchTargeting(auth: ConnectorAuth, account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
    return microsoftSearchTargeting(this.builderApi(auth, account), kind, query);
  }

  createCampaign(
    auth: ConnectorAuth,
    account: AccountRef & { currency: string; timezone?: string | null },
    draft: BuilderDraft,
    assets: Map<string, BuilderAsset>,
  ): Promise<AccountStructure> {
    return microsoftCreateCampaign(this.builderApi(auth, account), account, draft, assets);
  }
}
