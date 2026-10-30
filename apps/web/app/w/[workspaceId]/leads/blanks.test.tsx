import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { hydrateDateRange, makeLead, makeLeads, renderWithProviders, routeApi } from "@/test-utils";
import LeadsPage from "./page";

beforeEach(() => {
  vi.mocked(api).mockReset();
  hydrateDateRange();
  navigation.reset({ pathname: "/w/ws_1/leads", search: { platform: "META" } });
});

describe("Leads with missing details", () => {
  it("shows — instead of blank lines, and titles the dialog with the lead's display name", async () => {
    const bare = makeLead({ id: "l9", name: "", email: "only@example.com", phone: null, adName: null, formName: "  " });
    routeApi(api, { "GET /workspaces/ws_1/leads": makeLeads({ leads: [bare] }) });
    const { user } = renderWithProviders(<LeadsPage />);

    const name = await screen.findByText("only@example.com", { selector: ".font-medium" });
    const row = name.closest("tr")!;
    // Contact sub-line has the email; the ad/form line falls back to —.
    const cells = within(row).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("only@example.com");
    expect(within(cells[3]!).getAllByText("—").length).toBeGreaterThan(0);

    await user.click(name);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "only@example.com" })).toBeInTheDocument();
  });

  it("shows — when a lead has neither phone nor email", async () => {
    routeApi(api, { "GET /workspaces/ws_1/leads": makeLeads({ leads: [makeLead({ id: "l8", name: "Asha", phone: null, email: null })] }) });
    renderWithProviders(<LeadsPage />);
    const name = await screen.findByText("Asha", { selector: ".font-medium" });
    expect(name.nextElementSibling).toHaveTextContent(/^—$/);
  });
});
