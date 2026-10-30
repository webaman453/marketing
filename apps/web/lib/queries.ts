"use client";

import type {
  AdAccountDTO,
  AdMediaDTO,
  ArchivedWorkspaceDTO,
  AuditLogDTO,
  CampaignDetailResponse,
  CampaignListResponse,
  ConnectionDTO,
  EntityStatus,
  InvitationDTO,
  LeadDTO,
  LeadQuery,
  LeadsResponse,
  MeResponse,
  MemberDTO,
  OverviewResponse,
  Platform,
  PlatformInfo,
  UpdateLeadInput,
} from "@ashniva/shared";
import type {
  AiInsightsResponse,
  AiStatusDTO,
  AiWalletDTO,
  ApiKeyDTO,
  CreativeDTO,
  DraftDTO,
  NotificationDTO,
  NotificationPrefsDTO,
  ReportDTO,
  ReportResult,
  RuleDTO,
  RuleRunDTO,
  SpendBudgetInput,
  SpendOverviewDTO,
  UsageDTO,
} from "@ashniva/shared";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./api";
import { useDateRange } from "./date-range";

export const qk = {
  me: ["me"] as const,
  overview: (ws: string, from: string, to: string) => ["overview", ws, from, to] as const,
  campaigns: (ws: string, params: object) => ["campaigns", ws, params] as const,
  campaign: (ws: string, id: string, from: string, to: string) => ["campaign", ws, id, from, to] as const,
  workspaceAdAccounts: (ws: string) => ["workspace-ad-accounts", ws] as const,
  platforms: (org: string) => ["platforms", org] as const,
  connections: (org: string) => ["connections", org] as const,
  adAccounts: (org: string) => ["ad-accounts", org] as const,
  members: (org: string) => ["members", org] as const,
  invitations: (org: string) => ["invitations", org] as const,
  archivedWorkspaces: (org: string) => ["archived-workspaces", org] as const,
  notificationPrefs: ["notification-prefs"] as const,
  audit: (org: string, ws?: string) => ["audit", org, ws ?? "all"] as const,
};

export const useMe = () =>
  useQuery({ queryKey: qk.me, queryFn: () => api<MeResponse>("/auth/me"), staleTime: 60_000 });

export function useOverview(workspaceId: string, refetchInterval?: number) {
  const { from, to, ready } = useDateRange();
  return useQuery({
    queryKey: qk.overview(workspaceId, from, to),
    queryFn: () => api<OverviewResponse>(`/workspaces/${workspaceId}/overview`, { query: { from, to } }),
    enabled: ready,
    placeholderData: keepPreviousData,
    refetchInterval,
  });
}

export interface CampaignFilters {
  platform?: Platform;
  status?: EntityStatus;
  adAccountId?: string;
  search?: string;
}

