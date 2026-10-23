"use client";

import { PLATFORM_INFO, credentialGroupFor, type ConnectionDTO, type CredentialGroupId, type Platform } from "@ashniva/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Trash2,
  Unplug,
  XCircle,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { CredentialDialog } from "@/components/admin/credentials-panel";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, ErrorState } from "@/components/app/states";
import { useWorkspace } from "@/components/app/workspace-context";
import { PlatformIcon } from "@/components/platform-icon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { qk, useAdAccounts, useConnections, usePlatforms, type PlatformCatalogItem } from "@/lib/queries";
import { cn } from "@/lib/utils";

const UNASSIGNED = "__none__";

export default function IntegrationsPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Integrations"
        description="Connect your ad platforms and choose which ad accounts report into each workspace."
      />
      <Suspense>
        <OAuthResultNotice />
      </Suspense>
      <HowConnectingWorks />
      <PlatformsSection />
      <ConnectionsSection />
      <AdAccountsSection />
    </div>
  );
}

/** Reads ?connected= / ?error= set by the OAuth callback and shows a toast once. */
function OAuthResultNotice() {
  const params = useSearchParams();
  const router = useRouter();
  const { workspace } = useWorkspace();

  useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error) return;
    if (connected && connected in PLATFORM_INFO) {
      const n = Number(params.get("accounts") ?? 0);
      toast.success(`${PLATFORM_INFO[connected as Platform].name} connected`, {
        description: `${n} ad ${n === 1 ? "account" : "accounts"} found. Your data is syncing now.`,
      });
    }
    if (error) toast.error("Connection failed", { description: error });
    router.replace(`/w/${workspace.id}/integrations`);
  }, [params, router, workspace.id]);

  return null;
}

