"use client";

import { differenceInCalendarDays, parseISO } from "date-fns";
import {
  Bot,
  Check,
  ChevronsUpDown,
  FileImage,
  FileText,
  History,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Contact,
  Megaphone,
  Monitor,
  Moon,
  Plug,
  Plus,
  Settings,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useQueryClient } from "@tanstack/react-query";
import { LogoMark } from "@/components/brand";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import { useWorkspace } from "./workspace-context";

const NAV_GROUPS = [
  {
    label: "Analyze",
    items: [
      { href: "overview", label: "Overview", icon: LayoutDashboard },
      { href: "reports", label: "Reports", icon: FileText },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "campaigns", label: "Campaigns", icon: Megaphone },
      { href: "formats", label: "Ad formats", icon: LayoutGrid },
      { href: "leads", label: "Leads", icon: Contact },
      { href: "creatives", label: "Creatives", icon: FileImage },
      { href: "automations", label: "Automations", icon: Bot },
    ],
  },
] as const;

export function AppSidebar() {
  const { me, workspace, can } = useWorkspace();
  const pathname = usePathname();
  const base = `/w/${workspace.id}`;
  const isActive = (href: string) => pathname === `${base}/${href}` || pathname.startsWith(`${base}/${href}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pb-0">
        <WorkspaceSwitcher />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.label}>
                      <Link href={`${base}/${item.href}`}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup>
          <SidebarGroupLabel>Setup</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("integrations")} tooltip="Integrations">
                  <Link href={`${base}/integrations`}>
                    <Plug />
                    <span>Integrations</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {can("audit:view") && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive("activity")} tooltip="Activity log">
                    <Link href={`${base}/activity`}>
                      <History />
                      <span>Activity log</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {me.user.isSuperAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname.startsWith("/admin")} tooltip="Platform admin">
                    <Link href="/admin">
                      <ShieldCheck />
                      <span>Platform admin</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("settings")} tooltip="Settings">
                  <Link href={`${base}/settings`}>
                    <Settings />
                    <span>Settings</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <TrialCard />
        <UserMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function WorkspaceSwitcher() {
  const { me, org, workspace, can } = useWorkspace();
  const { isMobile } = useSidebar();
  const router = useRouter();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <LogoMark className="size-8" />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">{workspace.name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{org.name}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={6}
          >
            {me.orgs.map((o) => (
              <DropdownMenuGroup key={o.id}>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{o.name}</DropdownMenuLabel>
                {o.workspaces.map((w) => (
                  <DropdownMenuItem key={w.id} onSelect={() => router.push(`/w/${w.id}/overview`)} className="gap-2.5">
                    <span className="flex size-6 items-center justify-center rounded-md border bg-muted text-[10px] font-semibold">
                      {initials(w.name)}
                    </span>
                    <span className="flex-1 truncate">{w.name}</span>
                    {w.id === workspace.id && <Check className="size-4 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
            {can("workspaces:manage") && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => router.push(`/w/${workspace.id}/settings/workspaces?new=1`)} className="gap-2.5">
                  <span className="flex size-6 items-center justify-center rounded-md border border-dashed">
                    <Plus className="size-3.5" />
                  </span>
                  <span>New workspace</span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function TrialCard() {
  const { org, workspace } = useWorkspace();
  const { state } = useSidebar();
  if (org.plan !== "TRIAL" || !org.trialEndsAt || state === "collapsed") return null;
  const days = Math.max(0, differenceInCalendarDays(parseISO(org.trialEndsAt), new Date()));
  return (
    <div className="mx-1 mb-1 rounded-lg border bg-gradient-to-b from-primary/[0.06] to-transparent p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-sidebar-accent-foreground">Free trial</span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
          {days} {days === 1 ? "day" : "days"} left
        </Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-sidebar-foreground/75">Upgrade to keep syncing your ad accounts.</p>
      <Button asChild size="sm" className="mt-2.5 h-7 w-full text-xs">
        <Link href={`/w/${workspace.id}/settings/billing`}>View plans</Link>
      </Button>
    </div>
  );
}

function UserMenu() {
  const { me, workspace } = useWorkspace();
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-primary/10 text-xs font-semibold text-primary">
                  {initials(me.user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium text-sidebar-accent-foreground">{me.user.name}</span>
                <span className="truncate text-xs text-sidebar-foreground/70">{me.user.email}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-sidebar-foreground/60" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={6}>
            <DropdownMenuLabel className="font-normal">
              <div className="text-sm font-medium">{me.user.name}</div>
              <div className="text-xs text-muted-foreground">{me.user.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push(`/w/${workspace.id}/settings/profile`)}>
              <UserRound /> Profile
            </DropdownMenuItem>
            {me.user.isSuperAdmin && (
              <DropdownMenuItem onSelect={() => router.push("/admin")}>
                <ShieldCheck /> Platform admin
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Sun /> Appearance
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <Sun /> Light
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <Moon /> Dark
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    <Monitor /> System
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
