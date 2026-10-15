"use client";

import { BRAND } from "@ashniva/shared";
import { Building2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { LogoMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe } from "@/lib/queries";
import { AppSidebar } from "./app-sidebar";
import { CommandMenu } from "./command-menu";
import { NotificationsBell } from "./notifications-bell";
import { EmptyState, ErrorState } from "./states";
import { LAST_WORKSPACE_KEY, WorkspaceProvider } from "./workspace-context";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const me = useMe();

  const org = me.data?.orgs.find((o) => o.workspaces.some((w) => w.id === workspaceId));
  const workspace = org?.workspaces.find((w) => w.id === workspaceId);

  useEffect(() => {
    if (workspace) {
      try {
        localStorage.setItem(LAST_WORKSPACE_KEY, workspace.id);
      } catch {
        /* storage unavailable */
      }
      document.title = `${workspace.name} · ${BRAND.name}`;
    }
  }, [workspace]);

  if (me.isPending) return <ShellSkeleton />;
  if (me.isError) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <ErrorState message={me.error.message} onRetry={() => me.refetch()} />
      </div>
    );
  }
  if (!org || !workspace) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <EmptyState
          icon={Building2}
          title="Workspace not found"
          description="It may have been archived, or you no longer have access to it."
          action={
            <Button asChild>
              <Link href="/app">Go to my workspace</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <WorkspaceProvider me={me.data} org={org} workspace={workspace}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/70 md:px-6">
            <SidebarTrigger className="-ml-1.5 text-muted-foreground" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden truncate text-muted-foreground sm:inline">{org.name}</span>
              <span className="hidden text-muted-foreground/50 sm:inline">/</span>
              <span className="truncate font-medium">{workspace.name}</span>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <CommandMenu />
              <NotificationsBell />
            </div>
          </header>
          {org.locked && (
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-sm">
              <span className="font-medium">
                {org.plan === "TRIAL" ? "Your free trial has ended." : "Your subscription is inactive."}
              </span>
              <span className="text-muted-foreground">Your data is safe and read-only until you choose a plan.</span>
              {org.role === "OWNER" && (
                <Link href={`/w/${workspace.id}/settings/billing`} className="font-medium text-primary hover:underline">
                  View plans →
                </Link>
              )}
            </div>
          )}
          <main className="flex-1 px-4 py-6 md:px-6 lg:px-8">
            <div className="mx-auto w-full max-w-[1400px]">{children}</div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </WorkspaceProvider>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex min-h-svh">
      <div className="hidden w-64 flex-col gap-3 border-r bg-sidebar p-3 md:flex">
        <div className="flex items-center gap-2 p-1">
          <LogoMark />
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
        <div className="mt-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      </div>
      <div className="flex-1">
        <div className="h-14 border-b" />
        <div className="space-y-6 p-8">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-80" />
        </div>
      </div>
    </div>
  );
}
