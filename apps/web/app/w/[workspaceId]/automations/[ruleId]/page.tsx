"use client";

import { useParams } from "next/navigation";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { RuleEditor } from "@/components/automations/rule-editor";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRule } from "@/lib/queries";

export default function RulePage() {
  const { ruleId } = useParams<{ ruleId: string }>();
  const { workspace } = useWorkspace();
  const rule = useRule(workspace.id, ruleId);
  if (rule.isError) return <Card><ErrorState message={rule.error.message} onRetry={() => rule.refetch()} /></Card>;
  if (!rule.data) return <Skeleton className="h-[600px] rounded-xl" />;
  return <RuleEditor key={rule.data.id} rule={rule.data} />;
}
