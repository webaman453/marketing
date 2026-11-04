"use client";

import { ANOMALY_DEAD_DAYS, ANOMALY_SPIKE_RATIOS, type AnomalySettingsDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { SettingsCard } from "@/components/settings/settings-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { toastError } from "@/lib/forms";
import { qk2, useAnomalySettings } from "@/lib/queries";

const SENSITIVITY: Record<number, string> = {
  1.5: "Sensitive: 1.5× the recent daily average",
  2: "Normal: 2× the recent daily average",
  3: "Relaxed: 3× the recent daily average",
};

/** How touchy the unusual-spend alerts are for this workspace, or off. Each change saves at once. */
export function AnomalySettingsCard() {
  const { workspace, can } = useWorkspace();
  const settings = useAnomalySettings(workspace.id);
  const queryClient = useQueryClient();
  const canEdit = can("workspaces:manage");

  async function save(patch: Partial<AnomalySettingsDTO>) {
    const before = settings.data;
    if (!before) return;
    const next = { ...before, ...patch };
    queryClient.setQueryData(qk2.anomalySettings(workspace.id), next);
    try {
      queryClient.setQueryData(qk2.anomalySettings(workspace.id), await api<AnomalySettingsDTO>(`/workspaces/${workspace.id}/anomaly-settings`, { method: "PUT", body: next }));
      toast.success("Saved");
    } catch (err) {
      queryClient.setQueryData(qk2.anomalySettings(workspace.id), before);
      toastError(err);
    }
  }

  return (
    <SettingsCard
      title="Unusual spend alerts"
      description="We watch each running campaign for a sudden jump in spend, and for spend that stops recording conversions. You can also mute one campaign from its page, or straight from an alert."
    >
      {!settings.data ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="space-y-5">
          <label htmlFor="anomaly-enabled" className="flex cursor-pointer items-center justify-between gap-6">
            <span>
              <span className="block text-sm font-medium">Alert me about unusual spend</span>
              <span className="block text-xs text-muted-foreground">Turn off to stop these alerts for every campaign in this workspace.</span>
            </span>
            <Switch id="anomaly-enabled" checked={settings.data.enabled} disabled={!canEdit} onCheckedChange={(enabled) => void save({ enabled })} />
          </label>
          {settings.data.enabled && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="anomaly-ratio" label="Spend jump">
                <Select value={String(settings.data.spikeRatio)} disabled={!canEdit} onValueChange={(v) => void save({ spikeRatio: Number(v) })}>
                  <SelectTrigger id="anomaly-ratio" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{ANOMALY_SPIKE_RATIOS.map((r) => <SelectItem key={r} value={String(r)}>{SENSITIVITY[r]}</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
              <FormField id="anomaly-days" label="Spending without conversions">
                <Select value={String(settings.data.deadDays)} disabled={!canEdit} onValueChange={(v) => void save({ deadDays: Number(v) })}>
                  <SelectTrigger id="anomaly-days" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{ANOMALY_DEAD_DAYS.map((d) => <SelectItem key={d} value={String(d)}>After {d} days in a row</SelectItem>)}</SelectContent>
                </Select>
              </FormField>
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
