"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { resetPasswordSchema } from "@ashniva/shared";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";

const schema = resetPasswordSchema
  .pick({ password: true })
  .extend({ confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });
type Values = z.infer<typeof schema>;

const COPY = {
  reset: {
    title: "Choose a new password",
    button: "Update password",
    doneTitle: "Password updated",
    doneBody: "For your security we signed you out everywhere. Sign in with your new password.",
    missing: "This reset link is missing its token.",
  },
  set: {
    title: "Set your password",
    button: "Set password",
    doneTitle: "You're all set",
    doneBody: "Your password is saved and your email is verified. Sign in to get started.",
    missing: "This link is missing its token.",
  },
};

/**
 * Both emailed password links (forgot password, and the one sent for an admin-created account)
 * post to /auth/reset-password; only the wording differs.
 */
export function PasswordLinkForm({ mode }: { mode: keyof typeof COPY }) {
  return (
    <Suspense>
      <LinkForm mode={mode} />
    </Suspense>
  );
}

function LinkForm({ mode }: { mode: keyof typeof COPY }) {
  const copy = COPY[mode];
  const token = useSearchParams().get("token") ?? "";
  const [done, setDone] = useState(false);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async ({ password }) => {
    try {
      await api("/auth/reset-password", { method: "POST", body: { token, password } });
      setDone(true);
    } catch (err) {
      applyServerErrors(err, form.setError, ["password"]);
    }
  });

  if (done) {
    return (
      <div className="text-center animate-fade-up">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-success/10">
          <CheckCircle2 className="size-6 text-success" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{copy.doneTitle}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{copy.doneBody}</p>
        <Button asChild className="mt-8 h-10 w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-sm text-muted-foreground">Make it at least 8 characters, with a letter and a number.</p>
      </div>
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {(errors.root || !token) && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>
              {errors.root?.message ?? copy.missing}{" "}
              <Link href="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            </span>
          </div>
        )}
        <FormField id="password" label="New password" error={errors.password}>
          <PasswordInput id="password" autoComplete="new-password" autoFocus className="h-10" {...form.register("password")} />
        </FormField>
        <FormField id="confirm" label="Confirm password" error={errors.confirm}>
          <PasswordInput id="confirm" autoComplete="new-password" className="h-10" {...form.register("confirm")} />
        </FormField>
        <Button type="submit" className="h-10 w-full" disabled={isSubmitting || !token}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {copy.button}
        </Button>
      </form>
    </>
  );
}
