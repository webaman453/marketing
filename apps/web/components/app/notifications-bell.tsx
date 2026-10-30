"use client";

import type { NotificationDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bell, Bot, CheckCheck, Plug } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { qk2, useNotifications } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./workspace-context";

const ICONS: Record<string, typeof Bell> = {
  "rule.triggered": Bot,
  "integration.expired": Plug,
};

type NotificationList = { unread: number; items: NotificationDTO[] };

/** The bell in the app header. Shows the current organization's notifications only. */
export function NotificationsBell() {
  const { org } = useWorkspace();
  const { data } = useNotifications(org.id);
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const unread = data?.unread ?? 0;
  const queryKey = [...qk2.notifications, org.id];

  /** Shows the given notifications (all when omitted) as read right away, then saves that. */
  async function markRead(ids?: string[]) {
    await queryClient.cancelQueries({ queryKey });
    const now = new Date().toISOString();
    queryClient.setQueryData<NotificationList>(queryKey, (prev) => {
      if (!prev) return prev;
      let marked = 0;
      const items = prev.items.map((n) => {
        if (n.readAt || (ids && !ids.includes(n.id))) return n;
        marked++;
        return { ...n, readAt: now };
      });
      return { items, unread: ids ? Math.max(0, prev.unread - marked) : 0 };
    });
    await api("/notifications/read", { method: "POST", body: ids ? { ids } : { orgId: org.id } }).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: qk2.notifications });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => void markRead()}>
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
                      onClick={() => {
                        if (!n.readAt) void markRead([n.id]);
                        if (n.link) {
                          setOpen(false);
                          router.push(n.link);
                        }
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
