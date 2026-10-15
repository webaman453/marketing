"use client";

import type { CampaignRowDTO } from "@ashniva/shared";
import { AlertCircle, Loader2 } from "lucide-react";
import { useState } from "react";
import { FormField } from "@/components/form-field";
import { PlatformLabel } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { money } from "@/lib/format";
import { useSetCampaignBudget } from "./use-campaign-actions";

export function BudgetDialog({
  campaign,
  workspaceId,
  onOpenChange,
}: {
  campaign: CampaignRowDTO | null;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!campaign} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed so the form starts fresh for each campaign. */}
        {campaign && (
          <BudgetForm
            key={campaign.id}
            campaign={campaign}
            workspaceId={workspaceId}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BudgetForm({
  campaign,
  workspaceId,
  onDone,
}: {
  campaign: CampaignRowDTO;
  workspaceId: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(campaign.dailyBudget != null ? String(campaign.dailyBudget) : "");
  const mutation = useSetCampaignBudget(workspaceId);
  const onOpenChange = (open: boolean) => !open && onDone();
  const amount = Number(value);
  const valid = value !== "" && Number.isFinite(amount) && amount > 0;
  const change = campaign.dailyBudget ? (amount - campaign.dailyBudget) / campaign.dailyBudget : null;
  const symbol = money(0, campaign.currency).replace(/[\d.,\s]/g, "");

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit daily budget</DialogTitle>
        <DialogDescription className="space-y-1">
          <span className="block truncate font-medium text-foreground">{campaign.name}</span>
          <PlatformLabel platform={campaign.platform} className="text-xs" />
        </DialogDescription>
      </DialogHeader>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          mutation.mutate({ id: campaign.id, dailyBudget: amount }, { onSuccess: onDone });
        }}
      >
        <FormField
          id="budget"
          label={`Daily budget (${campaign.currency})`}
          hint={
            campaign.dailyBudget != null
              ? `Currently ${money(campaign.dailyBudget, campaign.currency)} per day`
              : "This campaign has no campaign-level daily budget yet."
          }
        >
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
              {symbol}
            </span>
            <Input
              id="budget"
              type="number"
              inputMode="decimal"
              min={1}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-10 pl-8 tabular"
              autoFocus
            />
          </div>
        </FormField>

        {valid && change != null && Math.abs(change) >= 0.5 && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
            This is a {change > 0 ? "increase" : "decrease"} of {Math.abs(change * 100).toFixed(0)}%. Large changes can
            send the campaign back into the platform&apos;s learning phase.
          </p>
        )}

        {mutation.isError && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {errorMessage(mutation.error)}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || mutation.isPending || amount === campaign.dailyBudget}>
            {mutation.isPending && <Loader2 className="animate-spin" />}
            Save budget
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