function HowConnectingWorks() {
  const steps = [
    ["Click Connect", "Pick a platform below. Nobody needs to copy API keys: it's a normal sign-in."],
    ["Sign in and allow access", "Use the login that can see your ad accounts (e.g. your Business Manager or MCC admin)."],
    ["Choose a workspace", "Found ad accounts appear below. Assign each to a workspace and its data syncs automatically."],
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border bg-border md:grid-cols-3">
      {steps.map(([title, body], i) => (
        <div key={title} className="flex gap-3 bg-card px-4 py-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{i + 1}</span>
          <div>
            <div className="text-sm font-medium">{title}</div>
            <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ───────────────────────── Platforms ─────────────────────────

function PlatformsSection() {
  const { org, workspace, can, me } = useWorkspace();
  const platforms = usePlatforms(org.id);
  const connections = useConnections(org.id);
  const [connecting, setConnecting] = useState<Platform | null>(null);
  const [settingUp, setSettingUp] = useState<CredentialGroupId | null>(null);
  const isOwner = me.user.isSuperAdmin;

  async function connect(p: Platform) {
    setConnecting(p);
    try {
      const { url } = await api<{ url: string }>(`/orgs/${org.id}/connections/${p.toLowerCase()}/authorize`, {
        method: "POST",
        body: { workspaceId: workspace.id },
      });
      window.location.assign(url);
    } catch (err) {
      toastError(err);
      setConnecting(null);
    }
  }

  const liveCount = (p: Platform) =>
    connections.data?.filter((c) => c.platform === p && c.mode === "LIVE" && c.status !== "REVOKED").length ?? 0;

  return (
    <section className="space-y-3">
      <SectionTitle
        title="Ad platforms"
        description={
          isOwner
            ? "Connect signs in with the saved app. Change API keys to throw that app away and paste a new App ID and secret."
            : "Sign in once per platform. Your team never has to share passwords."
        }
      />
      {platforms.isError ? (
        <Card><ErrorState message={platforms.error.message} onRetry={() => platforms.refetch()} /></Card>
      ) : !platforms.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {platforms.data.map((p, i) => (
            <PlatformCard
              key={p.id}
              platform={p}
              connected={liveCount(p.id)}
              canManage={can("integrations:manage")}
              loading={connecting === p.id}
              onConnect={() => connect(p.id)}
              onSetUp={isOwner ? () => setSettingUp(credentialGroupFor(p.id)?.id ?? null) : undefined}
              style={{ animationDelay: `${i * 35}ms` }}
            />
          ))}
        </div>
      )}
      {isOwner && <CredentialDialog groupId={settingUp} onClose={() => setSettingUp(null)} />}
    </section>
  );
}

function PlatformCard({
  platform: p,
  connected,
  canManage,
  loading,
  onConnect,
  onSetUp,
  style,
}: {
  platform: PlatformCatalogItem;
  connected: number;
  canManage: boolean;
  loading: boolean;
  onConnect: () => void;
  /** Only for the platform owner: opens the API key setup. */
  onSetUp?: () => void;
  style?: React.CSSProperties;
}) {
  const comingSoon = !p.supported;
  return (
    <Card
      className={cn("gap-4 p-5 transition-shadow animate-fade-up hover:shadow-md", comingSoon && "bg-muted/30 hover:shadow-none")}
      style={style}
    >
      <div className="flex items-start justify-between gap-3">
        <PlatformIcon platform={p.id} size="lg" className={cn(comingSoon && "opacity-60 grayscale-[35%]")} />
        {connected > 0 ? (
          <Badge className="gap-1 border-success/20 bg-success/10 text-success" variant="outline">
            <CheckCircle2 className="size-3" /> Connected
          </Badge>
        ) : comingSoon ? (
          <Badge variant="secondary">Coming soon</Badge>
        ) : null}
      </div>
      <div className="space-y-1">
        <h3 className="font-semibold">{p.name}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{p.description}</p>
      </div>
      <div className="flex flex-wrap gap-1">
        {p.channels.slice(0, 4).map((ch) => (
          <span key={ch} className="rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {ch}
          </span>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-2">
        {comingSoon ? (
          <Button variant="outline" size="sm" className="w-full" disabled>
            On the roadmap
          </Button>
        ) : !p.configured && onSetUp ? (
          <Button size="sm" className="w-full" onClick={onSetUp}>
            <KeyRound /> Add API keys
          </Button>
        ) : !p.configured ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block">
                <Button variant="outline" size="sm" className="w-full" disabled>
                  Not available yet
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">
              Connecting {p.name} isn&apos;t switched on yet. Ask your Ashniva administrator, or load sample data below to try the product.
            </TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Button size="sm" variant={connected ? "outline" : "default"} className="w-full" disabled={!canManage || loading} onClick={onConnect}>
              {loading ? <Loader2 className="animate-spin" /> : <Plug />}
              {connected ? "Connect another login" : "Connect"}
            </Button>
            {onSetUp && (
              <Button size="sm" variant="ghost" className="w-full" onClick={onSetUp}>
                <KeyRound /> Change API keys
              </Button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ───────────────────────── Connections ─────────────────────────

function ConnectionsSection() {
  const { org, workspace, can, me } = useWorkspace();
  const queryClient = useQueryClient();
  const connections = useConnections(org.id);
  const [removing, setRemoving] = useState<ConnectionDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = can("integrations:manage");
  const hasSample = connections.data?.some((c) => c.mode === "DEMO");

  const refresh = () =>
    Promise.all(
      ["connections", "ad-accounts", "overview", "campaigns", "me", "workspace-ad-accounts"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );

  async function sync(c: ConnectionDTO) {
    try {
      await api(`/orgs/${org.id}/connections/${c.id}/sync`, { method: "POST" });
      queryClient.setQueryData<ConnectionDTO[]>(qk.connections(org.id), (list) =>
        list?.map((x) => (x.id === c.id ? { ...x, syncStatus: "QUEUED" } : x)),
      );
      toast.success("Sync started", { description: "Fresh data will appear in a minute." });
      void queryClient.invalidateQueries({ queryKey: qk.connections(org.id) });
    } catch (err) {
      toastError(err);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/orgs/${org.id}/connections/${removing.id}`, { method: "DELETE" });
      toast.success(`${PLATFORM_INFO[removing.platform].name} disconnected`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function sampleData(action: "add" | "remove") {
    setBusy(true);
    try {
      if (action === "add") {
        await api(`/orgs/${org.id}/sample-data`, { method: "POST", body: { workspaceId: workspace.id } });
        toast.success("Sample data is loading");
      } else {
        await api(`/orgs/${org.id}/sample-data`, { method: "DELETE" });
        toast.success("Sample data removed");
      }
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle title="Connections" description="Logins your organization has authorized, and their sync health." />
        {canManage && connections.data && (
          <Button variant="outline" size="sm" className="bg-card" disabled={busy} onClick={() => sampleData(hasSample ? "remove" : "add")}>
            <FlaskConical />
            {hasSample ? "Remove sample data" : "Load sample data"}
          </Button>
        )}
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        {connections.isError ? (
          <ErrorState message={connections.error.message} onRetry={() => connections.refetch()} />
        ) : !connections.data ? (
          <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : connections.data.length === 0 ? (
          <EmptyState icon={Unplug} title="No connections yet" description="Connect a platform above to start syncing campaigns and performance data." />
        ) : (
          <ul className="divide-y">
            {connections.data.map((c) => (
              <li key={c.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <PlatformIcon platform={c.platform} size="md" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{PLATFORM_INFO[c.platform].name}</span>
                      {c.mode === "DEMO" && <Badge variant="secondary" className="h-5 text-[10px]">Sample data</Badge>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.mode === "DEMO" ? "Simulated account for exploring the product" : c.externalUserName ?? "Connected login"}
                      {c.connectedBy && c.mode === "LIVE" && <> · added by {c.connectedBy}</>}
                      {" · "}
                      {c.adAccountCount} {c.adAccountCount === 1 ? "account" : "accounts"}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 sm:justify-end">
                  <SyncBadge connection={c} />
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="Connection actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={c.syncStatus === "RUNNING" || c.syncStatus === "QUEUED"}
                          onSelect={() => sync(c)}
                        >
                          <RefreshCw /> Sync now
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(c)}>
                          <Trash2 /> Disconnect
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {removing && PLATFORM_INFO[removing.platform].name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {removing?.adAccountCount} ad {removing?.adAccountCount === 1 ? "account" : "accounts"} and all synced
              campaigns and history will be removed from every workspace. Your campaigns on the platform itself are not
              affected.
              {me.user.isSuperAdmin &&
                " The saved App ID and secret stay. To use a different app, click Change API keys on that platform's card, paste the new keys, then Connect."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              {busy && <Loader2 className="animate-spin" />}
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function SyncBadge({ connection: c }: { connection: ConnectionDTO }) {
  if (c.status === "EXPIRED") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
        <XCircle className="size-3.5" /> Access expired · reconnect
      </span>
    );
  }
  if (c.syncStatus === "QUEUED" || c.syncStatus === "RUNNING") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary">
        <Loader2 className="size-3.5 animate-spin" /> {c.syncStatus === "QUEUED" ? "Queued" : "Syncing…"}
      </span>
    );
  }
  if (c.syncStatus === "FAILED") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-help items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3.5" /> Sync failed
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{c.lastSyncError ?? "Unknown error"}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="size-1.5 rounded-full bg-success" />
      {c.lastSyncedAt ? `Synced ${timeAgo(c.lastSyncedAt)}` : "Waiting for first sync"}
    </span>
  );
}

// ───────────────────────── Ad accounts ─────────────────────────

function AdAccountsSection() {
  const { org, can } = useWorkspace();
  const queryClient = useQueryClient();
  const accounts = useAdAccounts(org.id);
  const canManage = can("integrations:manage");

  async function assign(accountId: string, workspaceId: string | null) {
    try {
      await api(`/orgs/${org.id}/ad-accounts/${accountId}`, { method: "PATCH", body: { workspaceId } });
      toast.success(workspaceId ? "Ad account assigned" : "Ad account unassigned");
      await Promise.all(
        ["ad-accounts", "overview", "campaigns", "me", "workspace-ad-accounts", "connections"].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
    } catch (err) {
      toastError(err);
    }
  }

  if (accounts.data && accounts.data.length === 0) return null;

  return (
    <section className="space-y-3">
      <SectionTitle
        title="Ad accounts"
        description="Assign each account to a workspace. Only assigned accounts are synced and counted in reports."
      />
      <Card className="gap-0 overflow-hidden py-0">
        {!accounts.data ? (
          <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Account</TableHead>
                <TableHead className="hidden md:table-cell">Account ID</TableHead>
                <TableHead className="hidden sm:table-cell">Currency</TableHead>
                <TableHead className="hidden lg:table-cell">Last synced</TableHead>
                <TableHead className="pr-4 text-right">Workspace</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-4">
                    <div className="flex items-center gap-2.5">
                      <PlatformIcon platform={a.platform} size="sm" />
                      <span className="font-medium">{a.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{a.externalId}</TableCell>
                  <TableCell className="hidden sm:table-cell">{a.currency}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {a.lastSyncedAt ? timeAgo(a.lastSyncedAt) : "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {canManage ? (
                      <Select
                        value={a.workspaceId ?? UNASSIGNED}
                        onValueChange={(v) => assign(a.id, v === UNASSIGNED ? null : v)}
                      >
                        <SelectTrigger size="sm" className="ml-auto w-[190px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value={UNASSIGNED}>
                            <span className="text-muted-foreground">Not assigned</span>
                          </SelectItem>
                          {org.workspaces.map((w) => (
                            <SelectItem key={w.id} value={w.id}>
                              {w.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-sm">{a.workspaceName ?? "Not assigned"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </section>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
