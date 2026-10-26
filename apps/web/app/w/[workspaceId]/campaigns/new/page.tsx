"use client";

import { isPlatform, type Platform, type Values } from "@ashniva/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { PageHeader } from "@/components/app/page-header";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { CampaignBuilder } from "@/components/builder/campaign-builder";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDraft } from "@/lib/queries";

export default function NewCampaignPage() {
  return (
    <Suspense>
      <NewCampaign />
    </Suspense>
  );
}

function presetFrom(params: { get(name: string): string | null; entries(): IterableIterator<[string, string]> }): { platform: Platform; setup: Values } | null {
  const platform = params.get("platform");
  if (!isPlatform(platform)) return null;
  const setup: Values = {};
  for (const [key, value] of params.entries()) {
    if (key === "platform" || key === "draft") continue;
    setup[key] = value;
  }
  return { platform, setup };
}

function NewCampaign() {
  const { workspace } = useWorkspace();
  const params = useSearchParams();
  // Read once: the builder updates ?draft= itself after the first autosave.
  const [draftId] = useState(() => params.get("draft"));
  const preset = presetFrom(params);
  const draft = useDraft(workspace.id, draftId);

  return (
    <div className="space-y-6">
      <PageHeader title={draftId ? "Edit draft campaign" : "Create campaign"} description="The same options as each platform's own ads manager, with a live preview and AI help.">
        <Link href={`/w/${workspace.id}/campaigns`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Campaigns
        </Link>
      </PageHeader>
      {draftId && draft.isError ? (
        <Card><ErrorState message={draft.error.message} /></Card>
      ) : draftId && !draft.data ? (
        <Skeleton className="h-[560px] rounded-xl" />
      ) : (
        <CampaignBuilder initial={draft.data ?? null} preset={preset} />
      )}
    </div>
  );
}
