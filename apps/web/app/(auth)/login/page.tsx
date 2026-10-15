"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema, type LoginInput, type MeResponse } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useForm } from "react-hook-form";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";
import { qk } from "@/lib/queries";

export default function LoginPage() {
  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
        <p className="text-sm text-muted-foreground">Sign in to manage your campaigns.</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}

/** Only allow same-site relative redirects. */
const safeNext = (next: string | null) => (next && next.startsWith("/") && !next.startsWith("//") ? next : "/app");

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const sessionExpired = params.get("error") === "session";

  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const me = await api<MeResponse>("/auth/login", { method: "POST", body: values });
      queryClient.setQueryData(qk.me, me);
      router.replace(safeNext(params.get("next")));
    } catch (err) {
      applyServerErrors(err, form.setError, ["email", "password"]);
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {(errors.root || sessionExpired) && (
        <div className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive animate-fade-up">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {errors.root?.message ?? "Your session ended. Please sign in again."}
        </div>
      )}
      <FormField id="email" label="Work email" error={errors.email}>
        <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" autoFocus className="h-10" {...form.register("email")} />
      </FormField>
      <FormField
        id="password"
        label="Password"
        error={errors.password}
        action={
          <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        }
      >
        <PasswordInput id="password" autoComplete="current-password" className="h-10" {...form.register("password")} />
      </FormField>
      <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
        {isSubmitting && <Loader2 className="animate-spin" />}
        Sign in
      </Button>
    </form>
  );
}
