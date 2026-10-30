import type { AdPreviewData } from "./builder/preview";
import type { AccountOptionKind, BuilderIssue, TargetingValue } from "./builder/types";
/**
 * Response shapes shared between the API and the web app.
 * Dates are ISO strings; money values are numbers in the account currency.
 */
import type { DraftResult } from "./builder";
import type { FxInfo } from "./format";
import type { MetricSet, MetricTotals } from "./metrics";
import type { PlanId } from "./plans";
import type { ReportConfig } from "./reports";
import type { RuleAction, RuleCondition, RuleScope } from "./rules";
import type { Platform } from "./platforms";
import type { Role } from "./roles";
import type { EntityStatus } from "./schemas";

export interface UserDTO {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  emailVerified: boolean;
  isSuperAdmin: boolean;
  /** Already had the free trial; orgs they create now start without one */
  trialUsed: boolean;
  createdAt: string;
}

export interface WorkspaceDTO {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  currency: string;
  timezone: string;
  adAccountCount: number;
  createdAt: string;
}

export interface ArchivedWorkspaceDTO extends WorkspaceDTO {
  archivedAt: string;
}

export interface BrandingDTO {
  brandName: string | null;
  brandColor: string | null;
  brandLogoUrl: string | null;
  reportFooter: string | null;
}

export type SubscriptionStatusDTO = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";

export interface OrgDTO {
  id: string;
  name: string;
  slug: string;
  plan: PlanId;
  trialEndsAt: string | null;
  subscriptionStatus: SubscriptionStatusDTO;
  currentPeriodEnd: string | null;
  /** True when the trial ended or payment lapsed: data is read-only until a plan is active. */
  locked: boolean;
  branding: BrandingDTO;
  role: Role;
  workspaces: WorkspaceDTO[];
}

export interface MeResponse {
  user: UserDTO;
  orgs: OrgDTO[];
}

export interface MemberDTO {
  id: string;
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: Role;
  workspaceIds: string[];
  joinedAt: string;
}

export interface InvitationDTO {
  id: string;
  email: string;
  role: Role;
  workspaceIds: string[];
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export type ConnectionStatus = "ACTIVE" | "EXPIRED" | "ERROR" | "REVOKED";
export type SyncStatus = "IDLE" | "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED";

export interface ConnectionDTO {
  id: string;
  platform: Platform;
  mode: "LIVE" | "DEMO";
  status: ConnectionStatus;
  externalUserName: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  adAccountCount: number;
  connectedBy: string | null;
  createdAt: string;
}

export interface AdAccountDTO {
  id: string;
  platform: Platform;
  externalId: string;
  name: string;
  currency: string;
  timezone: string | null;
  status: string;
  connectionId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  lastSyncedAt: string | null;
}

export interface CampaignRowDTO {
  id: string;
  platform: Platform;
  externalId: string;
  name: string;
  status: EntityStatus;
  deliveryStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string;
  adAccount: { id: string; name: string };
  startDate: string | null;
  endDate: string | null;
  /** In `currency`, the ad account's own (what the platform bills). */
  metrics: MetricSet;
  /** The same metrics in the workspace currency, when the account bills in another one and a rate is known. */
  converted?: MetricSet;
}

export interface TimeseriesPoint extends MetricTotals {
  date: string;
}

export interface PlatformBreakdown {
  platform: Platform;
  metrics: MetricSet;
}

export interface DateRange {
  from: string;
  to: string;
}

export interface OverviewResponse {
  range: DateRange;
  compareRange: DateRange;
  currency: string;
  totals: MetricSet;
  previous: MetricSet;
  timeseries: TimeseriesPoint[];
  byPlatform: PlatformBreakdown[];
  /** Already in the workspace currency (`currency` on each row is the workspace's). */
  topCampaigns: CampaignRowDTO[];
  accounts: { total: number; connections: number; failing: number };
  lastSyncedAt: string | null;
  /** How totals were converted into `currency`. */
  fx?: FxInfo;
}

export interface CampaignListResponse {
  range: DateRange;
  currency: string;
  campaigns: CampaignRowDTO[];
  /** In the workspace `currency`. */
  totals: MetricSet;
  fx?: FxInfo;
}

export interface AdGroupRowDTO {
  id: string;
  externalId: string;
  name: string;
  status: EntityStatus;
  dailyBudget: number | null;
  metrics: MetricSet;
  adCount: number;
}

export interface AdRowDTO {
  id: string;
  externalId: string;
  adGroupId: string;
  name: string;
  status: EntityStatus;
  headline: string | null;
  body: string | null;
  finalUrl: string | null;
  thumbnailUrl: string | null;
  /** Creative snapshot for placement previews (ads made in the builder) */
  preview: AdPreviewData | null;
  metrics: MetricSet;
}

export interface AdMediaItemDTO {
  type: "IMAGE" | "VIDEO";
  url: string | null;
  posterUrl: string | null;
  title: string | null;
  description: string | null;
  link: string | null;
  durationSec: number | null;
  permalink: string | null;
}

/** An ad's creative files, fetched fresh from the platform (media URLs expire). */
export interface AdMediaDTO {
  format: "IMAGE" | "VIDEO" | "CAROUSEL" | "UNKNOWN";
  headline: string | null;
  body: string | null;
  callToAction: string | null;
  link: string | null;
  items: AdMediaItemDTO[];
  /** False when the platform could not share files and only the synced thumbnail is shown. */
  live: boolean;
}

export interface CampaignDetailResponse {
  campaign: CampaignRowDTO;
  timeseries: TimeseriesPoint[];
  adGroups: AdGroupRowDTO[];
  ads: AdRowDTO[];
  activity: AuditLogDTO[];
  fx?: FxInfo;
}

export interface AuditLogDTO {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityName: string | null;
  actor: { id: string; name: string } | null;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    /** Campaign builder problems, when code is DRAFT_INVALID */
    issues?: BuilderIssue[];
  };
}

