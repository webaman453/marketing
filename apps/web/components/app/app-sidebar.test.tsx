import type { Role } from "@ashniva/shared";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { makeMe, makeOrg, makeWorkspace, renderWithProviders, routeApi } from "@/test-utils";
import { AppSidebar } from "./app-sidebar";

const renderSidebar = (o: Parameters<typeof renderWithProviders>[1] = {}) => renderWithProviders(<AppSidebar />, { sidebar: true, ...o });
const link = (name: string) => screen.queryByRole("link", { name });

beforeEach(() => {
  navigation.reset({ pathname: "/w/ws_1/campaigns/c_9" });
  vi.mocked(api).mockReset();
});

describe("AppSidebar gating", () => {
  it.each<[Role, boolean, boolean]>([
    ["OWNER", true, true],
    ["ADMIN", true, true],
    ["MANAGER", true, false],
    ["ANALYST", false, false],
    ["CLIENT", false, false],
  ])("%s: Ad formats %s, Activity log %s", (role, formats, activity) => {
    renderSidebar({ role });
    expect(Boolean(link("Ad formats"))).toBe(formats);
    expect(Boolean(link("Activity log"))).toBe(activity);
    // Everyone sees the basics.
    for (const name of ["Overview", "Reports", "Campaigns", "Leads", "Creatives", "Automations", "Integrations", "Settings"]) expect(link(name)).toBeInTheDocument();
  });

  it("shows Platform admin only to the super admin", () => {
    const { unmount } = renderSidebar();
    expect(link("Platform admin")).not.toBeInTheDocument();
    unmount();
    renderSidebar({ superAdmin: true });
    expect(link("Platform admin")).toHaveAttribute("href", "/admin");
  });

  it("links into the workspace and marks the current section active", () => {
    renderSidebar();
    expect(link("Campaigns")).toHaveAttribute("href", "/w/ws_1/campaigns");
    expect(link("Campaigns")).toHaveAttribute("data-active", "true");
    expect(link("Overview")).toHaveAttribute("data-active", "false");
  });
});

describe("AppSidebar trial card", () => {
  it("counts down the trial days", () => {
    const ends = new Date(Date.now() + 5 * 86_400_000).toISOString();
    renderSidebar({ org: { plan: "TRIAL", trialEndsAt: ends, subscriptionStatus: "TRIALING" } });
    expect(screen.getByText("Free trial")).toBeInTheDocument();
    expect(screen.getByText(/^[45] days left$/)).toBeInTheDocument();
    expect(link("View plans")).toHaveAttribute("href", "/w/ws_1/settings/billing");
  });

  it("is hidden for paid plans and trials without an end date", () => {
    const { unmount } = renderSidebar();
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument();
    unmount();
    renderSidebar({ org: { plan: "TRIAL", trialEndsAt: null } });
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument();
  });
});

describe("AppSidebar menus", () => {
  it("switches workspace and offers New workspace only to managers of workspaces", async () => {
    const ws2 = makeWorkspace({ id: "ws_2", name: "Clients" });
    const org = makeOrg({ workspaces: [makeWorkspace(), ws2] });
    const { user, unmount } = renderSidebar({ me: makeMe({ orgs: [org] }) });
    await user.click(screen.getByRole("button", { name: /Main workspace/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Clients/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_2/overview");
    await user.click(screen.getByRole("button", { name: /Main workspace/ }));
    await user.click(await screen.findByRole("menuitem", { name: /New workspace/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/settings/workspaces?new=1");
    unmount();

    const r = renderSidebar({ role: "MANAGER", me: makeMe({ orgs: [makeOrg({ role: "MANAGER" })] }) });
    await r.user.click(screen.getByRole("button", { name: /Main workspace/ }));
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /New workspace/ })).not.toBeInTheDocument();
  });

  it("user menu: profile, admin for super admins, and sign out", async () => {
    routeApi(api, { "POST /auth/logout": undefined });
    const { user, queryClient } = renderSidebar({ superAdmin: true });
    const clear = vi.spyOn(queryClient, "clear");
    await user.click(screen.getByRole("button", { name: /Asha Verma/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Profile/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/settings/profile");
    await user.click(screen.getByRole("button", { name: /Asha Verma/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Platform admin/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/admin");
    await user.click(screen.getByRole("button", { name: /Asha Verma/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Sign out/ }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
    expect(clear).toHaveBeenCalled();
    expect(vi.mocked(api)).toHaveBeenCalledWith("/auth/logout", { method: "POST" });
  });

  it("signs out even if the logout request fails", async () => {
    vi.mocked(api).mockRejectedValue(new Error("offline"));
    const { user } = renderSidebar();
    await user.click(screen.getByRole("button", { name: /Asha Verma/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Sign out/ }));
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/login"));
  });
});
