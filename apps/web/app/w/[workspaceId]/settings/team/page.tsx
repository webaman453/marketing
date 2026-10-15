"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  ROLE_INFO,
  ROLES,
  canManageMember,
  hasAllWorkspaceAccess,
  inviteMemberSchema,
  type InviteMemberInput,
  type MemberDTO,
  type Role,
} from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Crown, Loader2, Mail, MoreHorizontal, RotateCw, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "zod";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { initials, timeAgo } from "@/lib/format";
import { applyServerErrors, toastError } from "@/lib/forms";
import { qk, useInvitations, useMembers } from "@/lib/queries";

const ASSIGNABLE = ROLES.filter((r) => r !== "OWNER");

export default function TeamPage() {
  const { org, me, can } = useWorkspace();
  const queryClient = useQueryClient();
  const canManage = can("members:manage");
  const members = useMembers(org.id);
  const invitations = useInvitations(org.id, canManage);
  const [inviting, setInviting] = useState(false);
  const [accessFor, setAccessFor] = useState<MemberDTO | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; description: string; action: string; run: () => Promise<void> } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const isOwner = org.role === "OWNER";

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.members(org.id) }),
      queryClient.invalidateQueries({ queryKey: qk.invitations(org.id) }),
    ]);

  async function changeRole(m: MemberDTO, role: Role) {
    if (role === m.role) return;
    // Scoped roles only see assigned workspaces, so pick them before switching.
    if (!hasAllWorkspaceAccess(role) && (hasAllWorkspaceAccess(m.role) || m.workspaceIds.length === 0)) {
      setAccessFor({ ...m, role, workspaceIds: m.workspaceIds.length ? m.workspaceIds : [] });
      return;
    }
    try {
      await api(`/orgs/${org.id}/members/${m.id}`, { method: "PATCH", body: { role } });
      toast.success(`${m.name} is now ${ROLE_INFO[role].label}`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeMember(m: MemberDTO) {
    try {
      await api(`/orgs/${org.id}/members/${m.id}`, { method: "DELETE" });
      toast.success(`${m.name} removed`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function makeOwner(m: MemberDTO) {
    try {
      await api(`/orgs/${org.id}/transfer-ownership`, { method: "POST", body: { memberId: m.id } });
      toast.success(`${m.name} is now the owner`, { description: "You're an Admin now." });
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: qk.me })]);
    } catch (err) {
      toastError(err);
    }
  }

  async function runConfirm() {
    if (!confirm) return;
    setConfirming(true);
    try {
      await confirm.run();
      setConfirm(null);
    } finally {
      setConfirming(false);
    }
  }

  async function inviteAction(id: string, action: "resend" | "revoke") {
    try {
      if (action === "resend") await api(`/orgs/${org.id}/invitations/${id}/resend`, { method: "POST" });
      else await api(`/orgs/${org.id}/invitations/${id}`, { method: "DELETE" });
      toast.success(action === "resend" ? "Invitation sent again" : "Invitation revoked");
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  const workspaceNames = (ids: string[]) =>
    org.workspaces.filter((w) => ids.includes(w.id)).map((w) => w.name).join(", ") || "No workspaces";

  return (
    <div className="space-y-6">
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Team members</CardTitle>
          <CardDescription>People who can access {org.name}.</CardDescription>
          {canManage && (
            <CardAction>
              <Button size="sm" onClick={() => setInviting(true)}>
                <UserPlus /> Invite
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {members.isError ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">{members.error.message}</p>
        ) : !members.data ? (
          <div className="space-y-3 p-6">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : (
          <ul className="divide-y">
            {members.data.map((m) => {
              const self = m.userId === me.user.id;
              // Only the owner manages admins; nobody manages the owner.
              const editable = canManage && !self && canManageMember(org.role, m.role);
              return (
                <li key={m.id} className="flex flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar className="size-9">
                      <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials(m.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 truncate font-medium">
                        {m.name}
                        {self && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {m.email}
                        {!hasAllWorkspaceAccess(m.role) && <> · {workspaceNames(m.workspaceIds)}</>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 sm:justify-end">
                    <Badge variant={m.role === "OWNER" ? "default" : "secondary"} className="font-medium">
                      {ROLE_INFO[m.role].label}
                    </Badge>
                    {editable && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Manage ${m.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                          <DropdownMenuLabel className="text-xs text-muted-foreground">Role</DropdownMenuLabel>
                          <DropdownMenuRadioGroup value={m.role} onValueChange={(r) => changeRole(m, r as Role)}>
                            {ASSIGNABLE.map((r) => (
                              <DropdownMenuRadioItem key={r} value={r} className="items-start">
                                <div>
                                  <div>{ROLE_INFO[r].label}</div>
                                  <div className="text-xs text-muted-foreground">{ROLE_INFO[r].description}</div>
                                </div>
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                          {!hasAllWorkspaceAccess(m.role) && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => setAccessFor(m)}>Workspace access…</DropdownMenuItem>
                            </>
                          )}
                          {isOwner && m.role !== "CLIENT" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() =>
                                  setConfirm({
                                    title: `Make ${m.name} the owner?`,
                                    description: `${m.name} gets full control, including billing. You become an Admin and can't undo this yourself.`,
                                    action: "Transfer ownership",
                                    run: () => makeOwner(m),
                                  })
                                }
                              >
                                <Crown /> Make owner…
                              </DropdownMenuItem>
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() =>
                              setConfirm({
                                title: `Remove ${m.name}?`,
                                description: `${m.name} loses access to ${org.name} right away. You can invite them again later.`,
                                action: "Remove",
                                run: () => removeMember(m),
                              })
                            }
                          >
                            <Trash2 /> Remove from organization
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {canManage && invitations.data && invitations.data.length > 0 && (
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-5">
            <CardTitle>Pending invitations</CardTitle>
            <CardDescription>Invitations expire after 7 days.</CardDescription>
          </CardHeader>
          <ul className="divide-y">
            {invitations.data.map((i) => (
              <li key={i.id} className="flex flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-full border border-dashed">
                    <Mail className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{i.email}</div>
                    <div className="text-xs text-muted-foreground">
                      {ROLE_INFO[i.role].label} · invited {timeAgo(i.createdAt)}
                      {i.invitedBy && <> by {i.invitedBy}</>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => inviteAction(i.id, "resend")}>
                    <RotateCw /> Resend
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() =>
                      setConfirm({
                        title: "Revoke this invitation?",
                        description: `The link sent to ${i.email} stops working.`,
                        action: "Revoke",
                        run: () => inviteAction(i.id, "revoke"),
                      })
                    }
                  >
                    <X /> Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="gap-3 p-6">
        <CardTitle className="text-sm">Roles at a glance</CardTitle>
        <dl className="grid gap-3 sm:grid-cols-2">
          {ROLES.map((r) => (
            <div key={r} className="rounded-lg border p-3">
              <dt className="text-sm font-medium">{ROLE_INFO[r].label}</dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{ROLE_INFO[r].description}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <InviteDialog open={inviting} onOpenChange={setInviting} onInvited={refresh} />
      <AccessDialog member={accessFor} onOpenChange={(o) => !o && setAccessFor(null)} onSaved={refresh} />
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.action === "Transfer ownership" ? undefined : "bg-destructive text-white hover:bg-destructive/90"}
              disabled={confirming}
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
            >
              {confirming && <Loader2 className="animate-spin" />} {confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WorkspaceChecklist({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { org } = useWorkspace();
  return (
    <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
      {org.workspaces.map((w) => (
        <label key={w.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
          <Checkbox
            checked={value.includes(w.id)}
            onCheckedChange={(on) => onChange(on ? [...value, w.id] : value.filter((x) => x !== w.id))}
          />
          {w.name}
        </label>
      ))}
    </div>
  );
}

type InviteForm = z.input<typeof inviteMemberSchema>;

function InviteDialog({ open, onOpenChange, onInvited }: { open: boolean; onOpenChange: (o: boolean) => void; onInvited: () => void }) {
  const { org, workspace } = useWorkspace();
  const form = useForm<InviteForm, unknown, InviteMemberInput>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: "", role: "MANAGER", workspaceIds: [workspace.id] },
  });
  const { errors, isSubmitting } = form.formState;
  const role = form.watch("role");

  const submit = form.handleSubmit(async (values) => {
    try {
      await api(`/orgs/${org.id}/invitations`, { method: "POST", body: values });
      toast.success(`Invitation sent to ${values.email}`);
      form.reset();
      onOpenChange(false);
      onInvited();
    } catch (err) {
      applyServerErrors(err, form.setError, ["email", "role"]);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a teammate</DialogTitle>
          <DialogDescription>They&apos;ll get an email with a link to join {org.name}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormField id="invite-email" label="Email" error={errors.email ?? errors.root}>
            <Input id="invite-email" type="email" placeholder="name@company.com" autoFocus {...form.register("email")} />
          </FormField>
          <FormField id="invite-role" label="Role" hint={role ? ROLE_INFO[role].description : undefined}>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_INFO[r].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
          {role && !hasAllWorkspaceAccess(role) && (
            <div className="grid gap-1.5">
              <Label className="text-[13px]">Workspace access</Label>
              <Controller
                control={form.control}
                name="workspaceIds"
                render={({ field }) => <WorkspaceChecklist value={field.value ?? []} onChange={field.onChange} />}
              />
              {errors.workspaceIds && <p className="text-xs font-medium text-destructive">{errors.workspaceIds.message}</p>}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AccessDialog({
  member,
  onOpenChange,
  onSaved,
}: {
  member: MemberDTO | null;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const { org } = useWorkspace();
  const [ids, setIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [forId, setForId] = useState<string | null>(null);

  const members = useMembers(org.id);
  const before = members.data?.find((m) => m.id === member?.id);
  const changingRole = Boolean(member && before && before.role !== member.role);
  const key = member ? `${member.id}:${member.role}` : null;
  if (member && forId !== key) {
    setForId(key);
    setIds(member.workspaceIds);
  }

  async function save() {
    if (!member) return;
    setSaving(true);
    try {
      await api(`/orgs/${org.id}/members/${member.id}`, { method: "PATCH", body: { role: member.role, workspaceIds: ids } });
      toast.success(changingRole ? `${member.name} is now ${ROLE_INFO[member.role].label}` : "Workspace access updated");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!member} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{changingRole && member ? `Make ${member.name} ${ROLE_INFO[member.role].label}` : "Workspace access"}</DialogTitle>
          <DialogDescription>
            {changingRole && member
              ? `A ${ROLE_INFO[member.role].label} only sees the workspaces you pick. Choose at least one.`
              : `Choose which workspaces ${member?.name} can see.`}
          </DialogDescription>
        </DialogHeader>
        <WorkspaceChecklist value={ids} onChange={setIds} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || ids.length === 0}>
            {saving && <Loader2 className="animate-spin" />}
            {changingRole ? "Change role" : "Save access"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
