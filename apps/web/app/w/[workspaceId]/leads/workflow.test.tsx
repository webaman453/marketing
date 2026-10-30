/** Leads page: the extra filters (kept in the URL), sorting and page size, and the status/note workflow. */
import type { LeadDTO, LeadsResponse } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
// test-utils first: it installs the localStorage the date-range store needs.
import { hydrateDateRange, makeLead, makeLeads, renderWithProviders, routeApi } from "@/test-utils";
import { useDateRangeStore } from "@/lib/date-range";
import LeadsPage from "./page";

type Q = Record<string, unknown>;
const leadQueries = () => vi.mocked(api).mock.calls.filter((c) => c[0] === "/workspaces/ws_1/leads").map((c) => c[1]!.query as Q);
/** The page's own URL, which it keeps in step with the view. */
const lastUrl = () => new URL(window.location.href);

const facets = {
  byAdGroup: [
    { id: "g_1", name: "Ad set 1", count: 2 },
    { id: "g_2", name: "Retargeting", count: 1 },
  ],
  byAd: [
    { id: "ad_1", name: "Ad 1", count: 2 },
    { id: "ad_2", name: "Video ad", count: 1 },
  ],
  byForm: [
    { id: "form_1", name: "Diwali form", count: 2 },
    { id: "form_2", name: "Quote form", count: 1 },
  ],
};

function leadsApi(answer: (q: Q) => LeadsResponse, patch?: (body: Record<string, unknown>, id: string) => LeadDTO) {
  return routeApi(api, {
    "GET /workspaces/ws_1/leads": (o) => answer((o?.query ?? {}) as Q),
    "PATCH /workspaces/ws_1/leads/:id": (o, p) => (patch ? patch(o!.body as Record<string, unknown>, p.id!) : makeLead({ id: p.id, ...(o!.body as object) })),
  });
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  hydrateDateRange();
  navigation.reset({ pathname: "/w/ws_1/leads", search: { platform: "META" } });
  window.history.replaceState(null, "", "/w/ws_1/leads?platform=META");
});

