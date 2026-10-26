import type { BuilderDraft, BuilderOptions, EntityStatus, Platform, TargetingKind, TargetingSearchResult } from "@ashniva/shared";

export type { EntityStatus };

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
}

export interface ExternalUser {
  id: string;
  name: string;
}

export interface ExternalAdAccount {
  externalId: string;
  name: string;
  currency: string;
  timezone: string | null;
  status: string;
  /** Platform-specific extras needed for later API calls (e.g. Google login-customer-id). */
  meta?: Record<string, unknown>;
}

export interface ExternalCampaign {
  externalId: string;
  name: string;
  status: EntityStatus;
  deliveryStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startDate: string | null;
  endDate: string | null;
  updatedAt: Date | null;
  raw: Record<string, unknown>;
}

export interface ExternalAdGroup {
  externalId: string;
  campaignExternalId: string;
  name: string;
  status: EntityStatus;
  dailyBudget: number | null;
  bidStrategy: string | null;
  targeting: Record<string, unknown> | null;
  raw: Record<string, unknown>;
  /** Builder node key this ad group was created from */
  sourceKey?: string;
}

export interface ExternalAd {
  externalId: string;
  adGroupExternalId: string;
  campaignExternalId: string;
  name: string;
  status: EntityStatus;
  headline: string | null;
  body: string | null;
  thumbnailUrl: string | null;
  finalUrl: string | null;
  raw: Record<string, unknown>;
  /** Builder node key this ad was created from (an ad, or the ad group for asset-group platforms) */
  sourceKey?: string;
}

export interface AccountStructure {
  campaigns: ExternalCampaign[];
  adGroups: ExternalAdGroup[];
  ads: ExternalAd[];
  /** Non-fatal problems while creating (e.g. an extension the platform rejected). */
  warnings?: string[];
}

export type MetricLevel = "CAMPAIGN" | "AD_GROUP" | "AD";

export interface ExternalMetricRow {
  /** YYYY-MM-DD in the ad account's timezone */
  date: string;
  level: MetricLevel;
  /** External id of the campaign / ad group / ad */
  externalId: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  conversionValue: number;
  videoViews: number;
}

/** Credentials and account details passed to every API call. */
export interface ConnectorAuth {
  accessToken: string;
}

export interface AccountRef {
  externalId: string;
  currency?: string;
  meta?: Record<string, unknown> | null;
}

export interface CampaignRef {
  externalId: string;
  raw?: Record<string, unknown> | null;
}

/** One playable/downloadable file of an ad creative (a single image or video, or one carousel card). */
export interface AdMediaItem {
  type: "IMAGE" | "VIDEO";
  /** Full-size image URL, or the video file URL. Short-lived on most platforms: fetch fresh, never store. */
  url: string | null;
  /** Poster frame for videos, or a smaller image for fallback. */
  posterUrl: string | null;
  title: string | null;
  description: string | null;
  link: string | null;
  durationSec: number | null;
  /** Page where the video can be watched when the platform will not hand over the file. */
  permalink: string | null;
}

export interface AdMedia {
  format: "IMAGE" | "VIDEO" | "CAROUSEL" | "UNKNOWN";
  headline: string | null;
  body: string | null;
  callToAction: string | null;
  link: string | null;
  items: AdMediaItem[];
}

/** A lead submitted through a platform's native form (Meta Instant Forms). */
export interface ExternalLead {
  externalId: string;
  createdTime: Date;
  /** "fb" or "ig" on Meta */
  source: string | null;
  isOrganic: boolean;
  pageId: string | null;
  formId: string | null;
  formName: string | null;
  externalAdId: string | null;
  externalAdGroupId: string | null;
  externalCampaignId: string | null;
  adName: string | null;
  adGroupName: string | null;
  campaignName: string | null;
  /** Every answer on the form: question key → values */
  fields: Record<string, string[]>;
}

export interface AdPlatformConnector {
  readonly platform: Platform;
  /** False when the platform's app credentials are missing from the environment. */
  isConfigured(): boolean;

  getAuthUrl(params: { state: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; redirectUri: string; state?: string }): Promise<OAuthTokens>;
  /** Returns null when the platform does not support refresh (e.g. Meta long-lived tokens). */
  refreshTokens(refreshToken: string): Promise<OAuthTokens | null>;

  /**
   * Withdraws our app's access to the user's account (optional: platforms
   * without a revoke endpoint just have their tokens deleted on our side).
   * Pass the refresh token when there is one; it revokes the whole grant.
   */
  revokeAccess?(token: string): Promise<void>;

  getUser(auth: ConnectorAuth): Promise<ExternalUser>;
  listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]>;
  fetchStructure(auth: ConnectorAuth, account: AccountRef): Promise<AccountStructure>;
  fetchMetrics(
    auth: ConnectorAuth,
    account: AccountRef,
    range: { from: string; to: string },
  ): Promise<ExternalMetricRow[]>;

  setCampaignStatus(
    auth: ConnectorAuth,
    account: AccountRef,
    campaign: CampaignRef,
    status: "ACTIVE" | "PAUSED",
  ): Promise<void>;
  setCampaignDailyBudget(
    auth: ConnectorAuth,
    account: AccountRef & { currency: string },
    campaign: CampaignRef,
    amount: number,
  ): Promise<void>;

  /** Fresh creative media for one ad (image/video files, carousel cards), for in-app viewing and download. */
  fetchAdMedia?(auth: ConnectorAuth, account: AccountRef, ad: { externalId: string }): Promise<AdMedia>;

  /** Leads submitted after `since` (all of them when null), across every form this login can read. */
  fetchLeads?(auth: ConnectorAuth, params: { since: Date | null }): Promise<ExternalLead[]>;

  // ── Campaign creation (optional: only platforms supported by the builder) ──

  /** Pages, pixels and similar account assets the builder needs to offer. */
  getBuilderOptions?(auth: ConnectorAuth, account: AccountRef): Promise<BuilderOptions>;

  /** Typeahead for locations, interests, job titles… */
  searchTargeting?(auth: ConnectorAuth, account: AccountRef, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]>;

  /**
   * Creates the whole campaign → ad groups → ads tree from a builder draft and
   * returns what was created, in the same shape as a structure sync. Each ad
   * group and ad carries the draft node key it came from (`sourceKey`).
   */
  createCampaign?(
    auth: ConnectorAuth,
    account: AccountRef & { currency: string; timezone?: string | null },
    draft: BuilderDraft,
    assets: Map<string, BuilderAsset>,
  ): Promise<AccountStructure>;
}

/** A creative-library file handed to createCampaign. */
export interface BuilderAsset {
  creativeId: string;
  type: "IMAGE" | "VIDEO";
  filename: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  /** Loads file bytes on demand (skipped when a cached platform reference exists). */
  load: () => Promise<Buffer>;
  /** Previously uploaded reference for this ad account, e.g. a Meta image hash. */
  cachedRef?: string;
  /** Called with the platform reference after a fresh upload so it can be cached. */
  onUploaded?: (ref: string) => Promise<void>;
}
