import "./polyfills";
import type { BuilderOptions, CreativeDTO, MeResponse, OrgDTO, Platform, Role, WorkspaceDTO } from "@ashniva/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { configure, render, type RenderOptions } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import { WorkspaceProvider } from "@/components/app/workspace-context";
import { BuilderEnvProvider, emptyBrief, type BuilderEnv } from "@/components/builder/builder-context";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDateRangeStore } from "@/lib/date-range";
import { makeMe, makeOrg, makeWorkspace } from "./fixtures";

// Radix/cmdk-heavy screens are slow to render on a busy machine; give findBy*/waitFor and tests more room.
configure({ asyncUtilTimeout: 4000 });
vi.setConfig({ testTimeout: 30_000 });

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
}

export interface ProviderOptions {
  role?: Role;
  locked?: boolean;
  superAdmin?: boolean;
  org?: Partial<OrgDTO>;
  workspace?: Partial<WorkspaceDTO>;
  me?: MeResponse;
  queryClient?: QueryClient;
  /** Wrap in SidebarProvider (needed by anything using useSidebar). */
  sidebar?: boolean;
  /** Skip the WorkspaceProvider, for components that don't read it. */
  noWorkspace?: boolean;
  /** Seed the query cache before rendering: [queryKey, data][] */
  seed?: [readonly unknown[], unknown][];
}

export function workspaceValue(opts: ProviderOptions = {}) {
  const workspace = makeWorkspace(opts.workspace);
  const org = makeOrg({ role: opts.role ?? "OWNER", locked: opts.locked ?? false, workspaces: [workspace], ...opts.org });
  const me = opts.me ?? makeMe({ user: { isSuperAdmin: opts.superAdmin ?? false }, orgs: [org] });
  return { me, org, workspace };
}

/** Marks the date-range store as read from storage, so date-bound queries run. */
export function hydrateDateRange() {
  useDateRangeStore.setState({ hydrated: true, preset: "30d", custom: null });
}

export function renderWithProviders(ui: ReactElement, opts: ProviderOptions & Omit<RenderOptions, "wrapper"> = {}) {
  const queryClient = opts.queryClient ?? makeQueryClient();
  for (const [key, data] of opts.seed ?? []) queryClient.setQueryData(key, data);
  const ws = workspaceValue(opts);
  function Wrapper({ children }: { children: ReactNode }) {
    let inner = children;
    if (opts.sidebar) inner = <SidebarProvider>{inner}</SidebarProvider>;
    if (!opts.noWorkspace)
      inner = (
        <WorkspaceProvider me={ws.me} org={ws.org} workspace={ws.workspace}>
          {inner}
        </WorkspaceProvider>
      );
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={0}>{inner}</TooltipProvider>
      </QueryClientProvider>
    );
  }
  const user = userEvent.setup();
  const result = render(ui, { wrapper: Wrapper, ...opts });
  return { ...result, user, queryClient, ...ws };
}

export function makeBuilderEnv(o: Partial<BuilderEnv> = {}): BuilderEnv {
  return {
    workspaceId: "ws_1",
    platform: "META" as Platform,
    adAccountId: "acc_1",
    currency: "INR",
    options: {} as BuilderOptions,
    optionsLoading: false,
    creatives: [] as CreativeDTO[],
    ai: undefined,
    brief: emptyBrief(),
    setBrief: () => {},
    requestBrief: () => {},
    adContext: "",
    onAiUsed: () => {},
    ...o,
  };
}

/** Renders inside a BuilderEnvProvider (plus the normal providers). */
export function renderWithBuilder(ui: ReactElement, env: Partial<BuilderEnv> = {}, opts: ProviderOptions = {}) {
  const value = makeBuilderEnv(env);
  return { ...renderWithProviders(<BuilderEnvProvider value={value}>{ui}</BuilderEnvProvider>, opts), env: value };
}
