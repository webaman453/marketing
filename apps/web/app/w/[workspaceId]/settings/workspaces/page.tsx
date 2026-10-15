"use client";

import type { ArchivedWorkspaceDTO, WorkspaceDTO, WorkspaceInput } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Check, Loader2, MoreHorizontal, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { WorkspaceForm } from "@/components/settings/workspace-form";
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
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, errorMessage } from "@/lib/api";
import { initials, longDate } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { useArchivedWorkspaces } from "@/lib/queries";

export default function WorkspacesPage() {
  return (
    <Suspense>
      <Workspaces />
    </Suspense>
  );
}

function Workspaces() {
  const { org, workspace: current, can } = useWorkspace();
  const queryClient = useQueryClient();
  const router = useRouter();
  const params = useSearchParams();
  const canManage = can("workspaces:manage");

  // ?new=1 (from the workspace switcher) opens the create dialog straight away.
  const [creating, setCreating] = useState(() => params.get("new") === "1" && canManage);
  const [editing, setEditing] = useState<WorkspaceDTO | null>(null);
  const [archiving, setArchiving] = useState<WorkspaceDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const archived = useArchivedWorkspaces(org.id, canManage);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function restore(w: ArchivedWorkspaceDTO) {
    setRestoring(w.id);
    try {
      await api(`/orgs/${org.id}/workspaces/${w.id}/restore`, { method: "POST" });
      await queryClient.invalidateQueries();
      toast.success(`“${w.name}” restored`, {
        description: "Reassign its ad accounts and turn its rules and report schedules back on when you're ready.",
        action: { label: "Open", onClick: () => router.push(`/w/${w.id}/overview`) },
      });
    } catch (err) {
      toastError(err);
    } finally {
      setRestoring(null);
    }
  }

  async function create(values: WorkspaceInput) {
    const ws = await api<WorkspaceDTO>(`/orgs/${org.id}/workspaces`, { method: "POST", body: values });
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    setCreating(false);
    toast.success(`Workspace “${ws.name}” created`, {
      action: { label: "Open", onClick: () => router.push(`/w/${ws.id}/overview`) },
    });
  }

  async function update(values: WorkspaceInput) {
    if (!editing) return;
    await api(`/orgs/${org.id}/workspaces/${editing.id}`, { method: "PATCH", body: values });
    await queryClient.invalidateQueries();
    setEditing(null);
    toast.success("Workspace updated");
  }

  async function archive() {
    if (!archiving) return;
    setBusy(true);
    try {
      await api(`/orgs/${org.id}/workspaces/${archiving.id}`, { method: "DELETE" });
      toast.success(`“${archiving.name}” archived`);
      const next = org.workspaces.find((w) => w.id !== archiving.id);
      setArchiving(null);
      if (archiving.id === current.id && next) router.replace(`/w/${next.id}/settings/workspaces`);
      await queryClient.invalidateQueries();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>One workspace per brand or client. Each has its own ad accounts, dashboards and access list.</CardDescription>
          {canManage && (
            <CardAction>
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus /> New workspace
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <ul className="divide-y">
          {org.workspaces.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-6 py-3.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted text-xs font-semibold">
                {initials(w.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href={`/w/${w.id}/overview`} className="truncate font-medium hover:underline">
                    {w.name}
                  </Link>
                  {w.id === current.id && (
                    <span className="inline-flex items-center gap-1 text-xs text-primary">
                      <Check className="size-3" /> Current
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {w.adAccountCount} ad {w.adAccountCount === 1 ? "account" : "accounts"} · {w.currency} · created{" "}
                  {longDate(w.createdAt.slice(0, 10))}
                </div>
              </div>
              {canManage && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Workspace actions">
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setEditing(w)}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" disabled={org.workspaces.length <= 1} onSelect={() => setArchiving(w)}>
                      <Archive /> Archive
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>New workspace</DialogTitle>
              <DialogDescription>Create a separate space for a brand or client.</DialogDescription>
            </DialogHeader>
            <WorkspaceForm submitLabel="Create workspace" onSubmit={create} onCancel={() => setCreating(false)} />
          </DialogContent>
        </Dialog>

        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Edit workspace</DialogTitle>
              <DialogDescription>Update the name and reporting settings.</DialogDescription>
            </DialogHeader>
            {editing && (
              <WorkspaceForm
                defaultValues={{ name: editing.name, currency: editing.currency as "INR", timezone: editing.timezone }}
                submitLabel="Save changes"
                onSubmit={update}
                onCancel={() => setEditing(null)}
              />
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog open={!!archiving} onOpenChange={(o) => !o && setArchiving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive “{archiving?.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Its ad accounts become unassigned so you can move them to another workspace. Its automation rules are paused, scheduled
                reports stop and shared report links stop working. Campaign history is kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  void archive().catch((err) => toast.error(errorMessage(err)));
                }}
              >
                {busy && <Loader2 className="animate-spin" />}
                Archive
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Card>

      {canManage && archived.data && archived.data.length > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-5">
            <CardTitle>Archived workspaces</CardTitle>
            <CardDescription>
              Restored workspaces come back with their history. Rules stay paused and report schedules off until you turn them on.
            </CardDescription>
          </CardHeader>
          <ul className="divide-y">
            {archived.data.map((w) => (
              <li key={w.id} className="flex items-center gap-3 px-6 py-3.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-dashed text-xs font-semibold text-muted-foreground">
                  {initials(w.name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-muted-foreground">{w.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {w.currency} · archived {longDate(w.archivedAt.slice(0, 10))}
                  </div>
                </div>
                <Button variant="outline" size="sm" disabled={restoring !== null} onClick={() => void restore(w)}>
                  {restoring === w.id ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
