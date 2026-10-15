"use client";

import { AI_FEATURES, AI_TOKEN_PACKS, BRAND, PRICING, withGst, type AiLedgerEntryDTO, type AiTokenPack } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Gift, Loader2, Settings2, Sparkles, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { useCatalog } from "@/lib/catalog";
import { money, timeAgo, tokenCount } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useAiWallet } from "@/lib/queries";
import { loadRazorpay } from "@/lib/razorpay";
import { cn } from "@/lib/utils";

const FILL_COST = AI_FEATURES["builder.fill"]!.typicalTokens;

const LEDGER_ICON: Record<AiLedgerEntryDTO["type"], { icon: typeof Gift; cls: string; label: string }> = {
  FREE_GRANT: { icon: Gift, cls: "bg-success/10 text-success", label: "Free tokens" },
  PURCHASE: { icon: ArrowDownLeft, cls: "bg-primary/10 text-primary", label: "Token pack" },
  USAGE: { icon: ArrowUpRight, cls: "bg-muted text-muted-foreground", label: "AI usage" },
  ADJUSTMENT: { icon: Settings2, cls: "bg-warning/15 text-warning", label: "Adjustment" },
};

export default function AiTokensPage() {
  const { org, me, workspace, can } = useWorkspace();
  const wallet = useAiWallet(org.id);
  useCatalog();
  const queryClient = useQueryClient();
  const [buying, setBuying] = useState<string | null>(null);
  const canBuy = can("billing:manage");
  const w = wallet.data;

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk2.aiWallet(org.id) }),
      queryClient.invalidateQueries({ queryKey: qk2.aiStatus(workspace.id) }),
    ]);

  async function buy(pack: AiTokenPack) {
    setBuying(pack.id);
    try {
      const order = await api<{ razorpayOrderId: string; amount: number; currency: string; keyId: string }>(`/orgs/${org.id}/ai/packs/checkout`, {
        method: "POST",
        body: { packId: pack.id },
      });
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("Couldn't load the payment window. Check your connection and try again.");
      new window.Razorpay({
        key: order.keyId,
        order_id: order.razorpayOrderId,
        amount: order.amount,
        currency: order.currency,
        name: BRAND.name,
        description: `${tokenCount(pack.tokens)} AI tokens for ${org.name}`,
        prefill: { name: me.user.name, email: me.user.email },
        theme: { color: "#3b5bdb" },
        handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try {
            await api(`/orgs/${org.id}/ai/packs/verify`, { method: "POST", body: resp });
            toast.success(`${tokenCount(pack.tokens)} AI tokens added`, { description: "Thank you! Razorpay emails you the payment receipt." });
            await refresh();
          } catch (err) {
            toastError(err);
          } finally {
            setBuying(null);
          }
        },
        modal: { ondismiss: () => setBuying(null) },
      }).open();
    } catch (err) {
      toastError(err);
      setBuying(null);
    }
  }

  if (wallet.isError) return <Card><ErrorState message={wallet.error.message} onRetry={() => wallet.refetch()} /></Card>;
  if (!w) return <Skeleton className="h-[480px] rounded-xl" />;
  const balance = Math.max(0, w.balance);
  const low = w.available && !w.canUse;

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden py-0">
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <div className="bg-card p-6">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><Wallet className="size-4" /> AI tokens left</div>
            <div className={cn("mt-2 text-3xl font-semibold tracking-tight tabular", low && "text-destructive")}>{tokenCount(balance)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {low ? "Buy a pack to keep using AI" : `About ${Math.floor(balance / FILL_COST).toLocaleString("en-IN")} ad fills`}
            </div>
          </div>
          <div className="bg-card p-6">
            <div className="text-sm font-medium text-muted-foreground">Used this month</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight tabular">{tokenCount(w.usedThisMonth)}</div>
            <div className="mt-1 text-xs text-muted-foreground">Across every workspace in {org.name}</div>
          </div>
          <div className="bg-card p-6">
            <div className="text-sm font-medium text-muted-foreground">Purchased</div>
            <div className="mt-2 text-3xl font-semibold tracking-tight tabular">{tokenCount(w.purchasedTotal)}</div>
            <div className="mt-1 text-xs text-muted-foreground">All time</div>
          </div>
        </div>
        {!w.available && (
          <div className="border-t bg-warning/10 px-6 py-3 text-sm">
            AI isn&apos;t switched on for this deployment yet. Your tokens are safe and will work as soon as it is.
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Buy AI tokens</CardTitle>
          <CardDescription>
            One-time packs; tokens never expire and are shared by every workspace. Each AI action uses the tokens the model actually
            processes.
          </CardDescription>
        </CardHeader>
        <CardContent className={cn("grid gap-4", AI_TOKEN_PACKS.length === 2 ? "md:grid-cols-2" : AI_TOKEN_PACKS.length >= 4 ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3")}>
          {AI_TOKEN_PACKS.map((p) => (
            <div key={p.id} className={cn("relative flex flex-col rounded-xl border p-5", p.popular && "border-primary ring-1 ring-primary")}>
              {p.popular && <Badge className="absolute -top-2.5 left-5">Most popular</Badge>}
              <div className="text-sm font-medium text-muted-foreground">{p.name}</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight">{tokenCount(p.tokens)} tokens</div>
              <div className="mt-0.5 text-sm">
                {money(p.price, "INR", { decimals: 0 })}{" "}
                <span className="text-muted-foreground">
                  one-time{PRICING.gstPercent > 0 && ` + GST (${money(withGst(p.price), "INR", { decimals: 0 })} total)`}
                </span>
              </div>
              <ul className="mt-4 flex-1 space-y-1 text-xs text-muted-foreground">
                <li>≈ {Math.floor(p.tokens / FILL_COST).toLocaleString("en-IN")} ad fills</li>
                <li>≈ {Math.floor(p.tokens / AI_FEATURES["insights.overview"]!.typicalTokens).toLocaleString("en-IN")} performance analyses</li>
                <li>{money((p.price / p.tokens) * 100_000, "INR")} per 1 lakh tokens</li>
              </ul>
              {w.checkoutEnabled && canBuy ? (
                <Button className="mt-4" variant={p.popular ? "default" : "outline"} onClick={() => buy(p)} disabled={!!buying}>
                  {buying === p.id && <Loader2 className="animate-spin" />} Buy pack
                </Button>
              ) : canBuy ? (
                <Button asChild className="mt-4" variant="outline">
                  <a href={`mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(`AI tokens: ${p.name} pack for ${org.name}`)}`}>Talk to sales</a>
                </Button>
              ) : (
                <Button className="mt-4" variant="outline" disabled>
                  Only owners can buy
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /> What uses tokens</CardTitle>
          <CardDescription>Typical usage per action. Longer briefs and bigger campaigns use a little more.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-xl border">
            {Object.entries(AI_FEATURES).map(([key, f]) => (
              <li key={key} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.detail}</div>
                </div>
                <span className="shrink-0 text-sm text-muted-foreground tabular">~{tokenCount(f.typicalTokens)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Token history</CardTitle>
          <CardDescription>The last 100 changes to your balance.</CardDescription>
        </CardHeader>
        {w.ledger.length === 0 ? (
          <EmptyState icon={Wallet} title="No activity yet" description="Grants, purchases and AI usage will show up here." />
        ) : (
          <ul className="divide-y">
            {w.ledger.map((l) => {
              const t = LEDGER_ICON[l.type];
              return (
                <li key={l.id} className="flex items-center gap-3 px-6 py-3">
                  <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", t.cls)}><t.icon className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.feature ? (AI_FEATURES[l.feature]?.label ?? l.feature) : (l.note ?? t.label)}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.label}{l.user && ` · ${l.user}`} · {timeAgo(l.createdAt)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn("text-sm font-medium tabular", l.tokens > 0 ? "text-success" : "text-foreground")}>
                      {l.tokens > 0 ? "+" : l.tokens < 0 ? "−" : ""}{tokenCount(Math.abs(l.tokens))}
                    </div>
                    <div className="text-[11px] text-muted-foreground tabular">{tokenCount(Math.max(0, l.balanceAfter))} left</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
