"use client";

import { ALERT_GROUPS, type AlertWebhookDTO } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { BellRing, Check, Copy, Loader2, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { NoAccess } from "@/components/settings/no-access";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useAlertWebhooks } from "@/lib/queries";
import { cn } from "@/lib/utils";

type Kind = "SLACK" | "WEBHOOK" | "WHATSAPP";

const KINDS: { value: Kind; label: string; hint: string; placeholder: string }[] = [
  { value: "SLACK", label: "Slack", hint: "Paste an incoming webhook URL from your Slack app (api.slack.com/messaging/webhooks).", placeholder: "https://hooks.slack.com/services/T000/B000/XXXX" },
  { value: "WEBHOOK", label: "Webhook", hint: "We POST JSON to this URL and sign it, so your server can check it came from us.", placeholder: "https://example.com/hooks/ashniva" },
  {
    value: "WHATSAPP",
    label: "WhatsApp",
    hint: "Sends through your own WhatsApp Business account (Meta's Cloud API). You need a phone number ID, an access token and an approved message template whose body is a single variable, like “Ashniva alert: {{1}}”.",
    placeholder: "",
  },
];

/** "All workspaces", or the names of the workspaces and alert groups a channel is limited to. */
function scopeText(h: AlertWebhookDTO, workspaces: { id: string; name: string }[]) {
  const where = h.workspaceIds.length === 0 ? "all workspaces" : h.workspaceIds.map((id) => workspaces.find((w) => w.id === id)?.name ?? "a removed workspace").join(", ");
  const what = h.events.length === 0 ? "all alerts" : h.events.map((k) => ALERT_GROUPS.find((g) => g.key === k)?.label ?? k).join(", ");
  return `${where} · ${what}`;
}

/** Slack's four-colour mark, in simplified form. */
function SlackMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path fill="#E01E5A" d="M5.04 15.16a2.52 2.52 0 1 1-2.52-2.52h2.52v2.52Zm1.27 0a2.52 2.52 0 0 1 5.04 0v6.32a2.52 2.52 0 1 1-5.04 0v-6.32Z" />
      <path fill="#36C5F0" d="M8.83 5.04a2.52 2.52 0 1 1 2.52-2.52v2.52H8.83Zm0 1.27a2.52 2.52 0 0 1 0 5.04H2.52a2.52 2.52 0 1 1 0-5.04h6.31Z" />
      <path fill="#2EB67D" d="M18.96 8.83a2.52 2.52 0 1 1 2.52 2.52h-2.52V8.83Zm-1.27 0a2.52 2.52 0 0 1-5.04 0V2.52a2.52 2.52 0 1 1 5.04 0v6.31Z" />
      <path fill="#ECB22E" d="M15.17 18.96a2.52 2.52 0 1 1-2.52 2.52v-2.52h2.52Zm0-1.27a2.52 2.52 0 0 1 0-5.04h6.31a2.52 2.52 0 1 1 0 5.04h-6.31Z" />
    </svg>
  );
}

