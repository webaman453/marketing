"use client";

import { PLATFORM_INFO, SPEND_ALERT_PERCENTS, money, type SpendAccountDTO } from "@ashniva/shared";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useSetSpendBudget, useSetSpendLimit } from "@/lib/queries";

/** A positive amount typed with or without thousands separators; null when blank or invalid. */
export function parseAmount(raw: string): number | null {
  const v = Number(raw.replace(/[,\s]/g, ""));
  return raw.trim() && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

/** Rendered per account (keyed by its id), so the form starts from that account's values. */
export function BudgetDialog({
  workspaceId,
  account,
  onOpenChange,
}: {
  workspaceId: string;
  account: SpendAccountDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSetSpendBudget(workspaceId);
  const [amount, setAmount] = useState(account.budget ? String(account.budget.monthlyLimit) : "");
  const [alertPercent, setAlertPercent] = useState(account.budget?.alertPercent ?? 80);
  const [pauseAtLimit, setPauseAtLimit] = useState(account.budget?.pauseAtLimit ?? false);
  const [touched, setTouched] = useState(false);

  const value = parseAmount(amount);
  const invalid = touched && value == null;
  const platform = PLATFORM_INFO[account.platform].name;

  const submit = (monthlyLimit: number | null) =>
    save.mutate(
      { accountId: account.id, monthlyLimit, alertPercent, pauseAtLimit },
      {
        onSuccess: () => {
          toast.success(monthlyLimit == null ? "Monthly budget removed" : "Monthly budget saved", { description: account.name });
          onOpenChange(false);
        },
        onError: (err) => toast.error("Couldn't save the budget", { description: errorMessage(err) }),
      },
    );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Monthly budget</DialogTitle>
          <DialogDescription>
            {account.name} · {platform}. Spent {money(account.monthSpend, account.currency)} so far this month.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (value != null) submit(value);
          }}
        >
          <FormField
            id="budget-amount"
            label={`Budget per month (${account.currency})`}
            error={invalid ? { message: "Enter an amount above zero." } : undefined}
            hint="Counted in the ad account's timezone, from the 1st of each month."
          >
            <Input
              id="budget-amount"
              inputMode="decimal"
              autoFocus
              placeholder="50000"
              value={amount}
              aria-invalid={invalid}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <FormField id="budget-alert" label="Alert me at">
            <Select value={String(alertPercent)} onValueChange={(v) => setAlertPercent(Number(v))}>
              <SelectTrigger id="budget-alert" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPEND_ALERT_PERCENTS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {p}% of the budget
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
            <div className="space-y-1">
              <Label htmlFor="budget-pause" className="text-[13px]">
                Pause campaigns at the budget
              </Label>
              <p className="text-xs text-muted-foreground">
                When this month&apos;s spend reaches the budget, running campaigns on this account are paused on {platform}. They stay
                paused until you resume them.
              </p>
            </div>
            <Switch id="budget-pause" checked={pauseAtLimit} onCheckedChange={setPauseAtLimit} />
          </div>
          <p className="text-xs text-muted-foreground">
            Spend arrives with each sync, so a pause can land a little after the budget is reached. For a hard stop, also set the
            platform&apos;s own spending limit where it has one.
          </p>
          <DialogFooter className="gap-2 sm:justify-between">
            {account.budget ? (
              <Button type="button" variant="ghost" className="text-destructive" disabled={save.isPending} onClick={() => submit(null)}>
                Remove budget
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Save budget
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const LIMIT_COPY = {
  spend_cap: {
    title: "Account spending limit",
    body: "Meta stops every ad on this account once its total spend reaches the limit, until you raise or remove it. Only spend after you set it counts.",
  },
  account_budget: {
    title: "Account budget",
    body: "Google stops serving ads on this account once the account budget is used. Accounts paid by card don't have one; Google may take a few minutes to approve a change.",
  },
} as const;

export function SpendLimitDialog({
  workspaceId,
  account,
  onOpenChange,
}: {
  workspaceId: string;
  account: SpendAccountDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSetSpendLimit(workspaceId);
  const [amount, setAmount] = useState(account.platformBilling?.spendLimit ? String(account.platformBilling.spendLimit) : "");
  const [touched, setTouched] = useState(false);

  if (!account.accountLimit) return null;
  const copy = LIMIT_COPY[account.accountLimit];
  const value = parseAmount(amount);
  const invalid = touched && value == null;
  const current = account.platformBilling?.spendLimit ?? null;

  const submit = (limit: number | null) =>
    save.mutate(
      { accountId: account.id, amount: limit },
      {
        onSuccess: () => {
          toast.success(limit == null ? "Spending limit removed" : "Spending limit set", {
            description: `${account.name} · ${PLATFORM_INFO[account.platform].name}`,
          });
          onOpenChange(false);
        },
        onError: (err) => toast.error("The platform didn't accept the change", { description: errorMessage(err) }),
      },
    );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (value != null) submit(value);
          }}
        >
          <FormField
            id="limit-amount"
            label={`Limit (${account.currency})`}
            error={invalid ? { message: "Enter an amount above zero." } : undefined}
            hint={
              current != null && account.platformBilling?.spentTowardLimit != null
                ? `Now ${money(current, account.currency)}, of which ${money(account.platformBilling.spentTowardLimit, account.currency)} is spent.`
                : "No limit is set on the platform now."
            }
          >
            <Input
              id="limit-amount"
              inputMode="decimal"
              autoFocus
              placeholder="100000"
              value={amount}
              aria-invalid={invalid}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <DialogFooter className="gap-2 sm:justify-between">
            {current != null ? (
              <Button type="button" variant="ghost" className="text-destructive" disabled={save.isPending} onClick={() => submit(null)}>
                Remove limit
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Set on {PLATFORM_INFO[account.platform].name}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
