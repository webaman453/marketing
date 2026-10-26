"use client";

import { PLATFORM_INFO, isPlatformShown, type AuditLogDTO, type CampaignRowDTO } from "@ashniva/shared";
import { ArrowLeft, Eye, History, Pencil } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { DateRangePicker } from "@/components/app/date-range-picker";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { AdPreviews } from "@/components/campaigns/ad-previews";
import { BudgetDialog } from "@/components/campaigns/budget-dialog";
import { CampaignInsights } from "@/components/campaigns/campaign-insights";
import { useSetCampaignStatus } from "@/components/campaigns/use-campaign-actions";
import { PerformanceChart } from "@/components/dashboard/performance-chart";
import { StatusDot } from "@/components/metrics";
import { PlatformIcon } from "@/components/platform-icon";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dateTime, humanize, initials, longDate, money, multiple, number, percent, timeAgo } from "@/lib/format";
import { useCampaign } from "@/lib/queries";
import { cn } from "@/lib/utils";

export default function CampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { workspace, can } = useWorkspace();
  const query = useCampaign(workspace.id, campaignId);
  const setStatus = useSetCampaignStatus(workspace.id);
  const [editing, setEditing] = useState<CampaignRowDTO | null>(null);
  const [tab, setTab] = useState("groups");
  const [previewAd, setPreviewAd] = useState<string | null>(null);
  const back = (
    <Link
      href={`/w/${workspace.id}/campaigns`}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> Campaigns
    </Link>
  );

  if (query.isError) {
    return (
      <div className="space-y-6">
        {back}
        <Card>
          <ErrorState message={query.error.message} onRetry={() => query.refetch()} />
        </Card>
      </div>
    );
  }
  if (!query.data) return <DetailSkeleton back={back} />;

  const { campaign: c, timeseries, adGroups, ads, activity } = query.data;
  if (!isPlatformShown(c.platform)) {
    return (
      <div className="space-y-6">
        {back}
        <Card>
          <EmptyState icon={Eye} title="This campaign is not available" description="It belongs to a platform that is not shown in this workspace." />
        </Card>
      </div>
    );
  }
  const terms = PLATFORM_INFO[c.platform].terms;
  // Some platforms keep the budget on each ad group instead of the campaign.
  const groupBudget = adGroups.reduce((sum, g) => sum + (g.dailyBudget ?? 0), 0);
  const perDay = (v: number) => `${money(v, c.currency, { decimals: Number.isInteger(v) ? 0 : 2 })}/day`;
  const budgetLabel = c.dailyBudget != null ? perDay(c.dailyBudget) : groupBudget > 0 ? `${perDay(groupBudget)} across ${terms.adGroup.toLowerCase()}s` : "not set";
  const editable = can("campaigns:edit") && (c.status === "ACTIVE" || c.status === "PAUSED");
  const m = c.metrics;

  return (
    <div className={cn("space-y-6", query.isPlaceholderData && "opacity-70 transition-opacity")}>
      {back}

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <PlatformIcon platform={c.platform} size="lg" />
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">{c.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <StatusDot status={c.status} />
              <span>{PLATFORM_INFO[c.platform].name}</span>
              <span className="text-muted-foreground/40">•</span>
              <span>{c.adAccount.name}</span>
              {c.objective && (
                <>
                  <span className="text-muted-foreground/40">•</span>
                  <span>{humanize(c.objective)}</span>
                </>
              )}
              {c.startDate && (
                <>
                  <span className="text-muted-foreground/40">•</span>
                  <span>Started {longDate(c.startDate)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable && (
            <label className="flex h-8 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
              <Switch
                checked={c.status === "ACTIVE"}
                onCheckedChange={(on) => setStatus.mutate({ id: c.id, name: c.name, status: on ? "ACTIVE" : "PAUSED" })}
                className="scale-90"
              />
              {c.status === "ACTIVE" ? "Active" : "Paused"}
            </label>
          )}
          {editable && (
            <Button variant="outline" className="bg-card" onClick={() => setEditing(c)}>
              <Pencil /> Budget: {budgetLabel}
            </Button>
          )}
          <DateRangePicker />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3 xl:grid-cols-6">
        {[
          ["Spend", money(m.spend, c.currency)],
          ["Impressions", number(m.impressions)],
          ["Clicks", number(m.clicks)],
          ["CTR", percent(m.ctr)],
          ["Conversions", number(m.conversions, { decimals: 1 })],
          ["ROAS", multiple(m.roas)],
        ].map(([label, value]) => (
          <div key={label} className="bg-card px-4 py-3.5">
            <div className="text-xs font-medium text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold tracking-tight tabular">{value}</div>
          </div>
        ))}
      </div>

      <PerformanceChart series={timeseries} currency={c.currency} />

      <CampaignInsights campaignId={c.id} />

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList>
          <TabsTrigger value="groups">
            {terms.adGroup}s <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{adGroups.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="ads">
            {terms.ad}s <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">{ads.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Eye className="size-3.5" /> How it looks
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="groups">
          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">{terms.adGroup}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">{terms.ad}s</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Conv.</TableHead>
                  <TableHead className="text-right">Cost / conv.</TableHead>
                  <TableHead className="pr-4 text-right">ROAS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adGroups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="pl-4 font-medium">{g.name}</TableCell>
                    <TableCell><StatusDot status={g.status} /></TableCell>
                    <TableCell className="text-right tabular">{g.adCount}</TableCell>
                    <TableCell className="text-right font-medium tabular">{money(g.metrics.spend, c.currency)}</TableCell>
                    <TableCell className="text-right tabular">{number(g.metrics.clicks)}</TableCell>
                    <TableCell className="text-right tabular">{percent(g.metrics.ctr)}</TableCell>
                    <TableCell className="text-right tabular">{number(g.metrics.conversions, { decimals: 1 })}</TableCell>
                    <TableCell className="text-right tabular">{money(g.metrics.cpa, c.currency, { decimals: 0 })}</TableCell>
                    <TableCell className="pr-4 text-right tabular">{multiple(g.metrics.roas)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="ads">
          <Card className="gap-0 overflow-hidden py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">{terms.ad}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Impr.</TableHead>
                  <TableHead className="text-right">CTR</TableHead>
                  <TableHead className="text-right">Conv.</TableHead>
                  <TableHead className="text-right">ROAS</TableHead>
                  <TableHead className="pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {ads.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-[420px] pl-4">
                      <div className="truncate font-medium">{a.name}</div>
                      {a.headline && <div className="truncate text-xs text-muted-foreground">“{a.headline}”</div>}
                    </TableCell>
                    <TableCell><StatusDot status={a.status} /></TableCell>
                    <TableCell className="text-right font-medium tabular">{money(a.metrics.spend, c.currency)}</TableCell>
                    <TableCell className="text-right tabular">{number(a.metrics.impressions)}</TableCell>
                    <TableCell className="text-right tabular">{percent(a.metrics.ctr)}</TableCell>
                    <TableCell className="text-right tabular">{number(a.metrics.conversions, { decimals: 1 })}</TableCell>
                    <TableCell className="text-right tabular">{multiple(a.metrics.roas)}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setPreviewAd(a.id);
                          setTab("preview");
                        }}
                      >
                        <Eye /> Preview
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="preview">
          <AdPreviews ads={ads} campaign={c} brand={workspace.name} workspaceId={workspace.id} selected={previewAd} onSelect={setPreviewAd} />
        </TabsContent>

        <TabsContent value="activity">
          <Card className="py-2">
            {activity.length === 0 ? (
              <EmptyState icon={History} title="No changes yet" description="Status and budget changes made here will appear in this timeline." />
            ) : (
              <ActivityList items={activity} />
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <BudgetDialog campaign={editing} workspaceId={workspace.id} onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}

const ACTION_TEXT: Record<string, string> = {
  "campaign.paused": "paused this campaign",
  "campaign.activated": "activated this campaign",
  "campaign.budget_changed": "changed the daily budget",
  "campaign.created": "created this campaign in the campaign builder",
};

function ActivityList({ items }: { items: AuditLogDTO[] }) {
  return (
    <ol className="divide-y">
      {items.map((a) => {
        const budget = a.changes?.dailyBudget;
        return (
          <li key={a.id} className="flex items-start gap-3 px-5 py-3">
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary/10 text-[10px] font-semibold text-primary">
                {a.actor ? initials(a.actor.name) : "—"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{a.actor?.name ?? "System"}</span>{" "}
              <span className="text-muted-foreground">{ACTION_TEXT[a.action] ?? a.action}</span>
              {budget && (
                <span className="text-muted-foreground">
                  {" "}from <span className="font-medium text-foreground tabular">{String(budget.from ?? "—")}</span> to{" "}
                  <span className="font-medium text-foreground tabular">{String(budget.to)}</span>
                </span>
              )}
              <div className="text-xs text-muted-foreground" title={dateTime(a.createdAt)}>
                {timeAgo(a.createdAt)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DetailSkeleton({ back }: { back: React.ReactNode }) {
  return (
    <div className="space-y-6">
      {back}
      <div className="flex items-center gap-4">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-80" />
          <Skeleton className="h-4 w-60" />
        </div>
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
