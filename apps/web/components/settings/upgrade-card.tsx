"use client";

import { FEATURE_LABELS, PLANS, minimumPlanFor, type Feature } from "@ashniva/shared";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useCatalog } from "@/lib/catalog";

/** Shown in place of a feature the organization's plan doesn't include. */
export function UpgradeCard({ feature, workspaceId, description }: { feature: Feature; workspaceId: string; description: string }) {
  useCatalog();
  const plan = PLANS[minimumPlanFor(feature)];
  return (
    <Card className="items-center gap-3 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Sparkles className="size-5" />
      </span>
      <h3 className="font-semibold">{FEATURE_LABELS[feature]} is on the {plan.name} plan</h3>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      <Button asChild className="mt-2">
        <Link href={`/w/${workspaceId}/settings/billing`}>View plans</Link>
      </Button>
    </Card>
  );
}