export interface UsageDTO {
  workspaces: number;
  adAccounts: number;
  members: number;
}

export interface CreativeDTO {
  id: string;
  name: string;
  type: "IMAGE" | "VIDEO";
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  url: string;
  tags: string[];
  createdAt: string;
}

export interface DraftDTO {
  id: string;
  name: string;
  status: "DRAFT" | "LAUNCHING" | "LAUNCHED" | "PARTIAL" | "FAILED";
  payload: Record<string, unknown>;
  results: DraftResult[] | null;
  createdBy: string | null;
  launchedAt: string | null;
  updatedAt: string;
}

export interface BuilderOptionItem {
  id: string;
  name: string;
  /** Secondary line, e.g. "Android · com.example.app" */
  detail?: string;
  imageUrl?: string | null;
}

/** Pages, pixels, identities… loaded from the platform for one ad account. */
export type BuilderOptions = Partial<Record<AccountOptionKind, BuilderOptionItem[]>>;

export interface TargetingSearchResult extends TargetingValue {
  /** e.g. "Region in Maharashtra, India" or an audience size */
  detail?: string;
}

export interface ReportDTO {
  id: string;
  name: string;
  description: string | null;
  config: ReportConfig;
  schedule: {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY" | null;
    hour: number;
    dayOfWeek: number;
    dayOfMonth: number;
    recipients: string[];
    nextRunAt: string | null;
    lastRunAt: string | null;
  };
  shareToken: string | null;
  createdBy: string | null;
  updatedAt: string;
}

export interface RuleDTO {
  id: string;
  name: string;
  isActive: boolean;
  scope: RuleScope;
  conditionLogic: "ALL" | "ANY";
  conditions: RuleCondition[];
  actions: RuleAction[];
  lookbackDays: number;
  frequency: "HOURLY" | "DAILY";
  cooldownHours: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRun: RuleRunDTO | null;
  updatedAt: string;
}

export interface RuleRunDetail {
  campaignId: string;
  campaignName: string;
  platform: Platform;
  values: Record<string, number | null>;
  actions: { type: string; ok: boolean; error?: string; detail?: string }[];
}

