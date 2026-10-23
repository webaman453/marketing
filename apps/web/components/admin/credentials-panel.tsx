"use client";

import {
  CREDENTIAL_GROUPS,
  credentialFieldApplies,
  credentialValue,
  type CredentialField,
  type CredentialGroup,
  type CredentialGroupId,
  type CredentialGroupStatus,
  type CredentialsDTO,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Check,
  CheckCircle2,
  CircleDashed,
  Copy,
  CreditCard,
  ExternalLink,
  Loader2,
  Mail,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FormField } from "@/components/form-field";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { cn } from "@/lib/utils";

export const CREDENTIALS_KEY = ["admin-credentials"] as const;

export function useCredentials(enabled = true) {
  return useQuery({
    queryKey: CREDENTIALS_KEY,
    queryFn: () => api<CredentialsDTO>("/admin/settings/credentials"),
    enabled,
  });
}

const SECTIONS: {
  title: string;
  description: string;
  kinds: CredentialGroup["kind"][];
}[] = [
  {
    title: "Ad platforms",
    description:
      "One app per platform for the whole product. Your customers then just click Connect and sign in; they never see these keys.",
    kinds: ["platform"],
  },
  {
    title: "AI, payments and email",
    description: "Shared services every organization uses.",
    kinds: ["ai", "billing", "email"],
  },
];

/** Admin console: every integration's keys, how to get them, and whether they work. */
export function CredentialsPanel({
  initialGroup,
}: {
  initialGroup?: CredentialGroupId | null;
}) {
  const creds = useCredentials();
  const [open, setOpen] = useState<CredentialGroupId | null>(
    initialGroup ?? null,
  );

  return (
    <div className="space-y-8">
      <HowItWorks />
      {SECTIONS.map((section) => (
        <section key={section.title} className="space-y-3">
          <div>
            <h2 className="text-[15px] font-semibold">{section.title}</h2>
            <p className="text-sm text-muted-foreground">
              {section.description}
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {CREDENTIAL_GROUPS.filter((g) =>
              section.kinds.includes(g.kind),
            ).map((g) => {
              const status = creds.data?.groups.find((s) => s.id === g.id);
              return (
                <GroupCard
                  key={g.id}
                  group={g}
                  status={status}
                  loading={!creds.data}
                  onOpen={() => setOpen(g.id)}
                />
              );
            })}
          </div>
        </section>
      ))}
      <CredentialDialog groupId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function HowItWorks() {
  const steps = [
    [
      "You add the keys once",
      "Create an app on each platform's developer site and paste its keys here. Each card has the exact steps.",
    ],
    [
      "Customers click Connect",
      "On their Integrations page they sign in to Meta, Google and the rest through your app. No keys on their side.",
    ],
    [
      "Data syncs automatically",
      "Campaigns and results sync every few hours. Campaigns built here publish through the same connection.",
    ],
  ];
  return (
    <Card className="gap-0 p-0 md:grid md:grid-cols-3 md:divide-x">
      {steps.map(([title, body], i) => (
        <div key={title} className="flex gap-3 p-4">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <div className="space-y-0.5">
            <div className="text-sm font-medium">{title}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {body}
            </p>
          </div>
        </div>
      ))}
    </Card>
  );
}

function GroupIcon({
  group,
  className,
}: {
  group: CredentialGroup;
  className?: string;
}) {
  if (group.platform)
    return <PlatformIcon platform={group.platform} size="md" />;
  const Icon =
    group.kind === "ai" ? Bot : group.kind === "billing" ? CreditCard : Mail;
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary",
        className,
      )}
    >
      <Icon className="size-4.5" />
    </span>
  );
}

/** Fields someone has to type: an optional API version or a default provider alone doesn't make a setup "started". */
const requiredFields = (
  group: CredentialGroup,
  status?: CredentialGroupStatus,
) =>
  (status?.fields ?? []).filter((f) => {
    const def = group.fields.find((g) => g.key === f.key);
    // Fields for the other choice (e.g. Resend while sending with SMTP) don't count either.
    return (
      def &&
      !def.optional &&
      !def.options &&
      credentialFieldApplies(
        group,
        def,
        (key) => status?.fields.find((x) => x.key === key)?.display,
      )
    );
  });

function StatusBadge({
  group,
  status,
}: {
  group: CredentialGroup;
  status?: CredentialGroupStatus;
}) {
  if (!status) return null;
  const anySet = requiredFields(group, status).some((f) => f.set);
  if (status.configured) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-success/20 bg-success/10 text-success"
      >
        <CheckCircle2 className="size-3" /> Set up
      </Badge>
    );
  }
  return anySet ? (
    <Badge
      variant="outline"
      className="gap-1 border-warning/30 bg-warning/10 text-warning"
    >
      <CircleDashed className="size-3" /> Incomplete
    </Badge>
  ) : (
    <Badge variant="secondary">Not set up</Badge>
  );
}

