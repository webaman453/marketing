"use client";

import {
  PLATFORM_INFO,
  isVisible,
  resolveOptions,
  setupOptions,
  type AiReviewResponse,
  type BuilderOptions,
  type BuilderDraft,
  type BuilderIssue,
  type CreativeDTO,
  type DraftDTO,
  type Field,
  type FieldContext,
  type LevelSpec,
  type PlatformBuilderSpec,
  type Values,
} from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Info, Loader2, Rocket, Sparkles, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api } from "@/lib/api";
import { money } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2 } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AiTokensNotice } from "./ai";
import { useBuilderEnv } from "./builder-context";
import type { Selection } from "./draft-utils";

const SEVERITY = {
  high: { icon: XCircle, cls: "text-destructive", label: "High" },
  medium: { icon: AlertTriangle, cls: "text-warning", label: "Medium" },
  low: { icon: Info, cls: "text-muted-foreground", label: "Low" },
} as const;

/** Short, readable value for the summary table. */
function display(field: Field, value: unknown, ctx: FieldContext, currency: string, options: BuilderOptions, creatives: CreativeDTO[]): string | null {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  switch (field.type) {
    case "money":
      return money(Number(value), currency, { decimals: Number.isInteger(Number(value)) ? 0 : 2 });
    case "percent":
      return `${value}%`;
    case "toggle":
      return value ? "On" : "Off";
    case "select":
    case "radio":
    case "cards":
    case "segmented":
      return resolveOptions(field, ctx).find((o) => o.value === value)?.label ?? String(value);
    case "multiSelect":
    case "checkboxes":
    case "chips": {
      const opts = resolveOptions(field, ctx);
      return (value as string[]).map((v) => opts.find((o) => o.value === v)?.label ?? v).join(", ");
    }
    case "targeting":
      return (value as { name: string; exclude?: boolean }[]).map((t) => (t.exclude ? `not ${t.name}` : t.name)).join(", ");
    case "keywords":
      return `${(value as unknown[]).length} keywords`;
    case "ageRange": {
      const v = value as { min: number; max: number };
      return `${v.min}–${v.max}${field.openEnded && v.max === field.max ? "+" : ""}`;
    }
    case "placements": {
      const v = value as { mode: string; items: string[] };
      return v.mode === "AUTO" ? field.autoLabel : `${v.items.length} manual placements`;
    }
    case "media": {
      const ids = value as string[];
      const names = ids.map((id) => creatives.find((c) => c.id === id)?.name).filter(Boolean);
      return names.length === ids.length && names.length <= 2 ? names.join(", ") : `${ids.length} file${ids.length === 1 ? "" : "s"}`;
    }
    case "textList": {
      const list = (value as unknown[]).map((x) => (typeof x === "string" ? x : String((x as { text?: string }).text ?? ""))).filter((x) => x.trim());
      if (!list.length) return null;
      return `“${list[0]!.slice(0, 80)}”${list.length > 1 ? ` + ${list.length - 1} more` : ""}`;
    }
    case "repeater":
      return `${(value as unknown[]).length} × ${field.itemLabel.toLowerCase()}`;
    case "adSchedule":
      return Object.keys((value as { days?: object }).days ?? {}).length ? "Custom hours" : null;
    case "accountOption": {
      const list = options[field.source] ?? [];
      const name = (id: unknown) => (list.find((o) => o.id === id)?.name ?? String(id)).replace(/\s*\(sample[^)]*\)/i, "");
      return Array.isArray(value) ? value.map(name).join(", ") : name(value);
    }
    case "info":
      return null;
    default:
      return String(value).slice(0, 120);
  }
}