export interface RuleRunDTO {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  dryRun: boolean;
  evaluated: number;
  matched: number;
  details: RuleRunDetail[] | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ApiKeyDTO {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface AiInsight {
  title: string;
  detail: string;
  type: "opportunity" | "risk" | "info";
  impact: "high" | "medium" | "low";
}

export interface AiInsightsResponse {
  summary: string;
  insights: AiInsight[];
  generatedAt: string;
}

export interface AdCopyResponse {
  headlines: string[];
  descriptions: string[];
  primaryTexts: string[];
}

// ───────────────────────── Leads ─────────────────────────

/** Where the team is with a lead, in workflow order. */
export const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "WON", "LOST"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = { NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified", WON: "Won", LOST: "Lost" };
/** Longest note the team can keep on a lead. */
export const LEAD_NOTE_MAX = 2000;

/** How the leads list can be ordered. */
export const LEAD_SORTS = ["newest", "oldest", "campaign", "cost"] as const;
export type LeadSort = (typeof LEAD_SORTS)[number];

/**
 * Filters of GET /leads and /leads/export (besides from/to), as query string values.
 * Every filter combines with the others (AND).
 */
export interface LeadQuery {
  platform?: Platform;
  /** "fb", "ig"…; "unknown" = no source */
  source?: string;
  campaignId?: string;
  adGroupId?: string;
  adId?: string;
  formId?: string;
  status?: LeadStatus;
  /** "true" = has a phone number, "false" = has none */
  hasPhone?: "true" | "false";
  hasEmail?: "true" | "false";
  /** Organic (no ad) or paid (from an ad) leads */
  origin?: "paid" | "organic";
  search?: string;
  sort?: LeadSort;
  page?: number;
  pageSize?: number;
}

export interface LeadDTO {
  id: string;
  platform: Platform;
  /** "fb" / "ig" on Meta */
  source: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adGroupId: string | null;
  adGroupName: string | null;
  adId: string | null;
  adName: string | null;
  formId: string | null;
  formName: string | null;
  /** True for leads that came from a form without an ad (e.g. a Page's organic form). */
  isOrganic: boolean;
  /** ISO timestamp the form was submitted */
  createdTime: string;
  /** That ad's spend on the day ÷ leads it got that day. An average, not billed per lead. */
  estCost: number | null;
  currency: string;
  fields: Record<string, string[]>;
  status: LeadStatus;
  note: string | null;
  /** Last change to the status or note */
  statusUpdatedAt: string | null;
  statusUpdatedBy: { id: string; name: string } | null;
}

/** PATCH /leads/:leadId: set either or both; an empty note clears it. */
export interface UpdateLeadInput {
  status?: LeadStatus;
  note?: string | null;
}

/** One choice of a lead filter (ad set, ad, form) with how many leads it has in the current filter. */
export interface LeadFacet {
  id: string;
  name: string;
  count: number;
}

export interface LeadsResponse {
  total: number;
  page: number;
  pageSize: number;
  leads: LeadDTO[];
  summary: {
    total: number;
    /** Average of the estimated costs, over leads that have one */
    avgCost: number | null;
    totalCost: number | null;
    currency: string;
    /** How ad spend was converted into `currency` for the cost estimates. */
    fx?: FxInfo;
    withPhone: number;
    withEmail: number;
    organic: number;
  };
  /**
   * Leads per status, in workflow order. Counted with every filter except the status one,
   * so the status tabs keep their numbers while one is chosen.
   */
  byStatus: { status: LeadStatus; count: number }[];
  bySource: { source: string; count: number }[];
  /** How many leads each platform contributed in this response's filter. */
  byPlatform: { platform: Platform; count: number }[];
  /** Leads per hour of day (0-23) in the workspace timezone */
  byHour: number[];
  byDay: { date: string; count: number }[];
  byCampaign: { campaignId: string | null; name: string; count: number; cost: number | null }[];
  /** Ad sets, ads and forms in the current filter, most leads first (top 50 each), for the filter menus. */
  byAdGroup: LeadFacet[];
  byAd: LeadFacet[];
  byForm: LeadFacet[];
  /** Set when a connection could not read leads, e.g. it needs to be reconnected. */
  leadsError: string | null;
  timezone: string;
}
