"use client";

import {
  FEATURE_LABELS,
  PAID_PLANS,
  catalogSchema,
  type Catalog,
  type CatalogPlan,
  type Feature,
  type PlanId,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, Plus, RotateCcw, Star, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-field";
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
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { money, timeAgo, tokenCount } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { cn } from "@/lib/utils";

interface CatalogResponse {
  catalog: Catalog;
  defaults: Catalog;
  custom: boolean;
  updatedAt: string | null;
}

const PLAN_ORDER: PlanId[] = ["TRIAL", ...PAID_PLANS];
const FEATURES = Object.keys(FEATURE_LABELS) as Feature[];
const LIMITS: { key: keyof CatalogPlan["limits"]; label: string }[] = [
  { key: "workspaces", label: "Workspaces" },
  { key: "adAccounts", label: "Connected ad accounts" },
  { key: "members", label: "Team members" },
];

/** Whole-number input that keeps typing smooth (empty while editing). */
function NumberInput({
  id,
  value,
  onChange,
  min = 0,
  step = 1,
  prefix,
  suffix,
  className,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  // Follow outside changes (discard, reset) without fighting what's being typed.
  if (value !== synced) {
    setSynced(value);
    if (Number(text) !== value) setText(String(value));
  }
  return (
    <div className={cn("relative", className)}>
      {prefix && (
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">
          {prefix}
        </span>
      )}
      <Input
        id={id}
        inputMode="decimal"
        className={cn("tabular", prefix && "pl-7", suffix && "pr-14")}
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.]/g, "");
          setText(t);
          const n = Number(t);
          if (t !== "" && Number.isFinite(n))
            onChange(step < 1 ? n : Math.round(n));
        }}
        onBlur={() => {
          const n = Number(text);
          if (text === "" || !Number.isFinite(n) || n < min) {
            setText(String(Math.max(min, value)));
            onChange(Math.max(min, value));
          }
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "pack";

export function PricingEditor() {
  const query = useQuery({
    queryKey: ["admin-catalog"],
    queryFn: () => api<CatalogResponse>("/admin/settings/catalog"),
  });
  if (!query.data) return <Skeleton className="h-[600px] rounded-xl" />;
  return <PricingForm data={query.data} />;
}

function PricingForm({ data }: { data: CatalogResponse }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Catalog>(() =>
    structuredClone(data.catalog),
  );
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data.catalog),
    [draft, data],
  );
  useUnsavedChanges(dirty);
  const problems = useMemo(() => {
    const r = catalogSchema.safeParse(draft);
    const out = r.success
      ? []
      : r.error.issues.map((i) => `${i.path.join(" › ")}: ${i.message}`);
    const ids = draft.tokenPacks.map((p) => p.id);
    if (new Set(ids).size !== ids.length)
      out.push("Each token pack needs its own ID.");
    return out;
  }, [draft]);

  const setPlan = (id: PlanId, patch: Partial<CatalogPlan>) =>
    setDraft((d) => ({
      ...d,
      plans: { ...d.plans, [id]: { ...d.plans[id], ...patch } },
    }));
  const gst = (n: number) => Math.round(n * (1 + draft.gstPercent / 100));

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["catalog"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-stats"] }),
    ]);
  }

  async function save() {
    setBusy("save");
    try {
      const r = await api<{ catalog: Catalog }>("/admin/settings/catalog", {
        method: "PUT",
        body: draft,
      });
      setDraft(structuredClone(r.catalog));
      await refresh();
      toast.success("Prices saved", {
        description: "Every customer sees the new price list now.",
      });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    try {
      const r = await api<{ catalog: Catalog }>("/admin/settings/catalog", {
        method: "DELETE",
      });
      setDraft(structuredClone(r.catalog));
      await refresh();
      setConfirmReset(false);
      toast.success("Prices reset to the defaults");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="space-y-1 text-muted-foreground">
          <p>
            These prices, limits and features show on the pricing page, in every
            organization&apos;s Plan &amp; billing and AI tokens pages, and are
            enforced by the server.
          </p>
          <p>
            New prices apply to new purchases. Organizations already subscribed
            keep paying their current price until they change plan.{" "}
            {data.custom && data.updatedAt
              ? `Last saved ${timeAgo(data.updatedAt)}.`
              : "You're on the default prices."}
          </p>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>General</CardTitle>
          <CardDescription>
            Trial, tax and the free AI allowance for new organizations.
          </CardDescription>
        </CardHeader>
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <FormField
            id="trialDays"
            label="Free trial length"
            hint="Every feature is unlocked during the trial."
          >
            <NumberInput
              id="trialDays"
              value={draft.trialDays}
              onChange={(n) => setDraft({ ...draft, trialDays: n })}
              suffix="days"
            />
          </FormField>
          <FormField
            id="gst"
            label="GST added at checkout"
            hint="Prices are shown before tax."
          >
            <NumberInput
              id="gst"
              value={draft.gstPercent}
              step={0.5}
              onChange={(n) => setDraft({ ...draft, gstPercent: n })}
              suffix="%"
            />
          </FormField>
          <FormField
            id="freeTokens"
            label="Free AI tokens"
            hint={`About ${Math.floor(draft.aiFreeTokens / 3000)} ad fills, given once to each new organization.`}
          >
            <NumberInput
              id="freeTokens"
              value={draft.aiFreeTokens}
              step={1000}
              onChange={(n) => setDraft({ ...draft, aiFreeTokens: n })}
              suffix="tokens"
            />
          </FormField>
          <FormField
            id="minBalance"
            label="Minimum balance to use AI"
            hint="Below this, AI asks the organization to buy tokens."
          >
            <NumberInput
              id="minBalance"
              value={draft.aiMinBalance}
              step={100}
              onChange={(n) => setDraft({ ...draft, aiMinBalance: n })}
              suffix="tokens"
            />
          </FormField>
        </div>
      </Card>

      <div className="space-y-3">
        <div>
          <h2 className="text-[15px] font-semibold">Plans</h2>
          <p className="text-sm text-muted-foreground">
            What each plan costs per month, what it includes and the limits the
            server enforces.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {PLAN_ORDER.map((id) => {
            const p = draft.plans[id];
            const trial = id === "TRIAL";
            return (
              <Card
                key={id}
                className={cn(
                  "gap-4 p-5",
                  p.popular && !trial && "ring-2 ring-primary",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="font-mono text-[10px]"
                    >
                      {id}
                    </Badge>
                    {trial && (
                      <span className="text-xs text-muted-foreground">
                        Limits during the {draft.trialDays}-day trial
                      </span>
                    )}
                  </div>
                  {!trial && (
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <Star
                        className={cn(
                          "size-3.5",
                          p.popular
                            ? "fill-primary text-primary"
                            : "text-muted-foreground",
                        )}
                      />{" "}
                      Most popular
                      <Switch
                        checked={p.popular}
                        onCheckedChange={(on) =>
                          setDraft((d) => ({
                            ...d,
                            plans: Object.fromEntries(
                              PLAN_ORDER.map((k) => [
                                k,
                                {
                                  ...d.plans[k],
                                  popular: on
                                    ? k === id
                                    : k === id
                                      ? false
                                      : d.plans[k].popular,
                                },
                              ]),
                            ) as Catalog["plans"],
                          }))
                        }
                      />
                    </label>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField id={`${id}-name`} label="Name">
                    <Input
                      id={`${id}-name`}
                      value={p.name}
                      maxLength={40}
                      onChange={(e) => setPlan(id, { name: e.target.value })}
                    />
                  </FormField>
                  {!trial && (
                    <FormField
                      id={`${id}-price`}
                      label="Price per month"
                      hint={`${money(gst(p.priceMonthly), "INR", { decimals: 0 })} with ${draft.gstPercent}% GST`}
                    >
                      <NumberInput
                        id={`${id}-price`}
                        value={p.priceMonthly}
                        prefix="₹"
                        onChange={(n) => setPlan(id, { priceMonthly: n })}
                      />
                    </FormField>
                  )}
                  <FormField
                    id={`${id}-audience`}
                    label="Who it's for"
                    className="sm:col-span-2"
                  >
                    <Input
                      id={`${id}-audience`}
                      value={p.audience}
                      maxLength={120}
                      onChange={(e) =>
                        setPlan(id, { audience: e.target.value })
                      }
                    />
                  </FormField>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {LIMITS.map((l) => {
                    const v = p.limits[l.key];
                    return (
                      <div key={l.key} className="space-y-1.5">
                        <div className="text-[13px] font-medium">{l.label}</div>
                        {v == null ? (
                          <div className="flex h-9 items-center rounded-lg border bg-muted/40 px-2.5 text-sm text-muted-foreground">
                            Unlimited
                          </div>
                        ) : (
                          <NumberInput
                            id={`${id}-${l.key}`}
                            value={v}
                            onChange={(n) =>
                              setPlan(id, {
                                limits: { ...p.limits, [l.key]: n },
                              })
                            }
                          />
                        )}
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={v == null}
                            onCheckedChange={(c) =>
                              setPlan(id, {
                                limits: { ...p.limits, [l.key]: c ? null : 5 },
                              })
                            }
                          />{" "}
                          Unlimited
                        </label>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-1.5">
                  <div className="text-[13px] font-medium">Features</div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {FEATURES.map((f) => (
                      <label
                        key={f}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={p.features.includes(f)}
                          onCheckedChange={(c) =>
                            setPlan(id, {
                              features: c
                                ? [...p.features, f]
                                : p.features.filter((x) => x !== f),
                            })
                          }
                        />
                        {FEATURE_LABELS[f]}
                      </label>
                    ))}
                  </div>
                </div>
                {!trial && (
                  <FormField
                    id={`${id}-highlights`}
                    label="Bullet points on the pricing card"
                    hint="One per line, up to 12."
                  >
                    <Textarea
                      id={`${id}-highlights`}
                      rows={4}
                      value={p.highlights.join("\n")}
                      onChange={(e) =>
                        setPlan(id, {
                          highlights: e.target.value
                            .split("\n")
                            .map((s) => s.slice(0, 80))
                            .slice(0, 12),
                        })
                      }
                      onBlur={() =>
                        setPlan(id, {
                          highlights: p.highlights
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </FormField>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>AI token packs</CardTitle>
          <CardDescription>
            What organizations can buy once their free tokens run out. A typical
            ad fill uses about 3,000 tokens.
          </CardDescription>
        </CardHeader>
        <div className="divide-y">
          {draft.tokenPacks.map((pack, i) => {
            const set = (patch: Partial<typeof pack>) =>
              setDraft((d) => ({
                ...d,
                tokenPacks: d.tokenPacks.map((x, j) =>
                  j === i
                    ? { ...x, ...patch }
                    : patch.popular
                      ? { ...x, popular: false }
                      : x,
                ),
              }));
            return (
              <div
                key={i}
                className="grid items-end gap-3 px-5 py-4 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
              >
                <FormField id={`pack-${i}-name`} label="Name">
                  <Input
                    id={`pack-${i}-name`}
                    value={pack.name}
                    maxLength={40}
                    onChange={(e) => set({ name: e.target.value })}
                  />
                </FormField>
                <FormField
                  id={`pack-${i}-tokens`}
                  label="Tokens"
                  hint={`≈ ${Math.floor(pack.tokens / 3000)} ad fills`}
                >
                  <NumberInput
                    id={`pack-${i}-tokens`}
                    value={pack.tokens}
                    step={1000}
                    onChange={(n) => set({ tokens: n })}
                  />
                </FormField>
                <FormField
                  id={`pack-${i}-price`}
                  label="Price"
                  hint={`${money(gst(pack.price), "INR", { decimals: 0 })} with GST · ₹${((pack.price / pack.tokens) * 100_000).toFixed(0)} per 100K`}
                >
                  <NumberInput
                    id={`pack-${i}-price`}
                    value={pack.price}
                    prefix="₹"
                    onChange={(n) => set({ price: n })}
                  />
                </FormField>
                <label className="flex h-9 items-center gap-2 text-xs font-medium">
                  <Switch
                    checked={Boolean(pack.popular)}
                    onCheckedChange={(on) => set({ popular: on })}
                  />{" "}
                  Popular
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${pack.name}`}
                  disabled={draft.tokenPacks.length <= 1}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      tokenPacks: draft.tokenPacks.filter((_, j) => j !== i),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="border-t px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={draft.tokenPacks.length >= 8}
            onClick={() => {
              const name = `Pack ${draft.tokenPacks.length + 1}`;
              const taken = new Set(draft.tokenPacks.map((p) => p.id));
              let id = `pack_${slug(name)}`;
              for (let n = 2; taken.has(id); n++)
                id = `pack_${slug(name)}_${n}`;
              setDraft({
                ...draft,
                tokenPacks: [
                  ...draft.tokenPacks,
                  { id, name, tokens: 1_000_000, price: 999 },
                ],
              });
            }}
          >
            <Plus /> Add pack
          </Button>
          <span className="ml-3 text-xs text-muted-foreground">
            Free allowance: {tokenCount(draft.aiFreeTokens)} tokens per new
            organization.
          </span>
        </div>
      </Card>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-3">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              problems.length ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {problems.length
              ? problems[0]
              : dirty
                ? "You have unsaved changes."
                : "All changes saved."}
          </span>
          {data.custom && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmReset(true)}
              disabled={!!busy}
            >
              <RotateCcw /> Reset to defaults
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || !!busy}
            onClick={() => setDraft(structuredClone(data.catalog))}
          >
            Discard
          </Button>
          <Button
            size="sm"
            disabled={!dirty || problems.length > 0 || !!busy}
            onClick={save}
          >
            {busy === "save" && <Loader2 className="animate-spin" />} Save
            prices
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset every price to the defaults?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Plans, limits, trial length and token packs go back to what this
              release ships with. Existing subscriptions aren&apos;t changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void reset();
              }}
            >
              {busy === "reset" && <Loader2 className="animate-spin" />} Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
