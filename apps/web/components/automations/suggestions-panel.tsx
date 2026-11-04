"use client";

import { PLATFORM_INFO, type RuleSuggestionDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useRuleSuggestions } from "@/lib/queries";
import { describeAction } from "./rule-text";

/** What rules in "ask me first" mode want to do, waiting for a yes or no. Renders nothing when there are none. */
export function SuggestionsPanel() {
  const { workspace, can } = useWorkspace();
  const suggestions = useRuleSuggestions(workspace.id);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const canEdit = can("campaigns:edit");
  const list = suggestions.data ?? [];
  if (list.length === 0) return null;

  async function decide(s: RuleSuggestionDTO, verb: "approve" | "dismiss") {
    setBusy(s.id);
    try {
      await api(`/workspaces/${workspace.id}/rule-suggestions/${s.id}/${verb}`, { method: "POST" });
      toast.success(verb === "approve" ? "Applied" : "Dismissed", { description: s.campaignName });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk2.ruleSuggestions(workspace.id) }),
        queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
      ]);
    }
  }

  return (
    <Card className="gap-0 p-0" data-testid="rule-suggestions">
      <div className="border-b px-5 py-4">
        <h2 className="font-semibold">Waiting for your approval</h2>
        <p className="text-sm text-muted-foreground">
          {list.length} {list.length === 1 ? "change" : "changes"} suggested by your rules. Nothing happens on the platform until you approve.
        </p>
      </div>
      <ul className="divide-y">
        {list.map((s) => (
          <li key={s.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <PlatformIcon platform={s.platform} size="md" />
              <div className="min-w-0">
                <Link href={`/w/${workspace.id}/campaigns/${s.campaignId}`} className="block truncate text-sm font-medium hover:underline">
                  {s.campaignName}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {PLATFORM_INFO[s.platform].name} · {s.actions.map((a) => describeAction(a, workspace.currency).toLowerCase()).join(", ")} · from “{s.ruleName}” {timeAgo(s.createdAt)}
                </p>
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => decide(s, "approve")} disabled={busy === s.id}>
                  {busy === s.id ? <Loader2 className="animate-spin" /> : <Check />} Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => decide(s, "dismiss")} disabled={busy === s.id}>
                  <X /> Dismiss
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
