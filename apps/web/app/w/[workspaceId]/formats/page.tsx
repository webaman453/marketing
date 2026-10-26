"use client";

import { PLATFORMS, PLATFORM_INFO, VISIBLE_PLATFORMS, isPlatform, isPlatformShown, type Platform } from "@ashniva/shared";
import { ArrowLeft } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PageHeader } from "@/components/app/page-header";
import { useWorkspace } from "@/components/app/workspace-context";
import { CampaignBuilder } from "@/components/builder/campaign-builder";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useWorkspaceAdAccounts } from "@/lib/queries";
import { cn } from "@/lib/utils";

const GROUPS: { label: string; ids: Platform[] }[] = [
  { label: "Social", ids: ["META", "SNAPCHAT", "X", "LINKEDIN", "PINTEREST"] },
  { label: "Search and shopping", ids: ["GOOGLE", "MICROSOFT", "AMAZON", "APPLE"] },
  { label: "Native", ids: ["TABOOLA", "OUTBRAIN"] },
  { label: "Audio and programmatic", ids: ["SPOTIFY", "CRITEO", "YAHOO", "TRADEDESK"] },
  { label: "Stores and hiring", ids: ["SHOPIFY"] },
];

export default function AdFormatsPage() {
  return (
    <Suspense>
      <AdFormats />
    </Suspense>
  );
}

function AdFormats() {
  const params = useSearchParams();
  const requested = params.get("platform");
  if (isPlatform(requested) && isPlatformShown(requested)) return <PlatformForm platform={requested} />;
  return <PlatformGallery />;
}

function PlatformGallery() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const accounts = useWorkspaceAdAccounts(workspace.id);
  const counts = Object.fromEntries(PLATFORMS.map((platform) => [platform, 0])) as Record<Platform, number>;
  for (const account of accounts.data ?? []) counts[account.platform] += 1;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Ad formats"
        description="Choose a platform. The next screen is that platform's own form, with the same ad types it uses in its ads manager."
      />
      {[...GROUPS, { label: "More", ids: VISIBLE_PLATFORMS.filter((platform) => !GROUPS.some((group) => group.ids.includes(platform))) }].filter((group) => group.ids.some(isPlatformShown)).map((group) => (
        <section key={group.label} className="space-y-3">
          <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {group.ids.map((platform) => {
              const info = PLATFORM_INFO[platform];
              const connected = counts[platform] > 0;
              return (
                <button
                  key={platform}
                  type="button"
                  onClick={() => router.push(`/w/${workspace.id}/formats?platform=${platform}`)}
                  className="flex h-full flex-col rounded-xl border bg-card p-5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <PlatformIcon platform={platform} size="lg" />
                    <Badge variant={connected ? "secondary" : "outline"}>{connected ? `${counts[platform]} connected` : "Not connected"}</Badge>
                  </div>
                  <div className="mt-4 text-base font-semibold tracking-tight">{info.name}</div>
                  <p className="mt-1 line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">{info.description}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {info.channels.map((channel) => (
                      <span key={channel} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{channel}</span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function PlatformForm({ platform }: { platform: Platform }) {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const info = PLATFORM_INFO[platform];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-3">
          <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => router.push(`/w/${workspace.id}/formats`)}>
            <ArrowLeft /> All platforms
          </Button>
          <div className="flex items-center gap-3">
            <PlatformIcon platform={platform} size="lg" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">{info.name}</h1>
              <p className={cn("text-sm text-muted-foreground")}>{info.description}</p>
            </div>
          </div>
        </div>
      </div>
      <CampaignBuilder key={platform} initial={null} preset={{ platform, setup: {} }} />
    </div>
  );
}
