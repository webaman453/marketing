"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ROLE_INFO, registerSchema, type MeResponse, type Role } from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, MailX } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { EmptyState } from "@/components/app/states";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";
import { qk } from "@/lib/queries";

interface InviteInfo {
  email: string;
  orgName: string;
  role: Role;
  invitedBy: string | null;
  hasAccount: boolean;
}

const newAccountSchema = registerSchema.pick({ name: true, password: true });
type NewAccount = z.infer<typeof newAccountSchema>;

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InviteInfo>(`/auth/invitations/${token}`),
    retry: false,
  });

  const form = useForm<NewAccount>({ resolver: zodResolver(newAccountSchema), defaultValues: { name: "", password: "" } });
  const { errors, isSubmitting } = form.formState;
  const [accepting, setAccepting] = useState(false);

  async function accept(values?: NewAccount) {
    try {
      const me = await api<MeResponse>("/auth/invitations/accept", { method: "POST", body: { token, ...values } });
      queryClient.setQueryData(qk.me, me);
      router.replace("/app");
    } catch (err) {
      applyServerErrors(err, form.setError, ["name", "password"]);
    }
  }

  if (invite.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-6 h-10 w-full" />
      </div>
    );
  }

  if (invite.isError) {
    return (
      <EmptyState
        icon={MailX}
        title="This invitation isn't valid"
        description={`${errorMessage(invite.error)} It may have expired or already been used. Ask your admin to send a new one.`}
        action={
          <Button asChild variant="outline">
            <Link href="/login">Go to sign in</Link>
          </Button>
        }
      />
    );
  }

  const info = invite.data;
  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Join {info.orgName}</h1>
        <p className="text-sm text-muted-foreground">
          {info.invitedBy ? `${info.invitedBy} invited` : "You've been invited"}{" "}
          <span className="font-medium text-foreground">{info.email}</span> to join as{" "}
          <span className="font-medium text-foreground">{ROLE_INFO[info.role].label}</span>.
        </p>
      </div>

      {errors.root && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {errors.root.message}{" "}
            {info.hasAccount && (
              <Link href={`/login?next=/invite/${token}`} className="font-medium underline">
                Sign in
              </Link>
            )}
          </span>
        </div>
      )}

      {info.hasAccount ? (
        <Button
          className="h-10 w-full"
          disabled={accepting}
          onClick={async () => {
            setAccepting(true);
            await accept();
            setAccepting(false);
          }}
        >
          {accepting && <Loader2 className="animate-spin" />}
          Accept invitation
        </Button>
      ) : (
        <form onSubmit={form.handleSubmit(accept)} className="space-y-4" noValidate>
          <FormField id="email" label="Email">
            <Input id="email" value={info.email} disabled className="h-10" />
          </FormField>
          <FormField id="name" label="Full name" error={errors.name}>
            <Input id="name" autoComplete="name" autoFocus className="h-10" {...form.register("name")} />
          </FormField>
          <FormField id="password" label="Create a password" error={errors.password} hint="At least 8 characters, with a letter and a number.">
            <PasswordInput id="password" autoComplete="new-password" className="h-10" {...form.register("password")} />
          </FormField>
          <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            Create account &amp; join
          </Button>
        </form>
      )}
    </>
  );
}