export function useCampaigns(workspaceId: string, filters: CampaignFilters) {
  const { from, to, ready } = useDateRange();
  const params = { from, to, ...filters };
  return useQuery({
    queryKey: qk.campaigns(workspaceId, params),
    queryFn: () => api<CampaignListResponse>(`/workspaces/${workspaceId}/campaigns`, { query: { ...params } }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
}

export function useCampaign(workspaceId: string, campaignId: string) {
  const { from, to, ready } = useDateRange();
  return useQuery({
    queryKey: qk.campaign(workspaceId, campaignId, from, to),
    queryFn: () =>
      api<CampaignDetailResponse>(`/workspaces/${workspaceId}/campaigns/${campaignId}`, { query: { from, to } }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
}

export interface LeadFilters extends Omit<LeadQuery, "page" | "pageSize"> {
  page: number;
  /** Rows per page; 1 when only the summary counts are needed. */
  pageSize?: number;
}

export function useLeads(workspaceId: string, filters: LeadFilters, options?: { enabled?: boolean }) {
  const { from, to, ready } = useDateRange();
  const params = { from, to, ...filters };
  return useQuery({
    queryKey: ["leads", workspaceId, params],
    queryFn: () => api<LeadsResponse>(`/workspaces/${workspaceId}/leads`, { query: { ...params } }),
    enabled: ready && (options?.enabled ?? true),
    placeholderData: keepPreviousData,
  });
}

/**
 * Sets a lead's status and/or note. The lead changes in every cached list right away;
 * on failure the lists are put back. Counts and filtered lists refresh afterwards.
 */
export function useUpdateLead(workspaceId: string) {
  const queryClient = useQueryClient();
  type Snapshot = [QueryKey, LeadsResponse | undefined][];
  const patchLists = (id: string, patch: Partial<LeadDTO>) => {
    const snapshot: Snapshot = queryClient.getQueriesData<LeadsResponse>({ queryKey: ["leads", workspaceId] });
    for (const [key, data] of snapshot) {
      if (!data) continue;
      queryClient.setQueryData<LeadsResponse>(key, { ...data, leads: data.leads.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
    }
    return snapshot;
  };
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & UpdateLeadInput) =>
      api<LeadDTO>(`/workspaces/${workspaceId}/leads/${id}`, { method: "PATCH", body }),
    onMutate: async ({ id, ...body }) => {
      await queryClient.cancelQueries({ queryKey: ["leads", workspaceId] });
      return patchLists(id, body.note === undefined ? { status: body.status } : { ...body, note: body.note?.trim() || null });
    },
    onError: (_err, _vars, snapshot) => snapshot?.forEach(([key, data]) => queryClient.setQueryData(key, data)),
    // Only the workflow fields: the list keeps its own cost estimate.
    onSuccess: (saved) =>
      void patchLists(saved.id, { status: saved.status, note: saved.note, statusUpdatedAt: saved.statusUpdatedAt, statusUpdatedBy: saved.statusUpdatedBy }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["leads", workspaceId] }),
  });
}

export const useAdMedia = (workspaceId: string, adId: string | null) =>
  useQuery({
    queryKey: ["ad-media", workspaceId, adId],
    queryFn: () => api<AdMediaDTO>(`/workspaces/${workspaceId}/ads/${adId}/media`),
    enabled: Boolean(adId),
    // Media URLs expire, so never serve a stale copy for long.
    staleTime: 5 * 60_000,
  });

export const useWorkspaceAdAccounts = (workspaceId: string) =>
  useQuery({
    queryKey: qk.workspaceAdAccounts(workspaceId),
    queryFn: () =>
      api<{ id: string; name: string; externalId: string; platform: Platform; currency: string; timezone: string | null; sample: boolean; connected: boolean }[]>(`/workspaces/${workspaceId}/ad-accounts`),
  });

export type PlatformCatalogItem = PlatformInfo & {
  supported: boolean;
  configured: boolean;
  /** Connect asks for the organization's own API keys instead of a sign-in. */
  connectsWithCredentials?: boolean;
  /** The operator's own keys are set too (only the platform operator may connect with them). */
  operatorKeys?: boolean;
};

export const usePlatforms = (orgId: string) =>
  useQuery({
    queryKey: qk.platforms(orgId),
    queryFn: () => api<PlatformCatalogItem[]>(`/orgs/${orgId}/platforms`),
    staleTime: 5 * 60_000,
  });

export const useConnections = (orgId: string) =>
  useQuery({
    queryKey: qk.connections(orgId),
    queryFn: () => api<ConnectionDTO[]>(`/orgs/${orgId}/connections`),
    // Poll while any sync is in flight so status updates without a reload.
    refetchInterval: (q) =>
      q.state.data?.some((c) => c.syncStatus === "QUEUED" || c.syncStatus === "RUNNING") ? 2500 : false,
  });

export const useAdAccounts = (orgId: string) =>
  useQuery({ queryKey: qk.adAccounts(orgId), queryFn: () => api<AdAccountDTO[]>(`/orgs/${orgId}/ad-accounts`) });

export const useMembers = (orgId: string) =>
  useQuery({ queryKey: qk.members(orgId), queryFn: () => api<MemberDTO[]>(`/orgs/${orgId}/members`) });

export const useInvitations = (orgId: string, enabled = true) =>
  useQuery({
    queryKey: qk.invitations(orgId),
    queryFn: () => api<InvitationDTO[]>(`/orgs/${orgId}/invitations`),
    enabled,
  });

export const useArchivedWorkspaces = (orgId: string, enabled = true) =>
  useQuery({
    queryKey: qk.archivedWorkspaces(orgId),
    queryFn: () => api<ArchivedWorkspaceDTO[]>(`/orgs/${orgId}/workspaces/archived`),
    enabled,
  });

export const useNotificationPrefs = () =>
  useQuery({ queryKey: qk.notificationPrefs, queryFn: () => api<NotificationPrefsDTO>("/notifications/preferences") });

export const useAuditLog = (orgId: string, workspaceId?: string) =>
  useInfiniteQuery({
    queryKey: qk.audit(orgId, workspaceId),
    queryFn: ({ pageParam }) =>
      api<{ items: AuditLogDTO[]; nextCursor: string | null }>(`/orgs/${orgId}/audit-logs`, {
        query: { cursor: pageParam, workspaceId, limit: 30 },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

// ───────── Phase 2–4 ─────────



export const qk2 = {
  creatives: (ws: string) => ["creatives", ws] as const,
  drafts: (ws: string) => ["drafts", ws] as const,
  draft: (ws: string, id: string) => ["draft", ws, id] as const,
  reports: (ws: string) => ["reports", ws] as const,
  report: (ws: string, id: string) => ["report", ws, id] as const,
  reportData: (ws: string, id: string, from: string, to: string) => ["report-data", ws, id, from, to] as const,
  rules: (ws: string) => ["rules", ws] as const,
  rule: (ws: string, id: string) => ["rule", ws, id] as const,
  ruleRuns: (ws: string, id: string) => ["rule-runs", ws, id] as const,
  notifications: ["notifications"] as const,
  billing: (org: string) => ["billing", org] as const,
  apiKeys: (org: string) => ["api-keys", org] as const,
  aiStatus: (ws: string) => ["ai-status", ws] as const,
  aiWallet: (org: string) => ["ai-wallet", org] as const,
};

export const useCreatives = (ws: string) =>
  useQuery({ queryKey: qk2.creatives(ws), queryFn: () => api<CreativeDTO[]>(`/workspaces/${ws}/creatives`) });

export const useDrafts = (ws: string) =>
  useQuery({ queryKey: qk2.drafts(ws), queryFn: () => api<DraftDTO[]>(`/workspaces/${ws}/drafts`) });

export const useDraft = (ws: string, id: string | null) =>
  useQuery({
    queryKey: qk2.draft(ws, id ?? "none"),
    queryFn: () => api<DraftDTO>(`/workspaces/${ws}/drafts/${id}`),
    enabled: Boolean(id),
  });

export const useReports = (ws: string) =>
  useQuery({ queryKey: qk2.reports(ws), queryFn: () => api<ReportDTO[]>(`/workspaces/${ws}/reports`) });

export const useReport = (ws: string, id: string) =>
  useQuery({ queryKey: qk2.report(ws, id), queryFn: () => api<ReportDTO>(`/workspaces/${ws}/reports/${id}`) });

export const useReportData = (ws: string, id: string, range?: { from: string; to: string }) =>
  useQuery({
    queryKey: qk2.reportData(ws, id, range?.from ?? "", range?.to ?? ""),
    queryFn: () => api<ReportResult>(`/workspaces/${ws}/reports/${id}/data`, { query: range }),
    placeholderData: keepPreviousData,
  });

export const useRules = (ws: string) =>
  useQuery({ queryKey: qk2.rules(ws), queryFn: () => api<RuleDTO[]>(`/workspaces/${ws}/rules`) });

export const useRule = (ws: string, id: string) =>
  useQuery({ queryKey: qk2.rule(ws, id), queryFn: () => api<RuleDTO>(`/workspaces/${ws}/rules/${id}`) });

export const useRuleRuns = (ws: string, id: string) =>
  useQuery({ queryKey: qk2.ruleRuns(ws, id), queryFn: () => api<RuleRunDTO[]>(`/workspaces/${ws}/rules/${id}/runs`) });

/** The signed-in user's notifications in one organization (all of them when orgId is omitted). */
export const useNotifications = (orgId?: string) =>
  useQuery({
    // Prefixed by qk2.notifications, so invalidating that refreshes every org's list.
    queryKey: [...qk2.notifications, orgId ?? "all"],
    queryFn: () => api<{ unread: number; items: NotificationDTO[] }>("/notifications", { query: orgId ? { orgId } : undefined }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export interface BillingInfo {
  plan: "TRIAL" | "STARTER" | "GROWTH" | "AGENCY";
  subscriptionStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  provider: string | null;
  usage: UsageDTO;
  limits: { workspaces: number | null; adAccounts: number | null; members: number | null };
  checkoutEnabled: boolean;
  razorpayKeyId: string | null;
}

export const useBilling = (org: string) =>
  useQuery({ queryKey: qk2.billing(org), queryFn: () => api<BillingInfo>(`/orgs/${org}/billing`) });

export const useApiKeys = (org: string, enabled = true) =>
  useQuery({ queryKey: qk2.apiKeys(org), queryFn: () => api<ApiKeyDTO[]>(`/orgs/${org}/api-keys`), enabled });

export const useAiStatus = (ws: string) =>
  useQuery({
    queryKey: qk2.aiStatus(ws),
    queryFn: () => api<AiStatusDTO>(`/workspaces/${ws}/ai/status`),
    staleTime: 60_000,
  });

export const useAiWallet = (org: string) =>
  useQuery({ queryKey: qk2.aiWallet(org), queryFn: () => api<AiWalletDTO>(`/orgs/${org}/ai/wallet`) });

export type { AiInsightsResponse };

// ───────── Spend & billing ─────────

export const spendKey = (ws: string) => ["spend", ws] as const;

export const useSpend = (workspaceId: string) =>
  useQuery({ queryKey: spendKey(workspaceId), queryFn: () => api<SpendOverviewDTO>(`/workspaces/${workspaceId}/spend`) });

/** Monthly budget of one ad account; `monthlyLimit: null` removes it. */
export function useSetSpendBudget(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, ...body }: SpendBudgetInput & { accountId: string }) =>
      api(`/workspaces/${workspaceId}/ad-accounts/${accountId}/spend-budget`, { method: "PUT", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spendKey(workspaceId) }),
  });
}

export function useRefreshBilling(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api(`/workspaces/${workspaceId}/ad-accounts/${accountId}/billing/refresh`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spendKey(workspaceId) }),
  });
}

/** The platform's own account spending limit (Meta spend cap, Google account budget); null removes it. */
export function useSetSpendLimit(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, amount }: { accountId: string; amount: number | null }) =>
      api(`/workspaces/${workspaceId}/ad-accounts/${accountId}/spend-limit`, { method: "PUT", body: { amount } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spendKey(workspaceId) }),
  });
}
