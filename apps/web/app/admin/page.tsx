"use client";

import {
  CREDENTIAL_GROUPS,
  PLANS,
  PLATFORM_INFO,
  type CredentialGroupId,
  type Platform,
} from "@ashniva/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  MoreHorizontal,
  Search,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useEffect, useState } from "react";
import { toast } from "sonner";
import { CredentialsPanel } from "@/components/admin/credentials-panel";
import { PricingEditor } from "@/components/admin/pricing-editor";
import { Logo } from "@/components/brand";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, api } from "@/lib/api";
import { tokenCount, longDate, money, timeAgo } from "@/lib/format";
import { toastError } from "@/lib/forms";
import { useCatalog } from "@/lib/catalog";
import { useMe } from "@/lib/queries";

interface Stats {
  orgs: number;
  users: number;
  newOrgs30d: number;
  liveConnections: number;
  failingConnections: number;
  syncRuns24h: number;
  syncFailures24h: number;
  mrr: number;
  aiTokensUsedThisMonth: number;
  aiSalesThisMonth: number;
  byPlan: Record<string, number>;
}

interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  plan: keyof typeof PLANS;
  subscriptionStatus: string;
  trialEndsAt: string | null;
  locked: boolean;
  aiTokenBalance: number;
  owner: { name: string; email: string } | null;
  counts: {
    members: number;
    workspaces: number;
    adAccounts: number;
    connections: number;
  };
  createdAt: string;
}

interface SyncFailure {
  id: string;
  platform: Platform;
  mode: string;
  login: string | null;
  org: { id: string; name: string };
  error: string | null;
  startedAt: string;
}

const TABS = ["overview", "keys", "pricing"] as const;
type Tab = (typeof TABS)[number];

export default function AdminPage() {
  return (
    <Suspense>
      <AdminConsole />
    </Suspense>
  );
}

