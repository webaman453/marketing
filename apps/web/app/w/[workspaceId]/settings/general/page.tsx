"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { updateOrgSchema, type UpdateOrgInput } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, LogOut, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { SettingsCard } from "@/components/settings/settings-card";
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
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors, toastError } from "@/lib/forms";
import { qk } from "@/lib/queries";

export default function GeneralSettingsPage() {
  const { org, workspace, can } = useWorkspace();
  const queryClient = useQueryClient();
  const canEditOrg = can("org:update");
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const nameMatches = confirmName.trim() === org.name.trim();

  async function deleteOrg() {
    setBusy(true);
    try {
      await api(`/orgs/${org.id}`, { method: "DELETE", body: { confirmName } });
      queryClient.clear();
      toast.success(`${org.name} was deleted`);
      router.replace("/app");
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      await api(`/orgs/${org.id}/leave`, { method: "POST" });
      queryClient.clear();
      toast.success(`You left ${org.name}`);
      router.replace("/app");
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  }

  const form = useForm<UpdateOrgInput>({ resolver: zodResolver(updateOrgSchema), values: { name: org.name } });
  const { errors, isSubmitting, isDirty } = form.formState;

  const saveOrg = form.handleSubmit(async (values) => {
    try {
      await api(`/orgs/${org.id}`, { method: "PATCH", body: values });
      await queryClient.invalidateQueries({ queryKey: qk.me });
      toast.success("Organization updated");
    } catch (err) {
      applyServerErrors(err, form.setError, ["name"]);
    }
  });

  return (
    <div className="space-y-6">
      <form onSubmit={saveOrg} noValidate>
        <SettingsCard
          title="Organization"
          description="Your company or agency. Every workspace, member and integration belongs to it."
          footer={
            canEditOrg && (
              <Button type="submit" size="sm" disabled={isSubmitting || !isDirty}>
                {isSubmitting && <Loader2 className="animate-spin" />}
                Save
              </Button>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="org-name" label="Organization name" error={errors.name ?? errors.root}>
              <Input id="org-name" disabled={!canEditOrg} {...form.register("name")} />
            </FormField>
            <FormField id="org-id" label="Organization ID" hint="Share this with support if you need help.">
              <div className="flex gap-2">
                <Input id="org-id" value={org.id} readOnly className="font-mono text-xs text-muted-foreground" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Copy organization ID"
                  onClick={() => {
                    void navigator.clipboard.writeText(org.id);
                    toast.success("Copied to clipboard");
                  }}
                >
                  <Copy />
                </Button>
              </div>
            </FormField>
          </div>
        </SettingsCard>
      </form>

      <SettingsCard
        title="This workspace"
        description="Reporting settings for this workspace. Totals are shown in this currency and timezone."
      >
        <WorkspaceForm
          key={workspace.id}
          disabled={!can("workspaces:manage")}
          defaultValues={{ name: workspace.name, currency: workspace.currency as "INR", timezone: workspace.timezone }}
          submitLabel="Save workspace"
          onSubmit={async (values) => {
            await api(`/orgs/${org.id}/workspaces/${workspace.id}`, { method: "PATCH", body: values });
            await queryClient.invalidateQueries();
            toast.success("Workspace updated");
          }}
        />
      </SettingsCard>

      <SettingsCard
        title={org.role === "OWNER" ? "Ownership" : "Leave organization"}
        description={
          org.role === "OWNER"
            ? "You own this organization. To hand it over or leave it, make another member the owner first."
            : `Remove yourself from ${org.name}. You'll lose access to all its workspaces until someone invites you again.`
        }
      >
        {org.role === "OWNER" ? (
          <Button asChild size="sm" variant="outline">
            <Link href={`/w/${workspace.id}/settings/team`}>Transfer ownership on the Team page</Link>
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setLeaving(true)}>
            <LogOut /> Leave {org.name}
          </Button>
        )}
      </SettingsCard>

      {can("org:delete") && (
        <SettingsCard
          title="Danger zone"
          className="border-destructive/40"
          description="Permanently delete this organization and everything in it."
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">
              <li>All workspaces, campaign data, reports, rules and creatives are deleted.</li>
              <li>Your subscription is cancelled right away and ad platform access is revoked.</li>
              <li>Every member loses access. This can&apos;t be undone.</li>
            </ul>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive"
              onClick={() => {
                setConfirmName("");
                setDeleting(true);
              }}
            >
              <Trash2 /> Delete organization
            </Button>
          </div>
        </SettingsCard>
      )}

      <AlertDialog open={deleting} onOpenChange={(o) => !busy && setDeleting(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {org.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes {org.workspaces.length} {org.workspaces.length === 1 ? "workspace" : "workspaces"} and all their
              data, cancels billing and removes every member. There&apos;s no way to get it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FormField id="confirm-org-name" label={
              <span>
                Type <span className="font-semibold">{org.name}</span> to confirm
              </span>
            }>
            <Input
              id="confirm-org-name"
              value={confirmName}
              autoComplete="off"
              autoFocus
              onChange={(e) => setConfirmName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && nameMatches && !busy) void deleteOrg();
              }}
            />
          </FormField>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy || !nameMatches}
              onClick={(e) => {
                e.preventDefault();
                void deleteOrg();
              }}
            >
              {busy && <Loader2 className="animate-spin" />} Delete organization
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {org.name}?</AlertDialogTitle>
            <AlertDialogDescription>You&apos;ll lose access right away. An owner or admin can invite you again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Stay</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={busy} onClick={(e) => { e.preventDefault(); void leave(); }}>
              {busy && <Loader2 className="animate-spin" />} Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
