import type { LeadsResponse } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { hydrateDateRange, makeLead, makeLeads, renderWithProviders, routeApi } from "@/test-utils";
import LeadsPage from "./page";

type Q = Record<string, unknown>;

/** Leads endpoint whose answer depends on the filters, like the API's. */
function leadsApi(answer: (q: Q) => LeadsResponse) {
  return routeApi(api, { "GET /workspaces/ws_1/leads": (o) => answer((o?.query ?? {}) as Q) });
}
const leadQueries = () => vi.mocked(api).mock.calls.filter((c) => c[0] === "/workspaces/ws_1/leads").map((c) => c[1]!.query as Q);

beforeEach(() => {
  vi.mocked(api).mockReset();
  hydrateDateRange();
  navigation.reset({ pathname: "/w/ws_1/leads", search: { platform: "META" } });
});

describe("Leads gallery", () => {
  it("lists Meta with its count and the platforms coming soon", async () => {
    navigation.reset({ pathname: "/w/ws_1/leads" });
    leadsApi(() => makeLeads({ byPlatform: [{ platform: "META", count: 7 }] }));
    const { user } = renderWithProviders(<LeadsPage />);
    const meta = (await screen.findByText("7 leads")).closest("button")!;
    expect(screen.getByText("Lead sync coming soon")).toBeInTheDocument();
    expect(screen.getByText("Google Ads")).toBeInTheDocument();
    expect(screen.queryByText("TikTok Ads")).not.toBeInTheDocument();
    expect(leadQueries()[0]).toMatchObject({ page: 1, pageSize: 1 });
    await user.click(meta);
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/leads?platform=META");
  });

  it("falls back to the gallery for hidden platforms", async () => {
    navigation.reset({ pathname: "/w/ws_1/leads", search: { platform: "TIKTOK" } });
    leadsApi(() => makeLeads({ byPlatform: [] }));
    renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("No leads")).toBeInTheDocument();
  });
});

