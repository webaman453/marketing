"use client";

import {
  defaultValue,
  isRequired,
  isVisible,
  resolveOptions,
  type Field,
  type FieldContext,
  type Option,
  type PinnedText,
  type TextField,
  type TextListField,
} from "@ashniva/shared";
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  Film,
  Filter,
  GalleryHorizontal,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  Layers,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  MonitorPlay,
  MousePointerClick,
  Plus,
  RotateCw,
  Search,
  Settings2,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Type,
  X,
} from "lucide-react";
import { createContext, useContext, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AiSuggestButton } from "./ai";
import { useBuilderEnv } from "./builder-context";
import { AdScheduleInput, KeywordsInput, MediaInput, PlacementsInput, RepeaterInput, TargetingInput } from "./fields-advanced";

export interface FieldProps<F extends Field = Field> {
  field: F;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: FieldContext;
  errors: string[];
}

function Counter({ length, max, recommended }: { length: number; max?: number; recommended?: number }) {
  if (!max) return null;
  const over = length > max;
  const long = !over && recommended != null && length > recommended;
  return (
    <span className={cn("text-[11px] tabular", over ? "font-medium text-destructive" : long ? "text-warning" : "text-muted-foreground")} title={long ? `Over ${recommended} characters may be cut off in some placements` : undefined}>
      {length}/{max}
    </span>
  );
}

/** Set when a field's label just repeats its section title; the label is then kept for screen readers only. */
export const SectionTitleContext = createContext<string | null>(null);

function Shell({ field, errors, required, action, note, children, id }: { field: Field; errors: string[]; required?: boolean; action?: React.ReactNode; /** Always shown under the input, even alongside errors. */ note?: React.ReactNode; children: React.ReactNode; id: string }) {
  const repeatsTitle = useContext(SectionTitleContext) === field.label && !action;
  return (
    <div className="grid gap-1.5">
      <div className={cn("flex min-h-6 items-center justify-between gap-2", repeatsTitle && "sr-only")}>
        <Label htmlFor={id} className="text-[13px]">
          {field.label}
          {required && <span className="text-destructive">*</span>}
        </Label>
        {action}
      </div>
      {children}
      {note}
      {errors.length > 0 ? (
        <div className="space-y-0.5">
          {errors.map((e) => (
            <p key={e} className="flex items-start gap-1 text-xs font-medium text-destructive">
              <CircleAlert className="mt-px size-3 shrink-0" /> {e}
            </p>
          ))}
        </div>
      ) : field.help ? (
        <p className="text-xs text-muted-foreground">{field.help}</p>
      ) : null}
    </div>
  );
}

const OPTION_ICONS: Record<string, typeof Info> = {
  Film,
  Filter,
  GalleryHorizontal,
  Image: ImageIcon,
  LayoutGrid,
  Layers,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  MonitorPlay,
  MousePointerClick,
  Search,
  Settings2,
  ShoppingBag,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Type,
};

export function OptionIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = name ? OPTION_ICONS[name] : undefined;
  return Icon ? <Icon className={className} /> : null;
}

