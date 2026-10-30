"use client";

import {
  type AiAudienceResponse,
  type AiKeywordIdea,
  type CreativeDTO,
  type Field,
  type FieldContext,
  type KeywordValue,
  type PlacementsValue,
  type TargetingSearchResult,
  type TargetingValue,
  type Values,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Film, Loader2, MapPin, Plus, Sparkles, Upload, X } from "lucide-react";
import { useDeferredValue, useRef, useState } from "react";
import { toast } from "sonner";
import { CreativeThumb, formatLabel } from "@/components/creatives/creative-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, apiUpload } from "@/lib/api";
import { toastError } from "@/lib/forms";
import { qk2 } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { AiTokensNotice, briefPayload } from "./ai";
import { useBuilderEnv } from "./builder-context";
import { FieldRenderer } from "./fields";

type TargetingField = Extract<Field, { type: "targeting" }>;
type KeywordsField = Extract<Field, { type: "keywords" }>;
type PlacementsField = Extract<Field, { type: "placements" }>;
type MediaField = Extract<Field, { type: "media" }>;
type RepeaterField = Extract<Field, { type: "repeater" }>;

// ───────── Targeting search ─────────

export function TargetingInput({ field, value, onChange, ctx }: { field: TargetingField; value: unknown; onChange: (v: unknown) => void; ctx: FieldContext }) {
  const env = useBuilderEnv();
  const list = (Array.isArray(value) ? value : []) as TargetingValue[];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const [ideas, setIdeas] = useState(false);
  const search = useQuery({
    queryKey: ["builder-targeting", env.workspaceId, env.adAccountId, field.kind, query],
    queryFn: () => api<TargetingSearchResult[]>(`/workspaces/${env.workspaceId}/builder/targeting`, { query: { adAccountId: env.adAccountId, kind: field.kind, q: query } }),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const has = (id: string) => list.some((x) => x.id === id);
  const add = (r: TargetingValue, exclude = false) => {
    if (has(r.id) || (field.max && list.length >= field.max)) return;
    onChange([...list, { id: r.id, name: r.name, type: r.type, countryCode: r.countryCode, ...(exclude ? { exclude: true } : {}) }]);
  };
  const remove = (id: string) => onChange(list.filter((x) => x.id !== id));
  const Icon = field.kind === "location" ? MapPin : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {list.map((t) => (
          <span key={t.id} className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs", t.exclude ? "border-destructive/40 bg-destructive/5 text-destructive" : "bg-muted/60")}>
            {t.exclude ? <Ban className="size-3" /> : Icon && <Icon className="size-3 text-muted-foreground" />}
            {t.name}
            {t.type && t.type !== "country" && field.kind === "location" && <span className="text-muted-foreground">· {t.type}</span>}
            <button type="button" onClick={() => remove(t.id)} aria-label={`Remove ${t.name}`} className="ml-0.5 opacity-60 hover:opacity-100"><X className="size-3" /></button>
          </span>
        ))}
        {list.length === 0 && <span className="text-xs text-muted-foreground">{field.kind === "location" ? "No locations yet." : "None added; the platform will use broad targeting."}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm"><Plus /> Add {field.label.toLowerCase()}</Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput value={q} onValueChange={setQ} placeholder={field.kind === "location" ? "Search countries, regions, cities…" : `Search ${field.label.toLowerCase()}…`} />
              <CommandList>
                {search.isFetching && <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching…</div>}
                <CommandEmpty>{query ? "No matches." : "Type to search."}</CommandEmpty>
                <CommandGroup>
                  {(search.data ?? []).map((r) => (
                    <CommandItem key={r.id} value={r.id} onSelect={() => add(r)} disabled={has(r.id)} className="items-start">
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{r.name}</div>
                        {r.detail && <div className="truncate text-[11px] text-muted-foreground">{r.detail}</div>}
                      </div>
                      {has(r.id) ? (
                        <Check className="size-4 text-primary" />
                      ) : (
                        field.allowExclude && (
                          <button
                            type="button"
                            className="rounded px-1.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              add(r, true);
                            }}
                          >
                            Exclude
                          </button>
                        )
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {field.ai && env.ai?.available && (
          <Button type="button" variant="ghost" size="sm" className="text-primary" onClick={() => setIdeas(true)}>
            <Sparkles /> Suggest with AI
          </Button>
        )}
      </div>
      {ideas && <AudienceIdeas field={field} existing={list} ctx={ctx} onClose={() => setIdeas(false)} onAdd={(items) => onChange([...list, ...items.filter((i) => !has(i.id))])} />}
    </div>
  );
}

/** AI interest ideas, matched to the platform's real targeting options. */
function AudienceIdeas({ field, existing, onClose, onAdd, ctx }: { field: TargetingField; existing: TargetingValue[]; ctx: FieldContext; onClose: () => void; onAdd: (items: TargetingValue[]) => void }) {
  const env = useBuilderEnv();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ rationale: string; matches: TargetingValue[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  async function run(brief = env.brief) {
    if (!brief.product) {
      env.requestBrief((b) => void run(b));
      return;
    }
    setLoading(true);
    try {
      const age = ctx.adGroup.age as { min: number; max: number } | undefined;
      const res = await api<AiAudienceResponse>(`/workspaces/${env.workspaceId}/ai/builder/audience`, {
        method: "POST",
        body: { platform: env.platform, kind: field.label, brief: briefPayload(brief), ageMin: Math.max(13, age?.min ?? 18), ageMax: Math.min(65, age?.max ?? 65) },
      });
      // Match each idea to a real targeting option so it can be sent to the platform.
      const matches: TargetingValue[] = [];
      for (const name of res.interests) {
        const found = await api<TargetingSearchResult[]>(`/workspaces/${env.workspaceId}/builder/targeting`, { query: { adAccountId: env.adAccountId, kind: field.kind, q: name } }).catch(() => []);
        const hit = found.find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? found[0];
        if (hit && !matches.some((m) => m.id === hit.id) && !existing.some((e) => e.id === hit.id)) matches.push({ id: hit.id, name: hit.name, type: hit.type });
      }
      setResult({ rationale: res.rationale, matches });
      setPicked(new Set(matches.map((m) => m.id)));
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
      env.onAiUsed();
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> {field.label} ideas</DialogTitle>
          <DialogDescription>AI suggests options from the brief, matched to what {field.label.toLowerCase()} the platform offers.</DialogDescription>
        </DialogHeader>
        {!env.ai?.canUse ? (
          <AiTokensNotice />
        ) : !result ? (
          <Button onClick={() => void run()} disabled={loading} className="w-full">
            {loading ? <Loader2 className="animate-spin" /> : <Sparkles />} {loading ? "Finding audiences…" : "Suggest audiences"}
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{result.rationale}</p>
            {result.matches.length === 0 ? (
              <p className="text-sm">No matching options were found on this platform. Try searching manually.</p>
            ) : (
              <div className="grid max-h-72 gap-1.5 overflow-y-auto sm:grid-cols-2">
                {result.matches.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                    <Checkbox checked={picked.has(m.id)} onCheckedChange={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(m.id); else n.delete(m.id); return n; })} />
                    <span className="truncate">{m.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {result && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button
              disabled={picked.size === 0}
              onClick={() => {
                onAdd(result.matches.filter((m) => picked.has(m.id)));
                onClose();
              }}
            >
              Add {picked.size}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ───────── Keywords ─────────

const fmtKeyword = (k: KeywordValue) => (k.matchType === "EXACT" ? `[${k.text}]` : k.matchType === "PHRASE" ? `"${k.text}"` : k.text);

/** Parses `[exact]`, `"phrase"` and broad keywords, one per line or comma. */
function parseKeywords(raw: string, fallback: KeywordValue["matchType"]): KeywordValue[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (/^\[.*\]$/.test(s)) return { text: s.slice(1, -1).trim().toLowerCase(), matchType: "EXACT" as const };
      if (/^".*"$/.test(s)) return { text: s.slice(1, -1).trim().toLowerCase(), matchType: "PHRASE" as const };
      return { text: s.toLowerCase(), matchType: fallback };
    })
    .filter((k) => k.text);
}

export function KeywordsInput({ field, value, onChange }: { field: KeywordsField; value: unknown; onChange: (v: unknown) => void }) {
  const env = useBuilderEnv();
  const list = (Array.isArray(value) ? value : []) as KeywordValue[];
  const [text, setText] = useState("");
  // Phrase match is the usual starting point, but some platforms (e.g. Apple) don't offer it.
  const [match, setMatch] = useState<KeywordValue["matchType"]>(field.matchTypes.includes("PHRASE") ? "PHRASE" : (field.matchTypes[0] ?? "BROAD"));
  const [ideas, setIdeas] = useState<AiKeywordIdea[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const addAll = (items: KeywordValue[]) => {
    const seen = new Set(list.map((k) => `${k.matchType}:${k.text}`));
    const next = [...list];
    for (const k of items) {
      const key = `${k.matchType}:${k.text}`;
      if (!seen.has(key) && next.length < field.max) {
        next.push(k);
        seen.add(key);
      }
    }
    onChange(next);
  };
  const cycle = (i: number) => {
    const order: KeywordValue["matchType"][] = ["BROAD", "PHRASE", "EXACT"].filter((m) => field.matchTypes.includes(m as never)) as KeywordValue["matchType"][];
    onChange(list.map((k, j) => (j === i ? { ...k, matchType: order[(order.indexOf(k.matchType) + 1) % order.length]! } : k)));
  };

  async function suggest(brief = env.brief) {
    if (!brief.product) {
      env.requestBrief((b) => void suggest(b));
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ keywords: AiKeywordIdea[] }>(`/workspaces/${env.workspaceId}/ai/builder/keywords`, {
        method: "POST",
        body: { platform: env.platform, brief: briefPayload(brief), existing: list.map((k) => k.text), negative: Boolean(field.negative) },
      });
      setIdeas(res.keywords);
      setPicked(new Set(res.keywords.map((k) => k.text)));
    } catch (err) {
      toastError(err);
    } finally {
      setLoading(false);
      env.onAiUsed();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && text.trim()) {
              e.preventDefault();
              addAll(parseKeywords(text, match));
              setText("");
            }
          }}
          rows={1}
          placeholder={field.negative ? "free, jobs, diy" : 'kurta for women, "ethnic wear online", [buy silk saree]'}
          className="min-h-9 flex-1 resize-y rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <div className="flex gap-2">
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            {field.matchTypes.map((m) => (
              <button key={m} type="button" onClick={() => setMatch(m)} className={cn("rounded px-2 py-1 capitalize", match === m && "bg-muted font-medium")}>
                {m.toLowerCase()}
              </button>
            ))}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9"
            disabled={!text.trim()}
            onClick={() => {
              addAll(parseKeywords(text, match));
              setText("");
            }}
          >
            Add
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">Press Enter to add. Paste many at once (one per line or comma-separated). Click a keyword to change its match type.</p>
      {list.length > 0 && (
        <div className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto">
          {list.map((k, i) => (
            <span key={`${k.matchType}:${k.text}`} className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs", field.negative && "border-destructive/30 text-destructive")}>
              <button type="button" onClick={() => cycle(i)} title="Change match type">{fmtKeyword(k)}</button>
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label={`Remove ${k.text}`} className="opacity-60 hover:opacity-100"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground tabular">{list.length} {field.negative ? "negative " : ""}keywords</span>
        {env.ai?.available && (
          <Button type="button" variant="ghost" size="sm" className="text-primary" onClick={() => void suggest()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <Sparkles />} {field.negative ? "Suggest negatives" : "Keyword ideas"}
          </Button>
        )}
      </div>
      {ideas && (
        <Dialog open onOpenChange={(o) => !o && setIdeas(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> {field.negative ? "Negative keyword ideas" : "Keyword ideas"}</DialogTitle>
              <DialogDescription>Untick anything that doesn&apos;t fit, then add the rest.</DialogDescription>
            </DialogHeader>
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {ideas.map((k) => (
                <label key={k.text} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                  <Checkbox checked={picked.has(k.text)} onCheckedChange={(on) => setPicked((s) => { const n = new Set(s); if (on) n.add(k.text); else n.delete(k.text); return n; })} />
                  <span className="flex-1 font-mono text-xs">{fmtKeyword(k)}</span>
                  {!field.negative && <Badge variant="secondary" className={cn("text-[10px]", k.intent === "high" && "bg-success/15 text-success")}>{k.intent} intent</Badge>}
                </label>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIdeas(null)}>Cancel</Button>
              <Button
                disabled={picked.size === 0}
                onClick={() => {
                  addAll(ideas.filter((k) => picked.has(k.text)).map((k) => ({ text: k.text, matchType: field.matchTypes.includes(k.matchType) ? k.matchType : field.matchTypes[0]! })));
                  setIdeas(null);
                }}
              >
                Add {picked.size}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ───────── Placements ─────────

export function PlacementsInput({ field, value, onChange }: { field: PlacementsField; value: unknown; onChange: (v: unknown) => void }) {
  const all = field.groups.flatMap((g) => g.items.map((i) => i.value));
  const v = (value as PlacementsValue) ?? { mode: "AUTO", items: all };
  const set = (items: string[]) => onChange({ ...v, items });
  return (
    <div className="space-y-3">
      {(["AUTO", "MANUAL"] as const).map((mode) => (
        <label key={mode} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3", v.mode === mode && "border-primary bg-primary/[0.04]")}>
          <input type="radio" className="mt-1 accent-[var(--primary)]" checked={v.mode === mode} onChange={() => onChange({ mode, items: mode === "AUTO" ? all : v.items.length ? v.items : all })} />
          <span>
            <span className="block text-sm font-medium">{mode === "AUTO" ? field.autoLabel : "Manual placements"}</span>
            <span className="block text-xs text-muted-foreground">{mode === "AUTO" ? field.autoDescription : "Choose exactly where your ads appear. More placements give the system more opportunities to reach people."}</span>
          </span>
        </label>
      ))}
      {v.mode === "MANUAL" && (
        <div className="divide-y rounded-lg border">
          {field.groups.map((g) => {
            const ids = g.items.map((i) => i.value);
            const on = ids.filter((id) => v.items.includes(id));
            return (
              <div key={g.id} className="p-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={on.length === ids.length ? true : on.length ? "indeterminate" : false}
                    onCheckedChange={(c) => set(c ? [...new Set([...v.items, ...ids])] : v.items.filter((x) => !ids.includes(x)))}
                  />
                  {g.label}
                  <span className="text-xs font-normal text-muted-foreground">{on.length}/{ids.length}</span>
                </label>
                <div className="mt-2 grid gap-1.5 pl-6 sm:grid-cols-2">
                  {g.items.map((i) => (
                    <label key={i.value} className="flex cursor-pointer items-start gap-2 text-sm">
                      <Checkbox checked={v.items.includes(i.value)} onCheckedChange={(c) => set(c ? [...v.items, i.value] : v.items.filter((x) => x !== i.value))} className="mt-0.5" />
                      <span>
                        {i.label}
                        {i.description && <span className="block text-xs text-muted-foreground">{i.description}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ───────── Media ─────────

const ratioValue = (r: string) => {
  const [a, b] = r.split(":").map(Number);
  return a && b ? a / b : null;
};
const fitsRatio = (c: CreativeDTO, ratios?: string[]) => {
  if (!ratios?.length || !c.width || !c.height) return true;
  const r = c.width / c.height;
  return ratios.some((x) => {
    const want = ratioValue(x);
    return want != null && Math.abs(r - want) / want < 0.04;
  });
};

export function MediaInput({ field, value, onChange }: { field: MediaField; value: unknown; onChange: (v: unknown) => void }) {
  const env = useBuilderEnv();
  const ids = (Array.isArray(value) ? value : []) as string[];
  const selected = ids.map((id) => env.creatives.find((c) => c.id === id)).filter((c): c is CreativeDTO => Boolean(c));
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map((c) => (
            <div key={c.id} className="group relative w-24 overflow-hidden rounded-lg border">
              <CreativeThumb creative={c} className="aspect-square" />
              <span className={cn("absolute inset-x-0 bottom-0 truncate px-1 py-0.5 text-[9px] text-white", fitsRatio(c, field.ratios) ? "bg-black/55" : "bg-destructive/85")}>
                {formatLabel(c) ?? c.name}
              </span>
              <button type="button" onClick={() => onChange(ids.filter((x) => x !== c.id))} className="absolute top-1 right-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100" aria-label={`Remove ${c.name}`}>
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          {field.accept.includes("VIDEO") && !field.accept.includes("IMAGE") ? <Film /> : <Plus />}
          {selected.length ? "Change" : field.max > 1 ? "Add media" : "Choose media"}
        </Button>
        {field.ratios && <span className="text-[11px] text-muted-foreground">Best: {field.ratios.join(", ")}</span>}
      </div>
      {field.specs && <p className="text-[11px] text-muted-foreground">{field.specs}</p>}
      {open && <MediaPicker field={field} initial={ids} onClose={() => setOpen(false)} onDone={(next) => onChange(next)} />}
    </div>
  );
}

function MediaPicker({ field, initial, onClose, onDone }: { field: MediaField; initial: string[]; onClose: () => void; onDone: (ids: string[]) => void }) {
  const env = useBuilderEnv();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[]>(initial);
  const [uploading, setUploading] = useState(false);
  const ratios = field.requiredRatio ? [field.requiredRatio] : field.ratios;
  const accepted = env.creatives.filter((c) => field.accept.includes(c.type));
  // Start with only the files that fit, as long as there are some; people can turn it off.
  const [onlyFit, setOnlyFit] = useState(() => Boolean(field.requiredRatio) || ((ratios?.length ?? 0) > 0 && accepted.some((c) => fitsRatio(c, ratios))));
  const inputRef = useRef<HTMLInputElement>(null);
  const items = accepted.filter((c) => !onlyFit || fitsRatio(c, ratios));

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : field.max === 1 ? [id] : p.length >= field.max ? p : [...p, id]));

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).slice(0, 10).forEach((f) => form.append("files", f));
      const created = await apiUpload<CreativeDTO[]>(`/workspaces/${env.workspaceId}/creatives`, form);
      await queryClient.invalidateQueries({ queryKey: qk2.creatives(env.workspaceId) });
      setPicked((p) => (field.max === 1 ? [created[0]!.id] : [...p, ...created.map((c) => c.id)].slice(0, field.max)));
      toast.success(`${created.length} ${created.length === 1 ? "file" : "files"} uploaded`);
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{field.label}</DialogTitle>
          <DialogDescription>
            {field.max === 1 ? "Choose one file" : `Choose up to ${field.max} files`} from your creative library{field.ratios ? ` · best ratios ${field.ratios.join(", ")}` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {(field.ratios || field.requiredRatio) && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={onlyFit} onCheckedChange={(c) => setOnlyFit(Boolean(c))} /> Only show files that fit
            </label>
          )}
          <input ref={inputRef} type="file" multiple hidden accept={field.accept.map((a) => (a === "IMAGE" ? "image/*" : "video/*")).join(",")} onChange={(e) => void upload(e.target.files)} />
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />} Upload
          </Button>
        </div>
        <div className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
          {items.map((c) => {
            const on = picked.includes(c.id);
            const fits = fitsRatio(c, field.ratios);
            return (
              <button key={c.id} type="button" onClick={() => toggle(c.id)} title={c.name} className={cn("relative overflow-hidden rounded-lg border-2 transition-all", on ? "border-primary" : "border-transparent hover:border-muted-foreground/30")}>
                <CreativeThumb creative={c} className="aspect-square" />
                {on && <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" /></span>}
                <span className={cn("absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[10px] text-white", fits ? "bg-black/55" : "bg-warning/90")}>{formatLabel(c) ?? c.name}</span>
              </button>
            );
          })}
          {items.length === 0 && (
            <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
              No {field.accept.length === 1 ? (field.accept[0] === "VIDEO" ? "videos" : "images") : "files"} {onlyFit ? "in this aspect ratio " : ""}yet. Upload one to continue.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              onDone(picked);
              onClose();
            }}
          >
            Use {picked.length || ""} {picked.length === 1 ? "file" : "files"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────── Repeater ─────────

export function RepeaterInput({ field, value, onChange, ctx, errors }: { field: RepeaterField; value: unknown; onChange: (v: unknown) => void; ctx: FieldContext; errors: string[] }) {
  const items = (Array.isArray(value) ? value : []) as Values[];
  const blank = () => Object.fromEntries(field.fields.map((f) => [f.key, f.type === "media" ? [] : ""]));
  const errorsFor = (i: number, f: Field) => errors.filter((e) => e.startsWith(`${field.itemLabel} ${i + 1}: ${f.label}`)).map((e) => e.replace(`${field.itemLabel} ${i + 1}: `, ""));
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase">{field.itemLabel} {i + 1}</span>
            {items.length > field.min && (
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${field.itemLabel.toLowerCase()} ${i + 1}`}>
                <X />
              </Button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field.fields.map((f) => (
              <div key={f.key} className={cn(f.type === "media" || f.type === "textarea" ? "sm:col-span-2" : "")}>
                <FieldRenderer field={f} value={item[f.key]} onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, [f.key]: v } : x)))} ctx={ctx} errors={errorsFor(i, f)} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {items.length < field.max && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, blank()])}>
          <Plus /> Add {field.itemLabel.toLowerCase()}
        </Button>
      )}
    </div>
  );
}

// ───────── Ad schedule ─────────

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

/** Hours grid; stored as contiguous [from, to) ranges per day. Empty means always on. */
export function AdScheduleInput({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const days = ((value as { days?: Record<string, [number, number][]> })?.days ?? {}) as Record<string, [number, number][]>;
  const active = Object.keys(days).length > 0;
  const on = (d: string, h: number) => !active || (days[d] ?? []).some(([a, b]) => h >= a && h < b);
  const toRanges = (hours: boolean[]) => {
    const out: [number, number][] = [];
    let start: number | null = null;
    hours.forEach((x, h) => {
      if (x && start === null) start = h;
      if (!x && start !== null) {
        out.push([start, h]);
        start = null;
      }
    });
    if (start !== null) out.push([start, 24]);
    return out;
  };
  const toggle = (d: string, h: number) => {
    const grid = Object.fromEntries(DAYS.map((day) => [day, Array.from({ length: 24 }, (_, hour) => on(day, hour))]));
    grid[d]![h] = !grid[d]![h];
    const next: Record<string, [number, number][]> = {};
    for (const day of DAYS) next[day] = toRanges(grid[day]!);
    const always = DAYS.every((day) => next[day]!.length === 1 && next[day]![0]![0] === 0 && next[day]![0]![1] === 24);
    onChange({ days: always ? {} : next });
  };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <div className="inline-grid grid-cols-[36px_repeat(24,14px)] gap-[2px] text-[9px]">
          <span />
          {Array.from({ length: 24 }, (_, h) => <span key={h} className="text-center text-muted-foreground">{h % 6 === 0 ? h : ""}</span>)}
          {DAYS.map((d) => (
            <div key={d} className="contents">
              <span className="pr-1 text-right text-[10px] text-muted-foreground">{d.slice(0, 2)}</span>
              {Array.from({ length: 24 }, (_, h) => (
                <button key={h} type="button" onClick={() => toggle(d, h)} aria-label={`${d} ${h}:00`} className={cn("h-4 rounded-[2px]", on(d, h) ? "bg-primary/80" : "bg-muted")} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {active ? "Ads run only in the highlighted hours." : "Ads run all day, every day. Click hours to switch them off."}
        {active && <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onChange({ days: {} })}>Reset</Button>}
      </div>
    </div>
  );
}