function AdminConsole() {
  const params = useSearchParams();
  const initialTab = (TABS as readonly string[]).includes(
    params.get("tab") ?? "",
  )
    ? (params.get("tab") as Tab)
    : "overview";
  const initialGroup = CREDENTIAL_GROUPS.some(
    (g) => g.id === params.get("group"),
  )
    ? (params.get("group") as CredentialGroupId)
    : null;
  const [tab, setTab] = useState<Tab>(initialTab);
  useCatalog();
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const allowed = me.data?.user.isSuperAdmin;

  useEffect(() => {
    if (me.data && !me.data.user.isSuperAdmin) router.replace("/app");
  }, [me.data, router]);

  const stats = useQuery({
    queryKey: ["admin-stats"],
    queryFn: () => api<Stats>("/admin/stats"),
    enabled: !!allowed,
  });
  const orgs = useQuery({
    queryKey: ["admin-orgs", query],
    queryFn: () => api<AdminOrg[]>("/admin/orgs", { query: { q: query } }),
    enabled: !!allowed,
  });
  const [granting, setGranting] = useState<AdminOrg | null>(null);
  const failures = useQuery({
    queryKey: ["admin-failures"],
    queryFn: () => api<SyncFailure[]>("/admin/sync-failures"),
    enabled: !!allowed,
  });

  async function update(
    org: AdminOrg,
    body: Record<string, unknown>,
    message: string,
  ) {
    try {
      await api(`/admin/orgs/${org.id}`, { method: "PATCH", body });
      toast.success(message, { description: org.name });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin-orgs"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-stats"] }),
      ]);
    } catch (err) {
      toastError(err);
    }
  }

  if (
    me.isError ||
    (stats.error instanceof ApiError && stats.error.status === 403)
  ) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        You don&apos;t have access to the admin panel.
      </div>
    );
  }

  const s = stats.data;
  const tiles = s
    ? [
        { label: "Monthly recurring revenue", value: money(s.mrr, "INR") },
        {
          label: "Organizations",
          value: `${s.orgs}`,
          sub: `+${s.newOrgs30d} in 30 days`,
        },
        { label: "Users", value: `${s.users}` },
        {
          label: "Live connections",
          value: `${s.liveConnections}`,
          sub: s.failingConnections
            ? `${s.failingConnections} need attention`
            : "All healthy",
        },
        {
          label: "Syncs (24h)",
          value: `${s.syncRuns24h}`,
          sub: `${s.syncFailures24h} failed`,
        },
        {
          label: "AI tokens used (this month)",
          value: tokenCount(s.aiTokensUsedThisMonth),
        },
        {
          label: "AI token sales (this month)",
          value: money(s.aiSalesThisMonth, "INR"),
        },
        {
          label: "Plans",
          value:
            Object.entries(s.byPlan)
              .map(
                ([p, n]) =>
                  `${PLANS[p as keyof typeof PLANS]?.name ?? p}: ${n}`,
              )
              .join(" · ") || "—",
          small: true,
        },
      ]
    : [];

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-5">
          <Logo />
          <Badge variant="secondary" className="gap-1">
            <ShieldCheck className="size-3" /> Platform admin
          </Badge>
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link href="/app">
              <ArrowLeft /> Back to app
            </Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl space-y-6 px-5 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">
            Platform admin
          </h1>
          <p className="text-sm text-muted-foreground">
            Organizations, integration keys and the prices every customer sees.
          </p>
        </div>
        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as Tab);
            window.history.replaceState(
              null,
              "",
              v === "overview" ? "/admin" : `/admin?tab=${v}`,
            );
          }}
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="keys">API keys &amp; integrations</TabsTrigger>
            <TabsTrigger value="pricing">Plans &amp; pricing</TabsTrigger>
          </TabsList>
          <TabsContent value="keys" className="mt-6">
            <CredentialsPanel initialGroup={initialGroup} />
          </TabsContent>
          <TabsContent value="pricing" className="mt-6">
            <PricingEditor />
          </TabsContent>
          <TabsContent value="overview" className="mt-6 space-y-6">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-4">
              {!s
                ? Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="bg-card p-4">
                      <Skeleton className="h-10" />
                    </div>
                  ))
                : tiles.map((t) => (
                    <div key={t.label} className="bg-card px-4 py-3.5">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t.label}
                      </div>
                      <div
                        className={
                          t.small
                            ? "mt-1 text-sm font-semibold"
                            : "mt-1 text-lg font-semibold tracking-tight tabular"
                        }
                      >
                        {t.value}
                      </div>
                      {t.sub && (
                        <div className="text-xs text-muted-foreground">
                          {t.sub}
                        </div>
                      )}
                    </div>
                  ))}
            </div>

            <Card className="gap-0 overflow-hidden py-0">
              <CardHeader className="border-b py-4">
                <CardTitle>Organizations</CardTitle>
                <div className="relative mt-2 max-w-sm">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search name, slug or owner email…"
                    className="h-8 pl-8"
                  />
                </div>
              </CardHeader>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-4">Organization</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Workspaces</TableHead>
                      <TableHead className="text-right">Ad accounts</TableHead>
                      <TableHead className="text-right">Members</TableHead>
                      <TableHead className="text-right">AI tokens</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="pr-4" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orgs.data?.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="pl-4">
                          <div className="font-medium">{o.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {o.slug}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{o.owner?.name ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">
                            {o.owner?.email}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant="secondary">
                              {PLANS[o.plan]?.name ?? o.plan}
                            </Badge>
                            {o.locked && (
                              <Badge variant="destructive">Locked</Badge>
                            )}
                          </div>
                          {o.plan === "TRIAL" && o.trialEndsAt && (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              ends {longDate(o.trialEndsAt.slice(0, 10))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {o.counts.workspaces}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {o.counts.adAccounts}
                        </TableCell>
                        <TableCell className="text-right tabular">
                          {o.counts.members}
                        </TableCell>
                        <TableCell
                          className={
                            o.aiTokenBalance <= 0
                              ? "text-right font-medium text-destructive tabular"
                              : "text-right tabular"
                          }
                        >
                          {tokenCount(Math.max(0, o.aiTokenBalance))}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {timeAgo(o.createdAt)}
                        </TableCell>
                        <TableCell className="pr-4 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Manage ${o.name}`}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel className="text-xs text-muted-foreground">
                                Set plan
                              </DropdownMenuLabel>
                              {(["STARTER", "GROWTH", "AGENCY"] as const).map(
                                (p) => (
                                  <DropdownMenuItem
                                    key={p}
                                    disabled={o.plan === p}
                                    onSelect={() =>
                                      update(
                                        o,
                                        { plan: p },
                                        `Moved to ${PLANS[p].name}`,
                                      )
                                    }
                                  >
                                    {PLANS[p].name}
                                  </DropdownMenuItem>
                                ),
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onSelect={() => setGranting(o)}>
                                Give AI tokens…
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() =>
                                  update(
                                    o,
                                    {
                                      plan: "TRIAL",
                                      subscriptionStatus: "TRIALING",
                                      extendTrialDays: 14,
                                    },
                                    "Trial extended by 14 days",
                                  )
                                }
                              >
                                Extend trial 14 days
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() =>
                                  update(
                                    o,
                                    { subscriptionStatus: "EXPIRED" },
                                    "Subscription expired",
                                  )
                                }
                              >
                                Mark expired
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>

            <Card className="gap-0 py-0">
              <CardHeader className="border-b py-4">
                <CardTitle>Recent sync failures</CardTitle>
                <CardDescription>
                  Connections that failed to sync, across all organizations.
                </CardDescription>
              </CardHeader>
              {failures.data?.length === 0 ? (
                <p className="px-6 py-8 text-center text-sm text-muted-foreground">
                  No sync failures. Everything is healthy.
                </p>
              ) : (
                <ul className="divide-y">
                  {failures.data?.map((f) => (
                    <li key={f.id} className="flex items-start gap-3 px-6 py-3">
                      <PlatformIcon platform={f.platform} size="sm" />
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="font-medium">
                          {f.org.name} · {PLATFORM_INFO[f.platform].name}
                          {f.login && ` · ${f.login}`}
                        </div>
                        <div className="truncate text-destructive">
                          {f.error}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(f.startedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
      <GrantTokensDialog org={granting} onClose={() => setGranting(null)} />
    </div>
  );
}

function GrantTokensDialog({
  org,
  onClose,
}: {
  org: AdminOrg | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [tokens, setTokens] = useState("100000");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!org) return;
    setBusy(true);
    try {
      await api(`/admin/orgs/${org.id}/ai-tokens`, {
        method: "POST",
        body: { tokens: Number(tokens), note },
      });
      toast.success(
        Number(tokens) > 0 ? "AI tokens added" : "AI tokens removed",
        { description: org.name },
      );
      await queryClient.invalidateQueries({ queryKey: ["admin-orgs"] });
      setNote("");
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!org} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Give AI tokens</DialogTitle>
          <DialogDescription>
            {org?.name} has {tokenCount(Math.max(0, org?.aiTokenBalance ?? 0))}{" "}
            tokens. Use a negative number to remove tokens.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="tokens" label="Tokens">
            <Input
              id="tokens"
              type="number"
              step={1000}
              value={tokens}
              onChange={(e) => setTokens(e.target.value)}
              className="tabular"
            />
          </FormField>
          <div className="flex flex-wrap gap-1.5">
            {[100_000, 500_000, 1_000_000, 5_000_000].map((n) => (
              <Button
                key={n}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setTokens(String(n))}
              >
                +{tokenCount(n)}
              </Button>
            ))}
          </div>
          <FormField
            id="note"
            label="Note (optional)"
            hint="Shown in the organization's token history."
          >
            <Input
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Bonus for annual plan"
              maxLength={200}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !Number(tokens)}>
            {busy && <Loader2 className="animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
