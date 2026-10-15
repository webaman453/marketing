"use client";

import { Bell, Building2, CreditCard, KeyRound, Layers, Palette, Sparkles, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/app/page-header";
import { useWorkspace } from "@/components/app/workspace-context";
import { cn } from "@/lib/utils";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { workspace, org, can } = useWorkspace();
  const client = org.role === "CLIENT";
  const pathname = usePathname();
  const base = `/w/${workspace.id}/settings`;

  const items = [
    { href: "general", label: "General", icon: Building2, show: true },
    { href: "workspaces", label: "Workspaces", icon: Layers, show: true },
    { href: "team", label: "Team", icon: Users, show: !client },
    { href: "branding", label: "Branding", icon: Palette, show: can("org:update") },
    { href: "api-keys", label: "Developer API", icon: KeyRound, show: can("org:update") },
    { href: "billing", label: "Plan & billing", icon: CreditCard, show: can("billing:manage") },
    { href: "ai", label: "AI tokens", icon: Sparkles, show: !client },
    { href: "profile", label: "Your profile", icon: UserRound, show: true },
    { href: "notifications", label: "Notifications", icon: Bell, show: true },
  ].filter((i) => i.show);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Manage your organization, workspaces, team and account." />
      <div className="grid gap-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
        <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1 lg:mx-0 lg:flex-col lg:overflow-visible">
          {items.map((i) => {
            const active = pathname.startsWith(`${base}/${i.href}`);
            return (
              <Link
                key={i.href}
                href={`${base}/${i.href}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                  active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <i.icon className="size-4" />
                {i.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0 max-w-3xl animate-fade-up" key={pathname}>
          {children}
        </div>
      </div>
    </div>
  );
}