function Summary({ level, values, ctx, currency }: { level: LevelSpec; values: Values; ctx: FieldContext; currency: string }) {
  const { options, creatives } = useBuilderEnv();
  const rows = level.sections
    .filter((s) => isVisible(s, ctx))
    .flatMap((s) => s.fields.filter((f) => isVisible(f, ctx) && !f.advanced))
    .map((f) => [f.label, display(f, values[f.key], ctx, currency, options, creatives)] as const)
    .filter(([, v]) => v);
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, v]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="truncate font-medium" title={v ?? ""}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewScreen({
  draft,
  spec,
  issues,
  initial,
  saveNow,
  onBack,
  onGoTo,
}: {
  draft: BuilderDraft;
  spec: PlatformBuilderSpec;
  issues: BuilderIssue[];
  initial: DraftDTO | null;
  saveNow: () => Promise<string>;
  onBack: () => void;
  onGoTo: (s: Selection, field?: string) => void;
}) {
  const env = useBuilderEnv();
  const queryClient = useQueryClient();
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<DraftDTO | null>(initial?.status === "FAILED" || initial?.status === "LAUNCHED" ? initial : null);
  const [serverIssues, setServerIssues] = useState<BuilderIssue[]>([]);
  const [review, setReview] = useState<AiReviewResponse | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const adSpec = spec.ad(draft.setup);
  const base: FieldContext = { setup: draft.setup, campaign: draft.campaign, adGroup: {}, ad: {} };
  const allIssues = [...issues, ...serverIssues.filter((s) => !issues.some((i) => i.message === s.message))];
  const status = draft.campaign.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";

  const whereOf = (i: BuilderIssue): Selection => {
    if (i.level === "adGroup" && i.nodeKey) return { level: "adGroup", key: i.nodeKey };
    if (i.level === "ad" && i.nodeKey) {
      const g = draft.adGroups.find((x) => x.ads.some((a) => a.key === i.nodeKey));
      if (g) return { level: "ad", groupKey: g.key, key: i.nodeKey };
    }
    return { level: "campaign" };
  };
  const nameOf = (i: BuilderIssue) => {
    if (i.level === "adGroup") return String(draft.adGroups.find((g) => g.key === i.nodeKey)?.values.name ?? spec.adGroup.label);
    if (i.level === "ad") return String(draft.adGroups.flatMap((g) => g.ads).find((a) => a.key === i.nodeKey)?.values.name ?? adSpec?.label ?? "Ad");
    return spec.campaign.label;
  };

  async function runReview() {
    setReviewing(true);
    try {
      setReview(await api<AiReviewResponse>(`/workspaces/${env.workspaceId}/ai/builder/review`, { method: "POST", body: { draft } }));
    } catch (err) {
      toastError(err);
    } finally {
      setReviewing(false);
      env.onAiUsed();
    }
  }

  async function publish() {
    setLaunching(true);
    setServerIssues([]);
    try {
      const id = await saveNow();
      const res = await api<DraftDTO>(`/workspaces/${env.workspaceId}/drafts/${id}/launch`, { method: "POST" });
      setResult(res);
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      void queryClient.invalidateQueries({ queryKey: qk2.drafts(env.workspaceId) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "DRAFT_INVALID") setServerIssues(err.issues?.length ? err.issues : [{ level: "setup", message: err.message }]);
      else toastError(err);
    } finally {
      setLaunching(false);
    }
  }

  if (result?.status === "LAUNCHED") {
    const r = result.results?.[0];
    return (
      <Card className="mx-auto max-w-xl gap-0 py-0 animate-fade-up">
        <div className="p-8 text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/10"><Rocket className="size-7 text-success" /></div>
          <h2 className="mt-5 text-xl font-semibold tracking-tight">Campaign published</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            “{String(draft.campaign.name)}” was created on {PLATFORM_INFO[draft.platform].name}
            {r?.created ? ` with ${r.created.adGroups} ${spec.adGroup.label.toLowerCase()}${r.created.adGroups === 1 ? "" : "s"} and ${r.created.ads} ${(adSpec?.label ?? "ad").toLowerCase()}${r.created.ads === 1 ? "" : "s"}` : ""}.
            {status === "PAUSED" ? " It's paused, so nothing spends until you switch it on." : " It starts delivering once the platform approves the ads."}
          </p>
        </div>
        <div className="flex justify-center gap-2 border-t bg-muted/20 p-4">
          <Button asChild variant="outline"><Link href={`/w/${env.workspaceId}/campaigns/new`}>Create another</Link></Button>
          {r?.campaignId && <Button asChild><Link href={`/w/${env.workspaceId}/campaigns/${r.campaignId}`}>View campaign</Link></Button>}
        </div>
      </Card>
    );
  }

  const failed = result?.status === "FAILED" ? result.results?.[0]?.error : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        <Card className="flex-row items-center gap-3 px-5 py-4">
          <PlatformIcon platform={draft.platform} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold tracking-tight">{String(draft.campaign.name)}</h2>
            <p className="truncate text-sm text-muted-foreground">
              {PLATFORM_INFO[draft.platform].name} · {spec.setup.map((c) => setupOptions(c, draft.setup).find((o) => o.value === draft.setup[c.key])?.label).filter(Boolean).join(" · ")}
            </p>
          </div>
          <Button variant="ghost" onClick={onBack}><ArrowLeft /> Edit</Button>
        </Card>

        {failed && (
          <div className="flex gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <XCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div>
              <div className="font-semibold">{PLATFORM_INFO[draft.platform].name} didn&apos;t accept the campaign</div>
              <div className="mt-0.5 text-muted-foreground">{failed}</div>
              <div className="mt-1 text-xs text-muted-foreground">Nothing was left half-created. Fix the problem and publish again.</div>
            </div>
          </div>
        )}

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle>Pre-publish checks</CardTitle>
            <CardDescription>Everything {PLATFORM_INFO[draft.platform].name} requires, checked against its rules and limits.</CardDescription>
          </CardHeader>
          {allIssues.length === 0 ? (
            <div className="flex items-center gap-3 p-5 text-sm">
              <CheckCircle2 className="size-5 text-success" />
              <span><span className="font-medium">Ready to publish.</span> No problems found.</span>
            </div>
          ) : (
            <ul className="divide-y">
              {allIssues.map((i, n) => (
                <li key={`${i.message}-${n}`} className="flex items-start gap-3 px-5 py-3">
                  <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1 text-sm">
                    <div>{i.message}</div>
                    <div className="text-xs text-muted-foreground">{nameOf(i)}</div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onGoTo(whereOf(i), i.field)}>Fix</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{spec.campaign.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <Summary level={spec.campaign} values={draft.campaign} ctx={base} currency={env.currency} />
          </CardContent>
        </Card>
        {draft.adGroups.map((g) => (
          <Card key={g.key}>
            <CardHeader>
              <CardTitle className="text-sm">{spec.adGroup.label}: {String(g.values.name ?? "")}</CardTitle>
              {adSpec && <CardDescription>{g.ads.length} {adSpec.label.toLowerCase()}{g.ads.length === 1 ? "" : "s"}: {g.ads.map((a) => String(a.values.name ?? "")).join(", ")}</CardDescription>}
            </CardHeader>
            <CardContent className="space-y-4">
              <Summary level={spec.adGroup} values={g.values} ctx={{ ...base, adGroup: g.values }} currency={env.currency} />
              {adSpec &&
                g.ads.map((a) => (
                  <div key={a.key} className="rounded-lg border bg-muted/20 p-3">
                    <div className="mb-2 text-xs font-semibold text-muted-foreground uppercase">{adSpec.label}: {String(a.values.name ?? "")}</div>
                    <Summary level={adSpec} values={a.values} ctx={{ ...base, adGroup: g.values, ad: a.values }} currency={env.currency} />
                  </div>
                ))}
            </CardContent>
          </Card>
        ))}
      </div>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle>Publish</CardTitle>
            <CardDescription>
              {status === "PAUSED" ? "Created paused: review it on the platform, then switch it on from Campaigns." : "Starts delivering as soon as the platform approves the ads."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full" size="lg" onClick={publish} disabled={launching || allIssues.length > 0}>
              {launching ? <Loader2 className="animate-spin" /> : <Rocket />} {launching ? "Publishing…" : `Publish to ${PLATFORM_INFO[draft.platform].name}`}
            </Button>
            {allIssues.length > 0 && <p className="text-center text-xs text-muted-foreground">Fix {allIssues.length} {allIssues.length === 1 ? "problem" : "problems"} to publish.</p>}
          </CardContent>
        </Card>

        {env.ai?.available && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> AI review</CardTitle>
              <CardDescription>Policy risks, weak copy, targeting gaps and budget sense-check.</CardDescription>
              <CardAction>
                {env.ai.canUse && (
                  <Button size="sm" variant={review ? "ghost" : "outline"} onClick={runReview} disabled={reviewing}>
                    {reviewing ? <Loader2 className="animate-spin" /> : <Sparkles />} {review ? "Re-run" : "Review"}
                  </Button>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-3">
              {!env.ai.canUse && <AiTokensNotice />}
              {review && (
                <>
                  <div className="flex items-center gap-3">
                    <div className={cn("flex size-14 shrink-0 items-center justify-center rounded-full border-4 text-lg font-semibold tabular", review.score >= 80 ? "border-success text-success" : review.score >= 60 ? "border-warning text-warning" : "border-destructive text-destructive")}>
                      {review.score}
                    </div>
                    <p className="text-sm leading-relaxed">{review.summary}</p>
                  </div>
                  {review.strengths.length > 0 && (
                    <ul className="space-y-1 text-sm">
                      {review.strengths.map((s) => <li key={s} className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />{s}</li>)}
                    </ul>
                  )}
                  <ul className="space-y-2.5">
                    {review.issues.map((i, n) => {
                      const sv = SEVERITY[i.severity];
                      return (
                        <li key={n} className="rounded-lg border p-3 text-sm">
                          <div className="flex items-center gap-1.5">
                            <sv.icon className={cn("size-4", sv.cls)} />
                            <span className="font-medium">{i.area}</span>
                            <Badge variant="secondary" className="ml-auto text-[10px]">{sv.label}</Badge>
                          </div>
                          <p className="mt-1 text-muted-foreground">{i.message}</p>
                          <p className="mt-1"><span className="font-medium">Fix: </span>{i.fix}</p>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-[11px] text-muted-foreground">AI suggestions; the platform&apos;s own review decides approval.</p>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </aside>
    </div>
  );
}

