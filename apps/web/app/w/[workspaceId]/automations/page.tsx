"use client";

import { RULE_TEMPLATES, type RuleDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Clock, Plus, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { describeAction, describeConditions } from "@/components/automations/rule-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useRules } from "@/lib/queries";

export default function AutomationsPage() {
  const { workspace, can } = useWorkspace();
  const rules = useRules(workspace.id);
  const queryClient = useQueryClient();
  const router = useRouter();
  const canEdit = can("campaigns:edit");

  async function toggle(r: RuleDTO) {
    queryClient.setQueryData<RuleDTO[]>(qk2.rules(workspace.id), (list) => list?.map((x) => (x.id === r.id ? { ...x, isActive: !x.isActive } : x)));
    try {
      await api(`/workspaces/${workspace.id}/rules/${r.id}/toggle`, { method: "POST" });
      toast.success(r.isActive ? "Rule paused" : "Rule activated", { description: r.name });
    } catch (err) {
      toastError(err);
    } finally {
      void queryClient.invalidateQueries({ queryKey: qk2.rules(workspace.id) });
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Automations"
        description="Rules that watch your campaigns around the clock and act when your thresholds are crossed."
        actions={canEdit && <Button asChild><Link href={`/w/${workspace.id}/automations/new`}><Plus /> New rule</Link></Button>}
      />

      {rules.isError ? (
        <Card><ErrorState message={rules.error.message} onRetry={() => rules.refetch()} /></Card>
      ) : !rules.data ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : rules.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Bot}
            title="No automation rules yet"
            description="Pause poor performers, scale winners and get alerts, automatically."
            action={canEdit && <Button asChild><Link href={`/w/${workspace.id}/automations/new`}><Plus /> Create a rule</Link></Button>}
          />
          <div className="grid gap-3 border-t p-5 md:grid-cols-3">
            {RULE_TEMPLATES.map((t) => (
              <div key={t.name} className="rounded-lg border p-4">
                <p className="text-sm font-medium">{t.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.data.map((r, i) => (
            <Card
              key={r.id}
              className="cursor-pointer gap-0 p-0 transition-all animate-fade-up hover:border-primary/40 hover:shadow-sm"
              style={{ animationDelay: `${i * 35}ms` }}
              onClick={() => router.push(`/w/${workspace.id}/automations/${r.id}`)}
            >
              <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
                <span className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${r.isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
                  <Zap className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{r.name}</h3>
                    <Badge variant="secondary" className="text-[10px]">{r.frequency === "HOURLY" ? "Hourly" : "Daily"}</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    If {describeConditions(r.conditions, r.conditionLogic, workspace.currency)} ({r.lookbackDays}d) → {r.actions.map((a) => describeAction(a, workspace.currency).toLowerCase()).join(", ")}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="size-3" />
                    {r.lastRun
                      ? `Last run ${timeAgo(r.lastRun.startedAt)} · ${r.lastRun.matched} matched${r.lastRun.status === "FAILED" ? " · failed" : ""}`
                      : "Hasn't run yet"}
                  </p>
                </div>
                {canEdit && (
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">{r.isActive ? "Active" : "Paused"}</span>
                    <Switch checked={r.isActive} onCheckedChange={() => toggle(r)} />
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
