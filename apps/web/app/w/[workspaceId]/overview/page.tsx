"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { DateRangePicker } from "@/components/app/date-range-picker";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { AiInsights } from "@/components/dashboard/ai-insights";
import { GetStarted } from "@/components/dashboard/get-started";
import { KpiCard, KpiCardSkeleton } from "@/components/dashboard/kpi-card";
import { PerformanceChart } from "@/components/dashboard/performance-chart";
import { PlatformBreakdown } from "@/components/dashboard/platform-breakdown";
import { TopCampaigns } from "@/components/dashboard/top-campaigns";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { useOverview } from "@/lib/queries";
import { cn } from "@/lib/utils";

const KPIS = [
  { metric: "spend", hint: "Total amount spent across all connected ad accounts." },
  { metric: "conversionValue", hint: "Purchase value attributed by each platform's own conversion tracking." },
  { metric: "roas", hint: "Return on ad spend: revenue divided by spend." },
  { metric: "conversions", hint: "Purchases and leads reported by the ad platforms." },
  { metric: "cpa", hint: "Average cost per conversion." },
  { metric: "ctr", hint: "Click-through rate: clicks divided by impressions." },
  { metric: "cpc", hint: "Average cost per click." },
  { metric: "impressions", hint: "Number of times your ads were shown." },
] as const;

export default function OverviewPage() {
  const { workspace } = useWorkspace();
  const overview = useOverview(workspace.id);
  const data = overview.data;
  const empty = data && data.accounts.total === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Performance across every connected ad account in this workspace."
        actions={!empty && <DateRangePicker />}
      >
        {data && !empty && <SyncStatus failing={data.accounts.failing} lastSyncedAt={data.lastSyncedAt} workspaceId={workspace.id} />}
      </PageHeader>

      {overview.isError ? (
        <Card>
          <ErrorState message={overview.error.message} onRetry={() => overview.refetch()} />
        </Card>
      ) : !data ? (
        <OverviewSkeleton />
      ) : empty ? (
        <GetStarted />
      ) : (
        <div className={cn("space-y-6 transition-opacity", overview.isPlaceholderData && "opacity-60")}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {KPIS.map((k, i) => (
              <KpiCard
                key={k.metric}
                metric={k.metric}
                hint={k.hint}
                totals={data.totals}
                previous={data.previous}
                series={data.timeseries}
                currency={data.currency}
                style={{ animationDelay: `${i * 40}ms` }}
              />
            ))}
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <PerformanceChart series={data.timeseries} currency={data.currency} />
            <PlatformBreakdown rows={data.byPlatform} currency={data.currency} />
          </div>

          <AiInsights />

          <TopCampaigns campaigns={data.topCampaigns} workspaceId={workspace.id} currency={data.currency} />
        </div>
      )}
    </div>
  );
}

function SyncStatus({ failing, lastSyncedAt, workspaceId }: { failing: number; lastSyncedAt: string | null; workspaceId: string }) {
  if (failing > 0) {
    return (
      <Link
        href={`/w/${workspaceId}/integrations`}
        className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-xs font-medium text-[color-mix(in_oklch,var(--warning),black_35%)] hover:bg-warning/15 dark:text-warning"
      >
        <AlertTriangle className="size-3.5" />
        {failing} {failing === 1 ? "integration needs" : "integrations need"} attention
      </Link>
    );
  }
  if (!lastSyncedAt) return null;
  return (
    <span className="mb-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <RefreshCw className="size-3" />
      Synced {timeAgo(lastSyncedAt)}
    </span>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <Skeleton className="h-[420px] rounded-xl" />
        <Skeleton className="h-[420px] rounded-xl" />
      </div>
    </div>
  );
}
