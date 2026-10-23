"use client";

import { BRAND, PAID_PLANS, PLANS, PRICING, type PaidPlanId } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
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
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { longDate, money } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk, qk2, useBilling } from "@/lib/queries";
import { useCatalog } from "@/lib/catalog";
import { loadRazorpay } from "@/lib/razorpay";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "Trial",
  ACTIVE: "Active",
  PAST_DUE: "Payment due",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

export default function BillingPage() {
  const { org, me } = useWorkspace();
  const billing = useBilling(org.id);
  useCatalog();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<PaidPlanId | "cancel" | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const isOwner = org.role === "OWNER";

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: qk.me }), queryClient.invalidateQueries({ queryKey: qk2.billing(org.id) })]);

  async function subscribe(plan: PaidPlanId) {
    setBusy(plan);
    try {
      const { subscriptionId, keyId } = await api<{ subscriptionId: string; keyId: string }>(`/orgs/${org.id}/billing/checkout`, {
        method: "POST",
        body: { plan },
      });
      if (!(await loadRazorpay()) || !window.Razorpay) throw new Error("Couldn't load the payment window. Check your connection and try again.");
      const rzp = new window.Razorpay({
        key: keyId,
        subscription_id: subscriptionId,
        name: BRAND.name,
        description: `${PLANS[plan].name} plan for ${org.name}`,
        prefill: { name: me.user.name, email: me.user.email },
        theme: { color: "#3b5bdb" },
        handler: async (resp: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          try {
            await api(`/orgs/${org.id}/billing/verify`, { method: "POST", body: resp });
            toast.success(`You're on the ${PLANS[plan].name} plan`, { description: "Thank you! Your receipt is on its way by email." });
            await refresh();
          } catch (err) {
            toastError(err);
          }
        },
        modal: { ondismiss: () => setBusy(null) },
      });
      rzp.open();
    } catch (err) {
      toastError(err);
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    try {
      await api(`/orgs/${org.id}/billing/cancel`, { method: "POST" });
      toast.success("Subscription cancelled", { description: "You keep access until the end of the current billing period." });
      setConfirmCancel(false);
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!billing.data) return <Skeleton className="h-96 rounded-xl" />;
  const b = billing.data;
  const trial = b.plan === "TRIAL";
  const daysLeft = trial && b.trialEndsAt ? Math.max(0, differenceInCalendarDays(parseISO(b.trialEndsAt), new Date())) : 0;
  // An extended trial can run longer than the standard length.
  const trialTotal = Math.max(1, PRICING.trialDays, daysLeft);
  const contact = `mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(`${BRAND.name} plan for ${org.name}`)}`;

  const meters = [
    { label: "Workspaces", used: b.usage.workspaces, limit: b.limits.workspaces },
    { label: "Connected ad accounts", used: b.usage.adAccounts, limit: b.limits.adAccounts },
    { label: "Team members (incl. invites)", used: b.usage.members, limit: b.limits.members },
  ];

  return (
    <div className="space-y-6">
      <Card className="gap-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {PLANS[b.plan].name}
            <Badge variant={b.subscriptionStatus === "ACTIVE" || b.subscriptionStatus === "TRIALING" ? "secondary" : "destructive"}>
              {trial && !b.trialEndsAt ? "No plan" : (STATUS_LABEL[b.subscriptionStatus] ?? b.subscriptionStatus)}
            </Badge>
          </CardTitle>
          <CardDescription>
            {trial
              ? b.trialEndsAt
                ? `Free trial ${daysLeft > 0 ? `ends ${longDate(b.trialEndsAt.slice(0, 10))}` : "has ended"} · all features included`
                : "No plan yet. Choose one below to start using this workspace."
              : b.currentPeriodEnd
                ? `${b.subscriptionStatus === "CANCELLED" ? "Access until" : "Renews on"} ${longDate(b.currentPeriodEnd.slice(0, 10))} · ${money(PLANS[b.plan].priceMonthly, "INR")}/month`
                : `${money(PLANS[b.plan].priceMonthly, "INR")}/month`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {trial && (
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{daysLeft} of {trialTotal} days left</span>
              </div>
              <Progress value={((trialTotal - daysLeft) / trialTotal) * 100} className="h-2" />
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            {meters.map((m) => {
              const pct = m.limit ? Math.min(100, (m.used / m.limit) * 100) : 0;
              return (
                <div key={m.label} className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{m.label}</div>
                  <div className="mt-1 text-sm font-semibold tabular">
                    {m.used} <span className="font-normal text-muted-foreground">/ {m.limit ?? "Unlimited"}</span>
                  </div>
                  {m.limit != null && <Progress value={pct} className={cn("mt-2 h-1.5", pct >= 90 && "[&>div]:bg-destructive")} />}
                </div>
              );
            })}
          </div>
          {isOwner && b.provider === "razorpay" && b.subscriptionStatus === "ACTIVE" && (
            <Button variant="ghost" size="sm" className="px-0 text-destructive hover:bg-transparent" onClick={() => setConfirmCancel(true)}>
              Cancel subscription
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        {PAID_PLANS.map((id) => {
          const p = PLANS[id];
          const current = b.plan === id && b.subscriptionStatus === "ACTIVE";
          const featured = Boolean(p.popular);
          return (
            <Card key={id} className={cn("gap-4 p-5", featured && "ring-2 ring-primary")}>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  {current ? <Badge variant="secondary">Current</Badge> : featured ? <Badge>Popular</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">{p.audience}</p>
              </div>
              <div>
                <span className="text-2xl font-semibold tracking-tight tabular">{money(p.priceMonthly, "INR")}</span>
                <span className="text-sm text-muted-foreground"> /month{PRICING.gstPercent > 0 ? ` + ${PRICING.gstPercent}% GST` : ""}</span>
              </div>
              <ul className="space-y-2">
                {p.highlights.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm"><Check className="mt-0.5 size-4 shrink-0 text-primary" />{f}</li>
                ))}
              </ul>
              <div className="mt-auto">
                {current ? (
                  <Button variant="outline" className="w-full" disabled>Your plan</Button>
                ) : b.checkoutEnabled && isOwner ? (
                  <Button variant={featured ? "default" : "outline"} className="w-full" disabled={!!busy} onClick={() => subscribe(id)}>
                    {busy === id && <Loader2 className="animate-spin" />}
                    {b.subscriptionStatus === "ACTIVE" ? "Switch plan" : `Choose ${p.name}`}
                  </Button>
                ) : (
                  <Button asChild variant={featured ? "default" : "outline"} className="w-full">
                    <a href={contact}>Talk to sales</a>
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {b.checkoutEnabled
          ? "Payments are processed securely by Razorpay. Cancel any time; you keep access until the end of the billing period."
          : "Online checkout isn't enabled on this server yet. Our team will set up your plan and invoice you directly."}
        {!isOwner && " Only the organization owner can change the plan."}
      </p>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll keep full access until {b.currentPeriodEnd ? longDate(b.currentPeriodEnd.slice(0, 10)) : "the end of this period"}. After that your data becomes read-only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep subscription</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={(e) => { e.preventDefault(); void cancel(); }}>
              {busy === "cancel" && <Loader2 className="animate-spin" />} Cancel subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
