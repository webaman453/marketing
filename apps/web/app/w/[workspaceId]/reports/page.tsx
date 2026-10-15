"use client";

import { DIMENSION_LABELS, METRIC_FORMATS, PRESET_TITLES } from "@ashniva/shared";
import { CalendarClock, FileText, Link2, Plus } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/format";
import { useReports } from "@/lib/queries";

export default function ReportsPage() {
  const { workspace, org } = useWorkspace();
  const reports = useReports(workspace.id);
  const canCreate = org.role !== "CLIENT";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Saved views of your performance. Export to PDF or Excel, email them on a schedule, or share a live link."
        actions={
          canCreate && (
            <Button asChild>
              <Link href={`/w/${workspace.id}/reports/new`}><Plus /> New report</Link>
            </Button>
          )
        }
      />

      {reports.isError ? (
        <Card><ErrorState message={reports.error.message} onRetry={() => reports.refetch()} /></Card>
      ) : !reports.data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>
      ) : reports.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No reports yet"
            description="Build a report once, then download it or have it emailed to your clients automatically."
            action={canCreate && <Button asChild><Link href={`/w/${workspace.id}/reports/new`}><Plus /> Create your first report</Link></Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {reports.data.map((r, i) => (
            <Link key={r.id} href={`/w/${workspace.id}/reports/${r.id}`} className="group">
              <Card className="h-full gap-3 p-5 transition-all animate-fade-up group-hover:border-primary/40 group-hover:shadow-md" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <FileText className="size-[18px]" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold group-hover:text-primary">{r.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      By {DIMENSION_LABELS[r.config.dimension].toLowerCase()} · {PRESET_TITLES[r.config.datePreset]}
                    </p>
                  </div>
                </div>
                {r.description && <p className="line-clamp-2 text-sm text-muted-foreground">{r.description}</p>}
                <p className="text-xs text-muted-foreground">
                  {r.config.metrics.slice(0, 5).map((m) => METRIC_FORMATS[m]!.label).join(" · ")}
                  {r.config.metrics.length > 5 && ` +${r.config.metrics.length - 5}`}
                </p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                  {r.schedule.frequency && <Badge variant="secondary" className="gap-1"><CalendarClock className="size-3" /> {r.schedule.frequency.toLowerCase()}</Badge>}
                  {r.shareToken && <Badge variant="secondary" className="gap-1"><Link2 className="size-3" /> shared</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">Updated {timeAgo(r.updatedAt)}</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
