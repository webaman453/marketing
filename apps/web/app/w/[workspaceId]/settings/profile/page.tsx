"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { changePasswordSchema, updateProfileSchema, type ChangePasswordInput, type UpdateProfileInput } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { applyServerErrors } from "@/lib/forms";
import { qk } from "@/lib/queries";

export default function ProfilePage() {
  const { me } = useWorkspace();
  const queryClient = useQueryClient();

  const profile = useForm<UpdateProfileInput>({ resolver: zodResolver(updateProfileSchema), values: { name: me.user.name } });
  const password = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: "", newPassword: "" },
  });

  const saveProfile = profile.handleSubmit(async (values) => {
    try {
      await api("/auth/me", { method: "PATCH", body: values });
      await queryClient.invalidateQueries({ queryKey: qk.me });
      toast.success("Profile updated");
    } catch (err) {
      applyServerErrors(err, profile.setError, ["name"]);
    }
  });

  const savePassword = password.handleSubmit(async (values) => {
    try {
      await api("/auth/change-password", { method: "POST", body: values });
      password.reset();
      toast.success("Password changed", { description: "You've been signed out on your other devices." });
    } catch (err) {
      applyServerErrors(err, password.setError, ["currentPassword", "newPassword"]);
    }
  });

  return (
    <div className="space-y-6">
      <form onSubmit={saveProfile} noValidate>
        <SettingsCard
          title="Your profile"
          description="How you appear to your teammates."
          footer={
            <Button type="submit" size="sm" disabled={profile.formState.isSubmitting || !profile.formState.isDirty}>
              {profile.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Save
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="name" label="Full name" error={profile.formState.errors.name ?? profile.formState.errors.root}>
              <Input id="name" autoComplete="name" {...profile.register("name")} />
            </FormField>
            <FormField id="email" label="Email" hint="Contact support to change your sign-in email.">
              <Input id="email" value={me.user.email} disabled />
            </FormField>
          </div>
        </SettingsCard>
      </form>

      <form onSubmit={savePassword} noValidate>
        <SettingsCard
          title="Password"
          description="Changing your password signs you out everywhere else."
          footer={
            <Button type="submit" size="sm" disabled={password.formState.isSubmitting}>
              {password.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Change password
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="currentPassword"
              label="Current password"
              error={password.formState.errors.currentPassword ?? password.formState.errors.root}
            >
              <PasswordInput id="currentPassword" autoComplete="current-password" {...password.register("currentPassword")} />
            </FormField>
            <FormField
              id="newPassword"
              label="New password"
              error={password.formState.errors.newPassword}
              hint="At least 8 characters, with a letter and a number."
            >
              <PasswordInput id="newPassword" autoComplete="new-password" {...password.register("newPassword")} />
            </FormField>
          </div>
        </SettingsCard>
      </form>
    </div>
  );
}
