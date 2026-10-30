import { VISIBLE_PLATFORMS } from "@ashniva/shared";
import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { makeWsAccount, renderWithProviders, routeApi } from "@/test-utils";
import AdFormatsPage from "./page";

beforeEach(() => {
  vi.mocked(api).mockReset();
  navigation.reset({ pathname: "/w/ws_1/formats" });
  routeApi(api, { "GET /workspaces/ws_1/ad-accounts": [makeWsAccount(), makeWsAccount({ id: "a2" }), makeWsAccount({ id: "g", platform: "GOOGLE" })] });
});

describe("Ad formats page", () => {
  it("lists every shown platform with its account count and opens its form", async () => {
    const { user } = renderWithProviders(<AdFormatsPage />);
    const meta = (await screen.findByText("Meta Ads")).closest("button")!;
    await waitFor(() => expect(meta).toHaveTextContent("2 accounts"));
    expect(screen.getByText("Google Ads").closest("button")).toHaveTextContent("1 account");
    expect(screen.getByText("Snapchat Ads").closest("button")).toHaveTextContent("Not connected");
    expect(screen.queryByText("TikTok Ads")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(VISIBLE_PLATFORMS.length);
    for (const g of ["Social", "Search and shopping", "Native", "Audio and programmatic", "Stores"]) expect(screen.getByRole("heading", { name: g })).toBeInTheDocument();
    await user.click(meta);
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/campaigns/new?platform=META");
  });

  it("explains that the role can't create ads", () => {
    renderWithProviders(<AdFormatsPage />, { role: "ANALYST" });
    expect(screen.getByText("You can't create ads in this organization")).toBeInTheDocument();
    expect(screen.queryByText("Meta Ads")).not.toBeInTheDocument();
  });

  it("asks a locked org to choose a plan", () => {
    renderWithProviders(<AdFormatsPage />, { locked: true });
    expect(screen.getByText("Choose a plan to create ads")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a plan" })).toHaveAttribute("href", "/w/ws_1/settings/billing");
  });

  it("forwards ?platform= to Create campaign", async () => {
    navigation.reset({ pathname: "/w/ws_1/formats", search: { platform: "GOOGLE" } });
    const { container } = renderWithProviders(<AdFormatsPage />);
    await waitFor(() => expect(navigation.router.replace).toHaveBeenCalledWith("/w/ws_1/campaigns/new?platform=GOOGLE"));
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("ignores hidden or unknown platforms in ?platform=", async () => {
    navigation.reset({ pathname: "/w/ws_1/formats", search: { platform: "TIKTOK" } });
    renderWithProviders(<AdFormatsPage />);
    expect(await screen.findByText("Meta Ads")).toBeInTheDocument();
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });

  it("doesn't forward when the org is locked", () => {
    navigation.reset({ pathname: "/w/ws_1/formats", search: { platform: "GOOGLE" } });
    renderWithProviders(<AdFormatsPage />, { locked: true });
    expect(navigation.router.replace).not.toHaveBeenCalled();
  });
});
