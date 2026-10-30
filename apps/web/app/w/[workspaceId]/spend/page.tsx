"use client";

import { PLATFORM_INFO, budgetUsed, money, type BillingHealth, type SpendAccountDTO } from "@ashniva/shared";
import { AlertTriangle, CircleCheck, ExternalLink, Loader2, MoreHorizontal, OctagonX, PauseCircle, RefreshCw, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon, PlatformLabel } from "@/components/platform-icon";
import { BudgetDialog, SpendLimitDialog } from "@/components/spend/spend-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useRefreshBilling, useSpend } from "@/lib/queries";
import { cn } from "@/lib/utils";

const monthLabel = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** Bar colour by how much of the budget is used. */
const usedTone = (used: number | null) =>
  used == null ? "bg-primary" : used >= 1 ? "bg-destructive" : used >= 0.8 ? "bg-amber-500" : "bg-emerald-500";

function UsageBar({ used, className }: { used: number | null; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)} role="presentation">
      <div className={cn("h-full rounded-full transition-all", usedTone(used))} style={{ width: `${Math.min(100, Math.round((used ?? 0) * 100))}%` }} />
    </div>
  );
}

const HEALTH: Record<BillingHealth, { label: string; icon: typeof CircleCheck; className: string }> = {
  ok: { label: "Billing OK", icon: CircleCheck, className: "text-emerald-600 dark:text-emerald-400" },
  attention: { label: "Needs a look", icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
  blocked: { label: "Ads stopped", icon: OctagonX, className: "text-destructive" },
  unknown: { label: "Status unknown", icon: AlertTriangle, className: "text-muted-foreground" },
};

export default function SpendPage() {
  const { workspace, can } = useWorkspace();
  const spend = useSpend(workspace.id);
  const refresh = useRefreshBilling(workspace.id);
  const [budgetFor, setBudgetFor] = useState<SpendAccountDTO | null>(null);
  const [limitFor, setLimitFor] = useState<SpendAccountDTO | null>(null);
  const canEdit = can("campaigns:edit");
  const canLimit = can("integrations:manage");
  const data = spend.data;
  const currency = data?.currency ?? workspace.currency;
  const attention = data?.accounts.filter((a) => a.platformBilling && a.platformBilling.health !== "ok" && a.platformBilling.health !== "unknown") ?? [];

  const refreshBilling = (a: SpendAccountDTO) =>
    refresh.mutate(a.id, {
      onSuccess: () => toast.success("Billing refreshed", { description: a.name }),
      onError: (err) => toast.error("Couldn't read billing", { description: errorMessage(err) }),
    });

  const rowProps = (a: SpendAccountDTO): AccountProps => ({
    account: a,
    canEdit,
    canLimit,
    refreshing: refresh.isPending && refresh.variables === a.id,
    onBudget: () => setBudgetFor(a),
    onLimit: () => setLimitFor(a),
    onRefresh: () => refreshBilling(a),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Spend & billing"
        description="Budgets and spend for every ad account. Payment stays on each platform: open its billing page to pay or change the card."
      />

      {spend.isError ? (
        <Card>
          <ErrorState message={spend.error.message} onRetry={() => spend.refetch()} />
        </Card>
      ) : !data ? (
        <SpendSkeleton />
      ) : data.accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={Wallet}
            title="No ad accounts in this workspace"
            description="Connect an ad platform and assign its accounts to this workspace to track spend and set budgets."
            action={
              <Button asChild>
                <Link href={`/w/${workspace.id}/integrations`}>Go to Integrations</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {attention.length > 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5 p-4">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="space-y-1 text-sm">
                  <p className="font-medium">
                    {attention.length === 1 ? "1 ad account needs" : `${attention.length} ad accounts need`} attention on its platform
                  </p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {attention.map((a) => (
                      <li key={a.id}>
                        {a.name} ({PLATFORM_INFO[a.platform].name}): {a.platformBilling?.note ?? "Check the platform's billing."}{" "}
                        {a.billingUrl && (
                          <a href={a.billingUrl} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-4 hover:underline">
                            Open billing
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label={`Spent in ${monthLabel(data.month)}`} value={money(data.totals.monthSpend, currency)} sub={!data.converted && hasOtherCurrencies(data.accounts, currency) ? "Other currencies not converted" : undefined} />
            <Stat
              label="Monthly budgets"
              value={data.totals.monthlyBudget == null ? "Not set" : money(data.totals.monthlyBudget, currency)}
              sub={data.totals.monthlyBudget == null ? "Set a budget per ad account below" : `${Math.round((budgetUsed(data.totals.monthSpend, data.totals.monthlyBudget) ?? 0) * 100)}% used`}
              bar={budgetUsed(data.totals.monthSpend, data.totals.monthlyBudget)}
            />
            <Stat label="Projected month end" value={money(data.totals.projectedMonthSpend, currency)} sub="At this month's daily average" />
          </div>

          <Card className="p-5">
            <h2 className="text-sm font-semibold">Spend by platform</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">How this month&apos;s spend splits across platforms, in {currency}.</p>
            <div className="mt-4 space-y-3">
              {data.platforms.map((p) => {
                const used = budgetUsed(p.monthSpend, p.monthlyBudget);
                return (
                  <div key={p.platform} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
                    <PlatformLabel platform={p.platform} className="text-sm" />
                    <div className="order-3 col-span-2 sm:order-none sm:col-span-1">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${Math.max(p.share * 100, p.monthSpend > 0 ? 1 : 0)}%`, backgroundColor: PLATFORM_INFO[p.platform].color }} />
                      </div>
                    </div>
                    <div className="text-right text-sm tabular-nums">
                      <span className="font-medium">{money(p.monthSpend, currency)}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{Math.round(p.share * 100)}%</span>
                      {p.monthlyBudget != null && (
                        <div className={cn("text-xs", used != null && used >= 1 ? "text-destructive" : "text-muted-foreground")}>
                          of {money(p.monthlyBudget, currency)} budget
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="border-b px-5 py-4">
              <h2 className="text-sm font-semibold">Ad accounts</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Amounts are in each account&apos;s own currency. Each platform bills its own account: pay there with its card, invoice or
                prepaid balance.
              </p>
            </div>
            <div className="divide-y md:hidden">
              {data.accounts.map((a) => (
                <AccountCard key={a.id} {...rowProps(a)} />
              ))}
            </div>
            <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Account</TableHead>
                  <TableHead>This month</TableHead>
                  <TableHead>Platform billing</TableHead>
                  <TableHead className="pr-5 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.accounts.map((a) => (
                  <AccountRow key={a.id} {...rowProps(a)} />
                ))}
              </TableBody>
            </Table>
            </div>
          </Card>
        </>
      )}

      {budgetFor && <BudgetDialog key={budgetFor.id} workspaceId={workspace.id} account={budgetFor} onOpenChange={(o) => !o && setBudgetFor(null)} />}
      {limitFor && <SpendLimitDialog key={limitFor.id} workspaceId={workspace.id} account={limitFor} onOpenChange={(o) => !o && setLimitFor(null)} />}
    </div>
  );
}

const hasOtherCurrencies = (accounts: SpendAccountDTO[], currency: string) => accounts.some((a) => a.currency !== currency);

function Stat({ label, value, sub, bar }: { label: string; value: string; sub?: string; bar?: number | null }) {
  return (
    <Card className="gap-1 p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
      {bar !== undefined && bar !== null && <UsageBar used={bar} className="mt-1" />}
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

interface AccountProps {
  account: SpendAccountDTO;
  canEdit: boolean;
  canLimit: boolean;
  refreshing: boolean;
  onBudget: () => void;
  onLimit: () => void;
  onRefresh: () => void;
}

function AccountName({ account: a }: { account: SpendAccountDTO }) {
  return (
    <div className="flex items-start gap-2.5">
      <PlatformIcon platform={a.platform} size="sm" className="mt-0.5" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium">{a.name}</span>
          {a.sample && <Badge variant="secondary">Sample</Badge>}
        </div>
        <div className="text-xs break-all text-muted-foreground">
          {PLATFORM_INFO[a.platform].name} · {a.externalId} · {a.activeCampaigns} running
        </div>
      </div>
    </div>
  );
}

function MonthSpend({ account: a }: { account: SpendAccountDTO }) {
  const used = budgetUsed(a.monthSpend, a.budget?.monthlyLimit);
  return (
    <div>
      <div className="tabular-nums">
        <span className="font-medium">{money(a.monthSpend, a.currency)}</span>
        {a.budget && <span className="text-muted-foreground"> / {money(a.budget.monthlyLimit, a.currency)}</span>}
      </div>
      {a.budget ? (
        <>
          <UsageBar used={used} className="my-1.5 max-w-48" />
          <div className="text-xs text-muted-foreground">
            {Math.round((used ?? 0) * 100)}% used · alert at {a.budget.alertPercent}%{a.budget.pauseAtLimit ? " · pauses at budget" : ""}
          </div>
          {a.budget.pausedAt && (
            <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
              <PauseCircle className="size-3.5" /> Campaigns paused {timeAgo(a.budget.pausedAt)}
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-muted-foreground">No monthly budget</div>
      )}
      <div className="mt-0.5 text-xs text-muted-foreground">Projected {money(a.projectedMonthSpend, a.currency)}</div>
    </div>
  );
}

function PlatformBilling({ account: a }: { account: SpendAccountDTO }) {
  const billing = a.platformBilling;
  if (!billing) {
    return (
      <span className="text-xs text-muted-foreground">
        {a.readsBilling ? "Not checked yet. It updates with the next sync." : `${PLATFORM_INFO[a.platform].name} doesn't share billing with apps.`}
      </span>
    );
  }
  const health = HEALTH[billing.health];
  return (
    <div className="space-y-0.5 text-xs">
      <div className={cn("flex items-center gap-1 text-[13px] font-medium", health.className)}>
        <health.icon className="size-3.5" /> {health.label}
      </div>
      {billing.note && <div className="text-muted-foreground">{billing.note}</div>}
      {billing.spendLimit != null && (
        <div className="text-muted-foreground">
          Limit {money(billing.spendLimit, a.currency)}
          {billing.spentTowardLimit != null && <> · {money(billing.spentTowardLimit, a.currency)} used</>}
        </div>
      )}
      {billing.balanceDue != null && billing.balanceDue > 0 && <div className="text-muted-foreground">Due {money(billing.balanceDue, a.currency)}</div>}
      {billing.fundsRemaining != null && <div className="text-muted-foreground">Funds left {money(billing.fundsRemaining, a.currency)}</div>}
      <div className="text-muted-foreground/80">Checked {timeAgo(billing.fetchedAt)}</div>
    </div>
  );
}

function AccountActions({ account: a, canEdit, canLimit, refreshing, onBudget, onLimit, onRefresh }: AccountProps) {
  const platform = PLATFORM_INFO[a.platform].name;
  const showMenu = (canEdit && a.readsBilling) || (canLimit && a.accountLimit);
  return (
    <div className="flex items-center justify-end gap-1.5">
      {canEdit && (
        <Button variant="outline" size="sm" onClick={onBudget}>
          {a.budget ? "Edit budget" : "Set budget"}
        </Button>
      )}
      {a.billingUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" asChild>
              <a href={a.billingUrl} target="_blank" rel="noreferrer">
                Pay <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open {platform} billing to pay, add funds or change the card</TooltipContent>
        </Tooltip>
      )}
      {showMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More for ${a.name}`}>
              {refreshing ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canEdit && a.readsBilling && (
              <DropdownMenuItem onSelect={onRefresh} disabled={refreshing}>
                <RefreshCw /> Refresh billing now
              </DropdownMenuItem>
            )}
            {canEdit && a.readsBilling && canLimit && a.accountLimit && <DropdownMenuSeparator />}
            {canLimit && a.accountLimit && (
              <DropdownMenuItem onSelect={onLimit}>
                <Wallet /> {a.accountLimit === "spend_cap" ? "Set spending limit on Meta" : "Set account budget on Google"}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function AccountRow(props: AccountProps) {
  return (
    <TableRow className="align-top">
      <TableCell className="pl-5">
        <AccountName account={props.account} />
      </TableCell>
      <TableCell className="min-w-44">
        <MonthSpend account={props.account} />
      </TableCell>
      <TableCell className="min-w-52">
        <PlatformBilling account={props.account} />
      </TableCell>
      <TableCell className="pr-5 text-right">
        <AccountActions {...props} />
      </TableCell>
    </TableRow>
  );
}

/** Phones: one card per account instead of a table that scrolls sideways. */
function AccountCard(props: AccountProps) {
  return (
    <div className="space-y-3 px-4 py-4">
      <AccountName account={props.account} />
      <div className="grid grid-cols-2 gap-3">
        <MonthSpend account={props.account} />
        <PlatformBilling account={props.account} />
      </div>
      <AccountActions {...props} />
    </div>
  );
}

function SpendSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
