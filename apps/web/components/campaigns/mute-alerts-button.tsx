"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { longDate } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2 } from "@/lib/queries";

const CHOICES = [1, 7, 30] as const;

/** Mutes this campaign's unusual-spend alerts for a while, or turns them back on. */
export function MuteAlertsButton({ campaignId }: { campaignId: string }) {
  const { workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const key = qk2.anomalySnooze(workspace.id, campaignId);
  const base = `/workspaces/${workspace.id}/campaigns/${campaignId}/anomaly-snooze`;
  const snooze = useQuery({ queryKey: key, queryFn: () => api<{ until: string | null }>(base) });
  if (!can("campaigns:edit")) return null;
  const until = snooze.data?.until ?? null;

  async function change(days: number | null) {
    try {
      if (days === null) await api(base, { method: "DELETE" });
      else await api(base, { method: "POST", body: { days } });
      toast.success(days === null ? "Unusual-spend alerts are back on" : `Unusual-spend alerts muted for ${days === 1 ? "a day" : `${days} days`}`);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="bg-card" aria-label="Unusual-spend alerts for this campaign">
          {until ? <BellOff /> : <BellRing />} {until ? `Muted until ${longDate(until)}` : "Alerts on"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {CHOICES.map((d) => (
          <DropdownMenuItem key={d} onSelect={() => void change(d)}>
            Mute for {d === 1 ? "a day" : `${d} days`}
          </DropdownMenuItem>
        ))}
        {until && <DropdownMenuItem onSelect={() => void change(null)}>Turn alerts back on</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
