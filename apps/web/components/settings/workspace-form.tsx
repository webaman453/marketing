"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CURRENCIES, workspaceSchema, type WorkspaceInput } from "@ashniva/shared";
import { Loader2 } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { applyServerErrors } from "@/lib/forms";
import { CURRENCY_LABELS, TIMEZONES } from "@/lib/timezones";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";

type FormInput = z.input<typeof workspaceSchema>;

export function WorkspaceForm({
  defaultValues,
  submitLabel,
  onSubmit,
  onCancel,
  disabled,
}: {
  defaultValues?: Partial<WorkspaceInput>;
  submitLabel: string;
  onSubmit: (values: WorkspaceInput) => Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const form = useForm<FormInput, unknown, WorkspaceInput>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { name: "", currency: "INR", timezone: "Asia/Kolkata", ...defaultValues },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  useUnsavedChanges(isDirty && !isSubmitting && !disabled);

  const submit = form.handleSubmit(async (values) => {
    try {
      await onSubmit(values);
      form.reset(values);
    } catch (err) {
      applyServerErrors(err, form.setError, ["name", "currency", "timezone"]);
    }
  });

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormField id="ws-name" label="Workspace name" error={errors.name ?? errors.root} hint="Usually a brand or client name.">
        <Input id="ws-name" disabled={disabled} placeholder="e.g. Acme Retail" {...form.register("name")} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="ws-currency" label="Reporting currency" error={errors.currency}>
          <Controller
            control={form.control}
            name="currency"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                <SelectTrigger id="ws-currency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CURRENCY_LABELS[c] ?? c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>
        <FormField id="ws-tz" label="Timezone" error={errors.timezone}>
          <Controller
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                <SelectTrigger id="ws-tz" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>
      </div>
      {!disabled && (
        <div className="flex justify-end gap-2 pt-1">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isSubmitting || (!isDirty && !!defaultValues?.name)}>
            {isSubmitting && <Loader2 className="animate-spin" />}
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