export function FieldRenderer(props: FieldProps) {
  const { field, ctx } = props;
  if (!isVisible(field, ctx)) return null;
  const required = isRequired(field, ctx);
  const id = `f-${field.key}`;
  const value = props.value === undefined ? defaultValue(field, ctx) : props.value;
  const p = { ...props, value };

  switch (field.type) {
    case "info":
      return (
        <div className={cn("flex gap-2.5 rounded-lg border p-3 text-sm", field.tone === "warning" ? "border-warning/40 bg-warning/10" : "bg-muted/40")}>
          <Info className={cn("mt-0.5 size-4 shrink-0", field.tone === "warning" ? "text-warning" : "text-primary")} />
          <div>
            <div className="font-medium">{field.label}</div>
            {field.help && <div className="text-xs text-muted-foreground">{field.help}</div>}
          </div>
        </div>
      );
    case "text":
    case "url":
    case "textarea":
      return <TextInput {...(p as FieldProps<TextField>)} id={id} required={required} />;
    case "textList":
      return <TextListInput {...(p as FieldProps<TextListField>)} id={id} required={required} />;
    case "number":
    case "money":
    case "percent":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <NumberInput id={id} field={field} value={value} onChange={p.onChange} />
        </Shell>
      );
    case "select":
    case "radio":
    case "cards":
    case "segmented":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <ChoiceInput id={id} type={field.type} options={resolveOptions(field, ctx)} value={String(value ?? "")} onChange={p.onChange} placeholder={field.placeholder} />
        </Shell>
      );
    case "multiSelect":
    case "chips":
    case "checkboxes":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <MultiInput id={id} type={field.type} options={resolveOptions(field, ctx)} value={(value as string[]) ?? []} onChange={p.onChange} max={field.max} placeholder={field.placeholder} />
        </Shell>
      );
    case "toggle":
      return (
        <label htmlFor={id} className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-3.5">
          <span>
            <span className="block text-sm font-medium">{field.label}</span>
            {(field.description || field.help) && <span className="mt-0.5 block text-xs text-muted-foreground">{field.description ?? field.help}</span>}
          </span>
          <Switch id={id} checked={value === true} onCheckedChange={(on) => p.onChange(on)} />
        </label>
      );
    case "date":
    case "datetime":
      return <DateInput {...(p as FieldProps<Extract<Field, { type: "date" | "datetime" }>>)} id={id} required={required} />;
    case "accountOption":
      return <AccountOptionInput {...(p as FieldProps<Extract<Field, { type: "accountOption" }>>)} id={id} required={required} />;
    case "ageRange": {
      const v = (value as { min: number; max: number }) ?? { min: field.min, max: field.max };
      const ages = Array.from({ length: field.max - field.min + 1 }, (_, i) => field.min + i);
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <div className="flex items-center gap-2">
            {(["min", "max"] as const).map((k, i) => (
              <div key={k} className="flex items-center gap-2">
                {i === 1 && <span className="text-sm text-muted-foreground">to</span>}
                <Select value={String(v[k])} onValueChange={(x) => p.onChange({ ...v, [k]: Number(x) })}>
                  <SelectTrigger className="w-24" id={i === 0 ? id : undefined}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ages.map((n) => <SelectItem key={n} value={String(n)}>{n === field.max && field.openEnded ? `${n}+` : n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </Shell>
      );
    }
    case "targeting":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <TargetingInput field={field} value={value} onChange={p.onChange} ctx={ctx} />
        </Shell>
      );
    case "keywords":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <KeywordsInput field={field} value={value} onChange={p.onChange} />
        </Shell>
      );
    case "placements":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <PlacementsInput field={field} value={value} onChange={p.onChange} />
        </Shell>
      );
    case "media":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <MediaInput field={field} value={value} onChange={p.onChange} />
        </Shell>
      );
    case "repeater":
      return (
        <Shell field={field} errors={p.errors} required={required} id={id}>
          <RepeaterInput field={field} value={value} onChange={p.onChange} ctx={ctx} errors={p.errors} />
        </Shell>
      );
    case "adSchedule":
      return (
        <Shell field={field} errors={p.errors} id={id}>
          <AdScheduleInput value={value} onChange={p.onChange} />
        </Shell>
      );
  }
}

// ───────── Text ─────────

function TextInput({ field, value, onChange, errors, id, required }: FieldProps<TextField> & { id: string; required: boolean }) {
  const text = String(value ?? "");
  const action = (
    <div className="flex items-center gap-1">
      {field.ai && field.maxLength && <AiSuggestButton label={field.label} purpose={field.ai.purpose} maxLength={field.maxLength} current={text ? [text] : []} count={4} onPick={(s) => onChange(s)} />}
      <Counter length={text.length} max={field.maxLength} recommended={field.recommendedLength} />
    </div>
  );
  return (
    <Shell field={field} errors={errors} required={required} action={action} id={id}>
      {field.type === "textarea" ? (
        <Textarea id={id} rows={field.rows ?? 3} value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={errors.length > 0} />
      ) : (
        <Input
          id={id}
          type={field.type === "url" ? "url" : "text"}
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          // Forgetting https:// is the most common URL mistake; add it for people.
          onBlur={() => field.type === "url" && text.trim() && !/^[a-z][a-z0-9+.-]*:/i.test(text.trim()) && onChange(`https://${text.trim()}`)}
          aria-invalid={errors.length > 0}
          className="h-9"
        />
      )}
    </Shell>
  );
}

