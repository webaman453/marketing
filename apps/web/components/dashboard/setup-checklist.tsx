"use client";

import { Check, Circle, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/app/workspace-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAlertWebhooks, useRules } from "@/lib/queries";
import { cn } from "@/lib/utils";

export interface SetupStep {
  key: string;
  title: string;
  body: string;
  done: boolean;
  href: string;
  cta: string;
  /** Hidden for people who can't do it, so nobody is sent to a page that says "no access". */
  show: boolean;
}

export function setupSteps(input: {
  workspaceId: string;
  hasCampaigns: boolean;
  hasRules: boolean;
  hasAlertChannel: boolean;
  canCreateCampaigns: boolean;
  canManageRules: boolean;
  canManageOrg: boolean;
}): SetupStep[] {
  const base = `/w/${input.workspaceId}`;
  return [
    {
      key: "connect",
      title: "Connect an ad platform",
      body: "Your ad accounts are connected and syncing.",
      done: true,
      href: `${base}/integrations`,
      cta: "Integrations",
      show: true,
    },
    {
      key: "campaign",
      title: "Get your first campaign in",
      body: input.hasCampaigns
        ? "Campaigns from your ad accounts are showing up."
        : "No campaigns yet. Create one here, or run one on the platform: it appears after the next sync.",
      done: input.hasCampaigns,
      href: `${base}/campaigns/new`,
      cta: "Create a campaign",
      show: input.canCreateCampaigns,
    },
    {
      key: "rule",
      title: "Set up an automation rule",
      body: "Pause what isn't working and get told when something needs a look. Start from a ready-made rule.",
      done: input.hasRules,
      href: `${base}/automations`,
      cta: "Browse rules",
      show: input.canManageRules,
    },
    {
      key: "alerts",
      title: "Send alerts to Slack or a webhook",
      body: "Get alerts where your team already works, not only in the bell menu.",
      done: input.hasAlertChannel,
      href: `${base}/settings/alerts`,
      cta: "Add a channel",
      show: input.canManageOrg,
    },
  ].filter((s) => s.show);
}

const storageKey = (workspaceId: string) => `setup-checklist-dismissed:${workspaceId}`;

function wasDismissed(workspaceId: string) {
  try {
    return window.localStorage.getItem(storageKey(workspaceId)) === "1";
  } catch {
    return false;
  }
}

/** Shown on the overview once an ad account is connected, until the rest of the basics are done or it's dismissed. */
export function SetupChecklist({ hasCampaigns }: { hasCampaigns: boolean }) {
  const { workspace, can } = useWorkspace();
  const canManageOrg = can("org:update");
  const rules = useRules(workspace.id);
  const channels = useAlertWebhooks(workspace.orgId, canManageOrg);
  const [dismissed, setDismissed] = useState(() => wasDismissed(workspace.id));

  // Wait for what we can't tell yet, so steps don't flash as undone.
  if (dismissed || rules.isLoading || (canManageOrg && channels.isLoading)) return null;

  const steps = setupSteps({
    workspaceId: workspace.id,
    hasCampaigns,
    hasRules: (rules.data?.length ?? 0) > 0,
    hasAlertChannel: (channels.data?.length ?? 0) > 0,
    canCreateCampaigns: can("campaigns:edit"),
    canManageRules: can("campaigns:edit"),
    canManageOrg,
  });
  const done = steps.filter((s) => s.done).length;
  if (steps.length === 0 || done === steps.length) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey(workspace.id), "1");
    } catch {
      // The checklist just comes back next time.
    }
    setDismissed(true);
  }

  return (
    <Card className="gap-0 p-0" data-testid="setup-checklist">
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">Finish setting up</h2>
          <p className="text-sm text-muted-foreground">{done} of {steps.length} done</p>
        </div>
        <Button variant="ghost" size="icon" className="-mr-2 -mt-1 size-8" onClick={dismiss} aria-label="Hide this checklist">
          <X />
        </Button>
      </div>
      <ul className="divide-y">
        {steps.map((s) => (
          <li key={s.key} className="flex items-center gap-3 px-5 py-3.5">
            <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full", s.done ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
              {s.done ? <Check className="size-3.5" /> : <Circle className="size-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-medium", s.done && "text-muted-foreground line-through")}>{s.title}</div>
              {!s.done && <p className="text-xs text-muted-foreground">{s.body}</p>}
            </div>
            {!s.done && (
              <Button asChild size="sm" variant="outline">
                <Link href={s.href}>{s.cta}</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
