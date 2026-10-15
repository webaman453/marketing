"use client";

import { NOTIFICATION_PREFS, type NotificationPrefKey, type NotificationPrefsDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { SettingsCard } from "@/components/settings/settings-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { toastError } from "@/lib/forms";
import { qk, useNotificationPrefs } from "@/lib/queries";

/** Alerts that only reach owners and admins; other roles see them greyed out. */
const ADMIN_ONLY: NotificationPrefKey[] = ["lowAiBalance", "syncFailures"];

export default function NotificationSettingsPage() {
  const { me, org } = useWorkspace();
  const queryClient = useQueryClient();
  const prefs = useNotificationPrefs();
  const isAdmin = org.role === "OWNER" || org.role === "ADMIN";

  async function toggle(key: NotificationPrefKey, on: boolean) {
    const before = prefs.data;
    if (!before) return;
    const next: NotificationPrefsDTO = { ...before, [key]: on };
    queryClient.setQueryData(qk.notificationPrefs, next);
    try {
      const saved = await api<NotificationPrefsDTO>("/notifications/preferences", { method: "PUT", body: next });
      queryClient.setQueryData(qk.notificationPrefs, saved);
      toast.success(on ? "Email turned on" : "Email turned off");
    } catch (err) {
      queryClient.setQueryData(qk.notificationPrefs, before);
      toastError(err);
    }
  }

  return (
    <SettingsCard
      title="Email notifications"
      description={
        <>
          Choose which emails we send to <span className="font-medium text-foreground">{me.user.email}</span>. You&apos;ll still see
          every alert in the bell menu inside the app. These settings apply to all your organizations.
        </>
      }
    >
      {prefs.isError ? (
        <ErrorState message={prefs.error.message} onRetry={() => prefs.refetch()} />
      ) : !prefs.data ? (
        <div className="space-y-3">{NOTIFICATION_PREFS.map((p) => <Skeleton key={p.key} className="h-12" />)}</div>
      ) : (
        <ul className="-my-3 divide-y">
          {NOTIFICATION_PREFS.map((p) => {
            const limited = ADMIN_ONLY.includes(p.key) && !isAdmin;
            return (
              <li key={p.key} className="flex items-center justify-between gap-6 py-3.5">
                <label htmlFor={`pref-${p.key}`} className="min-w-0 cursor-pointer">
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {p.description}
                    {limited && " You don't currently receive these in this organization."}
                  </div>
                </label>
                <Switch
                  id={`pref-${p.key}`}
                  checked={prefs.data[p.key]}
                  onCheckedChange={(on) => void toggle(p.key, on)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </SettingsCard>
  );
}
