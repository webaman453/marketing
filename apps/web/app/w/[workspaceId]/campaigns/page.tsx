"use client";

import { PLATFORM_INFO, isPlatformShown, type EntityStatus, type Platform } from "@ashniva/shared";
import { Megaphone, Plug, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { DateRangePicker } from "@/components/app/date-range-picker";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { DraftsList } from "@/components/builder/drafts-list";
import { CampaignsTable } from "@/components/campaigns/campaigns-table";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { money, moneyCompact, multiple, number } from "@/lib/format";
import { useCampaigns, useWorkspaceAdAccounts } from "@/lib/queries";
import { cn } from "@/lib/utils";

const ALL = "all";

export default function CampaignsPage() {
  const { workspace, can } = useWorkspace();
  const [search, setSearch] = useState("");
  const [platform, setPlatform] = useState<Platform | typeof ALL>(ALL);
  const [status, setStatus] = useState<EntityStatus | typeof ALL>(ALL);
  const [adAccountId, setAdAccountId] = useState<string>(ALL);
  const deferredSearch = useDeferredValue(search.trim());

  const accounts = useWorkspaceAdAccounts(workspace.id);
  const campaigns = useCampaigns(workspace.id, {
    platform: platform === ALL ? undefined : platform,
    status: status === ALL ? undefined : status,
    adAccountId: adAccountId === ALL ? undefined : adAccountId,
    search: deferredSearch || undefined,
  });

  const shownAccounts = useMemo(
    () => (accounts.data ?? []).filter((a) => isPlatformShown(a.platform)),
    [accounts.data],
  );
  const platforms = useMemo(
    () => [...new Set(shownAccounts.map((a) => a.platform))],
    [shownAccounts],
  );
  const filtered = search !== "" || platform !== ALL || status !== ALL || adAccountId !== ALL;
  const data = campaigns.data;

  if (accounts.data && shownAccounts.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Campaigns" description="Every campaign from every connected platform." />
        <Card>
          <EmptyState
            icon={Plug}
            title="No ad accounts connected"
            description="Connect Meta or Google Ads to see and manage your campaigns here."
            action={
              <Button asChild>
                <Link href={`/w/${workspace.id}/integrations`}>Connect a platform</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        description="Every campaign from every connected platform, in one table."
        actions={
          <>
            <DateRangePicker />
            {can("campaigns:edit") && (
              <Button asChild>
                <Link href={`/w/${workspace.id}/campaigns/new`}>
                  <Plus /> Create campaign
                </Link>
              </Button>
            )}
          </>
        }
      />

      <DraftsList workspaceId={workspace.id} canEdit={can("campaigns:edit")} />

      {data && (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4 animate-fade-up">
          {[
            { label: "Spend", value: moneyCompact(data.totals.spend, data.currency), full: money(data.totals.spend, data.currency) },
            { label: "Conversions", value: number(data.totals.conversions), full: number(data.totals.conversions, { decimals: 1 }) },
            { label: "Cost / conv.", value: money(data.totals.cpa, data.currency, { decimals: 0 }), full: money(data.totals.cpa, data.currency) },
            { label: "ROAS", value: multiple(data.totals.roas), full: multiple(data.totals.roas) },
          ].map((s) => (
            <div key={s.label} className="bg-card px-4 py-3" title={s.full}>
              <div className="text-xs font-medium text-muted-foreground">{s.label}</div>
              <div className="mt-0.5 text-lg font-semibold tracking-tight tabular">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-col gap-2 border-b p-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search campaigns…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={platform} onValueChange={(v) => setPlatform(v as Platform | typeof ALL)}>
              <SelectTrigger size="sm" className="w-[160px]">
                <SelectValue placeholder="Platform" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All platforms</SelectItem>
                {platforms.map((p) => (
                  <SelectItem key={p} value={p}>
                    <PlatformIcon platform={p} size="xs" />
                    {PLATFORM_INFO[p].name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => setStatus(v as EntityStatus | typeof ALL)}>
              <SelectTrigger size="sm" className="w-[130px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="PAUSED">Paused</SelectItem>
                <SelectItem value="ARCHIVED">Archived</SelectItem>
              </SelectContent>
            </Select>
            {shownAccounts.length > 1 && (
              <Select value={adAccountId} onValueChange={setAdAccountId}>
                <SelectTrigger size="sm" className="w-[200px]">
                  <SelectValue placeholder="Ad account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All ad accounts</SelectItem>
                  {shownAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <PlatformIcon platform={a.platform} size="xs" />
                      <span className="truncate">{a.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setSearch("");
                  setPlatform(ALL);
                  setStatus(ALL);
                  setAdAccountId(ALL);
                }}
              >
                <X /> Reset
              </Button>
            )}
          </div>
        </div>

        {campaigns.isError ? (
          <ErrorState message={campaigns.error.message} onRetry={() => campaigns.refetch()} />
        ) : !data ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : data.campaigns.filter((c) => isPlatformShown(c.platform)).length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title={filtered ? "No campaigns match these filters" : "No campaigns yet"}
            description={
              filtered
                ? "Try a different search or clear the filters."
                : "Campaigns appear here after your ad accounts finish syncing."
            }
          />
        ) : (
          <div className={cn("transition-opacity", campaigns.isPlaceholderData && "opacity-60")}>
            <CampaignsTable
              campaigns={data.campaigns.filter((c) => isPlatformShown(c.platform))}
              totals={data.totals}
              currency={data.currency}
              workspaceId={workspace.id}
              canEdit={can("campaigns:edit")}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
