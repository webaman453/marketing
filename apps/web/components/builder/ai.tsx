"use client";

import type { AiSuggestResponse, Platform } from "@ashniva/shared";
import { Loader2, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { tokenCount } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { cn } from "@/lib/utils";
import { useBuilderEnv, type BriefState } from "./builder-context";

export const briefPayload = (b: BriefState, url?: string) => ({
  product: b.product.trim(),
  ...(b.audience.trim() ? { audience: b.audience.trim() } : {}),
  ...(b.offer.trim() ? { offer: b.offer.trim() } : {}),
  ...(b.tone.trim() ? { tone: b.tone.trim() } : {}),
  ...(b.language.trim() ? { language: b.language.trim() } : {}),
  ...(url && /^https?:\/\//.test(url) ? { url } : {}),
});

/** Small notice shown instead of AI buttons when the balance has run out. */
export function AiTokensNotice({ className }: { className?: string }) {
  const { workspaceId } = useBuilderEnv();
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      AI tokens used up.{" "}
      <Link href={`/w/${workspaceId}/settings/ai`} className="font-medium text-primary hover:underline" target="_blank">
        Buy tokens
      </Link>
    </p>
  );
}

const TONES = ["Friendly", "Professional", "Bold", "Luxury", "Playful", "Urgent", "Informative"];

/** Collects what the ad is about; used by every AI action. */
export function BriefDialog({
  open,
  onOpenChange,
  onSubmit,
  title = "Tell AI about your ad",
  submitLabel = "Continue",
  busy,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (b: BriefState) => void;
  title?: string;
  submitLabel?: string;
  busy?: boolean;
}) {
  const { brief, setBrief, ai } = useBuilderEnv();
  const [draft, setDraft] = useState<BriefState>(brief);
  const set = (k: keyof BriefState) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setDraft(brief);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> {title}</DialogTitle>
          <DialogDescription>A few words is enough. AI writes in each platform&apos;s style and character limits.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="product" label="What are you advertising?">
            <Textarea id="product" rows={3} value={draft.product} onChange={set("product")} placeholder="Handmade festive kurtas for women, sizes XS–3XL, shipped across India in 3 days" autoFocus />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="audience" label="Who is it for? (optional)">
              <Input id="audience" value={draft.audience} onChange={set("audience")} placeholder="Women 25–45 in metro cities" />
            </FormField>
            <FormField id="offer" label="Offer or key message (optional)">
              <Input id="offer" value={draft.offer} onChange={set("offer")} placeholder="Up to 40% off, free delivery" />
            </FormField>
            <FormField id="tone" label="Tone">
              <Select value={draft.tone || "Friendly"} onValueChange={(v) => setDraft((d) => ({ ...d, tone: v }))}>
                <SelectTrigger id="tone" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{TONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField id="language" label="Language">
              <Input id="language" value={draft.language} onChange={set("language")} placeholder="English, Hindi, Hinglish…" />
            </FormField>
          </div>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">{ai ? `${tokenCount(Math.max(0, ai.balance))} AI tokens left` : ""}</span>
          <Button
            disabled={draft.product.trim().length < 3 || busy}
            onClick={() => {
              setBrief(draft);
              onSubmit(draft);
            }}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sparkle button next to a text field: shows AI alternatives to insert. */
export function AiSuggestButton({
  label,
  purpose,
  maxLength,
  current,
  count = 5,
  onPick,
}: {
  label: string;
  purpose: string;
  maxLength: number;
  current: string[];
  count?: number;
  onPick: (text: string) => void;
}) {
  const env = useBuilderEnv();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  if (!env.ai?.available) return null;

  async function load() {
    setLoading(true);
    try {
      const res = await api<AiSuggestResponse>(`/workspaces/${env.workspaceId}/ai/builder/suggest`, {
        method: "POST",
        body: {
          platform: env.platform satisfies Platform,
          label,
          purpose,
          maxLength,
          count,
          current: current.filter(Boolean).slice(0, 20),
          context: env.adContext.slice(0, 3500),
          ...(env.brief.product ? { brief: briefPayload(env.brief) } : {}),
        },
      });
      setItems(res.suggestions);
    } catch (err) {
      toastError(err);
      setOpen(false);
    } finally {
      setLoading(false);
      env.onAiUsed();
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && items.length === 0) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-primary hover:text-primary">
          <Sparkles className="size-3" /> Suggest
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        {!env.ai.canUse ? (
          <AiTokensNotice className="p-2" />
        ) : loading && items.length === 0 ? (
          <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Writing options…</div>
        ) : (
          <div className="space-y-1">
            {items.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onPick(s);
                  setItems((list) => list.filter((x) => x !== s));
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                <Plus className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 break-words">{s}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground tabular">{s.length}/{maxLength}</span>
              </button>
            ))}
            {items.length === 0 && <p className="p-2 text-sm text-muted-foreground">No more suggestions.</p>}
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <Sparkles />} More options
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
