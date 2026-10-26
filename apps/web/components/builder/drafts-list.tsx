"use client";

import { PLATFORM_INFO, isPlatform, isPlatformShown, type DraftDTO, type Platform } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { FileClock, Trash2 } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useDrafts } from "@/lib/queries";

const STATUS: Record<DraftDTO["status"], { label: string; variant: "secondary" | "destructive" | "outline" }> = {
  DRAFT: { label: "Draft", variant: "secondary" },
  LAUNCHING: { label: "Launching", variant: "outline" },
  LAUNCHED: { label: "Launched", variant: "outline" },
  PARTIAL: { label: "Partly launched", variant: "destructive" },
  FAILED: { label: "Launch failed", variant: "destructive" },
};

/** Unfinished campaigns from the builder, shown above the campaigns table. */
export function DraftsList({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const drafts = useDrafts(workspaceId);
  const queryClient = useQueryClient();
  const open = (drafts.data ?? []).filter((d) => d.status !== "LAUNCHED" && (!isPlatform(d.payload.platform) || isPlatformShown(d.payload.platform)));
  if (open.length === 0) return null;

  async function remove(d: DraftDTO) {
    try {
      await api(`/workspaces/${workspaceId}/drafts/${d.id}`, { method: "DELETE" });
      toast.success("Draft deleted");
      await queryClient.invalidateQueries({ queryKey: qk2.drafts(workspaceId) });
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <Card className="gap-0 py-0 animate-fade-up">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <FileClock className="size-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Drafts</span>
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{open.length}</Badge>
      </div>
      <ul className="divide-y">
        {open.slice(0, 5).map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
            {typeof d.payload.platform === "string" && <PlatformIcon platform={d.payload.platform as Platform} size="sm" />}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{d.name}</span>
                <Badge variant={STATUS[d.status].variant} className="h-5 text-[10px]">{STATUS[d.status].label}</Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {d.status === "FAILED" && d.results?.[0]?.error && <span className="text-destructive">{d.results[0].error.slice(0, 80)} · </span>}
                {typeof d.payload.platform === "string" && `${PLATFORM_INFO[d.payload.platform as Platform]?.name ?? ""} · `}
                Edited {timeAgo(d.updatedAt)}
                {d.createdBy && <> · {d.createdBy}</>}
              </div>
            </div>
            {canEdit && (
              <>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/w/${workspaceId}/campaigns/new?draft=${d.id}`}>Continue</Link>
                </Button>
                <Button size="icon-sm" variant="ghost" className="text-muted-foreground" onClick={() => remove(d)} aria-label="Delete draft">
                  <Trash2 />
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
