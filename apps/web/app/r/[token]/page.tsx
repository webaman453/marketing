"use client";

import type { ReportResult } from "@ashniva/shared";
import { useQuery } from "@tanstack/react-query";
import { Download, FileX } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { EmptyState } from "@/components/app/states";
import { ReportView } from "@/components/reports/report-view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { longDate } from "@/lib/format";

/** Public, white-labelled report shared via link. No sign-in. */
export default function SharedReportPage() {
  const { token } = useParams<{ token: string }>();
  const report = useQuery({
    queryKey: ["public-report", token],
    queryFn: () => api<ReportResult>(`/public/reports/${token}`),
    retry: false,
  });

  useEffect(() => {
    if (report.data) document.title = `${report.data.name} · ${report.data.branding.name}`;
  }, [report.data]);

  if (report.isError) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <EmptyState icon={FileX} title="This report isn't available" description="The link may have been turned off. Ask the sender for a new one." />
      </div>
    );
  }

  const r = report.data;
  return (
    <div className="min-h-svh bg-background">
      <header className="border-b bg-card" style={r ? { borderTop: `3px solid ${r.branding.color}` } : undefined}>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          {r ? (
            r.branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.branding.logoUrl} alt={r.branding.name} className="max-h-8 max-w-[180px] object-contain" />
            ) : (
              <span className="text-base font-bold" style={{ color: r.branding.color }}>{r.branding.name}</span>
            )
          ) : (
            <Skeleton className="h-6 w-40" />
          )}
          {r && (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/public/reports/${token}?format=pdf`}><Download /> Download PDF</a>
            </Button>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 px-5 py-8">
        {!r ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <>
            <div>
              <p className="text-sm text-muted-foreground">{r.workspaceName}</p>
              <h1 className="text-2xl font-semibold tracking-tight">{r.name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {longDate(r.range.from)} – {longDate(r.range.to)}
                {r.compareRange && ` · compared with the previous ${r.series.length} days`}
              </p>
            </div>
            <ReportView result={r} />
            <footer className="flex flex-wrap justify-between gap-2 border-t pt-4 text-xs text-muted-foreground">
              <span>{r.branding.footer ?? `Prepared by ${r.branding.name}`}</span>
              <span>Updated {new Date(r.generatedAt).toLocaleString()}</span>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
