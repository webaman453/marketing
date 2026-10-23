"use client";

import { BRAND, planHasFeature } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Info, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { FormField } from "@/components/form-field";
import { NoAccess } from "@/components/settings/no-access";
import { UpgradeCard } from "@/components/settings/upgrade-card";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useCatalog } from "@/lib/catalog";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk2, useApiKeys } from "@/lib/queries";

export default function ApiKeysPage() {
  const { org, workspace, can, me } = useWorkspace();
  useCatalog();
  const allowed = planHasFeature(org.plan, "public_api") && can("org:update");
  const keys = useApiKeys(org.id, allowed);
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!can("org:update")) return <NoAccess what="developer API keys" />;
  if (!allowed) {
    return (
      <UpgradeCard
        feature="public_api"
        workspaceId={workspace.id}
        description="Pull campaigns and performance into your own dashboards, BI tools or data warehouse with a REST API."
      />
    );
  }

  async function create() {
    setBusy(true);
    try {
      const res = await api<{ secret: string }>(`/orgs/${org.id}/api-keys`, { method: "POST", body: { name } });
      setSecret(res.secret);
      setName("");
      await queryClient.invalidateQueries({ queryKey: qk2.apiKeys(org.id) });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/orgs/${org.id}/api-keys/${id}`, { method: "DELETE" });
      toast.success("API key revoked");
      await queryClient.invalidateQueries({ queryKey: qk2.apiKeys(org.id) });
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-muted-foreground">
          These keys let your own tools <strong className="font-medium text-foreground">read data out of {BRAND.name}</strong> (Looker Studio, Power BI, scripts). You
          don&apos;t need them to connect Meta, Google or other ad platforms: that&apos;s a normal sign-in on{" "}
          <Link href={`/w/${workspace.id}/integrations`} className="font-medium text-primary hover:underline">Integrations</Link>.
          {me.user.isSuperAdmin && (
            <>
              {" "}Platform app keys (Meta App ID, Google OAuth client…) go in{" "}
              <Link href="/admin?tab=keys" className="font-medium text-primary hover:underline">Admin → API keys</Link>.
            </>
          )}
        </p>
      </div>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Developer API keys</CardTitle>
          <CardDescription>
            Read-only access to campaigns and metrics for every workspace in {org.name}.{" "}
            <Link href="/docs/api" target="_blank" className="font-medium text-primary hover:underline">API reference</Link>
          </CardDescription>
          <CardAction>
            <Button size="sm" onClick={() => setCreating(true)}><Plus /> New key</Button>
          </CardAction>
        </CardHeader>
        {keys.data?.length === 0 ? (
          <EmptyState icon={KeyRound} title="No API keys" description="Create a key to connect Looker Studio, Power BI, a data warehouse or your own scripts." />
        ) : (
          <ul className="divide-y">
            {keys.data?.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-6 py-3.5">
                <KeyRound className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{k.name}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-mono">{k.prefix}…</span> · created {timeAgo(k.createdAt)}
                    {k.createdBy && ` by ${k.createdBy}`} · {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : "never used"}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => revoke(k.id)}>
                  <Trash2 /> Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={creating}
        onOpenChange={(o) => {
          setCreating(o);
          if (!o) setSecret(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{secret ? "Copy your API key" : "New API key"}</DialogTitle>
            <DialogDescription>
              {secret ? "This is the only time the full key is shown. Store it somewhere safe." : "Name the key after where it'll be used."}
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
            <FormField id="key-name" label="Name">
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Looker Studio" autoFocus />
            </FormField>
          )}
          <DialogFooter>
            {secret ? (
              <Button onClick={() => { setCreating(false); setSecret(null); }}>Done</Button>
            ) : (
              <Button onClick={create} disabled={busy || name.trim().length < 2}>
                {busy && <Loader2 className="animate-spin" />} Create key
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
