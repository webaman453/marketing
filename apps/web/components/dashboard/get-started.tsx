"use client";

import { PLATFORM_INFO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FlaskConical, Loader2, Plug, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { toastError } from "@/lib/forms";

/** Shown on the overview until the workspace has at least one ad account. */
export function GetStarted() {
  const { org, workspace, me, can } = useWorkspace();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const firstName = me.user.name.split(" ")[0];

  async function loadSample() {
    setLoading(true);
    try {
      await api(`/orgs/${org.id}/sample-data`, { method: "POST", body: { workspaceId: workspace.id } });
      toast.success("Sample data is loading", { description: "Your dashboard will fill in a few seconds." });
      // Give the worker a moment, then refresh everything.
      setTimeout(() => void queryClient.invalidateQueries(), 2500);
      setTimeout(() => void queryClient.invalidateQueries(), 6000);
    } catch (err) {
      toastError(err);
    } finally {
      setTimeout(() => setLoading(false), 2500);
    }
  }

  const steps = [
    {
      icon: Plug,
      title: "Connect an ad platform",
      body: "Sign in with Meta or Google Ads and choose the accounts to bring into this workspace.",
      action: (
        <Button asChild size="sm">
          <Link href={`/w/${workspace.id}/integrations`}>
            Connect platform <ArrowRight />
          </Link>
        </Button>
      ),
      show: can("integrations:manage"),
    },
    {
      icon: Users,
      title: "Invite your team",
      body: "Add managers, analysts and clients with the right level of access.",
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href={`/w/${workspace.id}/settings/team`}>Invite people</Link>
        </Button>
      ),
      show: can("members:manage"),
    },
    {
      icon: FlaskConical,
      title: "Explore with sample data",
      body: "Waiting on platform access? Load realistic sample campaigns to try every feature.",
      action: (
        <Button size="sm" variant="outline" onClick={loadSample} disabled={loading}>
          {loading && <Loader2 className="animate-spin" />}
          Load sample data
        </Button>
      ),
      show: can("integrations:manage"),
    },
  ].filter((s) => s.show);

  return (
    <div className="space-y-6 animate-fade-up">
      <Card className="relative gap-0 overflow-hidden p-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_80%_at_100%_0%,color-mix(in_oklch,var(--primary)_10%,transparent),transparent)]" />
        <div className="relative grid gap-6 p-6 md:grid-cols-[1fr_auto] md:items-center md:p-8">
          <div className="max-w-xl space-y-2">
            <p className="text-sm font-medium text-primary">Welcome, {firstName}</p>
            <h2 className="text-2xl font-semibold tracking-tight">Let&apos;s bring your ads into one place</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Connect your ad accounts to see spend, conversions and ROAS across every platform, and manage campaigns
              without switching tabs.
            </p>
          </div>
          <div className="flex -space-x-1.5">
            {(["META", "GOOGLE", "TIKTOK", "LINKEDIN", "MICROSOFT"] as const).map((p) => (
              <PlatformIcon key={p} platform={p} size="lg" className="rounded-full ring-2 ring-card" />
            ))}
          </div>
        </div>
      </Card>

      {steps.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <Card key={s.title} className="gap-3 p-5 animate-fade-up" style={{ animationDelay: `${(i + 1) * 60}ms` }}>
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <s.icon className="size-[18px]" />
                </span>
                <span className="text-xs font-medium text-muted-foreground">Step {i + 1}</span>
              </div>
              <div>
                <h3 className="font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
              <div className="mt-auto pt-1">{s.action}</div>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No ad accounts are linked to this workspace yet. Ask an admin to connect {PLATFORM_INFO.META.name} or{" "}
          {PLATFORM_INFO.GOOGLE.name}.
        </p>
      )}
    </div>
  );
}