describe("Platform leads", () => {
  it("shows KPIs, the table and a lead's details", async () => {
    leadsApi(() => makeLeads({ leads: [makeLead(), makeLead({ id: "l2", name: null, email: "anon@example.com", source: "ig", estCost: null })] }));
    const { user } = renderWithProviders(<LeadsPage />);
    expect(await screen.findByRole("heading", { name: "Meta Ads leads" })).toBeInTheDocument();
    expect((await screen.findByText("Busiest hour")).nextElementSibling).toHaveTextContent("10 AM");
    expect(screen.getByText("Top source").nextElementSibling).toHaveTextContent("Facebook");
    expect(screen.getByText("Est. cost per lead").nextElementSibling).toHaveTextContent("₹120.00");
    expect(screen.getByText("anon@example.com", { selector: ".font-medium" })).toBeInTheDocument();
    await user.click(screen.getByText("Ravi Kumar"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("full name")).toBeInTheDocument();
    expect(within(dialog).getByText("Pune")).toBeInTheDocument();
    expect(within(dialog).getByText(/est\. ₹120\.00/)).toBeInTheDocument();
  });

  it("source buttons stay when one is chosen", async () => {
    leadsApi((q) =>
      q.source
        ? makeLeads({ bySource: [{ source: String(q.source), count: 1 }] })
        : makeLeads({ bySource: [{ source: "fb", count: 3 }, { source: "an", count: 1 }] }),
    );
    const { user } = renderWithProviders(<LeadsPage />);
    const names = () => ["All sources", "Facebook", "Instagram", "Audience Network"].map((n) => Boolean(screen.queryByRole("button", { name: n })));
    await screen.findByRole("button", { name: "Audience Network" });
    expect(names()).toEqual([true, true, true, true]);
    await user.click(screen.getByRole("button", { name: "Audience Network" }));
    await waitFor(() => expect(leadQueries().some((q) => q.source === "an")).toBe(true));
    // The filtered answer only knows "an"; the other buttons come from the unfiltered counts.
    await waitFor(() => expect(leadQueries().some((q) => q.pageSize === 1 && !q.source)).toBe(true));
    expect(names()).toEqual([true, true, true, true]);
    expect(screen.getByRole("button", { name: "Audience Network" })).toHaveAttribute("data-variant", "default");
    await user.click(screen.getByRole("button", { name: "All sources" }));
    expect(screen.getByRole("button", { name: "All sources" })).toHaveAttribute("data-variant", "default");
  });

  it("the campaign filter stays once a campaign is chosen", async () => {
    const two = [
      { campaignId: "c_1", name: "Diwali leads", count: 2, cost: 100 },
      { campaignId: "c_2", name: "Wedding leads", count: 1, cost: 50 },
    ];
    leadsApi((q) => (q.campaignId ? makeLeads({ byCampaign: two.filter((c) => c.campaignId === q.campaignId) }) : makeLeads({ byCampaign: two })));
    const { user } = renderWithProviders(<LeadsPage />);
    const select = await screen.findByRole("combobox", { name: "Campaign" });
    await user.selectOptions(select, "c_2");
    await waitFor(() => expect(leadQueries().some((q) => q.campaignId === "c_2")).toBe(true));
    expect(screen.getByRole("combobox", { name: "Campaign" })).toHaveValue("c_2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Campaign" }), "");
    await waitFor(() => expect(leadQueries().at(-1)!.campaignId).toBeUndefined());
  });

  it("keeps a chosen campaign the answer no longer lists", async () => {
    const two = [
      { campaignId: "c_1", name: "Diwali leads", count: 2, cost: 100 },
      { campaignId: "c_2", name: "Wedding leads", count: 1, cost: 50 },
    ];
    leadsApi((q) => (q.campaignId ? makeLeads({ leads: [], total: 0, byCampaign: [] }) : makeLeads({ byCampaign: two })));
    const { user } = renderWithProviders(<LeadsPage />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Campaign" }), "c_1");
    expect(await screen.findByRole("option", { name: "Selected campaign" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Campaign" })).toHaveValue("c_1");
    expect(screen.getByText("No leads from Meta Ads")).toBeInTheDocument();
  });

  it("hides the campaign filter with a single campaign", async () => {
    leadsApi(() => makeLeads());
    renderWithProviders(<LeadsPage />);
    await screen.findByText("Ravi Kumar");
    expect(screen.queryByRole("combobox", { name: "Campaign" })).not.toBeInTheDocument();
  });

  it("searches and pages through results", async () => {
    leadsApi((q) => makeLeads({ total: 30, page: Number(q.page), pageSize: 25 }));
    const { user } = renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText("Search name, email, phone…"), "ravi");
    await waitFor(() => expect(leadQueries().at(-1)).toMatchObject({ search: "ravi", page: 1 }));
  });

  it("builds the export link from the current filters", async () => {
    leadsApi(() => makeLeads());
    const { user } = renderWithProviders(<LeadsPage />);
    await user.click(await screen.findByRole("button", { name: "Facebook" }));
    const href = screen.getByRole("link", { name: /Export CSV/ }).getAttribute("href")!;
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/api/workspaces/ws_1/leads/export");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ platform: "META", source: "fb" });
    expect(url.searchParams.get("from")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("hides Export CSV from roles without leads:export", async () => {
    leadsApi(() => makeLeads());
    renderWithProviders(<LeadsPage />, { role: "ANALYST" });
    await screen.findByText("Ravi Kumar");
    expect(screen.queryByRole("link", { name: /Export CSV/ })).not.toBeInTheDocument();
  });

  it("explains when Meta couldn't read leads", async () => {
    leadsApi(() => makeLeads({ leadsError: "Reconnect Meta to grant leads_retrieval." }));
    renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("Leads couldn't be read from Meta")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Integrations" })).toHaveAttribute("href", "/w/ws_1/integrations");
  });

  it("empty state for other platforms says lead sync is coming", async () => {
    navigation.reset({ pathname: "/w/ws_1/leads", search: { platform: "GOOGLE" } });
    leadsApi(() => makeLeads({ leads: [], total: 0, bySource: [], byCampaign: [], byHour: Array(24).fill(0), summary: { total: 0, avgCost: null, totalCost: null, currency: "INR", withPhone: 0, withEmail: 0, organic: 0 } }));
    const { user } = renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("Lead sync for Google Ads is coming soon. Use Google Ads's own lead export for now.")).toBeInTheDocument();
    expect(screen.getByText("Busiest hour").nextElementSibling).toHaveTextContent("—");
    // Only "All sources" without Meta's fixed buttons.
    expect(screen.getByRole("button", { name: "All sources" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Facebook" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /All platforms/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/leads");
  });
});
