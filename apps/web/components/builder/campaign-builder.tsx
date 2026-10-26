"use client";

import {
  BUILDER_SPECS,
  PLATFORM_INFO,
  isBuilderDraft,
  isVisible,
  newAd,
  newAdGroup,
  nodeKey,
  setupOptions,
  validateDraft,
  withDefaults,
  type AiFillResponse,
  type BuilderDraft,
  type BuilderOptions,
  type DraftDTO,
  type FieldContext,
  type LevelSpec,
  type MediaInfo,
  type Platform,
  type Values,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  Eye,
  Image as ImageIcon,
  Layers,
  Loader2,
  Megaphone,
  Plus,
  Rocket,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import { PreviewPanel } from "@/components/previews";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { tokenCount } from "@/lib/format";
import { toastError } from "@/lib/forms";
import {
  qk2,
  useAiStatus,
  useCreatives,
  useWorkspaceAdAccounts,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { BriefDialog, briefPayload } from "./ai";
import {
  BuilderEnvProvider,
  emptyBrief,
  type BriefState,
  type BuilderEnv,
} from "./builder-context";
import { BuilderStart } from "./builder-start";
import {
  adContextOf,
  applyAutoSelect,
  issuesFor,
  nodeOrder,
  previewDataFor,
  sameSelection,
  type Selection,
} from "./draft-utils";
import { FieldRenderer, SectionTitleContext } from "./fields";
import { ReviewScreen } from "./review";

export function CampaignBuilder({ initial, preset }: { initial: DraftDTO | null; preset?: { platform: Platform; setup: Values } | null }) {
  const startDraft =
    initial && isBuilderDraft(initial.payload)
      ? (initial.payload as BuilderDraft)
      : null;
  const [draft, setDraft] = useState<BuilderDraft | null>(startDraft);
  if (!draft) return <BuilderStart onStart={setDraft} preset={preset ?? undefined} />;
  return <Editor initialDraft={draft} initial={initial} />;
}

function Editor({
  initialDraft,
  initial,
}: {
  initialDraft: BuilderDraft;
  initial: DraftDTO | null;
}) {
  const { workspace, me } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const spec = BUILDER_SPECS[initialDraft.platform];
  const creatives = useCreatives(workspace.id);
  const accounts = useWorkspaceAdAccounts(workspace.id);
  const account = accounts.data?.find((a) => a.id === initialDraft.adAccountId);
  const aiStatus = useAiStatus(workspace.id);

  const [draft, setDraft] = useState<BuilderDraft>(() => {
    // Specs grow over time; fill in any fields added since the draft was saved.
    const ctx: FieldContext = {
      setup: initialDraft.setup,
      campaign: initialDraft.campaign,
      adGroup: {},
      ad: {},
    };
    const adSpec = spec.ad(initialDraft.setup);
    return {
      ...initialDraft,
      campaign: withDefaults(spec.campaign, initialDraft.campaign, ctx),
      adGroups: initialDraft.adGroups.map((g) => ({
        ...g,
        values: withDefaults(spec.adGroup, g.values, {
          ...ctx,
          adGroup: g.values,
        }),
        ads: adSpec
          ? g.ads.map((a) => ({
              ...a,
              values: withDefaults(adSpec, a.values, {
                ...ctx,
                adGroup: g.values,
                ad: a.values,
              }),
            }))
          : [],
      })),
    };
  });
  const [sel, setSelRaw] = useState<Selection>({ level: "campaign" });
  /** Switches node and scrolls to the top, or to a field when one is given. */
  const setSel = useCallback((s: Selection, field?: string) => {
    setSelRaw(s);
    requestAnimationFrame(() => {
      const el = field ? document.getElementById(`f-${field}`) : null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      } else window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }, []);
  const [mode, setMode] = useState<"edit" | "review">(
    initial?.status === "FAILED" ? "review" : "edit",
  );
  const [showErrors, setShowErrors] = useState(initial?.status === "FAILED");
  /** Fields the person has left (blurred); their problems show right away. */
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [draftId, setDraftId] = useState<string | null>(initial?.id ?? null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [brief, setBrief] = useState<BriefState>(emptyBrief);
  const [briefOpen, setBriefOpen] = useState<null | {
    then: (b: BriefState) => void;
    title?: string;
    submit?: string;
  }>(null);
  const [filling, setFilling] = useState(false);

  const options = useQuery({
    queryKey: ["builder-options", workspace.id, draft.adAccountId],
    queryFn: () =>
      api<BuilderOptions>(`/workspaces/${workspace.id}/builder/options`, {
        query: { adAccountId: draft.adAccountId },
      }),
    staleTime: 10 * 60_000,
  });
  const opts = useMemo(() => options.data ?? {}, [options.data]);
  const effective = useMemo(
    () => applyAutoSelect(spec, draft, opts),
    [spec, draft, opts],
  );
  const media = useMemo(
    () =>
      new Map<string, MediaInfo>(
        (creatives.data ?? []).map((c) => [
          c.id,
          { type: c.type, width: c.width, height: c.height },
        ]),
      ),
    [creatives.data],
  );
  const issues = useMemo(
    () => validateDraft(spec, effective, media),
    [spec, effective, media],
  );
  const adSpec = spec.ad(draft.setup);

  // The start screen is long; open the editor at the top.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  // ── Autosave ──
  const dirty = useRef(false);
  const update = useCallback((fn: (d: BuilderDraft) => BuilderDraft) => {
    dirty.current = true;
    setDraft(fn);
  }, []);
  const save = useCallback(
    async (d: BuilderDraft) => {
      const body = {
        name: String(d.campaign.name || "Untitled campaign"),
        payload: d,
      };
      if (draftId) {
        await api(`/workspaces/${workspace.id}/drafts/${draftId}`, {
          method: "PATCH",
          body,
        });
        return draftId;
      }
      const created = await api<DraftDTO>(
        `/workspaces/${workspace.id}/drafts`,
        { method: "POST", body },
      );
      setDraftId(created.id);
      // Native history keeps the page (and its title) as is; Next's router stays in sync with it.
      window.history.replaceState(
        null,
        "",
        `/w/${workspace.id}/campaigns/new?draft=${created.id}`,
      );
      return created.id;
    },
    [draftId, workspace.id],
  );
  useEffect(() => {
    if (!dirty.current && draftId) return;
    const t = setTimeout(async () => {
      setSaving("saving");
      try {
        await save(effective);
        dirty.current = false;
        setSaving("saved");
        void queryClient.invalidateQueries({
          queryKey: qk2.drafts(workspace.id),
        });
      } catch {
        setSaving("error");
      }
    }, 900);
    return () => clearTimeout(t);
  }, [effective, draftId, save, queryClient, workspace.id]);

  // ── Node helpers ──
  const group =
    sel.level === "campaign"
      ? null
      : (draft.adGroups.find(
          (g) => g.key === (sel.level === "ad" ? sel.groupKey : sel.key),
        ) ?? null);
  const values =
    sel.level === "campaign"
      ? effective.campaign
      : sel.level === "adGroup"
        ? (effective.adGroups.find((g) => g.key === sel.key)?.values ?? {})
        : (effective.adGroups
            .find((g) => g.key === sel.groupKey)
            ?.ads.find((a) => a.key === sel.key)?.values ?? {});
  const level: LevelSpec | null =
    sel.level === "campaign"
      ? spec.campaign
      : sel.level === "adGroup"
        ? spec.adGroup
        : adSpec;
  const ctx: FieldContext = {
    setup: draft.setup,
    campaign: effective.campaign,
    adGroup:
      (sel.level === "campaign"
        ? effective.adGroups[0]?.values
        : effective.adGroups.find((g) => g.key === group?.key)?.values) ?? {},
    ad: values,
  };
  if (sel.level !== "ad") ctx.ad = {};
  if (sel.level === "adGroup") ctx.adGroup = values;

  const setValue = (key: string, value: unknown) =>
    update((d) => {
      if (sel.level === "campaign")
        return { ...d, campaign: { ...d.campaign, [key]: value } };
      return {
        ...d,
        adGroups: d.adGroups.map((g) => {
          if (sel.level === "adGroup" && g.key === sel.key)
            return { ...g, values: { ...g.values, [key]: value } };
          if (sel.level === "ad" && g.key === sel.groupKey)
            return {
              ...g,
              ads: g.ads.map((a) =>
                a.key === sel.key
                  ? { ...a, values: { ...a.values, [key]: value } }
                  : a,
              ),
            };
          return g;
        }),
      };
    });

  const addGroup = () => {
    if (draft.adGroups.length >= spec.maxAdGroups) return;
    const g = newAdGroup(spec, draft);
    update((d) => ({ ...d, adGroups: [...d.adGroups, g] }));
    setSel({ level: "adGroup", key: g.key });
  };
  const duplicateGroup = (key: string) => {
    const g = draft.adGroups.find((x) => x.key === key);
    if (!g || draft.adGroups.length >= spec.maxAdGroups) return;
    const copy = {
      key: nodeKey("g"),
      values: {
        ...structuredClone(g.values),
        name: `${String(g.values.name ?? spec.adGroup.label)} – Copy`,
      },
      ads: g.ads.map((a) => ({
        key: nodeKey("a"),
        values: structuredClone(a.values),
      })),
    };
    update((d) => ({ ...d, adGroups: [...d.adGroups, copy] }));
    setSel({ level: "adGroup", key: copy.key });
  };
  const removeGroup = (key: string) => {
    if (draft.adGroups.length <= 1) return;
    update((d) => ({
      ...d,
      adGroups: d.adGroups.filter((g) => g.key !== key),
    }));
    setSel({ level: "campaign" });
  };
  const addAd = (groupKey: string, from?: Values) => {
    const g = draft.adGroups.find((x) => x.key === groupKey);
    if (!g || g.ads.length >= spec.maxAds) return;
    const created = newAd(spec, draft, g);
    if (!created) return;
    const node = from
      ? {
          ...created,
          values: {
            ...structuredClone(from),
            name: `${String(from.name ?? "Ad")} – Copy`,
          },
        }
      : created;
    update((d) => ({
      ...d,
      adGroups: d.adGroups.map((x) =>
        x.key === groupKey ? { ...x, ads: [...x.ads, node] } : x,
      ),
    }));
    setSel({ level: "ad", groupKey, key: node.key });
  };
  const removeAd = (groupKey: string, key: string) => {
    const g = draft.adGroups.find((x) => x.key === groupKey);
    if (!g || g.ads.length <= 1) return;
    update((d) => ({
      ...d,
      adGroups: d.adGroups.map((x) =>
        x.key === groupKey
          ? { ...x, ads: x.ads.filter((a) => a.key !== key) }
          : x,
      ),
    }));
    setSel({ level: "adGroup", key: groupKey });
  };

  // ── AI ──
  const ai = aiStatus.data;
  const refreshAi = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: qk2.aiStatus(workspace.id),
      }),
    [queryClient, workspace.id],
  );
  const preview = previewDataFor(
    spec,
    effective,
    sel,
    creatives.data ?? [],
    opts,
    workspace.name,
  );
  const env: BuilderEnv = {
    workspaceId: workspace.id,
    platform: draft.platform,
    adAccountId: draft.adAccountId,
    currency: account?.currency ?? workspace.currency,
    options: opts,
    optionsLoading: options.isLoading,
    creatives: creatives.data ?? [],
    ai,
    brief,
    setBrief,
    requestBrief: (then) => setBriefOpen({ then }),
    adContext: adContextOf({ ...preview.data.adGroup, ...preview.data.ad }),
    onAiUsed: refreshAi,
  };

  async function aiFill(b: BriefState) {
    const target =
      sel.level === "ad"
        ? { adGroupKey: sel.groupKey, adKey: sel.key }
        : {
            adGroupKey: group?.key ?? draft.adGroups[0]!.key,
            adKey: (group ?? draft.adGroups[0])?.ads[0]?.key,
          };
    setFilling(true);
    try {
      const url = String(
        preview.data.ad.url ??
          preview.data.ad.finalUrl ??
          preview.data.adGroup.finalUrl ??
          "",
      );
      const res = await api<AiFillResponse>(
        `/workspaces/${workspace.id}/ai/builder/fill`,
        {
          method: "POST",
          body: { draft: effective, ...target, brief: briefPayload(b, url) },
        },
      );
      update((d) => ({
        ...d,
        campaign: { ...d.campaign, ...res.campaign },
        adGroups: d.adGroups.map((g) =>
          g.key !== target.adGroupKey
            ? g
            : {
                ...g,
                values: { ...g.values, ...res.adGroup },
                ads: g.ads.map((a) =>
                  a.key === target.adKey
                    ? { ...a, values: { ...a.values, ...res.ad } }
                    : a,
                ),
              },
        ),
      }));
      const n =
        Object.keys(res.ad).length +
        Object.keys(res.adGroup).length +
        Object.keys(res.campaign).length;
      toast.success(
        n
          ? `AI filled ${n} ${n === 1 ? "field" : "fields"}`
          : "AI had nothing to fill here",
        { description: res.notes[0] },
      );
      if (sel.level === "campaign" && target.adKey)
        setSel({ level: "ad", groupKey: target.adGroupKey, key: target.adKey });
      else if (sel.level === "campaign")
        setSel({ level: "adGroup", key: target.adGroupKey });
    } catch (err) {
      toastError(err);
    } finally {
      setFilling(false);
      setBriefOpen(null);
      refreshAi();
    }
  }

  const order = nodeOrder(draft);
  const position = order.findIndex((o) => sameSelection(o, sel));
  const next = order[position + 1];
  const prev = order[position - 1];
  const labelOf = (s: Selection) =>
    s.level === "campaign"
      ? spec.campaign.label
      : s.level === "adGroup"
        ? spec.adGroup.label
        : (adSpec?.label ?? "Ad");
  const nodeIssues = issuesFor(issues, sel);
  const nodeId = sel.level === "campaign" ? "campaign" : sel.key;
  const placements = spec.previews(preview.ctx);
  const setupSummary = spec.setup
    .map(
      (c) =>
        setupOptions(c, draft.setup).find((o) => o.value === draft.setup[c.key])
          ?.label,
    )
    .filter(Boolean)
    .join(" · ");

  const previewPanel = (
    <PreviewPanel data={preview.data} placements={placements} />
  );

  if (mode === "review") {
    return (
      <BuilderEnvProvider value={env}>
        <ReviewScreen
          draft={effective}
          spec={spec}
          issues={issues}
          initial={initial}
          saveNow={async () => {
            const id = await save(effective);
            dirty.current = false;
            return id;
          }}
          onBack={() => setMode("edit")}
          onGoTo={(s, field) => {
            setShowErrors(true);
            setMode("edit");
            // The editor renders again first; wait a frame before scrolling to the field.
            setTimeout(() => setSel(s, field), 50);
          }}
        />
      </BuilderEnvProvider>
    );
  }

  return (
    <BuilderEnvProvider value={env}>
      <div className="space-y-4">
        {/* Top bar */}
        <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
          <PlatformIcon platform={draft.platform} size="md" />
          <div className="min-w-0 flex-1">
            <Input
              value={String(draft.campaign.name ?? "")}
              onChange={(e) =>
                update((d) => ({
                  ...d,
                  campaign: { ...d.campaign, name: e.target.value },
                }))
              }
              className="h-8 max-w-md border-transparent px-1.5 text-base font-semibold shadow-none hover:border-input focus-visible:border-input"
              aria-label="Campaign name"
            />
            <div className="truncate px-1.5 text-xs text-muted-foreground">
              {PLATFORM_INFO[draft.platform].name} · {setupSummary} ·{" "}
              {saving === "saving"
                ? "Saving…"
                : saving === "saved"
                  ? "Draft saved"
                  : saving === "error"
                    ? "Couldn't save, retrying on next change"
                    : draftId
                      ? "Draft"
                      : "Saves automatically"}
            </div>
          </div>
          {ai?.available && (
            <Button
              variant="outline"
              onClick={() =>
                ai.canUse
                  ? setBriefOpen({
                      then: (b) => void aiFill(b),
                      title: "Fill this ad with AI",
                      submit: "Fill with AI",
                    })
                  : router.push(`/w/${workspace.id}/settings/ai`)
              }
              disabled={filling}
              title={`${tokenCount(Math.max(0, ai.balance))} AI tokens left`}
            >
              {filling ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Sparkles className="text-primary" />
              )}{" "}
              {ai.canUse ? "Fill with AI" : "Buy AI tokens"}
            </Button>
          )}
          <Button
            variant="outline"
            className="xl:hidden"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye /> Preview
          </Button>
          <Button
            onClick={() => {
              setShowErrors(true);
              setMode("review");
            }}
          >
            Review & publish <ArrowRight />
          </Button>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[200px_minmax(0,1fr)_350px] 2xl:grid-cols-[230px_minmax(0,1fr)_400px]">
          {/* Tree */}
          <nav className="lg:sticky lg:top-20 lg:self-start">
            <Card className="gap-0 p-2">
              <TreeItem
                icon={Megaphone}
                label={String(draft.campaign.name || spec.campaign.label)}
                sub={spec.campaign.label}
                active={sel.level === "campaign"}
                issues={issuesFor(issues, { level: "campaign" }).length}
                strong={showErrors}
                onClick={() => setSel({ level: "campaign" })}
              />
              {draft.adGroups.map((g) => (
                <div key={g.key} className="mt-1">
                  <TreeItem
                    icon={Layers}
                    indent={1}
                    label={String(g.values.name || spec.adGroup.label)}
                    sub={spec.adGroup.label}
                    active={sel.level === "adGroup" && sel.key === g.key}
                    issues={
                      issuesFor(issues, { level: "adGroup", key: g.key }).length
                    }
                    strong={showErrors}
                    onClick={() => setSel({ level: "adGroup", key: g.key })}
                    actions={
                      <>
                        {draft.adGroups.length < spec.maxAdGroups && (
                          <IconAction
                            label="Duplicate"
                            icon={Copy}
                            onClick={() => duplicateGroup(g.key)}
                          />
                        )}
                        {draft.adGroups.length > 1 && (
                          <IconAction
                            label="Delete"
                            icon={Trash2}
                            onClick={() => removeGroup(g.key)}
                          />
                        )}
                      </>
                    }
                  />
                  {adSpec &&
                    g.ads.map((a) => (
                      <TreeItem
                        key={a.key}
                        icon={ImageIcon}
                        indent={2}
                        label={String(a.values.name || adSpec.label)}
                        sub={adSpec.label}
                        active={sel.level === "ad" && sel.key === a.key}
                        issues={
                          issuesFor(issues, {
                            level: "ad",
                            groupKey: g.key,
                            key: a.key,
                          }).length
                        }
                        strong={showErrors}
                        onClick={() =>
                          setSel({ level: "ad", groupKey: g.key, key: a.key })
                        }
                        actions={
                          <>
                            {g.ads.length < spec.maxAds && (
                              <IconAction
                                label="Duplicate"
                                icon={Copy}
                                onClick={() => addAd(g.key, a.values)}
                              />
                            )}
                            {g.ads.length > 1 && (
                              <IconAction
                                label="Delete"
                                icon={Trash2}
                                onClick={() => removeAd(g.key, a.key)}
                              />
                            )}
                          </>
                        }
                      />
                    ))}
                  {adSpec && g.ads.length < spec.maxAds && (
                    <button
                      type="button"
                      onClick={() => addAd(g.key)}
                      className="ml-8 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <Plus className="size-3.5" /> Add{" "}
                      {adSpec.label.toLowerCase()}
                    </button>
                  )}
                </div>
              ))}
              {draft.adGroups.length < spec.maxAdGroups && (
                <button
                  type="button"
                  onClick={addGroup}
                  className="mt-1 ml-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Plus className="size-3.5" /> Add{" "}
                  {spec.adGroup.label.toLowerCase()}
                </button>
              )}
            </Card>
            {showErrors && issues.length > 0 && (
              <p className="mt-2 px-2 text-xs text-destructive">
                {issues.length}{" "}
                {issues.length === 1 ? "thing needs" : "things need"} attention
                before publishing.
              </p>
            )}
          </nav>

          {/* Form */}
          <div
            key={sel.level === "campaign" ? "campaign" : sel.key}
            className="min-w-0 space-y-4 animate-fade-up"
          >
            <div className="flex items-center gap-2 px-1">
              <Badge variant="secondary">{labelOf(sel)}</Badge>
              <span className="truncate text-sm text-muted-foreground">
                {String(values.name ?? "")}
              </span>
            </div>
            {showErrors && nodeIssues.filter((i) => !i.field).length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {nodeIssues
                  .filter((i) => !i.field)
                  .map((i) => (
                    <div key={i.message}>{i.message}</div>
                  ))}
              </div>
            )}
            {level?.sections.map((section) =>
              isVisible(section, ctx) ? (
                <SectionCard
                  key={section.id}
                  section={section}
                  values={values}
                  ctx={ctx}
                  errorsFor={(key) =>
                    showErrors || touched.has(`${nodeId}:${key}`)
                      ? nodeIssues
                          .filter((i) => i.field === key)
                          .map((i) => i.message)
                      : []
                  }
                  onTouch={(key) =>
                    setTouched((t) =>
                      t.has(`${nodeId}:${key}`)
                        ? t
                        : new Set(t).add(`${nodeId}:${key}`),
                    )
                  }
                  onChange={setValue}
                />
              ) : null,
            )}
            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                onClick={() =>
                  prev
                    ? setSel(prev)
                    : router.push(`/w/${workspace.id}/campaigns`)
                }
              >
                <ArrowLeft /> {prev ? labelOf(prev) : "Campaigns"}
              </Button>
              {next ? (
                <Button variant="outline" onClick={() => setSel(next)}>
                  Next: {labelOf(next)} <ArrowRight />
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setShowErrors(true);
                    setMode("review");
                  }}
                >
                  <Rocket /> Review & publish
                </Button>
              )}
            </div>
          </div>

          {/* Preview */}
          <aside className="hidden xl:sticky xl:top-20 xl:block xl:self-start">
            <Card className="gap-3 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Ad preview</div>
                <span className="text-xs text-muted-foreground">
                  {String(preview.data.ad.name ?? "")}
                </span>
              </div>
              {previewPanel}
            </Card>
          </aside>
        </div>

        <Sheet open={previewOpen} onOpenChange={setPreviewOpen}>
          <SheetContent className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Ad preview</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6">{previewPanel}</div>
          </SheetContent>
        </Sheet>

        <BriefDialog
          open={Boolean(briefOpen)}
          onOpenChange={(o) => !o && setBriefOpen(null)}
          title={briefOpen?.title}
          submitLabel={briefOpen?.submit}
          busy={filling}
          onSubmit={(b) => {
            const then = briefOpen?.then;
            if (!briefOpen?.submit) setBriefOpen(null);
            then?.(b);
          }}
        />
        <p className="text-center text-xs text-muted-foreground">
          Signed in as {me.user.name}.{" "}
          <Link
            href={`/w/${workspace.id}/creatives`}
            target="_blank"
            className="hover:underline"
          >
            Open creative library
          </Link>
        </p>
      </div>
    </BuilderEnvProvider>
  );
}