export default function AlertChannelsPage() {
  const { org, workspace, can } = useWorkspace();
  const allowed = can("org:update");
  const hooks = useAlertWebhooks(org.id, allowed);
  const queryClient = useQueryClient();
  // Whether the platform owner has switched on the one-click Add to Slack button.
  const options = useQuery({ queryKey: ["alert-webhook-options", org.id], queryFn: () => api<{ slackOAuth: boolean }>(`/orgs/${org.id}/alert-webhooks/options`), enabled: allowed });
  const [slackBusy, setSlackBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  /** The channel being edited (its URL stays as it is); null when adding. */
  const [editing, setEditing] = useState<AlertWebhookDTO | null>(null);
  // Which workspaces' alerts go to the channel. With several workspaces, start with this one only.
  const [allWorkspaces, setAllWorkspaces] = useState(true);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>("SLACK");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  // WhatsApp: which business number sends, to whom, and with which approved template.
  const [waPhoneId, setWaPhoneId] = useState("");
  const [waToken, setWaToken] = useState("");
  const [waRecipients, setWaRecipients] = useState("");
  const [waTemplate, setWaTemplate] = useState("");
  const [waLanguage, setWaLanguage] = useState("en");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);

  // Slack sends people back here with the result of Add to Slack in the address.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const added = params.get("slack") === "added";
    const failed = params.get("slack_error");
    if (!added && !failed) return;
    if (added) toast.success(`Slack connected${params.get("channel") ? `: ${params.get("channel")}` : ""}`, { description: "A first message was sent to the channel." });
    else toast.error(failed ?? "Add to Slack didn't work.");
    window.history.replaceState(null, "", window.location.pathname);
    void queryClient.invalidateQueries({ queryKey: qk2.alertWebhooks(org.id) });
  }, [org.id, queryClient]);

  if (!allowed) return <NoAccess what="alert channels" />;
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk2.alertWebhooks(org.id) });
  const current = KINDS.find((k) => k.value === kind)!;

  const several = org.workspaces.length > 1;
  const scopeValid = allWorkspaces || workspaceIds.length > 0;

  function openAdd() {
    setEditing(null);
    setName("");
    setUrl("");
    setEvents([]);
    setAllWorkspaces(!several);
    setWorkspaceIds(several ? [workspace.id] : []);
    setCreating(true);
  }

  function openEdit(h: AlertWebhookDTO) {
    setEditing(h);
    setName(h.name);
    setAllWorkspaces(h.workspaceIds.length === 0);
    setWorkspaceIds(h.workspaceIds);
    setEvents(h.events);
    setCreating(true);
  }

  function close() {
    setCreating(false);
    setEditing(null);
    setSecret(null);
    setName("");
    setUrl("");
    setWaPhoneId("");
    setWaToken("");
    setWaRecipients("");
    setWaTemplate("");
    setWaLanguage("en");
  }

  const channelBody = () =>
    kind === "WHATSAPP"
      ? { phoneNumberId: waPhoneId, accessToken: waToken, recipients: waRecipients.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean), template: waTemplate, language: waLanguage }
      : { url };
  const channelReady = kind === "WHATSAPP" ? waPhoneId.trim().length >= 5 && waToken.trim().length >= 10 && waRecipients.trim().length >= 8 && waTemplate.trim().length >= 1 : url.trim().length >= 8;

  const scopeBody = () => ({ workspaceIds: allWorkspaces ? [] : workspaceIds, events });

  async function save() {
    if (!editing) return create();
    setBusy(true);
    try {
      await api(`/orgs/${org.id}/alert-webhooks/${editing.id}`, { method: "PATCH", body: { name, ...scopeBody() } });
      await refresh();
      toast.success("Channel updated");
      close();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  /** Sends the person to Slack to pick a workspace and channel; Slack hands back the webhook, so nothing is pasted. */
  async function addToSlack() {
    setSlackBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/orgs/${org.id}/alert-webhooks/slack/authorize`, { method: "POST", body: { returnWorkspaceId: workspace.id, ...scopeBody() } });
      window.location.assign(url);
    } catch (err) {
      toastError(err);
      setSlackBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const res = await api<AlertWebhookDTO & { secret: string | null }>(`/orgs/${org.id}/alert-webhooks`, { method: "POST", body: { name, kind, ...channelBody(), ...scopeBody() } });
      await refresh();
      if (res.secret) setSecret(res.secret);
      else {
        toast.success("Channel added. Send a test to check it.");
        close();
      }
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setTesting(id);
    try {
      const res = await api<{ ok: boolean; error: string | null }>(`/orgs/${org.id}/alert-webhooks/${id}/test`, { method: "POST" });
      if (res.ok) toast.success("Test alert sent");
      else toast.error(res.error ?? "The test alert failed");
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setTesting(null);
    }
  }

  async function toggle(h: AlertWebhookDTO, isActive: boolean) {
    try {
      await api(`/orgs/${org.id}/alert-webhooks/${h.id}`, { method: "PATCH", body: { isActive } });
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function remove(id: string) {
    try {
      await api(`/orgs/${org.id}/alert-webhooks/${id}`, { method: "DELETE" });
      toast.success("Channel removed");
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Slack and webhook alerts</CardTitle>
          <CardDescription>
            Every alert for {org.name} (automation rules, unusual spend, sync failures, budgets, billing) is also posted here, not just shown in the bell menu.
          </CardDescription>
          <CardAction>
            <Button size="sm" onClick={openAdd}><Plus /> Add channel</Button>
          </CardAction>
        </CardHeader>
        {hooks.data?.length === 0 ? (
          <EmptyState icon={BellRing} title="No channels yet" description="Add a Slack channel or a webhook to get alerts where your team already works." />
        ) : (
          <ul className="divide-y">
            {hooks.data?.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 px-6 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {h.name}
                    <Badge variant="secondary">{h.kind === "SLACK" ? "Slack" : h.kind === "WHATSAPP" ? "WhatsApp" : "Webhook"}</Badge>
                    {h.signed && <Badge variant="outline">Signed</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {h.urlHint} · {scopeText(h, org.workspaces)} · {h.lastSentAt ? `last sent ${timeAgo(h.lastSentAt)}` : "nothing sent yet"}
                    {h.lastError && <span className="text-destructive"> · {h.lastError}</span>}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => openEdit(h)}>
                  <Pencil /> Edit
                </Button>
                <Button size="sm" variant="outline" onClick={() => test(h.id)} disabled={testing === h.id}>
                  {testing === h.id ? <Loader2 className="animate-spin" /> : <Send />} Send test
                </Button>
                <Switch checked={h.isActive} onCheckedChange={(on) => void toggle(h, on)} aria-label={`${h.name} on or off`} />
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => remove(h.id)}>
                  <Trash2 /> Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog open={creating} onOpenChange={(o) => (o ? setCreating(true) : close())}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{secret ? "Copy your signing secret" : editing ? "Edit alert channel" : "Add an alert channel"}</DialogTitle>
            <DialogDescription>
              {secret ? "Use it to verify the X-Ashniva-Signature header (sha256 of timestamp.body). It is shown only once." : editing ? "Change what this channel receives. To use a different URL, remove it and add a new one." : current.hint}
            </DialogDescription>
          </DialogHeader>
          {secret ? (
            <div className="flex gap-2">
              <Input value={secret} readOnly className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(secret);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {!editing && (
              <div className="grid grid-cols-3 gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={cn("rounded-lg border px-3 py-2 text-sm font-medium transition-colors", kind === k.value ? "border-primary bg-primary/5 text-primary" : "hover:bg-muted")}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
              )}
              {!editing && kind === "SLACK" && options.data?.slackOAuth && (
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3.5">
                  <Button type="button" className="w-full" onClick={addToSlack} disabled={slackBusy || !scopeValid}>
                    {slackBusy ? <Loader2 className="animate-spin" /> : <SlackMark />} Add to Slack
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    You choose your Slack workspace and the channel on Slack&apos;s own page. No URL to copy. The workspace and alert choices below are kept. Or paste a webhook URL yourself:
                  </p>
                </div>
              )}
              <FormField id="hook-name" label="Name">
                <Input id="hook-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="#ads-alerts" autoFocus />
              </FormField>
              {!editing && kind !== "WHATSAPP" && (
                <FormField id="hook-url" label={kind === "SLACK" ? "Slack webhook URL" : "Webhook URL"}>
                  <Input id="hook-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={current.placeholder} />
                </FormField>
              )}
              {!editing && kind === "WHATSAPP" && (
                <div className="space-y-3">
                  <FormField id="wa-phone" label="Phone number ID" hint="From WhatsApp Manager → API setup. It's a long number, not the phone number itself.">
                    <Input id="wa-phone" inputMode="numeric" value={waPhoneId} onChange={(e) => setWaPhoneId(e.target.value)} placeholder="109876543210987" />
                  </FormField>
                  <FormField id="wa-token" label="Access token" hint="A permanent token from a system user. It's stored encrypted and never shown again.">
                    <Input id="wa-token" type="password" autoComplete="off" value={waToken} onChange={(e) => setWaToken(e.target.value)} />
                  </FormField>
                  <FormField id="wa-to" label="Send alerts to" hint="Up to 5 numbers with country code, separated by commas.">
                    <Input id="wa-to" value={waRecipients} onChange={(e) => setWaRecipients(e.target.value)} placeholder="+91 98765 43210, +91 91234 56789" />
                  </FormField>
                  <div className="grid grid-cols-[1fr_6rem] gap-3">
                    <FormField id="wa-template" label="Template name" hint="Lowercase with underscores.">
                      <Input id="wa-template" value={waTemplate} onChange={(e) => setWaTemplate(e.target.value)} placeholder="ashniva_alert" />
                    </FormField>
                    <FormField id="wa-lang" label="Language">
                      <Input id="wa-lang" value={waLanguage} onChange={(e) => setWaLanguage(e.target.value)} placeholder="en" />
                    </FormField>
                  </div>
                </div>
              )}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Which workspaces</legend>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={allWorkspaces} onCheckedChange={(on) => setAllWorkspaces(on === true)} />
                  All workspaces and organization-wide alerts
                </label>
                {several && allWorkspaces && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    Alerts from every workspace, with campaign names and spend, will reach this channel. For a client-facing channel, pick only that client&apos;s workspace.
                  </p>
                )}
                {!allWorkspaces && (
                  <div className="space-y-1.5 rounded-lg border p-3">
                    {org.workspaces.map((w) => (
                      <label key={w.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={workspaceIds.includes(w.id)}
                          onCheckedChange={(on) => setWorkspaceIds((cur) => (on === true ? [...cur, w.id] : cur.filter((id) => id !== w.id)))}
                        />
                        {w.name}
                      </label>
                    ))}
                    {workspaceIds.length === 0 && <p className="text-xs text-destructive">Pick at least one workspace.</p>}
                  </div>
                )}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Which alerts</legend>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={events.length === 0} onCheckedChange={(on) => on === true && setEvents([])} />
                  All alerts
                </label>
                <div className="space-y-1.5 rounded-lg border p-3">
                  {ALERT_GROUPS.map((g) => (
                    <label key={g.key} className="flex items-start gap-2 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={events.includes(g.key)}
                        onCheckedChange={(on) => setEvents((cur) => (on === true ? [...cur, g.key] : cur.filter((k) => k !== g.key)))}
                      />
                      <span>
                        {g.label}
                        <span className="block text-xs text-muted-foreground">{g.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}
          <DialogFooter>
            {secret ? (
              <Button onClick={close}>Done</Button>
            ) : (
              <Button onClick={save} disabled={busy || name.trim().length < 2 || (!editing && !channelReady) || !scopeValid}>
                {busy && <Loader2 className="animate-spin" />} {editing ? "Save changes" : "Add channel"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
