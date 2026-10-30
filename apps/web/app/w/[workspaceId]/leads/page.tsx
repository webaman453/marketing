"use client";

import {
  LEAD_NOTE_MAX,
  LEAD_SORTS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  PLATFORMS,
  PLATFORM_INFO,
  isPlatform,
  isPlatformShown,
  type LeadDTO,
  type LeadSort,
  type LeadStatus,
  type Platform,
} from "@ashniva/shared";
import { ArrowLeft, ChevronLeft, ChevronRight, Clock, Contact, Download, Mail, Phone, Search, StickyNote, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DateRangePicker } from "@/components/app/date-range-picker";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { useDateRange, useDateRangeStore } from "@/lib/date-range";
import { money } from "@/lib/format";
import { useLeads, useUpdateLead } from "@/lib/queries";
import { cn } from "@/lib/utils";
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_FILTERS,
  PAGE_SIZES,
  SORT_LABELS,
  activeFilterCount,
  apiFilters,
  filtersFromParams,
  filtersToParams,
  rangeFromParams,
  rangeParams,
  type LeadViewFilters,
} from "./filters";

const GROUPS: { label: string; ids: Platform[] }[] = [
  { label: "Social", ids: ["META", "SNAPCHAT", "X", "LINKEDIN", "PINTEREST"] },
  { label: "Search and shopping", ids: ["GOOGLE", "MICROSOFT", "AMAZON", "APPLE"] },
  { label: "Native", ids: ["TABOOLA", "OUTBRAIN"] },
  { label: "Audio and programmatic", ids: ["SPOTIFY", "CRITEO", "YAHOO", "TRADEDESK"] },
  { label: "Stores", ids: ["SHOPIFY"] },
];

/** Platforms whose leads are synced today; the rest are listed as coming soon. */
const LEAD_SYNC_PLATFORMS: readonly Platform[] = ["META"];

const SOURCES: Record<string, string> = { fb: "Facebook", ig: "Instagram", an: "Audience Network", ms: "Messenger", unknown: "Other" };
const sourceName = (s: string | null) => SOURCES[s ?? "unknown"] ?? s ?? "Other";
/** Null for missing or blank values, so fallbacks kick in for "" as well. */
const filled = (v: string | null | undefined) => (v?.trim() ? v : null);
const leadName = (l: { name: string | null; email: string | null; phone: string | null }) =>
  filled(l.name) ?? filled(l.email) ?? filled(l.phone) ?? "Unnamed lead";
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
  return (
    <Suspense>
      <Leads />
    </Suspense>
  );
}

function Leads() {
  const params = useSearchParams();
  const requested = params.get("platform");
  if (isPlatform(requested) && isPlatformShown(requested)) return <PlatformLeads key={requested} platform={requested} />;
  return <PlatformGallery />;
}