function TextListInput({ field, value, onChange, errors, id, required }: FieldProps<TextListField> & { id: string; required: boolean }) {
  const pinnable = Boolean(field.pinnable);
  const list: PinnedText[] = (Array.isArray(value) ? value : []).map((v) => (typeof v === "string" ? { text: v, pin: null } : { text: String((v as PinnedText).text ?? ""), pin: (v as PinnedText).pin ?? null }));
  const emit = (next: PinnedText[]) => onChange(pinnable ? next : next.map((x) => x.text));
  const filled = list.filter((x) => x.text.trim()).length;
  const add = (text = "") => {
    const empty = list.findIndex((x) => !x.text.trim());
    if (text && empty >= 0) emit(list.map((x, i) => (i === empty ? { ...x, text } : x)));
    else if (list.length < field.max) emit([...list, { text, pin: null }]);
  };
  const action = (
    <div className="flex items-center gap-2">
      {field.ai && list.length < field.max + 1 && (
        <AiSuggestButton label={field.itemLabel} purpose={field.ai.purpose} maxLength={field.maxLength} current={list.map((x) => x.text)} count={Math.min(6, Math.max(2, field.max - filled))} onPick={(s) => add(s)} />
      )}
      <span className="text-[11px] text-muted-foreground tabular">{filled}/{field.max}</span>
    </div>
  );
  return (
    <Shell field={field} errors={errors} required={required} action={action} id={id}>
      <div className="space-y-2">
        {list.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="relative flex-1">
              {field.multiline ? (
                <Textarea id={i === 0 ? id : undefined} rows={2} value={item.text} onChange={(e) => emit(list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder={`${field.itemLabel} ${i + 1}`} className="pb-6" />
              ) : (
                <Input id={i === 0 ? id : undefined} value={item.text} onChange={(e) => emit(list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder={`${field.itemLabel} ${i + 1}`} className="h-9 pr-16" />
              )}
              <span className={cn("absolute right-3", field.multiline ? "bottom-1.5" : "top-2.5")}><Counter length={item.text.length} max={field.maxLength} recommended={field.recommendedLength} /></span>
            </div>
            {pinnable && (
              <Select value={item.pin ?? "none"} onValueChange={(v) => emit(list.map((x, j) => (j === i ? { ...x, pin: v === "none" ? null : v } : x)))}>
                <SelectTrigger className="h-9 w-[72px] shrink-0 px-2 text-xs" aria-label="Pin position" title="Pin to a position"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Any</SelectItem>
                  {field.pinnable!.positions.map((pos) => <SelectItem key={pos} value={pos}>Pin {pos}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {list.length > Math.max(1, field.min === 0 ? 0 : 1) || (field.min === 0 && list.length > 0) ? (
              <Button type="button" variant="ghost" size="icon-sm" className="mt-1" onClick={() => emit(list.filter((_, j) => j !== i))} aria-label={`Remove ${field.itemLabel.toLowerCase()}`}>
                <X />
              </Button>
            ) : (
              <span className="w-8" />
            )}
          </div>
        ))}
        {list.length < field.max && (
          <Button type="button" variant="ghost" size="sm" onClick={() => add()}>
            <Plus /> Add {field.itemLabel.toLowerCase()}
          </Button>
        )}
      </div>
    </Shell>
  );
}

// ───────── Numbers & choices ─────────

function NumberInput({ id, field, value, onChange }: { id: string; field: Extract<Field, { type: "number" | "money" | "percent" }>; value: unknown; onChange: (v: unknown) => void }) {
  const { currency } = useBuilderEnv();
  const prefix = field.type === "money" ? new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).formatToParts(0).find((x) => x.type === "currency")?.value : null;
  const suffix = field.type === "percent" ? "%" : field.suffix;
  return (
    <div className={cn("relative", field.width === "full" ? "w-full" : "w-full sm:w-56")}>
      {prefix && <span className="absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>}
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.min}
        max={field.max}
        step={field.step ?? (field.type === "money" ? 1 : "any")}
        value={value == null ? "" : String(value)}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className={cn("h-9 tabular", prefix && "pl-8", suffix && "pr-8")}
      />
      {suffix && <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-muted-foreground">{suffix}</span>}
    </div>
  );
}

export function ChoiceInput({ id, type, options, value, onChange, placeholder }: { id: string; type: "select" | "radio" | "cards" | "segmented"; options: (Option & { disabled?: boolean; disabledReason?: string })[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  if (type === "select") {
    return (
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-full sm:max-w-sm"><SelectValue placeholder={placeholder ?? "Choose…"} /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (type === "segmented") {
    return (
      <div className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1" role="radiogroup" id={id}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            title={o.description}
            onClick={() => onChange(o.value)}
            className={cn("rounded-md px-3 py-1.5 text-sm transition-colors", value === o.value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  if (type === "cards") {
    return (
      <div className="@container" id={id}>
      <div className="grid gap-2.5 @md:grid-cols-2 @3xl:grid-cols-3" role="radiogroup">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={o.label}
              disabled={o.disabled}
              title={o.disabledReason}
              onClick={() => onChange(o.value)}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50",
                active ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "hover:border-foreground/20 hover:bg-muted/40",
              )}
            >
              {o.icon && (
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                  <OptionIcon name={o.icon} className="size-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {o.label}
                  {o.badge && <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">{o.badge}</Badge>}
                </span>
                {(o.disabledReason ?? o.description) && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{o.disabled ? o.disabledReason : o.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
      </div>
    );
  }
  return (
    <RadioGroup id={id} value={value} onValueChange={onChange} className="gap-2">
      {options.map((o) => (
        <label key={o.value} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors", value === o.value ? "border-primary bg-primary/[0.04]" : "hover:bg-muted/40")}>
          <RadioGroupItem value={o.value} className="mt-0.5" disabled={o.disabled} />
          <span>
            <span className="block text-sm font-medium">{o.label}</span>
            {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

function MultiInput({ id, type, options, value, onChange, max, placeholder }: { id: string; type: "multiSelect" | "chips" | "checkboxes"; options: Option[]; value: string[]; onChange: (v: string[]) => void; max?: number; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : max && value.length >= max ? value : [...value, v]);
  if (type === "checkboxes") {
    return (
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2" id={id}>
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox checked={value.includes(o.value)} onCheckedChange={() => toggle(o.value)} className="mt-0.5" />
            <span>
              {o.label}
              {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
            </span>
          </label>
        ))}
      </div>
    );
  }
  if (type === "chips") {
    return (
      <div className="flex flex-wrap gap-1.5" id={id}>
        {options.map((o) => {
          const on = value.includes(o.value);
          return (
            <button key={o.value} type="button" onClick={() => toggle(o.value)} className={cn("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-sm", on ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>
              {on && <Check className="size-3.5" />} {o.label}
            </button>
          );
        })}
      </div>
    );
  }
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" className="h-9 w-full justify-between font-normal sm:max-w-sm">
            <span className="truncate text-muted-foreground">{value.length ? `${value.length} selected` : (placeholder ?? "Choose…")}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search…" />
            <CommandList>
              <CommandEmpty>No matches.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem key={o.value} value={o.label} onSelect={() => toggle(o.value)}>
                    <Checkbox checked={value.includes(o.value)} className="pointer-events-none" /> {o.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs">
              {labelOf(v)}
              <button type="button" onClick={() => toggle(v)} aria-label={`Remove ${labelOf(v)}`}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────── Account assets ─────────

function AccountOptionInput({ field, value, onChange, errors, id, required }: FieldProps<Extract<Field, { type: "accountOption" }>> & { id: string; required: boolean }) {
  const env = useBuilderEnv();
  const options = env.options[field.source] ?? [];
  const failed = !env.optionsLoading && !!env.optionsError;
  const empty = !env.optionsLoading && !failed && options.length === 0;
  const placeholder = env.optionsLoading ? "Loading…" : failed ? "Couldn't load from the ad account" : options.length ? "Choose…" : "None found in this ad account";
  const note = failed ? (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive sm:max-w-sm">
      <span className="flex items-start gap-1.5">
        <CircleAlert className="mt-px size-3.5 shrink-0" />
        <span>Couldn&apos;t load {field.label.toLowerCase()} from the ad account. {env.optionsError}</span>
      </span>
      {env.retryOptions && (
        <Button type="button" size="sm" variant="outline" className="h-7 bg-card text-foreground" onClick={env.retryOptions}>
          <RotateCw /> Retry
        </Button>
      )}
    </div>
  ) : empty ? (
    <p className="text-xs text-muted-foreground">This ad account has none yet. Create one in the platform&apos;s ads manager, then come back.</p>
  ) : null;
  if (field.multiple) {
    return (
      <Shell field={field} errors={errors} required={required} id={id} note={note}>
        <MultiInput id={id} type="multiSelect" options={options.map((o) => ({ value: o.id, label: o.name, description: o.detail }))} value={(value as string[]) ?? []} onChange={onChange} placeholder={placeholder} />
      </Shell>
    );
  }
  return (
    <Shell field={field} errors={errors} required={required} id={id} note={note}>
      <Select value={String(value ?? "") || undefined} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-9 w-full sm:max-w-sm">
          <SelectValue placeholder={placeholder}>
            {options.find((o) => o.id === value)?.name}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              <span className="flex flex-col">
                <span>{o.name}</span>
                {o.detail && <span className="text-[11px] text-muted-foreground">{o.detail}</span>}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Shell>
  );
}

// ───────── Dates ─────────

/** A date or date-time, labelled with the zone it's entered in (the platform schedules in the ad account's zone). */
function DateInput({ field, value, onChange, errors, id, required }: FieldProps<Extract<Field, { type: "date" | "datetime" }>> & { id: string; required: boolean }) {
  const { timeZone } = useBuilderEnv();
  const noteId = `${id}-tz`;
  const note = timeZone && (
    <p id={noteId} className="text-xs text-muted-foreground">
      {field.type === "date" ? "Dates" : "Times"} are in {timeZone.zone} ({timeZone.source === "account" ? "ad account" : "workspace"} time zone)
    </p>
  );
  return (
    <Shell field={field} errors={errors} required={required} id={id} note={note}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={field.type === "date" ? "date" : "datetime-local"}
          aria-describedby={timeZone ? noteId : undefined}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || null)}
          className="h-9"
        />
        {Boolean(value) && !required && (
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(null)} aria-label="Clear date"><X /></Button>
        )}
      </div>
    </Shell>
  );
}
