"use client";

import type { CampaignDetailResponse, CampaignListResponse, EntityStatus } from "@ashniva/shared";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, errorMessage } from "@/lib/api";
import { toastError } from "@/lib/forms";

type Snapshot = [QueryKey, unknown][];

/** Applies `patch` to a campaign wherever it appears in cached lists/detail; returns a snapshot for rollback. */
function patchCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  ids: Set<string>,
  patch: { status?: EntityStatus; dailyBudget?: number },
): Snapshot {
  const snapshot: Snapshot = [];
  for (const [key, data] of queryClient.getQueriesData<CampaignListResponse>({ queryKey: ["campaigns"] })) {
    if (!data) continue;
    snapshot.push([key, data]);
    queryClient.setQueryData<CampaignListResponse>(key, {
      ...data,
      campaigns: data.campaigns.map((c) => (ids.has(c.id) ? { ...c, ...patch } : c)),
    });
  }
  for (const [key, data] of queryClient.getQueriesData<CampaignDetailResponse>({ queryKey: ["campaign"] })) {
    if (!data || !ids.has(data.campaign.id)) continue;
    snapshot.push([key, data]);
    queryClient.setQueryData<CampaignDetailResponse>(key, { ...data, campaign: { ...data.campaign, ...patch } });
  }
  return snapshot;
}

const restore = (queryClient: ReturnType<typeof useQueryClient>, snapshot?: Snapshot) =>
  snapshot?.forEach(([key, data]) => queryClient.setQueryData(key, data));

const refreshAll = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all(
    ["campaigns", "campaign", "overview", "audit"].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
  );

export function useSetCampaignStatus(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; name: string; status: "ACTIVE" | "PAUSED" }) =>
      api(`/workspaces/${workspaceId}/campaigns/${id}/status`, { method: "PATCH", body: { status } }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ["campaigns"] });
      return patchCaches(queryClient, new Set([id]), { status });
    },
    onError: (err, vars, snapshot) => {
      restore(queryClient, snapshot);
      if (err instanceof ApiError && err.status === 402) toastError(err);
      else toast.error(`Couldn't update “${vars.name}”`, { description: errorMessage(err) });
    },
    onSuccess: (_d, { name, status }) => {
      toast.success(status === "PAUSED" ? "Campaign paused" : "Campaign activated", { description: name });
    },
    onSettled: () => refreshAll(queryClient),
  });
}

export function useSetCampaignBudget(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dailyBudget }: { id: string; dailyBudget: number }) =>
      api(`/workspaces/${workspaceId}/campaigns/${id}/budget`, { method: "PATCH", body: { dailyBudget } }),
    onSuccess: (_d, { id, dailyBudget }) => {
      patchCaches(queryClient, new Set([id]), { dailyBudget });
      toast.success("Daily budget updated");
      void refreshAll(queryClient);
    },
  });
}

export function useBulkCampaignStatus(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: "ACTIVE" | "PAUSED" }) =>
      api<{ updated: number; failed: { id: string; name: string; error: string }[] }>(
        `/workspaces/${workspaceId}/campaigns/bulk-status`,
        { method: "POST", body: { campaignIds: ids, status } },
      ),
    onMutate: async ({ ids, status }) => {
      await queryClient.cancelQueries({ queryKey: ["campaigns"] });
      return patchCaches(queryClient, new Set(ids), { status });
    },
    onError: (err, _vars, snapshot) => {
      restore(queryClient, snapshot);
      if (err instanceof ApiError && err.status === 402) toastError(err);
      else toast.error("Bulk update failed", { description: errorMessage(err) });
    },
    onSuccess: (res, { status }) => {
      const verb = status === "PAUSED" ? "paused" : "activated";
      if (res.failed.length === 0) {
        toast.success(`${res.updated} ${res.updated === 1 ? "campaign" : "campaigns"} ${verb}`);
      } else {
        toast.warning(`${res.updated} ${verb}, ${res.failed.length} failed`, {
          description: res.failed
            .slice(0, 3)
            .map((f) => `${f.name}: ${f.error}`)
            .join("\n"),
        });
      }
    },
    onSettled: () => refreshAll(queryClient),
  });
}
