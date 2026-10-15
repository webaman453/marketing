"use client";

import { useParams } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { ReportEditor } from "@/components/reports/report-editor";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReport } from "@/lib/queries";

export default function ReportPage() {
  const { reportId } = useParams<{ reportId: string }>();
  const { workspace } = useWorkspace();
  const report = useReport(workspace.id, reportId);
  if (report.isError) return <Card><ErrorState message={report.error.message} onRetry={() => report.refetch()} /></Card>;
  if (!report.data) return <Skeleton className="h-[600px] rounded-xl" />;
  return <ReportEditor key={report.data.id} report={report.data} />;
}
