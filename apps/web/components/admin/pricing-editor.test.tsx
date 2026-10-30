import { defaultCatalog, type Catalog } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { toast } from "sonner";
import { api } from "@/lib/api";
import { renderWithProviders, routeApi } from "@/test-utils";
import { PricingEditor } from "./pricing-editor";

function setup(o: { catalog?: Catalog; custom?: boolean } = {}) {
  const catalog = o.catalog ?? defaultCatalog();
  routeApi(api, {
    "GET /admin/settings/catalog": { catalog, defaults: defaultCatalog(), custom: o.custom ?? false, updatedAt: o.custom ? new Date().toISOString() : null },
    "PUT /admin/settings/catalog": (opts) => ({ catalog: opts?.body }),
    "DELETE /admin/settings/catalog": { catalog: defaultCatalog() },
  });
  return renderWithProviders(<PricingEditor />, { noWorkspace: true });
}

const planCard = (id: string) => screen.getByText(id, { selector: "[data-slot=badge]" }).closest<HTMLElement>("[data-slot=card]")!;
const byId = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /Save prices/ });
const status = () => saveButton().parentElement!.querySelector("span")!;

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast.success).mockClear();
});

describe("PricingEditor", () => {
  it("loads the price list and starts with nothing to save", async () => {
    setup();
    expect(await screen.findByLabelText("Free trial length")).toHaveValue("14");
    expect(screen.getByText("You're on the default prices.", { exact: false })).toBeInTheDocument();
    expect(status()).toHaveTextContent("All changes saved.");
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Reset to defaults/ })).not.toBeInTheDocument();
    // GST hint on a plan price.
    expect(within(planCard("STARTER")).getByText("₹3,539 with 18% GST")).toBeInTheDocument();
  });

  it("NumberInput keeps typing smooth: digits only, empty while editing, restored on blur", async () => {
    const { user } = setup();
    const trial = await screen.findByLabelText("Free trial length");
    await user.clear(trial);
    expect(trial).toHaveValue("");
    await user.type(trial, "3x0");
    expect(trial).toHaveValue("30");
    expect(status()).toHaveTextContent("You have unsaved changes.");
    expect(within(planCard("TRIAL")).getByText("Limits during the 30-day trial")).toBeInTheDocument();
    await user.clear(trial);
    await user.tab();
    // An empty box goes back to the last good value.
    expect(trial).toHaveValue("30");
  });

  it("decimal steps keep fractions; whole-number fields round", async () => {
    const { user } = setup();
    const gst = await screen.findByLabelText("GST added at checkout");
    await user.clear(gst);
    await user.type(gst, "12.5");
    expect(within(planCard("STARTER")).getByText(/with 12.5% GST/)).toBeInTheDocument();
    const price = byId("STARTER-price");
    await user.clear(price);
    await user.type(price, "1000.6");
    expect(within(planCard("STARTER")).getByText(/^₹1,126 with/)).toBeInTheDocument();
  });

  it("shows validation problems and blocks saving", async () => {
    const { user } = setup();
    const trial = await screen.findByLabelText("Free trial length");
    await user.clear(trial);
    await user.type(trial, "400");
    expect(status()).toHaveTextContent(/^trialDays: /);
    expect(status()).toHaveClass("text-destructive");
    expect(saveButton()).toBeDisabled();
  });

  it("flags plan names that are too short", async () => {
    const { user } = setup();
    await screen.findByLabelText("Free trial length");
    await user.clear(byId("GROWTH-name"));
    await user.type(byId("GROWTH-name"), "G");
    expect(status()).toHaveTextContent(/plans › GROWTH › name/);
  });

  it("Unlimited toggles swap the number box for a label and back to 5", async () => {
    const { user } = setup();
    await screen.findByLabelText("Free trial length");
    const starter = planCard("STARTER");
    const boxes = within(starter).getAllByRole("checkbox", { name: "Unlimited" });
    expect(byId("STARTER-workspaces")).toBeInTheDocument();
    await user.click(boxes[0]!);
    expect(document.getElementById("STARTER-workspaces")).toBeNull();
    await user.click(within(planCard("STARTER")).getAllByRole("checkbox", { name: "Unlimited" })[0]!);
    expect(byId("STARTER-workspaces")).toHaveValue("5");
  });

  it("only one plan can be Most popular", async () => {
    const { user } = setup();
    await screen.findByLabelText("Free trial length");
    const [starter, growth, agency] = screen.getAllByRole("switch", { name: /Most popular/ });
    expect(growth).toHaveAttribute("aria-checked", "true");
    await user.click(starter!);
    expect(screen.getAllByRole("switch", { name: /Most popular/ }).map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await user.click(screen.getAllByRole("switch", { name: /Most popular/ })[0]!);
    expect(screen.getAllByRole("switch", { name: /Most popular/ }).map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(agency).toBeInTheDocument();
    expect(within(planCard("TRIAL")).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("only one token pack can be Popular; packs can be added and removed", async () => {
    const { user } = setup();
    await screen.findByLabelText("Free trial length");
    const n = defaultCatalog().tokenPacks.length;
    await user.click(screen.getByRole("button", { name: /Add pack/ }));
    expect(screen.getByDisplayValue(`Pack ${n + 1}`)).toBeInTheDocument();
    const switches = () => screen.getAllByRole("switch", { name: "Popular" });
    expect(switches()).toHaveLength(n + 1);
    await user.click(switches()[n]!);
    expect(switches().filter((s) => s.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(switches()[n]).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("button", { name: `Remove Pack ${n + 1}` }));
    expect(screen.queryByDisplayValue(`Pack ${n + 1}`)).not.toBeInTheDocument();
  });

  it("can't remove the last pack or add more than eight", async () => {
    const one = defaultCatalog();
    one.tokenPacks = [{ id: "solo", name: "Solo", tokens: 100_000, price: 99 }];
    const { user } = setup({ catalog: one });
    expect(await screen.findByRole("button", { name: "Remove Solo" })).toBeDisabled();
    for (let i = 0; i < 7; i++) await user.click(screen.getByRole("button", { name: /Add pack/ }));
    expect(screen.getByRole("button", { name: /Add pack/ })).toBeDisabled();
  });

  it("asks for unique pack IDs", async () => {
    const dup = defaultCatalog();
    dup.tokenPacks = [
      { id: "same", name: "One", tokens: 100_000, price: 99 },
      { id: "same", name: "Two", tokens: 200_000, price: 199 },
    ];
    const { user } = setup({ catalog: dup });
    const trial = await screen.findByLabelText("Free trial length");
    await user.type(trial, "0");
    expect(status()).toHaveTextContent("Each token pack needs its own ID.");
  });

  it("features and highlights edit the plan", async () => {
    const { user } = setup();
    await screen.findByLabelText("Free trial length");
    const starter = planCard("STARTER");
    const first = within(starter).getAllByRole("checkbox").find((c) => !c.closest("label")!.textContent!.includes("Unlimited"))!;
    const was = first.getAttribute("data-state");
    await user.click(first);
    expect(first).toHaveAttribute("data-state", was === "checked" ? "unchecked" : "checked");
    const hl = byId("STARTER-highlights");
    await user.clear(hl);
    await user.type(hl, "  One  {Enter}{Enter}Two");
    await user.tab();
    expect(hl).toHaveValue("One\nTwo");
  });

  it("saves, discards and resets", async () => {
    const { user } = setup({ custom: true });
    const trial = await screen.findByLabelText("Free trial length");
    expect(screen.getByText(/Last saved/)).toBeInTheDocument();
    await user.clear(trial);
    await user.type(trial, "21");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(trial).toHaveValue("14");

    await user.clear(trial);
    await user.type(trial, "21");
    await user.click(saveButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Prices saved", expect.anything()));
    const put = vi.mocked(api).mock.calls.find((c) => c[1]?.method === "PUT")![1]!.body as Catalog;
    expect(put.trialDays).toBe(21);

    await user.click(screen.getByRole("button", { name: /Reset to defaults/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /Reset/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Prices reset to the defaults"));
  });
});
