"use client";

import type { LeadDTO } from "@ashniva/shared";
import { ChevronLeft, ChevronRight, Clock, Contact, Download, Mail, Phone, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DateRangePicker } from "@/components/app/date-range-picker";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDateRange } from "@/lib/date-range";
import { money } from "@/lib/format";
import { useLeads } from "@/lib/queries";
import { cn } from "@/lib/utils";

const SOURCES: Record<string, string> = { fb: "Facebook", ig: "Instagram", an: "Audience Network", ms: "Messenger", unknown: "Other" };
const sourceName = (s: string | null) => SOURCES[s ?? "unknown"] ?? s ?? "Other";
const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;

function when(iso: string, tz: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("en-IN", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }),
    time: d.toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" }),
  };
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export default function LeadsPage() {
  const { workspace } = useWorkspace();
  const { from, to } = useDateRange();
  const [source, setSource] = useState<string | undefined>();
  const [campaignId, setCampaignId] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<LeadDTO | null>(null);
  const leads = useLeads(workspace.id, { source, campaignId, search: search || undefined, page });
  const data = leads.data;

  const exportHref = `/api/workspaces/${workspace.id}/leads/export?${new URLSearchParams({
    from,
    to,
    ...(source ? { source } : {}),
    ...(campaignId ? { campaignId } : {}),
    ...(search ? { search } : {}),
  })}`;

  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };
  const peak = data ? Math.max(...data.byHour) : 0;
  const bestHour = data && peak > 0 ? data.byHour.indexOf(peak) : null;
  const topSource = data?.bySource[0];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        description="People who filled your Facebook and Instagram lead forms, with when they came and what they cost."
        actions={
          <>
            <DateRangePicker />
            <Button asChild variant="outline" size="sm" disabled={!data?.total}>
              <a href={exportHref} download><Download /> Export CSV</a>
            </Button>
          </>
        }
      />

      {data?.leadsError && (
        <Card className="flex-row items-start gap-3 border-amber-300/60 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div>
            <div className="font-medium">Leads couldn&apos;t be read from Meta</div>
            <p className="text-muted-foreground">{data.leadsError}</p>
            <Button asChild variant="link" className="h-auto p-0"><Link href={`/w/${workspace.id}/integrations`}>Go to Integrations</Link></Button>
          </div>
        </Card>
      )}

      {leads.isError ? (
        <ErrorState message="Couldn't load leads." onRetry={() => leads.refetch()} />
      ) : !data ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Leads" value={String(data.summary.total)} />
            <Kpi label="Est. cost per lead" value={data.summary.avgCost == null ? "—" : money(data.summary.avgCost, data.summary.currency)} hint="Average; Meta doesn't bill per lead" />
            <Kpi label="Busiest hour" value={bestHour == null ? "—" : hourLabel(bestHour)} hint={bestHour == null ? undefined : `${peak} leads · ${data.timezone}`} />
            <Kpi label="Top source" value={topSource ? sourceName(topSource.source) : "—"} hint={topSource ? `${topSource.count} leads` : undefined} />
          </div>

          {data.total > 0 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Card className="gap-3 p-4">
                <div className="text-sm font-medium">When leads come in</div>
                <div className="flex h-36 items-end gap-1" role="img" aria-label="Leads per hour of day">
                  {data.byHour.map((n, h) => (
                    <div key={h} className="group flex h-full flex-1 flex-col items-center justify-end" title={`${hourLabel(h)}: ${n} leads`}>
                      <div className={cn("w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary", n === 0 && "bg-muted")} style={{ height: `${peak ? Math.max((n / peak) * 100, n ? 4 : 2) : 2}%` }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
              </Card>
              <Card className="gap-3 p-4">
                <div className="text-sm font-medium">By source</div>
                <ul className="space-y-2">
                  {data.bySource.map((s) => (
                    <li key={s.source} className="text-sm">
                      <div className="flex justify-between"><span>{sourceName(s.source)}</span><span className="text-muted-foreground">{s.count} · {Math.round((s.count / data.total) * 100)}%</span></div>
                      <div className="mt-1 h-1.5 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${(s.count / data.total) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1 sm:max-w-xs">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => reset(setSearch)(e.target.value)} placeholder="Search name, email, phone…" className="pl-8" />
            </div>
            <div className="flex gap-1">
              {[undefined, "fb", "ig"].map((s) => (
                <Button key={s ?? "all"} size="sm" variant={source === s ? "default" : "outline"} onClick={() => reset(setSource)(s)}>{s ? sourceName(s) : "All sources"}</Button>
              ))}
            </div>
            {data.byCampaign.length > 1 && (
              <select aria-label="Campaign" value={campaignId ?? ""} onChange={(e) => reset(setCampaignId)(e.target.value || undefined)} className="h-8 max-w-64 rounded-md border bg-background px-2 text-sm">
                <option value="">All campaigns</option>
                {data.byCampaign.filter((c) => c.campaignId).map((c) => <option key={c.campaignId} value={c.campaignId!}>{c.name}</option>)}
              </select>
            )}
          </div>

          {data.total === 0 ? (
            <Card><EmptyState icon={Contact} title="No leads in this period" description="Leads from your Facebook and Instagram forms show up here as soon as they sync. Try a wider date range, or reconnect Meta if you haven't granted lead access." /></Card>
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Campaign / ad</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.leads.map((l) => {
                    const t = when(l.createdTime, data.timezone);
                    return (
                      <TableRow key={l.id} className="cursor-pointer" onClick={() => setOpen(l)}>
                        <TableCell>
                          <div className="font-medium">{l.name ?? l.email ?? l.phone ?? "Unnamed lead"}</div>
                          <div className="text-xs text-muted-foreground">{[l.phone, l.email].filter(Boolean).join(" · ")}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap"><div>{t.date}</div><div className="text-xs text-muted-foreground">{t.time}</div></TableCell>
                        <TableCell><Badge variant="secondary">{sourceName(l.source)}</Badge></TableCell>
                        <TableCell className="max-w-72"><div className="truncate">{l.campaignName ?? "—"}</div><div className="truncate text-xs text-muted-foreground">{l.adName ?? l.formName}</div></TableCell>
                        <TableCell className="text-right tabular-nums">{l.estCost == null ? "—" : money(l.estCost, l.currency)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="flex items-center justify-between border-t px-4 py-2 text-sm text-muted-foreground">
                <span>{data.total} leads</span>
                <div className="flex items-center gap-2">
                  <Button size="icon-sm" variant="outline" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
                  <span>Page {page} of {pages}</span>
                  <Button size="icon-sm" variant="outline" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          {open && data && (
            <>
              <DialogHeader><DialogTitle>{open.name ?? "Lead details"}</DialogTitle></DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span className="flex items-center gap-1"><Clock className="size-3.5" />{when(open.createdTime, data.timezone).date}, {when(open.createdTime, data.timezone).time}</span>
                  {open.phone && <span className="flex items-center gap-1"><Phone className="size-3.5" />{open.phone}</span>}
                  {open.email && <span className="flex items-center gap-1"><Mail className="size-3.5" />{open.email}</span>}
                </div>
                <dl className="divide-y rounded-lg border">
                  {Object.entries(open.fields).map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[40%_1fr] gap-2 px-3 py-2"><dt className="text-muted-foreground">{k.replaceAll("_", " ")}</dt><dd>{v.join(", ")}</dd></div>
                  ))}
                </dl>
                <div className="text-xs text-muted-foreground">
                  {sourceName(open.source)} · {open.campaignName ?? "Unknown campaign"} · {open.adName ?? open.formName ?? "—"}
                  {open.estCost != null && <> · est. {money(open.estCost, open.currency)}</>}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