function SectionCard({
  section,
  values,
  ctx,
  errorsFor,
  onChange,
  onTouch,
}: {
  section: LevelSpec["sections"][number];
  values: Values;
  ctx: FieldContext;
  errorsFor: (key: string) => string[];
  onChange: (key: string, value: unknown) => void;
  onTouch: (key: string) => void;
}) {
  const visible = section.fields.filter((f) => isVisible(f, ctx));
  const basic = visible.filter((f) => !f.advanced);
  const advanced = visible.filter((f) => f.advanced);
  const advancedHasErrors = advanced.some((f) => errorsFor(f.key).length > 0);
  const [showMore, setShowMore] = useState(false);
  if (visible.length === 0) return null;
  const render = (f: (typeof visible)[number]) => (
    <div
      key={f.key}
      onBlur={() => onTouch(f.key)}
      className={cn(
        f.width === "half"
          ? "sm:col-span-1"
          : f.width === "third"
            ? "sm:col-span-1"
            : "sm:col-span-2",
      )}
    >
      <FieldRenderer
        field={f}
        value={values[f.key]}
        onChange={(v) => onChange(f.key, v)}
        ctx={ctx}
        errors={errorsFor(f.key)}
      />
    </div>
  );
  return (
    <Card className="gap-0 py-0">
      <div className="border-b px-5 py-3.5">
        <h3 className="text-sm font-semibold">{section.title}</h3>
        {section.description && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {section.description}
          </p>
        )}
      </div>
      <SectionTitleContext.Provider value={section.title}>
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          {basic.map(render)}
          {advanced.length > 0 && (
            <div className="sm:col-span-2">
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    (showMore || advancedHasErrors) && "rotate-180",
                  )}
                />
                {showMore || advancedHasErrors
                  ? "Fewer options"
                  : `More options (${advanced.length})`}
              </button>
            </div>
          )}
          {(showMore || advancedHasErrors) && advanced.map(render)}
        </div>
      </SectionTitleContext.Provider>
    </Card>
  );
}

function TreeItem({
  icon: Icon,
  label,
  sub,
  active,
  onClick,
  indent = 0,
  issues,
  strong,
  actions,
}: {
  icon: typeof Megaphone;
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
  indent?: number;
  issues: number;
  /** Red after a review attempt; a quiet count before that. */
  strong?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-lg transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted",
      )}
      style={{ paddingLeft: indent * 14 }}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            active ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">
            {label}
          </span>
          <span className="block text-[10px] text-muted-foreground">{sub}</span>
        </span>
        {issues > 0 ? (
          <span
            title={`${issues} ${issues === 1 ? "thing" : "things"} left to fill`}
            className={cn(
              "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-bold",
              strong
                ? "bg-destructive text-white"
                : "bg-muted text-muted-foreground",
            )}
          >
            {issues}
          </span>
        ) : (
          <Check className="size-3.5 shrink-0 text-success" />
        )}
      </button>
      {actions && (
        <div className="mr-1 hidden shrink-0 items-center group-hover:flex">
          {actions}
        </div>
      )}
    </div>
  );
}

function IconAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Copy;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
    >
      <Icon className="size-3.5" />
    </button>
  );
}
