"use client";

import type { AiInsightsResponse } from "@ashniva/shared";
import { AlertTriangle, Info, Loader2, RefreshCw, Sparkles, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/app/workspace-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useAiStatus } from "@/lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

const TYPE = {
  opportunity: { icon: TrendingUp, cls: "bg-success/10 text-success" },
  risk: { icon: AlertTriangle, cls: "bg-destructive/10 text-destructive" },
  info: { icon: Info, cls: "bg-primary/10 text-primary" },
} as const;

/** On-demand AI analysis of recent performance (uses AI tokens): the whole workspace, or one campaign. */
export function AiInsights({
  path = "/ai/insights",
  title = "AI insights",
  intro = "Get a quick read on what's working, what's wasting budget and what to do next.",
}: { path?: string; title?: string; intro?: string } = {}) {
  const { workspace } = useWorkspace();
  const status = useAiStatus(workspace.id);
  const queryClient = useQueryClient();
  const [data, setData] = useState<AiInsightsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  if (!status.data?.available) return null;

  async function analyze() {
    setLoading(true);
    try {
      setData(await api<AiInsightsResponse>(`/workspaces/${workspace.id}${path}`, { method: "POST", body: { days: 30 } }));
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
      void queryClient.invalidateQueries({
        queryKey: qk2.aiStatus(workspace.id),
      });
    }
  }

  return (
    <Card className="gap-4 overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" /> {title}
        </CardTitle>
        <CardDescription>
          {data
            ? `Generated ${timeAgo(data.generatedAt)} from the last 30 days`
            : intro}
        </CardDescription>
        <CardAction>
          {!status.data.canUse ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/w/${workspace.id}/settings/ai`}>Buy AI tokens</Link>
            </Button>
          ) : (
            <Button size="sm" variant={data ? "ghost" : "default"} onClick={analyze} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : data ? <RefreshCw /> : <Sparkles />}
              {loading ? "Analysing…" : data ? "Refresh" : "Analyse performance"}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      {(loading || data) && (
        <CardContent className="space-y-4">
          {loading && !data ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : data ? (
            <>
              <p className="text-sm leading-relaxed">{data.summary}</p>
              <div className="grid gap-3 lg:grid-cols-2">
                {data.insights.map((ins, i) => {
                  const t = TYPE[ins.type];
                  return (
                    <div key={i} className="flex gap-3 rounded-lg border p-3.5 animate-fade-up" style={{ animationDelay: `${i * 50}ms` }}>
                      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", t.cls)}>
                        <t.icon className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{ins.title}</span>
                          <Badge variant="secondary" className="h-5 text-[10px] capitalize">
                            {ins.impact} impact
                          </Badge>
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{ins.detail}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                AI-generated from your synced data. Double-check before making large budget changes.
              </p>
            </>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
