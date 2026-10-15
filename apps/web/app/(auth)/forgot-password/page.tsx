"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { forgotPasswordSchema, type ForgotPasswordInput } from "@ashniva/shared";
import { ArrowLeft, Loader2, MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema), defaultValues: { email: "" } });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await api("/auth/forgot-password", { method: "POST", body: values });
      setSentTo(values.email);
    } catch (err) {
      applyServerErrors(err, form.setError, ["email"]);
    }
  });

  if (sentTo) {
    return (
      <div className="text-center animate-fade-up">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-primary/10">
          <MailCheck className="size-6 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          If an account exists for <span className="font-medium text-foreground">{sentTo}</span>, you&apos;ll receive a
          link to reset your password within a few minutes.
        </p>
        <Button asChild variant="outline" className="mt-8 h-10 w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <Link href="/login" className="mb-8 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
      <div className="mb-8 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground">Enter your email and we&apos;ll send you a reset link.</p>
      </div>
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        <FormField id="email" label="Work email" error={errors.email ?? errors.root}>
          <Input id="email" type="email" autoComplete="email" placeholder="you@company.com" autoFocus className="h-10" {...form.register("email")} />
        </FormField>
        <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Send reset link
        </Button>
      </form>
    </>
  );
}
