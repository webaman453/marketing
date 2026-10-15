"use client";

import {
  DIMENSION_LABELS,
  METRIC_FORMATS,
  PLATFORM_INFO,
  PRESET_TITLES,
  REPORT_DIMENSIONS,
  REPORT_METRICS,
  REPORT_PRESETS,
  type Platform,
  type ReportConfig,
  type ReportDTO,
  type ReportResult,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CalendarClock, Download, FileSpreadsheet, FileText, Link2, Loader2, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useWorkspaceAdAccounts } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ScheduleDialog, ShareDialog } from "./report-dialogs";
import { ReportView } from "./report-view";

const DEFAULT_CONFIG: ReportConfig = {
  metrics: ["spend", "clicks", "ctr", "conversions", "cpa", "roas"],
  dimension: "campaign",
  datePreset: "30d",
  platforms: [],
  compare: true,
  chartMetric: "spend",
};

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ReportEditor({ report: initial }: { report: ReportDTO | null }) {
  const { workspace, me } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const accounts = useWorkspaceAdAccounts(workspace.id);
  const isClient = me.orgs.find((o) => o.id === workspace.orgId)?.role === "CLIENT";

  const [report, setReport] = useState<ReportDTO | null>(initial);
  const [name, setName] = useState(initial?.name ?? "Untitled report");
  const [config, setConfig] = useState<ReportConfig>(initial?.config ?? DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const debounced = useDebounced(config, 350);

  const preview = useQuery({
    queryKey: ["report-preview", workspace.id, debounced],
    queryFn: () => api<ReportResult>(`/workspaces/${workspace.id}/reports/preview`, { method: "POST", body: { config: debounced, name } }),
    placeholderData: (prev) => prev,
  });

  const platforms = useMemo(() => [...new Set((accounts.data ?? []).map((a) => a.platform))], [accounts.data]);
  const dirty = !report || report.name !== name || JSON.stringify(report.config) !== JSON.stringify(config);

  async function save() {
    setSaving(true);
    try {
      const body = { name, description: report?.description ?? null, config };
      const saved = report
        ? await api<ReportDTO>(`/workspaces/${workspace.id}/reports/${report.id}`, { method: "PATCH", body })
        : await api<ReportDTO>(`/workspaces/${workspace.id}/reports`, { method: "POST", body });
      setReport(saved);
      toast.success("Report saved");
      void queryClient.invalidateQueries({ queryKey: qk2.reports(workspace.id) });
      if (!report) router.replace(`/w/${workspace.id}/reports/${saved.id}`);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!report) return;
    try {
      await api(`/workspaces/${workspace.id}/reports/${report.id}`, { method: "DELETE" });
      toast.success("Report deleted");
      void queryClient.invalidateQueries({ queryKey: qk2.reports(workspace.id) });
      router.push(`/w/${workspace.id}/reports`);
    } catch (err) {
      toastError(err);
    }
  }

  const toggleMetric = (m: (typeof REPORT_METRICS)[number]) =>
    setConfig((c) => {
      const on = c.metrics.includes(m);
      if (on && c.metrics.length === 1) return c;
      const metrics = on ? c.metrics.filter((x) => x !== m) : [...c.metrics, m].slice(0, 10);
      // Keep the chart on a selected metric.
      const chartMetric = c.chartMetric && metrics.includes(c.chartMetric) ? c.chartMetric : (metrics[0] ?? null);
      return { ...c, metrics, chartMetric };
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <Link href={`/w/${workspace.id}/reports`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" /> Reports
            </Link>
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isClient}
            aria-label="Report name"
            className="h-auto max-w-xl border-transparent px-0 text-xl font-semibold tracking-tight shadow-none hover:border-input focus-visible:border-input focus-visible:px-2 sm:text-[22px] dark:bg-transparent"
          />
          {report && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {report.schedule.frequency && (
                <Badge variant="secondary" className="gap-1"><CalendarClock className="size-3" /> {report.schedule.frequency.toLowerCase()} email</Badge>
              )}
              {report.shareToken && <Badge variant="secondary" className="gap-1"><Link2 className="size-3" /> Shared link on</Badge>}
              {report.schedule.nextRunAt && <span>Next send {dateTime(report.schedule.nextRunAt)}</span>}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="bg-card"><Download /> Export</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a href={`/api/workspaces/${workspace.id}/reports/${report.id}/export.pdf`}><FileText /> PDF</a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href={`/api/workspaces/${workspace.id}/reports/${report.id}/export.csv`}><FileSpreadsheet /> CSV (Excel)</a>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {report && !isClient && (
            <>
              <Button variant="outline" className="bg-card" onClick={() => setShareOpen(true)}><Link2 /> Share</Button>
              <Button variant="outline" className="bg-card" onClick={() => setScheduleOpen(true)}><CalendarClock /> Schedule</Button>
            </>
          )}
          {!isClient && (
            <Button onClick={save} disabled={saving || !dirty || name.trim().length < 2}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} {report ? "Save changes" : "Save report"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[300px_minmax(0,1fr)]">
        {!isClient && (
          <Card className="h-fit gap-5 p-5 xl:sticky xl:top-20">
            <div className="space-y-2">
              <Label className="text-[13px]">Metrics</Label>
              <div className="flex flex-wrap gap-1.5">
                {REPORT_METRICS.map((m) => {
                  const on = config.metrics.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleMetric(m)}
                      className={cn("rounded-md border px-2 py-1 text-xs transition-colors", on ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}
                    >
                      {METRIC_FORMATS[m]!.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <FormField id="dim" label="Break down by">
              <Select value={config.dimension} onValueChange={(v) => setConfig((c) => ({ ...c, dimension: v as ReportConfig["dimension"] }))}>
                <SelectTrigger id="dim" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{REPORT_DIMENSIONS.map((d) => <SelectItem key={d} value={d}>{DIMENSION_LABELS[d]}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField id="period" label="Period">
              <Select value={config.datePreset} onValueChange={(v) => setConfig((c) => ({ ...c, datePreset: v as ReportConfig["datePreset"] }))}>
                <SelectTrigger id="period" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{REPORT_PRESETS.map((p) => <SelectItem key={p} value={p}>{PRESET_TITLES[p]}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField id="chart" label="Trend chart">
              <Select value={config.chartMetric ?? "none"} onValueChange={(v) => setConfig((c) => ({ ...c, chartMetric: v === "none" ? null : (v as ReportConfig["chartMetric"]) }))}>
                <SelectTrigger id="chart" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No chart</SelectItem>
                  {config.metrics.map((m) => <SelectItem key={m} value={m}>{METRIC_FORMATS[m]!.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            {platforms.length > 1 && (
              <div className="space-y-2">
                <Label className="text-[13px]">Platforms</Label>
                <div className="flex flex-wrap gap-1.5">
                  {platforms.map((p: Platform) => {
                    const on = config.platforms.length === 0 || config.platforms.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() =>
                          setConfig((c) => {
                            const current = c.platforms.length ? c.platforms : platforms;
                            const next = current.includes(p) ? current.filter((x) => x !== p) : [...current, p];
                            return { ...c, platforms: next.length === platforms.length || next.length === 0 ? [] : next };
                          })
                        }
                        className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity", !on && "opacity-40")}
                      >
                        <PlatformIcon platform={p} size="xs" /> {PLATFORM_INFO[p].name.replace(" Ads", "")}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="flex items-center justify-between gap-3 text-sm">
              Compare with previous period
              <Switch checked={config.compare} onCheckedChange={(v) => setConfig((c) => ({ ...c, compare: v }))} />
            </label>
            {report && (
              <Button variant="ghost" size="sm" className="justify-start text-destructive hover:text-destructive" onClick={remove}>
                <Trash2 /> Delete report
              </Button>
            )}
          </Card>
        )}

        <div className="min-w-0">
          {preview.isError ? (
            <Card><ErrorState message={preview.error.message} onRetry={() => preview.refetch()} /></Card>
          ) : !preview.data ? (
            <div className="space-y-4">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-64 rounded-xl" />
              <Skeleton className="h-80 rounded-xl" />
            </div>
          ) : (
            <div className={cn("transition-opacity", preview.isFetching && "opacity-60")}>
              <p className="mb-3 text-xs text-muted-foreground">
                {preview.data.range.from} → {preview.data.range.to}
                {preview.data.compareRange && ` · compared with ${preview.data.compareRange.from} → ${preview.data.compareRange.to}`}
              </p>
              <ReportView result={preview.data} />
            </div>
          )}
        </div>
      </div>

      {report && (
        <>
          <ScheduleDialog key={`s-${scheduleOpen}`} report={report} workspaceId={workspace.id} timezone={workspace.timezone} open={scheduleOpen} onOpenChange={setScheduleOpen} onSaved={setReport} />
          <ShareDialog report={report} workspaceId={workspace.id} open={shareOpen} onOpenChange={setShareOpen} onSaved={setReport} />
        </>
      )}
    </div>
  );
}
