"use client";

import {
  ACTION_LABELS,
  METRIC_FORMATS,
  OPERATOR_LABELS,
  PLATFORM_INFO,
  RULE_ACTIONS,
  isPlatformShown,
  RULE_METRICS,
  RULE_OPERATORS,
  RULE_TEMPLATES,
  type Platform,
  type RuleAction,
  type RuleCondition,
  type RuleDTO,
  type RuleInput,
  type RuleRunDTO,
} from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bot, CheckCircle2, ChevronDown, Loader2, Play, Plus, Save, Search, Sparkles, Trash2, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { PlatformIcon } from "@/components/platform-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useAiStatus, useCampaigns, useRuleRuns, useWorkspaceAdAccounts } from "@/lib/queries";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { cn } from "@/lib/utils";
import { conditionValue, describeAction, describeConditions } from "./rule-text";

const blank = (): RuleInput => ({
  name: "",
  isActive: true,
  scope: { platforms: [], campaignIds: [], minSpend: 0 },
  conditionLogic: "ALL",
  conditions: [{ metric: "roas", operator: "lt", value: 1 }],
  actions: [{ type: "NOTIFY" }],
  lookbackDays: 3,
  frequency: "DAILY",
  cooldownHours: 24,
});

/** The editable part of a saved rule, in the same shape as the form. */
const toInput = (r: RuleDTO): RuleInput => ({
  name: r.name,
  isActive: r.isActive,
  scope: r.scope,
  conditionLogic: r.conditionLogic,
  conditions: r.conditions,
  actions: r.actions,
  lookbackDays: r.lookbackDays,
  frequency: r.frequency,
  cooldownHours: r.cooldownHours,
});

const unitHint = (metric: string, currency: string) =>
  metric === "ctr" ? "%" : metric === "roas" ? "×" : ["spend", "cpc", "cpm", "cpa"].includes(metric) ? currency : "";

