import { applyCatalog, defaultCatalog } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/razorpay", () => ({ loadRazorpay: vi.fn(async () => true) }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { toast } from "sonner";
import { api } from "@/lib/api";
import { makeBilling, renderWithProviders, routeApi, type Handler } from "@/test-utils";
import type { BillingInfo } from "@/lib/queries";
import BillingPage from "./page";

function setup(b: Partial<BillingInfo>, o: Parameters<typeof renderWithProviders>[1] = {}, extra: Record<string, Handler> = {}) {
  routeApi(api, { "GET /orgs/org_1/billing": makeBilling(b), "GET /catalog": defaultCatalog(), ...extra });
  return renderWithProviders(<BillingPage />, o);
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast.success).mockClear();
});
afterEach(() => applyCatalog(defaultCatalog()));

describe("Billing page", () => {
  it("shows No plan / Locked for sign-ups without a trial, and no trial bar", async () => {
    setup({ plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: null });
    expect(await screen.findByText("No plan")).toBeInTheDocument();
    expect(screen.getByText("Locked")).toBeInTheDocument();
    expect(screen.getByText("Choose a plan below to start using Ashniva Ads.")).toBeInTheDocument();
    expect(screen.queryByText(/days left/)).not.toBeInTheDocument();
  });

  it("shows the trial bar only with a trial end date", async () => {
    setup({ plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: days(4) });
    expect(await screen.findByText(/^[34] of 14 days left$/)).toBeInTheDocument();
    expect(screen.getByText(/Free trial ends/)).toBeInTheDocument();
    expect(screen.getByText("Trial")).toBeInTheDocument();
  });

  it("an extended trial longer than the standard length still fits the bar", async () => {
    setup({ plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: days(40) });
    expect(await screen.findByText(/^(39|40) of (39|40) days left$/)).toBeInTheDocument();
  });

  it("says when the trial has ended", async () => {
    setup({ plan: "TRIAL", subscriptionStatus: "EXPIRED", trialEndsAt: days(-3) });
    expect(await screen.findByText(/Free trial has ended/)).toBeInTheDocument();
    expect(screen.getByText("0 of 14 days left")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
  });

  it("paid plan: price, renewal date, usage meters and the current plan", async () => {
    setup({ plan: "GROWTH", subscriptionStatus: "ACTIVE", currentPeriodEnd: "2026-12-01T00:00:00.000Z", limits: { workspaces: 5, adAccounts: 10, members: null } });
    expect(await screen.findByText(/Renews on 1 Dec 2026 · ₹7,999\/month/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    const members = screen.getByText("Team members (incl. invites)").parentElement!;
    expect(members).toHaveTextContent("3 / Unlimited");
    expect(within(members).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Workspaces").parentElement).toHaveTextContent("1 / 5");
    expect(screen.getByRole("button", { name: "Your plan" })).toBeDisabled();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("without online checkout everyone gets Talk to sales; non-owners are told who can change the plan", async () => {
    setup({ checkoutEnabled: false }, { role: "ADMIN" });
    const links = await screen.findAllByRole("link", { name: "Talk to sales" });
    expect(links.length).toBe(2);
    expect(links[0]!.getAttribute("href")).toMatch(/^mailto:/);
    expect(screen.getByText(/Online checkout isn't enabled/)).toBeInTheDocument();
    expect(screen.getByText(/Only the organization owner can change the plan\./)).toBeInTheDocument();
  });

  it("owners with checkout can choose a plan through Razorpay", async () => {
    const open = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- typed so the test can read the options
    const Razorpay = vi.fn(function (this: { open: () => void }, _options: Record<string, unknown>) {
      this.open = open;
    });
    (window as unknown as { Razorpay: unknown }).Razorpay = Razorpay;
    const { user } = setup({ plan: "TRIAL", subscriptionStatus: "TRIALING", trialEndsAt: days(3), checkoutEnabled: true }, {}, {
      "POST /orgs/org_1/billing/checkout": { subscriptionId: "sub_1", keyId: "rzp_test" },
    });
    await user.click(await screen.findByRole("button", { name: "Choose Starter" }));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(Razorpay.mock.calls[0]![0]).toMatchObject({ key: "rzp_test", subscription_id: "sub_1", prefill: { email: "asha@example.com" } });
    delete (window as unknown as { Razorpay?: unknown }).Razorpay;
  });

  it("owners on razorpay can cancel", async () => {
    const { user } = setup({ provider: "razorpay", subscriptionStatus: "ACTIVE", currentPeriodEnd: "2026-12-01T00:00:00.000Z", checkoutEnabled: true }, {}, {
      "POST /orgs/org_1/billing/cancel": undefined,
    });
    expect(await screen.findAllByRole("button", { name: "Switch plan" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/keep full access until 1 Dec 2026/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Cancel subscription/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Subscription cancelled", expect.anything()));
  });

  it("follows the owner's catalog prices", async () => {
    const c = defaultCatalog();
    c.plans.STARTER.priceMonthly = 1234;
    c.gstPercent = 0;
    routeApi(api, { "GET /orgs/org_1/billing": makeBilling(), "GET /catalog": c });
    renderWithProviders(<BillingPage />);
    expect(await screen.findByText("₹1,234")).toBeInTheDocument();
    expect(screen.queryByText(/% GST/)).not.toBeInTheDocument();
  });
});