function PlatformGallery() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  // Only the per-platform counts are needed here, so ask for a single row.
  const leads = useLeads(workspace.id, { page: 1, pageSize: 1 });
  const counts = Object.fromEntries(PLATFORMS.map((platform) => [platform, 0])) as Record<Platform, number>;
  for (const row of leads.data?.byPlatform ?? []) counts[row.platform] = row.count;
  const comingSoon = GROUPS.flatMap((group) => group.ids).filter((platform) => isPlatformShown(platform) && !LEAD_SYNC_PLATFORMS.includes(platform));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Leads"
        description="Choose a platform. The next screen lists the people who came in from that platform."
        actions={<DateRangePicker />}
      />
      {leads.isError ? (
        <ErrorState message="Couldn't load leads." onRetry={() => leads.refetch()} />
      ) : !leads.data ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : (
        <section className="space-y-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Lead sync</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {LEAD_SYNC_PLATFORMS.filter(isPlatformShown).map((platform) => {
              const info = PLATFORM_INFO[platform];
              const count = counts[platform];
              return (
                <button
                  key={platform}
                  type="button"
                  onClick={() => router.push(`/w/${workspace.id}/leads?platform=${platform}`)}
                  className="flex h-full flex-col rounded-xl border bg-card p-5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <PlatformIcon platform={platform} size="lg" />
                    <Badge variant={count ? "secondary" : "outline"}>{count ? `${count} lead${count === 1 ? "" : "s"}` : "No leads"}</Badge>
                  </div>
                  <div className="mt-4 text-base font-semibold tracking-tight">{info.name}</div>
                  <p className="mt-1 line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">{info.description}</p>
                </button>
              );
            })}
          </div>
        </section>
      )}
      {comingSoon.length > 0 && (
        <section className="space-y-3">
          <div>
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Lead sync coming soon</h2>
            <p className="mt-1 text-sm text-muted-foreground">Leads from these platforms are not synced yet. Use each platform&apos;s own lead export for now.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {comingSoon.map((platform) => (
              <span key={platform} className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground opacity-80">
                <PlatformIcon platform={platform} size="xs" />
                {PLATFORM_INFO[platform].name}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const STATUS_TONE: Record<LeadStatus, string> = {
  NEW: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  CONTACTED: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  QUALIFIED: "bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-300",
  WON: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  LOST: "bg-muted text-muted-foreground",
};

function StatusBadge({ status }: { status: LeadStatus }) {
  return <Badge className={cn("border-transparent", STATUS_TONE[status])}>{LEAD_STATUS_LABELS[status]}</Badge>;
}

const selectClass = "h-8 max-w-64 rounded-md border bg-background px-2 text-sm";

/** Status for people who may change it, a badge for everyone else. */
function StatusControl({ lead, canManage, onChange, label }: { lead: LeadDTO; canManage: boolean; onChange: (s: LeadStatus) => void; label: string }) {
  if (!canManage) return <StatusBadge status={lead.status} />;
  return (
    <select
      aria-label={label}
      value={lead.status}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value as LeadStatus)}
      className={cn("h-7 rounded-md border-0 px-2 text-xs font-medium", STATUS_TONE[lead.status])}
    >
      {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>)}
    </select>
  );
}

/** A filter menu of ad sets, ads or forms; keeps a chosen value the current answer no longer lists. */
function FacetSelect({ label, all, value, options, onChange }: { label: string; all: string; value?: string; options: { id: string; name: string }[]; onChange: (v: string | undefined) => void }) {
  if (options.length <= 1 && !value) return null;
  return (
    <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className={selectClass}>
      <option value="">{all}</option>
      {value && !options.some((o) => o.id === value) && <option value={value}>Selected {label.toLowerCase()}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function PlatformLeads({ platform }: { platform: Platform }) {
  const { workspace, can } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const info = PLATFORM_INFO[platform];
  const range = useDateRange();
  const { from, to } = range;
  const canManage = can("leads:manage");
  const [filters, setFilters] = useState<LeadViewFilters>(() => filtersFromParams(params));
  const [openId, setOpenId] = useState<string | null>(null);
  const [openSnapshot, setOpenSnapshot] = useState<LeadDTO | null>(null);
  const update = useUpdateLead(workspace.id);

  /** Any filter change goes back to page 1. */
  const set = (patch: Partial<LeadViewFilters>) => setFilters((f) => ({ ...f, page: 1, ...patch }));
  const { source } = filters;

  // A date range in a shared link wins over the one this browser remembers (once, after that is read).
  const [linkRange] = useState(() => rangeFromParams(params));
  const linkSettled = useRef(!linkRange);
  useEffect(() => {
    if (!range.ready || !linkRange || linkSettled.current) return;
    const store = useDateRangeStore.getState();
    if ("preset" in linkRange) store.setPreset(linkRange.preset);
    else store.setCustom(linkRange);
  }, [range.ready, linkRange]);

  // Mirror the view into the URL so it can be bookmarked or shared. Native history keeps the page
  // as it is (no navigation), and Next's useSearchParams stays in sync with it.
  const query = filtersToParams(filters, { platform, ...rangeParams(range) }).toString();
  useEffect(() => {
    if (!range.ready) return;
    if (!linkSettled.current) {
      // Wait for the link's range to reach the store, so the URL never names the remembered one.
      const matches = linkRange && ("preset" in linkRange ? range.preset === linkRange.preset : range.preset === "custom" && range.from === linkRange.from && range.to === linkRange.to);
      if (!matches) return;
      linkSettled.current = true;
    }
    if (window.location.search !== `?${query}`) window.history.replaceState(window.history.state, "", `/w/${workspace.id}/leads?${query}`);
  }, [query, range.ready, range.preset, range.from, range.to, linkRange, workspace.id]);

  const leads = useLeads(workspace.id, { platform, ...apiFilters(filters) });
  const data = leads.data;
  // bySource only counts the chosen source, so the buttons come from the same filters without it.
  const unfiltered = useLeads(workspace.id, { platform, ...apiFilters({ ...filters, source: undefined }), page: 1, pageSize: 1 }, { enabled: Boolean(source) });
  const allSources = (source ? (unfiltered.data ?? data) : data)?.bySource.map((s) => s.source) ?? [];
  const sources = [...new Set([...(platform === "META" ? ["fb", "ig"] : []), ...allSources, ...(source ? [source] : [])])];

  const exportParams = filtersToParams({ ...filters, page: 1, pageSize: DEFAULT_PAGE_SIZE }, { from, to, platform });
  const exportHref = `/api/workspaces/${workspace.id}/leads/export?${exportParams}`;

  const setStatus = (lead: LeadDTO, status: LeadStatus) => {
    if (status === lead.status) return;
    update.mutate(
      { id: lead.id, status },
      {
        onSuccess: () => toast.success(`Marked ${LEAD_STATUS_LABELS[status].toLowerCase()}`, { description: leadName(lead) }),
        onError: (err) => toast.error(`Couldn't update ${leadName(lead)}`, { description: errorMessage(err) }),
      },
    );
  };

  const peak = data ? Math.max(...data.byHour) : 0;
  const bestHour = data && peak > 0 ? data.byHour.indexOf(peak) : null;
  const topSource = data?.bySource[0];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const { page } = filters;
  const narrowing = activeFilterCount(filters);
  const statusTotal = data?.byStatus.reduce((a, s) => a + s.count, 0) ?? 0;
  const open = openId ? (data?.leads.find((l) => l.id === openId) ?? openSnapshot) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${info.name} leads`}
        description={`People who came in from ${info.name} during this date range.`}
        actions={
          <>
            <DateRangePicker />
            {can("leads:export") && (
              <Button asChild variant="outline" size="sm" disabled={!data?.total}>
                <a href={exportHref} download><Download /> Export CSV</a>
              </Button>
            )}
          </>
        }
      >
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => router.push(`/w/${workspace.id}/leads`)}>
          <ArrowLeft /> All platforms
        </Button>
      </PageHeader>

      {platform === "META" && data?.leadsError && (
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
            <Kpi label="Leads" value={String(data.summary.total)} hint={data.summary.total ? `${data.summary.withPhone} with phone · ${data.summary.withEmail} with email${data.summary.organic ? ` · ${data.summary.organic} organic` : ""}` : undefined} />
            <Kpi label="Est. cost per lead" value={data.summary.avgCost == null ? "—" : money(data.summary.avgCost, data.summary.currency)} hint="That day's ad spend, shared across the leads it received" />
            <Kpi label="Busiest hour" value={bestHour == null ? "—" : hourLabel(bestHour)} hint={bestHour == null ? undefined : `${peak} leads · ${data.timezone}`} />
            <Kpi label="Top source" value={topSource ? sourceName(topSource.source) : "—"} hint={topSource ? `${topSource.count} leads` : undefined} />
          </div>

          <div className="flex flex-wrap gap-1" role="group" aria-label="Lead status">
            <Button size="sm" variant={filters.status ? "outline" : "default"} aria-pressed={!filters.status} onClick={() => set({ status: undefined })}>
              All statuses <span className="tabular-nums opacity-70">{statusTotal}</span>
            </Button>
            {data.byStatus.map((s) => (
              <Button key={s.status} size="sm" variant={filters.status === s.status ? "default" : "outline"} aria-pressed={filters.status === s.status} onClick={() => set({ status: s.status })}>
                {LEAD_STATUS_LABELS[s.status]} <span className="tabular-nums opacity-70">{s.count}</span>
              </Button>
            ))}
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

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-52 flex-1 sm:max-w-xs">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={filters.search} onChange={(e) => set({ search: e.target.value })} placeholder="Search name, email, phone…" className="pl-8" />
              </div>
              <div className="flex flex-wrap gap-1">
                {[undefined, ...sources].map((s) => (
                  <Button key={s ?? "all"} size="sm" variant={source === s ? "default" : "outline"} onClick={() => set({ source: s })}>{s ? sourceName(s) : "All sources"}</Button>
                ))}
              </div>
              <select aria-label="Sort" value={filters.sort} onChange={(e) => set({ sort: e.target.value as LeadSort })} className={cn(selectClass, "ml-auto")}>
                {LEAD_SORTS.map((s) => <option key={s} value={s}>{SORT_LABELS[s]}</option>)}
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(data.byCampaign.length > 1 || filters.campaignId) && (
                <select aria-label="Campaign" value={filters.campaignId ?? ""} onChange={(e) => set({ campaignId: e.target.value || undefined })} className={selectClass}>
                  <option value="">All campaigns</option>
                  {filters.campaignId && !data.byCampaign.some((c) => c.campaignId === filters.campaignId) && <option value={filters.campaignId}>Selected campaign</option>}
                  {data.byCampaign.filter((c) => c.campaignId).map((c) => <option key={c.campaignId} value={c.campaignId!}>{c.name}</option>)}
                </select>
              )}
              <FacetSelect label="Ad set" all="All ad sets" value={filters.adGroupId} options={data.byAdGroup} onChange={(adGroupId) => set({ adGroupId })} />
              <FacetSelect label="Ad" all="All ads" value={filters.adId} options={data.byAd} onChange={(adId) => set({ adId })} />
              <FacetSelect label="Form" all="All forms" value={filters.formId} options={data.byForm} onChange={(formId) => set({ formId })} />
              <select aria-label="Phone" value={filters.hasPhone ?? ""} onChange={(e) => set({ hasPhone: (e.target.value || undefined) as LeadViewFilters["hasPhone"] })} className={selectClass}>
                <option value="">Any phone</option>
                <option value="true">Has phone</option>
                <option value="false">No phone</option>
              </select>
              <select aria-label="Email" value={filters.hasEmail ?? ""} onChange={(e) => set({ hasEmail: (e.target.value || undefined) as LeadViewFilters["hasEmail"] })} className={selectClass}>
                <option value="">Any email</option>
                <option value="true">Has email</option>
                <option value="false">No email</option>
              </select>
              <select aria-label="Paid or organic" value={filters.origin ?? ""} onChange={(e) => set({ origin: (e.target.value || undefined) as LeadViewFilters["origin"] })} className={selectClass}>
                <option value="">Paid and organic</option>
                <option value="paid">Paid (from ads)</option>
                <option value="organic">Organic</option>
              </select>
              {narrowing > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setFilters((f) => ({ ...EMPTY_FILTERS, sort: f.sort, pageSize: f.pageSize }))}>
                  <X /> Clear filters ({narrowing})
                </Button>
              )}
            </div>
          </div>

          {data.total === 0 ? (
            <Card><EmptyState icon={Contact} title={`No leads from ${info.name}`} description={narrowing > 0 ? "No leads match these filters. Clear a filter or widen the date range." : platform === "META" ? "Facebook and Instagram Instant Form leads show up here after a sync. Try a wider date range, or reconnect Meta if lead access was not granted." : LEAD_SYNC_PLATFORMS.includes(platform) ? `${info.name} leads for this date range show up here after they sync.` : `Lead sync for ${info.name} is coming soon. Use ${info.name}'s own lead export for now.`} /></Card>
          ) : (
            <Card className="gap-0 overflow-hidden py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Received</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Campaign / ad</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Est. cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.leads.map((l) => {
                    const t = when(l.createdTime, data.timezone);
                    return (
                      <TableRow key={l.id} className="cursor-pointer" onClick={() => { setOpenId(l.id); setOpenSnapshot(l); }}>
                        <TableCell>
                          <div className="font-medium">{leadName(l)}</div>
                          <div className="text-xs text-muted-foreground">{[filled(l.phone), filled(l.email)].filter(Boolean).join(" · ") || "—"}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap"><div>{t.date}</div><div className="text-xs text-muted-foreground">{t.time}</div></TableCell>
                        <TableCell><Badge variant="secondary">{sourceName(l.source)}</Badge>{l.isOrganic && <div className="mt-1 text-xs text-muted-foreground">Organic</div>}</TableCell>
                        <TableCell className="max-w-72"><div className="truncate">{filled(l.campaignName) ?? "—"}</div><div className="truncate text-xs text-muted-foreground">{filled(l.adName) ?? filled(l.formName) ?? "—"}</div></TableCell>
                        <TableCell>
                          <StatusControl lead={l} canManage={canManage} label={`Status of ${leadName(l)}`} onChange={(s) => setStatus(l, s)} />
                          {l.note && <div className="mt-1 flex max-w-40 items-center gap-1 truncate text-xs text-muted-foreground" title={l.note}><StickyNote className="size-3 shrink-0" />{l.note}</div>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{l.estCost == null ? "—" : money(l.estCost, l.currency)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-sm text-muted-foreground">
                <span>{data.total} leads</span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5">
                    <span>Rows per page</span>
                    <select aria-label="Rows per page" value={filters.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) })} className="h-8 rounded-md border bg-background px-1.5 text-sm text-foreground">
                      {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </label>
                  <Button size="icon-sm" variant="outline" aria-label="Previous page" disabled={page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}><ChevronLeft /></Button>
                  <span>Page {page} of {pages}</span>
                  <Button size="icon-sm" variant="outline" aria-label="Next page" disabled={page >= pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}><ChevronRight /></Button>
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent>
          {open && data && (
            <>
              <DialogHeader><DialogTitle>{leadName(open)}</DialogTitle></DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  <span className="flex items-center gap-1"><Clock className="size-3.5" />{when(open.createdTime, data.timezone).date}, {when(open.createdTime, data.timezone).time}</span>
                  {filled(open.phone) && <span className="flex items-center gap-1"><Phone className="size-3.5" />{open.phone}</span>}
                  {filled(open.email) && <span className="flex items-center gap-1"><Mail className="size-3.5" />{open.email}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Status</span>
                  <StatusControl lead={open} canManage={canManage} label="Lead status" onChange={(s) => setStatus(open, s)} />
                  {open.statusUpdatedAt && (
                    <span className="text-xs text-muted-foreground">
                      Updated {when(open.statusUpdatedAt, data.timezone).date}{open.statusUpdatedBy ? ` by ${open.statusUpdatedBy.name}` : ""}
                    </span>
                  )}
                </div>
                <dl className="divide-y rounded-lg border">
                  {Object.entries(open.fields).map(([k, v]) => (
                    <div key={k} className="grid grid-cols-[40%_1fr] gap-2 px-3 py-2"><dt className="text-muted-foreground">{k.replaceAll("_", " ")}</dt><dd>{v.join(", ")}</dd></div>
                  ))}
                </dl>
                <LeadNote key={open.id} lead={open} canManage={canManage} saving={update.isPending} onSave={(note, done) => update.mutate({ id: open.id, note }, { onSuccess: () => { toast.success("Note saved"); done(); }, onError: (err) => toast.error("Couldn't save the note", { description: errorMessage(err) }) })} />
                <div className="text-xs text-muted-foreground">
                  {sourceName(open.source)}{open.isOrganic ? " (organic)" : ""} · {filled(open.campaignName) ?? "Unknown campaign"} · {filled(open.adName) ?? filled(open.formName) ?? "—"}
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

/** The team's note on a lead: editable for people who work leads, read-only for the rest. */
function LeadNote({ lead, canManage, saving, onSave }: { lead: LeadDTO; canManage: boolean; saving: boolean; onSave: (note: string | null, done: () => void) => void }) {
  const [draft, setDraft] = useState(lead.note ?? "");
  const saved = lead.note ?? "";
  if (!canManage) {
    return lead.note ? (
      <div>
        <div className="mb-1 text-muted-foreground">Note</div>
        <p className="rounded-lg border bg-muted/30 px-3 py-2 whitespace-pre-wrap">{lead.note}</p>
      </div>
    ) : null;
  }
  const tooLong = draft.length > LEAD_NOTE_MAX;
  const changed = draft.trim() !== saved.trim();
  return (
    <div className="space-y-1.5">
      <label htmlFor={`note-${lead.id}`} className="text-muted-foreground">Note</label>
      <Textarea id={`note-${lead.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Called on Monday, wants a quote for 3 rooms…" rows={3} aria-invalid={tooLong} />
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-xs text-muted-foreground tabular-nums", tooLong && "text-destructive")}>{draft.length.toLocaleString("en-IN")} / {LEAD_NOTE_MAX.toLocaleString("en-IN")}</span>
        <Button size="sm" disabled={!changed || tooLong || saving} onClick={() => onSave(draft.trim() || null, () => setDraft(draft.trim()))}>Save note</Button>
      </div>
    </div>
  );
}