describe("Lead filters", () => {
  it("opens a shared link with its filters, sort, page size and date range", async () => {
    // This browser last used a custom range; the link's preset must win.
    useDateRangeStore.setState({ preset: "custom", custom: { from: "2026-01-01", to: "2026-01-02" } });
    navigation.reset({
      pathname: "/w/ws_1/leads",
      search: { platform: "META", status: "QUALIFIED", hasPhone: "true", adGroupId: "g_2", origin: "paid", sort: "cost", pageSize: "100", range: "7d" },
    });
    leadsApi(() => makeLeads(facets));
    renderWithProviders(<LeadsPage />);
    await screen.findByText("Ravi Kumar");
    await waitFor(() => expect(useDateRangeStore.getState().preset).toBe("7d"));
    // The link's range replaces the remembered one, and the URL keeps naming it.
    await waitFor(() => expect(lastUrl().searchParams.get("range")).toBe("7d"));
    expect(lastUrl().searchParams.get("from")).toBeNull();
    await waitFor(() =>
      expect(leadQueries().at(-1)).toMatchObject({ platform: "META", status: "QUALIFIED", hasPhone: "true", adGroupId: "g_2", origin: "paid", sort: "cost", pageSize: 100, page: 1 }),
    );
    expect(screen.getByRole("combobox", { name: "Ad set" })).toHaveValue("g_2");
    expect(screen.getByRole("combobox", { name: "Phone" })).toHaveValue("true");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("cost");
    expect(screen.getByRole("combobox", { name: "Rows per page" })).toHaveValue("100");
    expect(screen.getByRole("button", { name: /^Qualified/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("combines ad set, ad, form, phone, email and organic filters in the list, the URL and the export", async () => {
    leadsApi(() => makeLeads(facets));
    const { user } = renderWithProviders(<LeadsPage />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Ad set" }), "g_2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Ad" }), "ad_2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Form" }), "form_2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Phone" }), "true");
    await user.selectOptions(screen.getByRole("combobox", { name: "Email" }), "false");
    await user.selectOptions(screen.getByRole("combobox", { name: "Paid or organic" }), "organic");
    const want = { adGroupId: "g_2", adId: "ad_2", formId: "form_2", hasPhone: "true", hasEmail: "false", origin: "organic" };
    await waitFor(() => expect(leadQueries().at(-1)).toMatchObject({ ...want, page: 1 }));
    await waitFor(() => expect(Object.fromEntries(lastUrl().searchParams)).toMatchObject({ platform: "META", range: "30d", ...want }));
    expect(lastUrl().pathname).toBe("/w/ws_1/leads");
    const href = new URL(screen.getByRole("link", { name: /Export CSV/ }).getAttribute("href")!, "http://x");
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ platform: "META", ...want });

    await user.click(screen.getByRole("button", { name: "Clear filters (6)" }));
    await waitFor(() => expect(leadQueries().at(-1)).toEqual(expect.not.objectContaining({ adGroupId: expect.anything() })));
    expect(screen.queryByRole("button", { name: /Clear filters/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Phone" })).toHaveValue("");
  });

  it("filters by status from the status counts, which keep their numbers", async () => {
    const counts = [
      { status: "NEW" as const, count: 4 },
      { status: "CONTACTED" as const, count: 2 },
      { status: "QUALIFIED" as const, count: 1 },
      { status: "WON" as const, count: 0 },
      { status: "LOST" as const, count: 3 },
    ];
    leadsApi(() => makeLeads({ byStatus: counts }));
    const { user } = renderWithProviders(<LeadsPage />);
    const group = await screen.findByRole("group", { name: "Lead status" });
    expect(within(group).getByRole("button", { name: "All statuses 10" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Contacted 2" })).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "Lost 3" }));
    await waitFor(() => expect(leadQueries().at(-1)).toMatchObject({ status: "LOST", page: 1 }));
    expect(within(group).getByRole("button", { name: "Lost 3" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(lastUrl().searchParams.get("status")).toBe("LOST"));
  });

  it("sorts and changes the page size, back on page 1", async () => {
    leadsApi((q) => makeLeads({ total: 300, page: Number(q.page), pageSize: Number(q.pageSize) }));
    const { user } = renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("Page 1 of 6")).toBeInTheDocument();
    expect(leadQueries().at(-1)).toMatchObject({ sort: "newest", pageSize: 50 });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page 2 of 6")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Rows per page" }), "100");
    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort" }), "campaign");
    await waitFor(() => expect(leadQueries().at(-1)).toMatchObject({ sort: "campaign", pageSize: 100, page: 1 }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining(["Newest first", "Oldest first", "Campaign (A–Z)", "Highest est. cost"]));
  });
});

describe("Lead status and notes", () => {
  it("changes a lead's status from the table right away", async () => {
    let status = "NEW";
    leadsApi(
      () => makeLeads({ leads: [makeLead({ status: status as LeadDTO["status"] })] }),
      (body, id) => {
        status = String(body.status);
        return makeLead({ id, status: status as LeadDTO["status"], statusUpdatedAt: "2026-10-21T09:00:00.000Z", statusUpdatedBy: { id: "user_1", name: "Asha Verma" } });
      },
    );
    const { user } = renderWithProviders(<LeadsPage />);
    const select = await screen.findByRole("combobox", { name: "Status of Ravi Kumar" });
    expect(select).toHaveValue("NEW");
    await user.selectOptions(select, "CONTACTED");
    expect(screen.getByRole("combobox", { name: "Status of Ravi Kumar" })).toHaveValue("CONTACTED");
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/workspaces/ws_1/leads/lead_1", { method: "PATCH", body: { status: "CONTACTED" } }));
    // Changing the status doesn't open the lead.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("puts the status back when saving fails", async () => {
    routeApi(api, {
      "GET /workspaces/ws_1/leads": makeLeads(),
      "PATCH /workspaces/ws_1/leads/:id": () => {
        throw new Error("Network down");
      },
    });
    const { user } = renderWithProviders(<LeadsPage />);
    await user.selectOptions(await screen.findByRole("combobox", { name: "Status of Ravi Kumar" }), "WON");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Status of Ravi Kumar" })).toHaveValue("NEW"));
  });

  it("edits the status and the note in the lead's dialog", async () => {
    const lead = makeLead({ note: "Call back", statusUpdatedAt: "2026-10-21T09:00:00.000Z", statusUpdatedBy: { id: "user_2", name: "Meera Shah" } });
    leadsApi(() => makeLeads({ leads: [lead] }), (body, id) => ({ ...lead, id, ...body }) as LeadDTO);
    const { user } = renderWithProviders(<LeadsPage />);
    expect(await screen.findByText("Call back")).toBeInTheDocument();
    await user.click(screen.getByText("Ravi Kumar"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Updated 21 Oct 2026 by Meera Shah/)).toBeInTheDocument();
    const note = within(dialog).getByLabelText("Note");
    expect(note).toHaveValue("Call back");
    const save = within(dialog).getByRole("button", { name: "Save note" });
    expect(save).toBeDisabled();
    await user.clear(note);
    await user.type(note, "  Wants a quote for 3 rooms  ");
    await user.click(save);
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/workspaces/ws_1/leads/lead_1", { method: "PATCH", body: { note: "Wants a quote for 3 rooms" } }));
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Lead status" }), "QUALIFIED");
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/workspaces/ws_1/leads/lead_1", { method: "PATCH", body: { status: "QUALIFIED" } }));
  });

  it("won't save a note over 2,000 characters", async () => {
    leadsApi(() => makeLeads());
    const { user } = renderWithProviders(<LeadsPage />);
    await user.click(await screen.findByText("Ravi Kumar"));
    const dialog = await screen.findByRole("dialog");
    const note = within(dialog).getByLabelText("Note");
    await user.click(note);
    await user.paste("x".repeat(2001));
    expect(within(dialog).getByText("2,001 / 2,000")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save note" })).toBeDisabled();
  });

  it.each(["CLIENT", "ANALYST"] as const)("%s sees status and note but can't change them", async (role) => {
    leadsApi(() => makeLeads({ leads: [makeLead({ status: "WON", note: "Signed" })] }));
    const { user } = renderWithProviders(<LeadsPage />, { role });
    await screen.findByText("Ravi Kumar");
    expect(screen.queryByRole("combobox", { name: /Status of/ })).not.toBeInTheDocument();
    expect(within(screen.getByText("Ravi Kumar").closest("tr")!).getByText("Won")).toBeInTheDocument();
    await user.click(screen.getByText("Ravi Kumar"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save note" })).not.toBeInTheDocument();
    expect(within(dialog).getByText("Signed")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.some((c) => (c[1] as { method?: string } | undefined)?.method === "PATCH")).toBe(false);
  });
});
