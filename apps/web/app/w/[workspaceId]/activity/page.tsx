"use client";

import type { AuditLogDTO } from "@ashniva/shared";
import {
  ArrowRightLeft,
  Building2,
  CirclePause,
  CirclePlay,
  FlaskConical,
  History,
  IndianRupee,
  Layers,
  Loader2,
  Plug,
  Unplug,
  UserMinus,
  UserPlus,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/format";
import { useAuditLog } from "@/lib/queries";

const ACTIONS: Record<string, { icon: LucideIcon; text: string; tone?: string }> = {
  "campaign.paused": { icon: CirclePause, text: "paused", tone: "text-muted-foreground" },
  "campaign.activated": { icon: CirclePlay, text: "activated", tone: "text-success" },
  "campaign.budget_changed": { icon: IndianRupee, text: "changed the budget of" },
  "integration.connected": { icon: Plug, text: "connected", tone: "text-primary" },
  "integration.disconnected": { icon: Unplug, text: "disconnected", tone: "text-destructive" },
  "ad_account.assigned": { icon: ArrowRightLeft, text: "assigned ad account" },
  "ad_account.unassigned": { icon: ArrowRightLeft, text: "unassigned ad account" },
  "member.invited": { icon: UserPlus, text: "invited", tone: "text-primary" },
  "member.updated": { icon: UserCog, text: "updated access for" },
  "member.removed": { icon: UserMinus, text: "removed", tone: "text-destructive" },
  "member.left": { icon: UserMinus, text: "left the organization" },
  "workspace.created": { icon: Layers, text: "created workspace" },
  "workspace.updated": { icon: Layers, text: "updated workspace" },
  "workspace.archived": { icon: Layers, text: "archived workspace" },
  "workspace.restored": { icon: Layers, text: "restored workspace" },
  "org.updated": { icon: Building2, text: "renamed the organization to" },
  "sample_data.added": { icon: FlaskConical, text: "loaded sample data into" },
  "sample_data.removed": { icon: FlaskConical, text: "removed sample data from" },
};

function dayLabel(iso: string) {
  const d = parseISO(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEEE, d MMMM yyyy");
}

function describeChange(a: AuditLogDTO, currency: string) {
  const budget = a.changes?.dailyBudget;
  if (budget) {
    const fmt = (v: unknown) => (typeof v === "number" ? money(v, currency) : "—");
    return `from ${fmt(budget.from)} to ${fmt(budget.to)}`;
  }
  const role = a.changes?.role;
  if (role) return `role ${String(role.from).toLowerCase()} → ${String(role.to).toLowerCase()}`;
  return null;
}

export default function ActivityPage() {
  const { org, workspace, can } = useWorkspace();
  const log = useAuditLog(org.id);

  if (!can("audit:view")) {
    return (
      <Card>
        <EmptyState icon={History} title="Activity log is limited to admins" description="Ask an owner or admin if you need to review changes." />
      </Card>
    );
  }

  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = items.reduce<{ day: string; items: AuditLogDTO[] }[]>((acc, item) => {
    const day = dayLabel(item.createdAt);
    const last = acc.at(-1);
    if (last?.day === day) last.items.push(item);
    else acc.push({ day, items: [item] });
    return acc;
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Activity log" description="Every change made in your organization: who did it, and when." />
      {log.isError ? (
        <Card><ErrorState message={log.error.message} onRetry={() => log.refetch()} /></Card>
      ) : !log.data ? (
        <Card className="p-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="mb-3 h-10" />)}</Card>
      ) : items.length === 0 ? (
        <Card><EmptyState icon={History} title="Nothing here yet" description="Campaign changes, new integrations and team updates will show up here." /></Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.day} className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.day}</h2>
              <Card className="gap-0 py-0">
                <ol className="divide-y">
                  {g.items.map((a) => {
                    const meta = ACTIONS[a.action] ?? { icon: History, text: a.action };
                    const change = describeChange(a, workspace.currency);
                    return (
                      <li key={a.id} className="flex items-start gap-3 px-5 py-3">
                        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                          <meta.icon className={`size-4 ${meta.tone ?? "text-foreground/70"}`} />
                        </span>
                        <div className="min-w-0 flex-1 text-sm leading-relaxed">
                          <span className="font-medium">{a.actor?.name ?? "System"}</span>{" "}
                          <span className="text-muted-foreground">{meta.text}</span>{" "}
                          {a.entityName && <span className="font-medium">{a.entityName}</span>}
                          {change && <span className="text-muted-foreground"> · {change}</span>}
                        </div>
                        <time className="shrink-0 text-xs text-muted-foreground tabular" dateTime={a.createdAt}>
                          {format(parseISO(a.createdAt), "h:mm a")}
                        </time>
                      </li>
                    );
                  })}
                </ol>
              </Card>
            </section>
          ))}
          {log.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                {log.isFetchingNextPage && <Loader2 className="animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