function GroupCard({
  group,
  status,
  loading,
  onOpen,
}: {
  group: CredentialGroup;
  status?: CredentialGroupStatus;
  loading: boolean;
  onOpen: () => void;
}) {
  const required = requiredFields(group, status);
  const fromEnv =
    required.some((f) => f.source === "env") &&
    !required.some((f) => f.source === "console");
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <GroupIcon group={group} />
        {loading ? (
          <Skeleton className="h-5 w-20" />
        ) : (
          <StatusBadge group={group} status={status} />
        )}
      </div>
      <div className="space-y-0.5">
        <h3 className="font-semibold">{group.title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {group.purpose}
        </p>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {fromEnv
            ? "From the server's .env file"
            : status?.updatedAt
              ? `Updated ${timeAgo(status.updatedAt)}`
              : ""}
        </span>
        <Button
          size="sm"
          variant={status?.configured ? "outline" : "default"}
          onClick={onOpen}
        >
          {status?.configured ? "Edit keys" : "Set up"}
        </Button>
      </div>
    </Card>
  );
}

function CopyBox({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3">
      <div className="text-xs font-medium">{label}</div>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          className="h-8 bg-background font-mono text-xs"
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="bg-background"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Steps, URLs to register and the key fields for one integration. Also used on the Integrations page. */
export function CredentialDialog({
  groupId,
  onClose,
}: {
  groupId: CredentialGroupId | null;
  onClose: () => void;
}) {
  const group = CREDENTIAL_GROUPS.find((g) => g.id === groupId);
  return (
    <Dialog open={!!group} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        {group && (
          <CredentialForm key={group.id} group={group} onClose={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CredentialForm({
  group,
  onClose,
}: {
  group: CredentialGroup;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const creds = useCredentials();
  const status = creds.data?.groups.find((g) => g.id === group.id);
  const current = (key: string) => status?.fields.find((f) => f.key === key);
  // Plain fields start with their current value; secrets start empty ("leave empty to keep").
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      group.fields.map((f) => [
        f.key,
        f.secret ? "" : (current(f.key)?.display ?? ""),
      ]),
    ),
  );
  useEffect(() => {
    if (!status) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const f of group.fields) {
        if (f.secret || next[f.key]) continue;
        next[f.key] = status.fields.find((x) => x.key === f.key)?.display ?? "";
      }
      return next;
    });
  }, [status, group.fields]);

  const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  // What a field holds right now: what's typed, else what's saved (dropdowns fall back to their first option).
  const valueOf = (key: string) => values[key] || current(key)?.display || "";
  const selectValue = (f: CredentialField) =>
    credentialValue(f, valueOf(f.key));
  // e.g. SMTP fields only while "Send with" is SMTP.
  const applies = (f: CredentialField) =>
    credentialFieldApplies(group, f, (key) => {
      const def = group.fields.find((x) => x.key === key);
      return def ? credentialValue(def, valueOf(key)) : valueOf(key);
    });
  const visible = group.fields.filter(applies);
  const hasConsoleValues = status?.fields.some((f) => f.source === "console");

  function changes() {
    const out: Record<string, string | null> = {};
    for (const f of group.fields) {
      const v = (values[f.key] ?? "").trim();
      if (f.options) {
        // Save the choice shown on screen, even when it's the default.
        const chosen = selectValue(f);
        if (chosen !== (current(f.key)?.display ?? "")) out[f.key] = chosen;
      } else if (f.secret) {
        if (v) out[f.key] = v;
      } else if (v !== (current(f.key)?.display ?? "")) {
        out[f.key] = v || null;
      }
    }
    return out;
  }

  const missing = group.fields.filter(
    (f) =>
      !f.optional &&
      !f.options &&
      !(values[f.key] ?? "").trim() &&
      !current(f.key)?.set &&
      applies(f),
  );

  const replacedIdentityWithoutSecret = group.fields.some(
    (f) => f.secret && current(f.key)?.set && !(values[f.key] ?? "").trim(),
  ) && group.fields.some(
    (f) => !f.secret && !f.optional && !f.options && (values[f.key] ?? "").trim() !== (current(f.key)?.display ?? ""),
  );

  async function save(thenTest: boolean) {
    if (replacedIdentityWithoutSecret) {
      toast.error("Paste the new secret too", {
        description: "The App ID changed. Leaving the secret empty keeps the old one, and the new app will not sign in.",
      });
      return;
    }
    setBusy(thenTest ? "test" : "save");
    setResult(null);
    try {
      const body = changes();
      if (Object.keys(body).length > 0) {
        await api("/admin/settings/credentials", {
          method: "PUT",
          body: { values: body },
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
          queryClient.invalidateQueries({ queryKey: ["platforms"] }),
        ]);
        setValues((v) =>
          Object.fromEntries(
            Object.entries(v).map(([k, x]) => [
              k,
              group.fields.find((f) => f.key === k)?.secret ? "" : x,
            ]),
          ),
        );
      }
      if (thenTest) {
        const r = await api<{ ok: boolean; message: string }>(
          `/admin/settings/credentials/${group.id}/test`,
          { method: "POST" },
        );
        setResult(r);
      } else {
        toast.success(`${group.title} saved`, {
          description: missing.length
            ? "Some required keys are still empty."
            : "It's live for every organization now.",
        });
        onClose();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  async function clearConsole() {
    setBusy("clear");
    try {
      await api("/admin/settings/credentials", {
        method: "PUT",
        body: {
          values: Object.fromEntries(group.fields.map((f) => [f.key, null])),
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CREDENTIALS_KEY }),
        queryClient.invalidateQueries({ queryKey: ["platforms"] }),
      ]);
      toast.success("Saved keys removed", {
        description: "The server's .env values apply again, if it has any.",
      });
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  }

  const redirectUrl = group.platform
    ? creds.data?.redirectUrls[group.platform]
    : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2.5">
          <GroupIcon group={group} className="size-8" /> {group.title}
        </DialogTitle>
        <DialogDescription>{group.purpose}</DialogDescription>
      </DialogHeader>

      <div className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">How to get these keys</h4>
            <Button asChild size="sm" variant="outline">
              <a href={group.consoleUrl} target="_blank" rel="noreferrer">
                Open {group.consoleLabel} <ExternalLink />
              </a>
            </Button>
          </div>
          <ol className="space-y-1.5">
            {group.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold">
                  {i + 1}
                </span>
                <span className="text-muted-foreground">{s}</span>
              </li>
            ))}
          </ol>
        </div>

        {group.needsRedirectUrl && redirectUrl && (
          <CopyBox
            label="Redirect URL"
            value={redirectUrl}
            hint="Paste this exactly in the platform's app settings, or sign-in will fail with a redirect error."
          />
        )}
        {group.needsWebhookUrl && creds.data && (
          <CopyBox
            label="Webhook URL"
            value={creds.data.webhookUrl}
            hint="Razorpay calls this after each payment so plans and token packs activate even if the customer closes the tab."
          />
        )}
        {redirectUrl?.includes("localhost") && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs">
            This server runs on localhost, so platforms can only redirect back
            on this computer. Set WEB_URL (or OAUTH_REDIRECT_BASE) to your
            public domain before customers connect.
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((f) => {
            const cur = current(f.key);
            const id = `cred-${f.key}`;
            const hint =
              f.secret && cur?.set
                ? `Saved (${cur.display}). Leave empty to keep it.`
                : f.help;
            return (
              <FormField
                key={f.key}
                id={id}
                label={`${f.label}${f.optional ? " (optional)" : ""}`}
                hint={hint}
                className={
                  f.secret || f.key.endsWith("_URL")
                    ? "sm:col-span-2"
                    : undefined
                }
              >
                {f.options ? (
                  <Select
                    value={selectValue(f)}
                    onValueChange={(v) =>
                      setValues((s) => ({ ...s, [f.key]: v }))
                    }
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {f.options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={id}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    placeholder={
                      f.secret && cur?.set ? "••••••••" : f.placeholder
                    }
                    value={values[f.key] ?? ""}
                    onChange={(e) =>
                      setValues((s) => ({ ...s, [f.key]: e.target.value }))
                    }
                  />
                )}
              </FormField>
            );
          })}
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-px size-3.5 shrink-0" />
          Secrets are encrypted before they&apos;re stored and are never shown
          again in full. Values saved here take priority over the server&apos;s
          .env file.
        </p>

        {result && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
              result.ok
                ? "border-success/30 bg-success/10"
                : "border-destructive/30 bg-destructive/10",
            )}
          >
            {result.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            )}
            {result.message}
          </div>
        )}
        {!group.testable && (
          <p className="text-xs text-muted-foreground">
            {group.title} can only be checked by connecting a real account:
            after saving, open Integrations in any workspace and click Connect.
          </p>
        )}
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <div>
          {hasConsoleValues && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={!!busy}
              onClick={clearConsole}
            >
              {busy === "clear" && <Loader2 className="animate-spin" />} Remove
              saved keys
            </Button>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          {group.testable && (
            <Button
              variant="outline"
              disabled={!!busy || missing.length > 0}
              onClick={() => save(true)}
            >
              {busy === "test" && <Loader2 className="animate-spin" />} Save &
              test
            </Button>
          )}
          <Button disabled={!!busy} onClick={() => save(false)}>
            {busy === "save" && <Loader2 className="animate-spin" />} Save
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}