export function RuleEditor({ rule }: { rule: RuleDTO | null }) {
  const { workspace, can } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const accounts = useWorkspaceAdAccounts(workspace.id);
  const campaigns = useCampaigns(workspace.id, {});
  const canEdit = can("campaigns:edit");

  const [saved, setSaved] = useState<RuleDTO | null>(rule);
  const [form, setForm] = useState<RuleInput>(() => (rule ? toInput(rule) : blank()));
  // What the form held when it was last loaded or saved.
  const [baseline, setBaseline] = useState(() => JSON.stringify(rule ? toInput(rule) : blank()));
  const [busy, setBusy] = useState<"save" | "preview" | "run" | null>(null);
  const [preview, setPreview] = useState<RuleRunDTO | null>(null);
  const [campaignSearch, setCampaignSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useUnsavedChanges(canEdit && !deleting && JSON.stringify(form) !== baseline);

  const platforms = useMemo(() => [...new Set((accounts.data ?? []).map((a) => a.platform))].filter(isPlatformShown), [accounts.data]);
  const currency = workspace.currency;
  const set = (patch: Partial<RuleInput>) => setForm((f) => ({ ...f, ...patch }));
  const setCondition = (i: number, patch: Partial<RuleCondition>) =>
    set({ conditions: form.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAction = (i: number, patch: Partial<RuleAction>) =>
    set({ actions: form.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  async function save(): Promise<RuleDTO | null> {
    setBusy("save");
    try {
      const result = saved
        ? await api<RuleDTO>(`/workspaces/${workspace.id}/rules/${saved.id}`, { method: "PATCH", body: form })
        : await api<RuleDTO>(`/workspaces/${workspace.id}/rules`, { method: "POST", body: form });
      setSaved(result);
      setBaseline(JSON.stringify(form));
      void queryClient.invalidateQueries({ queryKey: qk2.rules(workspace.id) });
      toast.success("Rule saved", { description: result.isActive ? "It will run on the next check." : "It's paused; switch it on when ready." });
      if (!saved) router.replace(`/w/${workspace.id}/automations/${result.id}`);
      return result;
    } catch (err) {
      toastError(err);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function run(dryRun: boolean) {
    const r = saved ?? (await save());
    if (!r) return;
    setBusy(dryRun ? "preview" : "run");
    try {
      const result = await api<RuleRunDTO>(`/workspaces/${workspace.id}/rules/${r.id}/run`, { method: "POST", body: { dryRun } });
      setPreview(result);
      if (!dryRun) {
        toast.success(`Rule ran: ${result.matched} matched`);
        void queryClient.invalidateQueries({ queryKey: qk2.ruleRuns(workspace.id, r.id) });
        void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!saved) return;
    setDeleting(true);
    try {
      await api(`/workspaces/${workspace.id}/rules/${saved.id}`, { method: "DELETE" });
      toast.success("Rule deleted");
      setConfirmDelete(false);
      void queryClient.invalidateQueries({ queryKey: qk2.rules(workspace.id) });
      router.push(`/w/${workspace.id}/automations`);
    } catch (err) {
      setDeleting(false);
      toastError(err);
    }
  }

  const campaignOptions = (campaigns.data?.campaigns ?? []).filter(
    (c) => isPlatformShown(c.platform) && (form.scope.platforms.length === 0 || form.scope.platforms.includes(c.platform)) && c.name.toLowerCase().includes(campaignSearch.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <div>
            <Link href={`/w/${workspace.id}/automations`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" /> Automations
            </Link>
          </div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">{saved ? saved.name : "New automation rule"}</h1>
          <p className="text-sm text-muted-foreground">
            When {describeConditions(form.conditions, form.conditionLogic, currency) || "…"} over the last {form.lookbackDays} {form.lookbackDays === 1 ? "day" : "days"} → {form.actions.map((a) => describeAction(a, currency).toLowerCase()).join(", ")}.
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 items-center gap-2 rounded-lg border bg-card px-3 text-sm">
              <Switch checked={form.isActive} onCheckedChange={(v) => set({ isActive: v })} /> {form.isActive ? "Active" : "Paused"}
            </label>
            <Button variant="outline" className="bg-card" disabled={!!busy || form.name.trim().length < 2} onClick={() => run(true)}>
              {busy === "preview" ? <Loader2 className="animate-spin" /> : <Search />} Preview matches
            </Button>
            <Button disabled={!!busy || form.name.trim().length < 2} onClick={save}>
              {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save rule
            </Button>
          </div>
        )}
      </div>

      {!saved && canEdit && <RuleFromText workspaceId={workspace.id} onRule={(r) => setForm(r)} />}

      {!saved && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Start from a template:</span>
          {RULE_TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              title={t.description}
              onClick={() => setForm({ ...t.rule, name: t.name, isActive: true })}
              className="rounded-full border bg-card px-3 py-1 text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card className="gap-5">
            <CardHeader>
              <CardTitle>Rule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <FormField id="rule-name" label="Name">
                <Input id="rule-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Pause campaigns with poor ROAS" disabled={!canEdit} />
              </FormField>

              {/* Conditions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[13px]">If</Label>
                  {form.conditions.length > 1 && (
                    <Select value={form.conditionLogic} onValueChange={(v) => set({ conditionLogic: v as "ALL" | "ANY" })}>
                      <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">All conditions match</SelectItem>
                        <SelectItem value="ANY">Any condition matches</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {form.conditions.map((c, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
                    <Select value={c.metric} onValueChange={(v) => setCondition(i, { metric: v as RuleCondition["metric"] })}>
                      <SelectTrigger size="sm" className="w-40 bg-card"><SelectValue /></SelectTrigger>
                      <SelectContent>{RULE_METRICS.map((m) => <SelectItem key={m} value={m}>{METRIC_FORMATS[m]!.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <Select value={c.operator} onValueChange={(v) => setCondition(i, { operator: v as RuleCondition["operator"] })}>
                      <SelectTrigger size="sm" className="w-40 bg-card"><SelectValue /></SelectTrigger>
                      <SelectContent>{RULE_OPERATORS.map((o) => <SelectItem key={o} value={o}>{OPERATOR_LABELS[o]}</SelectItem>)}</SelectContent>
                    </Select>
                    <div className="relative">
                      <Input type="number" min={0} step="any" value={Number.isFinite(c.value) ? c.value : ""} onChange={(e) => setCondition(i, { value: Number(e.target.value) })} className="h-8 w-32 bg-card pr-12 tabular" />
                      <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{unitHint(c.metric, currency)}</span>
                    </div>
                    {form.conditions.length > 1 && (
                      <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => set({ conditions: form.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition">
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                {form.conditions.length < 5 && (
                  <Button variant="ghost" size="sm" onClick={() => set({ conditions: [...form.conditions, { metric: "cpa", operator: "gt", value: 500 }] })}>
                    <Plus /> Add condition
                  </Button>
                )}
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  measured over the last
                  <Select value={String(form.lookbackDays)} onValueChange={(v) => set({ lookbackDays: Number(v) })}>
                    <SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger>
                    <SelectContent>{[1, 3, 7, 14, 30].map((d) => <SelectItem key={d} value={String(d)}>{d} {d === 1 ? "day" : "days"}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              {/* Actions */}
              <div className="space-y-2">
                <Label className="text-[13px]">Then</Label>
                {form.actions.map((a, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2">
                    <Select value={a.type} onValueChange={(v) => setAction(i, { type: v as RuleAction["type"], percent: v.includes("BUDGET") ? (a.percent ?? 10) : undefined })}>
                      <SelectTrigger size="sm" className="w-56 bg-card"><SelectValue /></SelectTrigger>
                      <SelectContent>{RULE_ACTIONS.map((t) => <SelectItem key={t} value={t}>{ACTION_LABELS[t]}</SelectItem>)}</SelectContent>
                    </Select>
                    {(a.type === "INCREASE_BUDGET" || a.type === "DECREASE_BUDGET") && (
                      <>
                        <span className="text-sm text-muted-foreground">by</span>
                        <div className="relative">
                          <Input type="number" min={1} max={100} value={a.percent ?? ""} onChange={(e) => setAction(i, { percent: Number(e.target.value) })} className="h-8 w-20 bg-card pr-7 tabular" />
                          <span className="absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                        </div>
                      </>
                    )}
                    {a.type === "INCREASE_BUDGET" && (
                      <>
                        <span className="text-sm text-muted-foreground">up to</span>
                        <Input type="number" min={1} placeholder="No cap" value={a.maxBudget ?? ""} onChange={(e) => setAction(i, { maxBudget: e.target.value ? Number(e.target.value) : undefined })} className="h-8 w-28 bg-card tabular" />
                      </>
                    )}
                    {a.type === "NOTIFY" && (
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox checked={!!a.email} onCheckedChange={(v) => setAction(i, { email: !!v })} /> Also send email
                      </label>
                    )}
                    {form.actions.length > 1 && (
                      <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => set({ actions: form.actions.filter((_, j) => j !== i) })} aria-label="Remove action">
                        <X />
                      </Button>
                    )}
                  </div>
                ))}
                {form.actions.length < 3 && (
                  <Button variant="ghost" size="sm" onClick={() => set({ actions: [...form.actions, { type: "NOTIFY" }] })}>
                    <Plus /> Add action
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="gap-5">
            <CardHeader>
              <CardTitle>Which campaigns</CardTitle>
              <CardDescription>Leave everything empty to check every campaign in this workspace.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {platforms.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {platforms.map((p: Platform) => {
                    const on = form.scope.platforms.includes(p);
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => set({ scope: { ...form.scope, platforms: on ? form.scope.platforms.filter((x) => x !== p) : [...form.scope.platforms, p] } })}
                        className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors", on ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}
                      >
                        <PlatformIcon platform={p} size="xs" /> {PLATFORM_INFO[p].name}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-[13px]">Specific campaigns (optional)</Label>
                  {form.scope.campaignIds.length > 0 && (
                    <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => set({ scope: { ...form.scope, campaignIds: [] } })}>Clear {form.scope.campaignIds.length}</Button>
                  )}
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={campaignSearch} onChange={(e) => setCampaignSearch(e.target.value)} placeholder="Search campaigns…" className="h-8 pl-8" />
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border">
                  {campaignOptions.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-muted/50">
                      <Checkbox
                        checked={form.scope.campaignIds.includes(c.id)}
                        onCheckedChange={(on) => set({ scope: { ...form.scope, campaignIds: on ? [...form.scope.campaignIds, c.id] : form.scope.campaignIds.filter((x) => x !== c.id) } })}
                      />
                      <PlatformIcon platform={c.platform} size="xs" />
                      <span className="truncate">{c.name}</span>
                    </label>
                  ))}
                  {campaignOptions.length === 0 && <p className="px-3 py-4 text-center text-xs text-muted-foreground">No campaigns match.</p>}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField id="min-spend" label={`Minimum spend (${currency})`} hint="Skip campaigns with too little data.">
                  <Input id="min-spend" type="number" min={0} value={form.scope.minSpend} onChange={(e) => set({ scope: { ...form.scope, minSpend: Number(e.target.value) || 0 } })} className="tabular" />
                </FormField>
                <FormField id="freq" label="Check every">
                  <Select value={form.frequency} onValueChange={(v) => set({ frequency: v as RuleInput["frequency"] })}>
                    <SelectTrigger id="freq" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HOURLY">Hour</SelectItem>
                      <SelectItem value="DAILY">Day</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField id="cooldown" label="Cooldown" hint="Wait before acting on the same campaign again.">
                  <Select value={String(form.cooldownHours)} onValueChange={(v) => set({ cooldownHours: Number(v) })}>
                    <SelectTrigger id="cooldown" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{[6, 12, 24, 48, 72, 168].map((h) => <SelectItem key={h} value={String(h)}>{h < 48 ? `${h} hours` : `${h / 24} days`}</SelectItem>)}</SelectContent>
                  </Select>
                </FormField>
              </div>
            </CardContent>
          </Card>

          {saved && canEdit && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete rule
            </Button>
          )}
          {saved && (
            <AlertDialog open={confirmDelete} onOpenChange={(o) => !deleting && setConfirmDelete(o)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{saved.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>The rule stops running and can’t be restored.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    disabled={deleting}
                    onClick={(e) => {
                      e.preventDefault();
                      void remove();
                    }}
                  >
                    {deleting && <Loader2 className="animate-spin" />} Delete rule
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        <div className="space-y-6">
          {preview && <RunCard run={preview} currency={currency} title={preview.dryRun ? "Preview" : "Latest run"} onRunNow={canEdit && preview.dryRun && preview.matched > 0 ? () => run(false) : undefined} running={busy === "run"} />}
          {saved && <RunHistory ruleId={saved.id} currency={currency} />}
          {!preview && !saved && (
            <Card className="gap-2 p-5 text-sm text-muted-foreground">
              <Bot className="size-5 text-primary" />
              <p>Rules check your campaigns automatically. Use <span className="font-medium text-foreground">Preview matches</span> to see which campaigns would be affected before turning a rule on.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function RunCard({ run, currency, title, onRunNow, running }: { run: RuleRunDTO; currency: string; title: string; onRunNow?: () => void; running?: boolean }) {
  return (
    <Card className="gap-3 animate-fade-up">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          <Badge variant={run.status === "FAILED" ? "destructive" : "secondary"}>{run.status === "FAILED" ? "Failed" : `${run.matched} of ${run.evaluated} matched`}</Badge>
        </CardTitle>
        <CardDescription>{run.dryRun ? "Nothing was changed." : `Ran ${timeAgo(run.startedAt)}`}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {run.error && <p className="text-sm text-destructive">{run.error}</p>}
        {run.details?.length === 0 && <p className="text-sm text-muted-foreground">No campaigns meet the conditions right now.</p>}
        {run.details?.map((d) => (
          <div key={d.campaignId} className="rounded-lg border p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <PlatformIcon platform={d.platform} size="xs" /> <span className="truncate">{d.campaignName}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular">
              {Object.entries(d.values).map(([m, v]) => (
                <span key={m}>{METRIC_FORMATS[m]?.label}: {v == null ? "—" : conditionValue({ metric: m as RuleCondition["metric"], operator: "gt", value: Math.round(v * 100) / 100 }, currency)}</span>
              ))}
            </div>
            <ul className="mt-2 space-y-0.5 text-xs">
              {d.actions.map((a, i) => (
                <li key={i} className={cn("flex items-center gap-1.5", a.ok ? "text-foreground" : "text-destructive")}>
                  {a.ok ? <CheckCircle2 className="size-3 text-success" /> : <XCircle className="size-3" />}
                  {a.type === "SKIPPED" ? "Skipped" : ACTION_LABELS[a.type as keyof typeof ACTION_LABELS] ?? a.type}
                  {a.detail && <span className="text-muted-foreground">· {a.detail}</span>}
                  {a.error && <span>· {a.error}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {onRunNow && (
          <Button className="w-full" onClick={onRunNow} disabled={running}>
            {running ? <Loader2 className="animate-spin" /> : <Play />} Run now on {run.matched} {run.matched === 1 ? "campaign" : "campaigns"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RunHistory({ ruleId, currency }: { ruleId: string; currency: string }) {
  const { workspace } = useWorkspace();
  const runs = useRuleRuns(workspace.id, ruleId);
  const [open, setOpen] = useState<string | null>(null);
  const live = (runs.data ?? []).filter((r) => !r.dryRun);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>Run history</CardTitle>
        <CardDescription>Automatic and manual runs. Previews aren&apos;t listed.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {live.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <ul className="divide-y">
            {live.map((r) => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center gap-3 px-6 py-2.5 text-left text-sm hover:bg-muted/40" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  {r.status === "FAILED" ? <XCircle className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-success" />}
                  <span className="flex-1">{dateTime(r.startedAt)}</span>
                  <span className="text-xs text-muted-foreground">{r.matched} matched</span>
                  <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open === r.id && "rotate-180")} />
                </button>
                {open === r.id && (
                  <div className="px-4 pb-3">
                    <RunCard run={r} currency={currency} title="Details" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** "Describe the rule in a sentence" → a filled-in rule, using AI tokens. */
function RuleFromText({ workspaceId, onRule }: { workspaceId: string; onRule: (r: RuleInput) => void }) {
  const status = useAiStatus(workspaceId);
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!status.data?.available) return null;

  async function build() {
    setBusy(true);
    try {
      const rule = await api<RuleInput>(`/workspaces/${workspaceId}/ai/rules/from-text`, { method: "POST", body: { text } });
      onRule(rule);
      toast.success("Rule drafted from your description", { description: "Check the conditions and actions, then save." });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: qk2.aiStatus(workspaceId) });
    }
  }

  return (
    <Card className="gap-3 border-primary/30 bg-primary/[0.03] py-4">
      <CardContent className="space-y-2 px-4">
        <Label htmlFor="rule-text" className="flex items-center gap-1.5 text-[13px]"><Sparkles className="size-3.5 text-primary" /> Describe the rule and let AI set it up</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="rule-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && text.trim().length >= 10 && !busy && void build()}
            placeholder="If ROAS stays below 1.5 for 3 days and spend is over ₹2,000, pause the campaign and email me"
            className="h-9 flex-1 bg-background"
          />
          {status.data.canUse ? (
            <Button onClick={build} disabled={busy || text.trim().length < 10}>
              {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Create with AI
            </Button>
          ) : (
            <Button asChild variant="outline"><Link href={`/w/${workspaceId}/settings/ai`}>Buy AI tokens</Link></Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
