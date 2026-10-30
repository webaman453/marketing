import type { Role } from "@ashniva/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { hydrateDateRange, makeMe, makeOrg, makeWorkspace, renderWithProviders, routeApi } from "@/test-utils";
import { CommandMenu } from "./command-menu";

const campaigns = {
  campaigns: [
    { id: "c1", name: "Diwali Sale", platform: "META" },
    { id: "c2", name: "Hidden TikTok push", platform: "TIKTOK" },
  ],
};

async function open(o: Parameters<typeof renderWithProviders>[1] = {}) {
  routeApi(api, { "GET /workspaces/ws_1/campaigns": campaigns });
  const utils = renderWithProviders(<CommandMenu />, o);
  await utils.user.click(screen.getByRole("button", { name: /Search/ }));
  const dialog = await screen.findByRole("dialog");
  return { ...utils, dialog };
}

const item = (dialog: HTMLElement, name: string | RegExp) => within(dialog).queryByRole("option", { name });

beforeEach(() => {
  navigation.reset();
  vi.mocked(api).mockReset();
  hydrateDateRange();
});

describe("CommandMenu", () => {
  it.each<[Role, boolean, boolean]>([
    ["OWNER", true, true],
    ["MANAGER", true, false],
    ["ANALYST", false, false],
    ["CLIENT", false, false],
  ])("%s sees Ad formats: %s, Activity log: %s", async (role, formats, activity) => {
    const { dialog } = await open({ role });
    expect(Boolean(item(dialog, /Ad formats/))).toBe(formats);
    expect(Boolean(item(dialog, /Activity log/))).toBe(activity);
    expect(item(dialog, /Overview/)).toBeInTheDocument();
    expect(item(dialog, /Platform admin/)).not.toBeInTheDocument();
  });

  it("shows Platform admin to the super admin", async () => {
    const { dialog } = await open({ superAdmin: true });
    expect(item(dialog, /Platform admin/)).toBeInTheDocument();
  });

  it("lists campaigns from shown platforms only and opens them", async () => {
    const { dialog, user } = await open();
    const sale = await within(dialog).findByRole("option", { name: /Diwali Sale/ });
    expect(item(dialog, /Hidden TikTok push/)).not.toBeInTheDocument();
    await user.click(sale);
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/campaigns/c1");
  });

  it("goes to a page and closes", async () => {
    const { dialog, user } = await open();
    await user.click(item(dialog, /Integrations/)!);
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/integrations");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers workspace switching only with more than one workspace", async () => {
    const first = await open();
    expect(within(first.dialog).queryByText("Switch workspace")).not.toBeInTheDocument();
    first.unmount();
    const org = makeOrg({ workspaces: [makeWorkspace(), makeWorkspace({ id: "ws_2", name: "Clients" })] });
    const { dialog, user } = await open({ me: makeMe({ orgs: [org] }) });
    await user.click(item(dialog, /Clients/)!);
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_2/overview");
  });

  it("filters by typing and toggles with ⌘K", async () => {
    const { dialog, user } = await open();
    await user.type(within(dialog).getByPlaceholderText(/Search pages/), "zzzz-nothing");
    expect(within(dialog).getByText("No results found.")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("has a theme switch", async () => {
    const { dialog } = await open();
    expect(item(dialog, /Switch to dark mode/)).toBeInTheDocument();
  });
});
