"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { registerSchema, type MeResponse, type RegisterInput } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";
import { qk } from "@/lib/queries";

export default function SignupPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", companyName: "" },
  });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const me = await api<MeResponse>("/auth/register", { method: "POST", body: values });
      queryClient.setQueryData(qk.me, me);
      const ws = me.orgs[0]?.workspaces[0];
      router.replace(ws ? `/w/${ws.id}/overview?welcome=1` : "/app");
    } catch (err) {
      applyServerErrors(err, form.setError, ["name", "email", "password", "companyName"]);
    }
  });

  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-muted-foreground">Choose a plan after you sign up. The workspace stays read-only until then.</p>
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {errors.root && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-sm text-destructive animate-fade-up">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {errors.root.message}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="name" label="Full name" error={errors.name}>
            <Input id="name" autoComplete="name" placeholder="Priya Sharma" autoFocus className="h-10" {...form.register("name")} />
          </FormField>
          <FormField id="companyName" label="Company" error={errors.companyName}>
            <Input id="companyName" autoComplete="organization" placeholder="Acme Media" className="h-10" {...form.register("companyName")} />
          </FormField>
        </div>
        <FormField id="email" label="Work email" error={errors.email}>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" className="h-10" {...form.register("email")} />
        </FormField>
        <FormField id="password" label="Password" error={errors.password} hint="At least 8 characters, with a letter and a number.">
          <PasswordInput id="password" autoComplete="new-password" className="h-10" {...form.register("password")} />
        </FormField>
        <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Create account
        </Button>
        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          By creating an account you agree to our{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      </form>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
