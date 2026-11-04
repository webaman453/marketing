"use client";

import { PLATFORM_INFO, type AlertActionInfoDTO } from "@ashniva/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BellOff, CheckCircle2, Loader2, PauseCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { longDate } from "@/lib/format";

export default function AlertActionPage() {
  return (
    <Suspense>
      <Confirm />
    </Suspense>
  );
}

/** Where the one-click links in alerts land: says what will happen and waits for one more click. */
function Confirm() {
  const token = useSearchParams().get("t") ?? "";
  const path = `/alert-actions/${encodeURIComponent(token)}`;
  const info = useQuery({ queryKey: ["alert-action", token], queryFn: () => api<AlertActionInfoDTO>(path), enabled: Boolean(token), retry: false });
  const run = useMutation({ mutationFn: () => api<{ done: "paused" | "muted"; until?: string }>(path, { method: "POST" }) });
  const d = info.data;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md items-center px-4">
      <Card className="w-full gap-5 p-6">
        {!token || info.isError ? (
          <>
            <TriangleAlert className="size-6 text-warning" />
            <div>
              <h1 className="text-lg font-semibold">This link can&apos;t be used</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {!token ? "The link is incomplete." : info.error instanceof Error ? info.error.message : "It may have expired."}
              </p>
            </div>
            <Button asChild variant="outline"><Link href="/app">Open Ashniva Ads</Link></Button>
          </>
        ) : !d ? (
          <Skeleton className="h-32" />
        ) : run.isSuccess ? (
          <>
            <CheckCircle2 className="size-6 text-success" />
            <div>
              <h1 className="text-lg font-semibold">{run.data.done === "paused" ? "Campaign paused" : "Alerts muted"}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {run.data.done === "paused" ? `${d.campaignName} is paused on ${PLATFORM_INFO[d.platform].name}.` : `You won't get unusual-spend alerts for ${d.campaignName} until ${run.data.until ? longDate(run.data.until) : "then"}.`}
              </p>
            </div>
            <Button asChild><Link href={`/w/${d.workspaceId}/campaigns`}>Go to campaigns</Link></Button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <PlatformIcon platform={d.platform} size="lg" />
              <div className="min-w-0">
                <div className="truncate font-semibold">{d.campaignName}</div>
                <div className="text-xs text-muted-foreground">{PLATFORM_INFO[d.platform].name} · {d.workspaceName}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              {d.action === "pause" ? <PauseCircle className="mt-0.5 size-5 text-primary" /> : <BellOff className="mt-0.5 size-5 text-primary" />}
              <p className="text-sm">
                {d.action === "pause"
                  ? `Pause this campaign on ${PLATFORM_INFO[d.platform].name}. Its ads stop running until you turn it back on.`
                  : `Stop unusual-spend alerts for this campaign for ${d.days === 1 ? "a day" : `${d.days} days`}.`}
              </p>
            </div>
            {d.note && <p className="text-sm text-muted-foreground">{d.note}</p>}
            {run.isError && <p className="text-sm text-destructive">{run.error instanceof Error ? run.error.message : "That didn't work."}</p>}
            <div className="flex gap-2">
              <Button onClick={() => run.mutate()} disabled={run.isPending || !d.available}>
                {run.isPending && <Loader2 className="animate-spin" />} {d.action === "pause" ? "Pause campaign" : "Mute alerts"}
              </Button>
              <Button asChild variant="outline"><Link href={`/w/${d.workspaceId}/campaigns`}>Cancel</Link></Button>
            </div>
          </>
        )}
      </Card>
    </main>
  );
}
