"use client";

import { BUILDER_SPECS, VISIBLE_PLATFORMS, PLATFORM_INFO, newDraft, setupOptions, type BuilderDraft, type Platform, type Values } from "@ashniva/shared";
import { ArrowRight, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAdAccounts, useWorkspaceAdAccounts } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ChoiceInput } from "./fields";

/** Like the platforms' "Create campaign" step: where, which account, which objective. */
export function BuilderStart({ onStart, preset }: { onStart: (draft: BuilderDraft) => void; preset?: { platform: Platform; setup: Values } }) {
  const { workspace, org } = useWorkspace();
  const accounts = useWorkspaceAdAccounts(workspace.id);
  const orgAccounts = useAdAccounts(org.id);
  // Ad accounts in other workspaces of this organization, to point people at the right one.
  const elsewhere = (orgAccounts.data ?? []).filter((a) => a.workspaceId && a.workspaceId !== workspace.id);
  const otherWorkspaces = [...new Map(elsewhere.map((a) => [a.workspaceId!, { id: a.workspaceId!, name: a.workspaceName ?? "another workspace", count: elsewhere.filter((x) => x.workspaceId === a.workspaceId).length }])).values()];
  const [platform, setPlatform] = useState<Platform | null>(preset?.platform ?? null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [setup, setSetup] = useState<Values>(preset?.setup ?? {});
  const [name, setName] = useState("");

  const byPlatform = (p: Platform) => (accounts.data ?? []).filter((a) => a.platform === p);
  const spec = platform ? BUILDER_SPECS[platform] : null;
  const platformAccounts = platform ? byPlatform(platform) : [];
  const account = platformAccounts.find((a) => a.id === accountId) ?? (platformAccounts.length === 1 ? platformAccounts[0] : undefined);
  const choices = spec ? spec.setup.filter((c) => !c.showIf || c.showIf(setup)) : [];
  const unchosen = choices.find((c) => !setupOptions(c, setup).some((o) => o.value === setup[c.key] && !o.disabled));
  const complete = Boolean(spec && account && !unchosen && name.trim().length >= 2);
  // Says what's still missing, so a greyed-out Continue never leaves people guessing.
  const missing = !platform ? null : !account ? "Select an ad account" : unchosen ? `Select the ${unchosen.label.toLowerCase()}` : name.trim().length < 2 ? "Name your campaign" : null;
  const locked = Boolean(preset?.platform);

  if (accounts.isLoading) return <Skeleton className="h-[480px] rounded-xl" />;

  return (
    <Card className="gap-0 py-0">
      <div className="space-y-8 p-6 sm:p-8">
        {locked && platform && platformAccounts.length === 0 && (
          <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
            {PLATFORM_INFO[platform].availability === "coming_soon" ? (
              <>
                <div className="font-medium">{PLATFORM_INFO[platform].name} cannot be connected from here yet.</div>
                <p className="mt-0.5 text-muted-foreground">The fields below match their own screen. They have not opened an API, so this form cannot publish the ad.</p>
              </>
            ) : (
              <>
                <div className="font-medium">Connect {PLATFORM_INFO[platform].name} to publish this form.</div>
                <p className="mt-0.5 text-muted-foreground">The fields below are the same ones {PLATFORM_INFO[platform].name} asks for. Connect an account in this workspace when you are ready to create the ad.</p>
                <Button asChild size="sm" className="mt-3" variant="outline">
                  <Link href={`/w/${workspace.id}/integrations`}><Link2 /> Connect {PLATFORM_INFO[platform].name}</Link>
                </Button>
              </>
            )}
          </div>
        )}
        {!locked && (
        <section className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Where do you want to advertise?</h2>
            <p className="text-sm text-muted-foreground">You&apos;ll get the same options as in each platform&apos;s own ads manager.</p>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {VISIBLE_PLATFORMS.map((p) => {
              const count = byPlatform(p).length;
              const active = platform === p;
              return (
                <button
                  key={p}
                  type="button"
                  disabled={count === 0}
                  onClick={() => {
                    setPlatform(p);
                    setAccountId(null);
                    setSetup({});
                  }}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50",
                    active ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "hover:border-foreground/20 hover:bg-muted/40",
                  )}
                >
                  <PlatformIcon platform={p} size="md" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{PLATFORM_INFO[p].name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{count ? `${count} ad ${count === 1 ? "account" : "accounts"}` : "Not connected"}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {(accounts.data ?? []).length === 0 && (
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
              <div className="font-medium">The “{workspace.name}” workspace has no ad accounts yet.</div>
              <p className="mt-0.5 text-muted-foreground">
                Campaigns are created on an ad account, so add one to this workspace{otherWorkspaces.length ? ", or switch to a workspace that has them" : ""}.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {otherWorkspaces.map((w) => (
                  <Button key={w.id} asChild size="sm">
                    <Link href={`/w/${w.id}/campaigns/new`}>Switch to {w.name} ({w.count} {w.count === 1 ? "account" : "accounts"})</Link>
                  </Button>
                ))}
                <Button asChild size="sm" variant="outline">
                  <Link href={`/w/${workspace.id}/integrations`}><Link2 /> Add or assign ad accounts</Link>
                </Button>
              </div>
            </div>
          )}
        </section>
        )}

        {spec && platformAccounts.length > 1 && (
          <section className="space-y-3 animate-fade-up">
            <Label className="text-sm font-semibold">Ad account</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {platformAccounts.map((a) => (
                <button key={a.id} type="button" onClick={() => setAccountId(a.id)} className={cn("rounded-lg border px-3.5 py-2.5 text-left text-sm", account?.id === a.id ? "border-primary bg-primary/[0.04]" : "hover:bg-muted/40")}>
                  <span className="block font-medium">{a.name}</span>
                  <span className="block text-xs text-muted-foreground">{a.currency} · {a.externalId}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {spec &&
          choices.map((c) => (
            <section key={c.key} className="space-y-3 animate-fade-up">
              <div>
                <h3 className="text-base font-semibold">{c.label}</h3>
                <p className="text-sm text-muted-foreground">{c.description}</p>
              </div>
              <ChoiceInput
                id={`setup-${c.key}`}
                type="cards"
                options={setupOptions(c, setup)}
                value={String(setup[c.key] ?? "")}
                onChange={(v) => {
                  // Later choices depend on earlier ones, so reset them.
                  const idx = spec.setup.findIndex((x) => x.key === c.key);
                  const next: Values = {};
                  for (const x of spec.setup.slice(0, idx)) next[x.key] = setup[x.key];
                  next[c.key] = v;
                  setSetup(next);
                }}
              />
            </section>
          ))}

        {spec && account && (
          <section className="max-w-md space-y-2 animate-fade-up">
            <Label htmlFor="campaign-name" className="text-sm font-semibold">Campaign name</Label>
            <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Festive Sale 2026" className="h-10" />
          </section>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-6 py-4 sm:px-8">
        <span className="text-xs text-muted-foreground">
          {platform && account ? (
            <>
              {PLATFORM_INFO[platform].name} · {account.name}
              {account.sample && <Badge variant="secondary" className="ml-2 text-[10px]">Sample account</Badge>}
            </>
          ) : (
            "Choose a platform to begin"
          )}
        </span>
        <div className="flex items-center gap-3">
          {missing && <span className="hidden text-xs text-muted-foreground sm:inline">{missing} to continue</span>}
          <Button disabled={!complete} onClick={() => spec && account && onStart(newDraft(spec, account.id, setup, name.trim()))}>
            Continue <ArrowRight />
          </Button>
        </div>
      </div>
    </Card>
  );
}
