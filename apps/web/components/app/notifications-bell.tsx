"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, Bot, CheckCheck, Plug } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { qk2, useNotifications } from "@/lib/queries";
import { cn } from "@/lib/utils";

const ICONS: Record<string, typeof Bell> = {
  "rule.triggered": Bot,
  "integration.expired": Plug,
};

export function NotificationsBell() {
  const { data } = useNotifications();
  const queryClient = useQueryClient();
  const router = useRouter();
  const unread = data?.unread ?? 0;

  async function markAll() {
    await api("/notifications/read", { method: "POST", body: {} }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: qk2.notifications });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative text-muted-foreground" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}>
          <Bell />
          {unread > 0 && (
            <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white tabular">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={markAll}>
              <CheckCheck /> Mark all read
            </Button>
          )}
        </div>
        {!data || data.items.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <Bell className="mx-auto size-5 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">You&apos;re all caught up</p>
            <p className="mt-1 text-xs text-muted-foreground">Automation alerts and integration issues will appear here.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[420px]">
            <ul className="divide-y">
              {data.items.map((n) => {
                const Icon = ICONS[n.type] ?? AlertTriangle;
                return (
                  <li key={n.id}>
                    <button
                      className={cn("flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60", !n.readAt && "bg-primary/[0.03]")}
                      onClick={async () => {
                        if (!n.readAt) {
                          await api("/notifications/read", { method: "POST", body: { ids: [n.id] } }).catch(() => undefined);
                          void queryClient.invalidateQueries({ queryKey: qk2.notifications });
                        }
                        if (n.link) router.push(n.link);
                      }}
                    >
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-card">
                        <Icon className="size-3.5 text-primary" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-2">
                          <span className="flex-1 text-sm leading-snug font-medium">{n.title}</span>
                          {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
                        </span>
                        {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
                        <span className="mt-1 block text-[11px] text-muted-foreground/80">{timeAgo(n.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
