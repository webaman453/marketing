"use client";

import { PLATFORMS, PLATFORM_INFO, VISIBLE_PLATFORMS, isPlatform, isPlatformShown, type Platform } from "@ashniva/shared";
import { CreditCard, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceAdAccounts } from "@/lib/queries";

const GROUPS: { label: string; ids: Platform[] }[] = [
  { label: "Social", ids: ["META", "SNAPCHAT", "X", "LINKEDIN", "PINTEREST"] },
  { label: "Search and shopping", ids: ["GOOGLE", "MICROSOFT", "AMAZON", "APPLE"] },
  { label: "Native", ids: ["TABOOLA", "OUTBRAIN"] },
  { label: "Audio and programmatic", ids: ["SPOTIFY", "CRITEO", "YAHOO", "TRADEDESK"] },
  { label: "Stores", ids: ["SHOPIFY"] },
];

export default function AdFormatsPage() {
  return (
    <Suspense>
      <AdFormats />
    </Suspense>
  );
}

function AdFormats() {
  const { workspace, org, can } = useWorkspace();
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("platform");
  const target = isPlatform(requested) && isPlatformShown(requested) ? requested : null;

  // The form itself lives on Create campaign, where autosave keeps its own URL (?draft=) working on reload.
  useEffect(() => {
    if (target && can("campaigns:edit") && !org.locked) router.replace(`/w/${workspace.id}/campaigns/new?platform=${target}`);
  }, [target, can, org.locked, router, workspace.id]);

  if (!can("campaigns:edit")) {
    return (
      <div className="space-y-8">
        <PageHeader title="Ad formats" />
        <Card>
          <EmptyState icon={Lock} title="You can't create ads in this organization" description="Your role can view data but not change campaigns. Ask an owner or admin for the Manager role." />
        </Card>
      </div>
    );
  }
  if (org.locked) {
    return (
      <div className="space-y-8">
        <PageHeader title="Ad formats" />
        <Card>
          <EmptyState
            icon={CreditCard}
            title="Choose a plan to create ads"
            description="This organization is read-only until a plan is active. Pick a plan and every platform's form opens here."
            action={
              <Button asChild>
                <Link href={`/w/${workspace.id}/settings/billing`}>Choose a plan</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }
  if (target) return <Skeleton className="h-[480px] rounded-xl" />;
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
                  onClick={() => router.push(`/w/${workspace.id}/campaigns/new?platform=${platform}`)}
                  className="flex h-full flex-col rounded-xl border bg-card p-5 text-left transition-colors hover:border-foreground/20 hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <PlatformIcon platform={platform} size="lg" />
                    <Badge variant={connected ? "secondary" : "outline"}>{connected ? `${counts[platform]} ${counts[platform] === 1 ? "account" : "accounts"}` : "Not connected"}</Badge>
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
