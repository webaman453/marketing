import { BUILDER_SPECS, newDraft, type BuilderDraft, type DraftDTO } from "@ashniva/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn(), apiUpload: vi.fn() }));

import { api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { apiCalls, makeAi, makeWsAccount, renderWithProviders, routeApi, type Handler } from "@/test-utils";
import { CampaignBuilder } from "./campaign-builder";

const spec = BUILDER_SPECS.META;

function dto(o: Partial<DraftDTO> = {}, payload?: BuilderDraft): DraftDTO {
  return {
    id: "d_1",
    name: "Festive",
    status: "DRAFT",
    payload: (payload ?? newDraft(spec, "acc_1", { objective: "OUTCOME_TRAFFIC" }, "Festive")) as unknown as Record<string, unknown>,
    results: null,
    createdBy: null,
    launchedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...o,
  };
}

function routes(extra: Record<string, Handler> = {}) {
  return routeApi(api, {
    "GET /workspaces/ws_1/creatives": [],
    "GET /workspaces/ws_1/ad-accounts": [makeWsAccount()],
    "GET /orgs/org_1/ad-accounts": [],
    "GET /workspaces/ws_1/ai/status": makeAi(),
    "GET /workspaces/ws_1/builder/options": {},
    "POST /workspaces/ws_1/drafts": (o: { body?: { name?: string } } | undefined) => dto({ id: "d_new", name: o?.body?.name ?? "" }),
    "PATCH /workspaces/ws_1/drafts/:id": {},
    ...extra,
  });
}

/** The tree button whose main label is exactly `label`. */
const treeButton = (label: string) => within(screen.getByRole("navigation")).getByText(label, { selector: "span" }).closest("button")!;
const findTreeButton = async (label: string) => {
  await screen.findByRole("navigation");
  return within(screen.getByRole("navigation")).findByText(label, { selector: "span" }).then((el) => el.closest("button")!);
};

beforeEach(() => {
  vi.mocked(api).mockReset();
  navigation.reset({ pathname: "/w/ws_1/campaigns/new" });
  window.history.replaceState(null, "", "/w/ws_1/campaigns/new?platform=META&objective=OUTCOME_TRAFFIC");
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CampaignBuilder", () => {
  it("starts on the start screen and autosaves a new draft, keeping the existing query params", async () => {
    routes();
    const { user } = renderWithProviders(<CampaignBuilder initial={null} />);
    await user.click(await screen.findByRole("button", { name: /Meta Ads/ }));
    await user.click(screen.getByRole("radio", { name: "Traffic" }));
    await user.type(screen.getByLabelText("Campaign name"), "Festive Sale");
    await user.click(screen.getByRole("button", { name: /Continue/ }));

    expect(await screen.findByRole("textbox", { name: "Campaign name" })).toHaveValue("Festive Sale");
    expect(screen.getByText(/Saves automatically/)).toBeInTheDocument();
    await waitFor(() => expect(apiCalls(api)).toContain("POST /workspaces/ws_1/drafts"), { timeout: 3000 });
    await waitFor(() => expect(screen.getByText(/Draft saved/)).toBeInTheDocument());
    const params = new URLSearchParams(window.location.search);
    expect(window.location.pathname).toBe("/w/ws_1/campaigns/new");
    expect(params.get("draft")).toBe("d_new");
    expect(params.get("platform")).toBe("META");
    expect(params.get("objective")).toBe("OUTCOME_TRAFFIC");
    const body = vi.mocked(api).mock.calls.find((c) => c[1]?.method === "POST")![1]!.body as { name: string; payload: BuilderDraft };
    expect(body.name).toBe("Festive Sale");
    expect(body.payload.platform).toBe("META");
  });

  it("an existing draft only saves after an edit, with PATCH", async () => {
    routes();
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    const name = await screen.findByRole("textbox", { name: "Campaign name" });
    expect(screen.getByText(/· Draft$/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1000));
    expect(apiCalls(api).filter((c) => !c.startsWith("GET"))).toEqual([]);
    await user.type(name, "!");
    await waitFor(() => expect(apiCalls(api)).toContain("PATCH /workspaces/ws_1/drafts/d_1"), { timeout: 3000 });
    const patch = vi.mocked(api).mock.calls.find((c) => c[1]?.method === "PATCH")![1]!.body as { name: string };
    expect(patch.name).toBe("Festive!");
  });

  it("says when a save fails", async () => {
    routes({ "PATCH /workspaces/ws_1/drafts/:id": () => Promise.reject(new Error("offline")) });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.type(await screen.findByRole("textbox", { name: "Campaign name" }), "x");
    expect(await screen.findByText(/Couldn't save, retrying on next change/, {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("shows the tree with issue counts that turn red after a review attempt", async () => {
    routes();
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    const ad = await findTreeButton("Ad 1");
    const badge = within(ad).getByTitle(/things? left to fill/);
    expect(Number(badge.textContent)).toBeGreaterThan(0);
    expect(badge).toHaveClass("bg-muted");
    expect(treeButton("Festive")).toBeInTheDocument();
    expect(treeButton("Ad set 1")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /Review & publish/ })[0]!);
    expect(await screen.findByText("Pre-publish checks")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    const strong = within(await findTreeButton("Ad 1")).getByTitle(/left to fill/);
    expect(strong).toHaveClass("bg-destructive");
    expect(screen.getByText(/needs? attention before publishing\./)).toBeInTheDocument();
  });

  it("auto-selects the only Facebook Page, so its issue disappears", async () => {
    routes();
    const first = renderWithProviders(<CampaignBuilder initial={dto()} />);
    const before = Number(within(await findTreeButton("Ad 1")).getByTitle(/left to fill/).textContent);
    first.unmount();
    routes({ "GET /workspaces/ws_1/builder/options": { pages: [{ id: "p1", name: "Acme Page" }] } });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await waitFor(() => {
      const after = Number(within(treeButton("Ad 1")).queryByTitle(/left to fill/)?.textContent ?? 0);
      expect(after).toBe(before - 1);
    });
    await user.click(treeButton("Ad 1"));
    expect(await screen.findByRole("combobox", { name: /Facebook Page/ })).toHaveTextContent("Acme Page");
  });

  it("shows a field's problem only after the person leaves it", async () => {
    routes();
    const { user, container } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await screen.findByRole("textbox", { name: "Campaign name" });
    const field = container.querySelector<HTMLInputElement>("#f-name")!;
    await user.clear(field);
    expect(screen.queryByText("Campaign name is required.")).not.toBeInTheDocument();
    await user.tab();
    expect(await screen.findByText("Campaign name is required.")).toBeInTheDocument();
    // Tree label falls back to the level name.
    expect(within(screen.getByRole("navigation")).getAllByText("Campaign", { selector: "span" })).toHaveLength(2);
  });

  it("moves through nodes with Next/Back and adds, duplicates and deletes ad sets", async () => {
    routes();
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await screen.findByRole("button", { name: /Next: Ad set/ }));
    expect(await screen.findByRole("button", { name: /Next: Ad/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next: Ad/ }));
    expect(screen.getAllByRole("button", { name: /Review & publish/ })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: /^Ad set$/ }));
    await user.click(screen.getByRole("button", { name: /^Campaign$/ }));
    await user.click(screen.getByRole("button", { name: /Campaigns/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/campaigns");

    await user.click(screen.getByRole("button", { name: /Add ad set/ }));
    expect(treeButton("Ad set 2")).toBeInTheDocument();
    await user.click(within(screen.getByRole("navigation")).getAllByRole("button", { name: "Duplicate" })[0]!);
    expect(treeButton("Ad set 1 – Copy")).toBeInTheDocument();
    const deletes = within(screen.getByRole("navigation")).getAllByRole("button", { name: "Delete" });
    await user.click(deletes[0]!);
    expect(within(screen.getByRole("navigation")).queryByText("Ad set 1", { selector: "span" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /Add ad$/ })[0]!);
    expect(treeButton("Ad 2")).toBeInTheDocument();
  });

  it("Fix on the review screen goes back and scrolls to the field", async () => {
    routes();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const { user } = renderWithProviders(<CampaignBuilder initial={dto({ status: "FAILED", results: [{ adGroupKey: null, error: "Page missing" } as never] })} />);
    // A failed draft opens on the review screen.
    expect(await screen.findByText("Pre-publish checks")).toBeInTheDocument();
    const fix = screen.getAllByRole("button", { name: "Fix" });
    expect(fix.length).toBeGreaterThan(0);
    await user.click(fix[0]!);
    await waitFor(() => expect(scroll).toHaveBeenCalled(), { timeout: 2000 });
    const el = scroll.mock.contexts[0] as HTMLElement;
    expect(el.id).toMatch(/^f-/);
    scroll.mockRestore();
  });

  it("Fill with AI is offered when AI is available, and sends people to buy tokens when it can't be used", async () => {
    routes({ "GET /workspaces/ws_1/ai/status": makeAi({ available: true, canUse: false, balance: 0 }) });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await screen.findByRole("button", { name: /Buy AI tokens/ }));
    expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/settings/ai");
  });

  it("Fill with AI asks for a brief and merges the AI's values", async () => {
    routes({
      "GET /workspaces/ws_1/ai/status": makeAi({ available: true, canUse: true, balance: 50_000 }),
      "POST /workspaces/ws_1/ai/builder/fill": { campaign: { name: "AI name" }, adGroup: {}, ad: {}, notes: ["Done"] },
    });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await screen.findByRole("button", { name: /Fill with AI/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What are you advertising?"), "Festive kurtas");
    await user.click(within(dialog).getByRole("button", { name: /Fill with AI/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Campaign name" })).toHaveValue("AI name"));
    const call = vi.mocked(api).mock.calls.find((c) => String(c[0]).endsWith("/ai/builder/fill"))!;
    expect((call[1]!.body as { brief: { product: string } }).brief.product).toBe("Festive kurtas");
  });

  it("opens the preview sheet", async () => {
    routes();
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await screen.findByRole("button", { name: /Preview/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Ad preview")).toBeInTheDocument();
    expect(within(sheet).getByText(/Previews are approximate/)).toBeInTheDocument();
  });

  it("saves edits still waiting for the autosave timer when the builder unmounts", async () => {
    routes();
    const { user, unmount } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    const name = await screen.findByRole("textbox", { name: "Campaign name" });
    await user.type(name, " Sale");
    expect(apiCalls(api)).not.toContain("PATCH /workspaces/ws_1/drafts/d_1");
    unmount();
    await waitFor(() => expect(apiCalls(api)).toContain("PATCH /workspaces/ws_1/drafts/d_1"));
    const patch = vi.mocked(api).mock.calls.find((c) => c[1]?.method === "PATCH")![1]!.body as { name: string };
    expect(patch.name).toBe("Festive Sale");
    // The URL now belongs to wherever the person went.
    expect(new URLSearchParams(window.location.search).get("draft")).toBeNull();
  });

  it("doesn't save on unmount when nothing changed", async () => {
    routes();
    const { unmount } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await screen.findByRole("textbox", { name: "Campaign name" });
    unmount();
    await act(async () => {});
    expect(apiCalls(api).some((c) => c.startsWith("PATCH") || c.startsWith("POST"))).toBe(false);
  });

  it("explains a failed options request and retries it", async () => {
    let fail = true;
    routes({
      "GET /workspaces/ws_1/builder/options": () => {
        if (fail) throw new Error("Meta didn't respond.");
        return { pages: [{ id: "p1", name: "Acme Store" }] };
      },
    });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await findTreeButton("Ad 1"));
    const alerts = await screen.findAllByRole("alert");
    const alert = alerts.find((a) => /Couldn.t load/.test(a.textContent ?? ""))!;
    expect(alert).toHaveTextContent("Meta didn't respond.");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(screen.queryByText(/Couldn.t load/)).not.toBeInTheDocument());
  });

  it("names the zone schedule times are in", async () => {
    routes({ "GET /workspaces/ws_1/ad-accounts": [{ ...makeWsAccount(), timezone: "America/New_York" }] });
    const { user } = renderWithProviders(<CampaignBuilder initial={dto()} />);
    await user.click(await findTreeButton("Ad set 1"));
    expect((await screen.findAllByText("Times are in America/New_York (ad account time zone)")).length).toBeGreaterThan(0);
  });

  it("ignores payloads that aren't builder drafts", async () => {
    routes();
    renderWithProviders(<CampaignBuilder initial={dto({ payload: { version: 1 } })} />);
    expect(await screen.findByText("Where do you want to advertise?")).toBeInTheDocument();
    await act(async () => {});
  });
});
