"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { createOrgSchema, type CreateOrgInput, type MeResponse } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { LAST_WORKSPACE_KEY } from "@/components/app/workspace-context";
import { LogoMark } from "@/components/brand";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";
import { qk, useMe } from "@/lib/queries";

/** Entry point after sign-in: sends the user to their last (or first) workspace. */
export default function AppEntry() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();

  async function signOut() {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    queryClient.clear();
    router.replace("/login");
  }

  useEffect(() => {
    if (!me.data) return;
    const workspaces = me.data.orgs.flatMap((o) => o.workspaces);
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_WORKSPACE_KEY);
    } catch {
      /* storage unavailable */
    }
    const target = workspaces.find((w) => w.id === last) ?? workspaces[0];
    if (target) router.replace(`/w/${target.id}/overview`);
  }, [me.data, router]);

  useEffect(() => {
    if (me.isError) router.replace("/login");
  }, [me.isError, router]);

  const noAccess = me.data && me.data.orgs.every((o) => o.workspaces.length === 0);
  if (noAccess && me.data!.orgs.length === 0) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center px-6 py-10">
        <div className="w-full max-w-sm animate-fade-up">
          <LogoMark className="mx-auto size-10" />
          <div className="mt-5 space-y-2 text-center">
            <h1 className="text-lg font-semibold">You&apos;re not part of an organization</h1>
            <p className="text-sm text-muted-foreground">
              Start a new organization below, or ask a teammate to invite you to theirs. Invitations arrive by email.
            </p>
          </div>
          <CreateOrgForm />
          <div className="mt-6 text-center">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </div>
    );
  }
  if (noAccess) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
        <LogoMark className="size-10" />
        <h1 className="text-lg font-semibold">No workspace access yet</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Your account isn&apos;t assigned to any workspace. Ask an admin of your organization to give you access.
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4">
      <LogoMark className="size-10 animate-pulse" />
      <p className="text-sm text-muted-foreground">Loading your workspace…</p>
    </div>
  );
}

/** Lets a signed-in user with no organization start one (with its first workspace). */
function CreateOrgForm() {
  const queryClient = useQueryClient();
  const form = useForm<CreateOrgInput>({ resolver: zodResolver(createOrgSchema), defaultValues: { companyName: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const me = await api<MeResponse>("/orgs", { method: "POST", body: values });
      // AppEntry's redirect takes it from here; a locked org shows the "choose a plan" banner.
      queryClient.setQueryData(qk.me, me);
    } catch (err) {
      applyServerErrors(err, form.setError, ["companyName"]);
    }
  });

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4 rounded-xl border bg-card p-5 shadow-xs" noValidate>
      {errors.root && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive animate-fade-up">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {errors.root.message}
        </div>
      )}
      <FormField
        id="companyName"
        label="Organization name"
        error={errors.companyName}
        hint="Choose a plan after you create it. The workspace stays read-only until then."
      >
        <Input id="companyName" autoComplete="organization" placeholder="Acme Media" autoFocus className="h-10" {...form.register("companyName")} />
      </FormField>
      <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        Create organization
      </Button>
    </form>
  );
}
