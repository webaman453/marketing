import type { Role } from "@ashniva/shared";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));

import { navigation } from "@/test-utils/next-navigation";
import { renderWithProviders } from "@/test-utils";
import SettingsLayout from "./layout";

const labels = () => screen.getAllByRole("link").map((a) => a.textContent);

beforeEach(() => navigation.reset({ pathname: "/w/ws_1/settings/team" }));

describe("Settings layout navigation", () => {
  it.each<[Role, string[]]>([
    ["OWNER", ["General", "Workspaces", "Team", "Branding", "Developer API", "Plan & billing", "AI tokens", "Your profile", "Notifications"]],
    ["ADMIN", ["General", "Workspaces", "Team", "Branding", "Developer API", "AI tokens", "Your profile", "Notifications"]],
    ["MANAGER", ["General", "Workspaces", "Team", "AI tokens", "Your profile", "Notifications"]],
    ["ANALYST", ["General", "Workspaces", "Team", "AI tokens", "Your profile", "Notifications"]],
    ["CLIENT", ["General", "Workspaces", "Your profile", "Notifications"]],
  ])("%s sees the right sections", (role, expected) => {
    renderWithProviders(<SettingsLayout><p>child</p></SettingsLayout>, { role });
    expect(labels()).toEqual(expected);
  });

  it("links into the workspace, highlights the open section and renders the page", () => {
    renderWithProviders(<SettingsLayout><p>Team page body</p></SettingsLayout>);
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute("href", "/w/ws_1/settings/team");
    expect(screen.getByRole("link", { name: "Team" })).toHaveClass("bg-accent");
    expect(screen.getByRole("link", { name: "General" })).not.toHaveClass("bg-accent");
    expect(screen.getByText("Team page body")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });
});
