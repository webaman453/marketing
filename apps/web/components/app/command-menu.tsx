"use client";

import { isPlatformShown } from "@ashniva/shared";
import { History, LayoutDashboard, Megaphone, Moon, Plug, Search, Settings, Sun, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useCampaigns } from "@/lib/queries";
import { useWorkspace } from "./workspace-context";

/** ⌘K palette: jump to pages, campaigns and workspaces. */
export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { me, workspace } = useWorkspace();
  const { setTheme, resolvedTheme } = useTheme();
  const campaigns = useCampaigns(workspace.id, {});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const base = `/w/${workspace.id}`;

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-8 w-8 justify-start gap-2 bg-card px-2 font-normal text-muted-foreground md:w-56 lg:w-64"
      >
        <Search />
        <span className="hidden md:inline">Search…</span>
        <kbd className="ml-auto hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium md:inline-flex">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a page, campaign or workspace">
        <CommandInput placeholder="Search pages, campaigns, workspaces…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem onSelect={() => go(`${base}/overview`)}>
              <LayoutDashboard /> Overview
            </CommandItem>
            <CommandItem onSelect={() => go(`${base}/campaigns`)}>
              <Megaphone /> Campaigns
            </CommandItem>
            <CommandItem onSelect={() => go(`${base}/integrations`)}>
              <Plug /> Integrations
            </CommandItem>
            <CommandItem onSelect={() => go(`${base}/activity`)}>
              <History /> Activity log
            </CommandItem>
            <CommandItem onSelect={() => go(`${base}/settings/team`)}>
              <Users /> Team members
            </CommandItem>
            <CommandItem onSelect={() => go(`${base}/settings`)}>
              <Settings /> Settings
            </CommandItem>
          </CommandGroup>
          {campaigns.data && campaigns.data.campaigns.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Campaigns">
                {campaigns.data.campaigns.filter((c) => isPlatformShown(c.platform)).slice(0, 50).map((c) => (
                  <CommandItem key={c.id} value={`${c.name} ${c.platform}`} onSelect={() => go(`${base}/campaigns/${c.id}`)}>
                    <PlatformIcon platform={c.platform} size="xs" />
                    <span className="truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {me.orgs.some((o) => o.workspaces.length > 1) && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Switch workspace">
                {me.orgs.flatMap((o) =>
                  o.workspaces.map((w) => (
                    <CommandItem key={w.id} value={`workspace ${w.name} ${o.name}`} onSelect={() => go(`/w/${w.id}/overview`)}>
                      <span className="flex size-4 items-center justify-center rounded border text-[8px] font-semibold">
                        {w.name[0]}
                      </span>
                      {w.name}
                      <span className="text-xs text-muted-foreground">{o.name}</span>
                    </CommandItem>
                  )),
                )}
              </CommandGroup>
            </>
          )}
          <CommandSeparator />
          <CommandGroup heading="Preferences">
            <CommandItem
              onSelect={() => {
                setTheme(resolvedTheme === "dark" ? "light" : "dark");
                setOpen(false);
              }}
            >
              {resolvedTheme === "dark" ? <Sun /> : <Moon />}
              Switch to {resolvedTheme === "dark" ? "light" : "dark"} mode
              <CommandShortcut>Theme</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
