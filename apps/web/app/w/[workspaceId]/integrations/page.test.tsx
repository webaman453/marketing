import type { ConnectionDTO } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { navigation } from "@/test-utils/next-navigation";
import { makeConnection, makeOrgAccount, makePlatform, makeWorkspace, renderWithProviders, routeApi, type Handler } from "@/test-utils";
import IntegrationsPage from "./page";

const PLATFORMS = [
  makePlatform("META"),
  makePlatform("GOOGLE", { configured: false }),
  makePlatform("OUTBRAIN", { connectsWithCredentials: true }),
  makePlatform("SHOPIFY"),
  makePlatform("NAUKRI", { supported: false, configured: false }),
];

const CREDS = {
  redirectUrls: { GOOGLE: "https://ads.example.com/api/oauth/google/callback" },
  webhookUrl: "https://ads.example.com/api/webhooks/razorpay",
  groups: [],
};

function setup(o: Parameters<typeof renderWithProviders>[1] & { connections?: ConnectionDTO[]; extra?: Record<string, Handler> } = {}) {
  routeApi(api, {
    "GET /orgs/org_1/platforms": PLATFORMS,
    "GET /orgs/org_1/connections": o.connections ?? [],
    "GET /orgs/org_1/ad-accounts": [],
    "GET /admin/settings/credentials": CREDS,
    ...o.extra,
  });
  return renderWithProviders(<IntegrationsPage />, o);
}

/** The card for a platform, found by its heading. */
const card = async (name: string) => (await screen.findByRole("heading", { name, level: 3 })).closest<HTMLElement>("[data-slot=card]")!;

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  navigation.reset({ pathname: "/w/ws_1/integrations" });
  assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, pathname: "/w/ws_1/integrations", search: "", assign } });
});
afterEach(() => vi.restoreAllMocks());

describe("Integrations · platform cards", () => {
  it("admin: Connect, Not available yet and On the roadmap", async () => {
    setup({ role: "ADMIN" });
    expect(within(await card("Meta Ads")).getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(within(await card("Google Ads")).getByRole("button", { name: "Not available yet" })).toBeDisabled();
    const naukri = await card("Naukri.com");
    expect(within(naukri).getByText("Coming soon")).toBeInTheDocument();
    expect(within(naukri).getByRole("button", { name: "On the roadmap" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Add API keys/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Change API keys/ })).not.toBeInTheDocument();
  });

  it("super admin: Add API keys on unconfigured platforms opens the key dialog", async () => {
    const { user } = setup({ superAdmin: true });
    expect(within(await card("Meta Ads")).getByRole("button", { name: /Change API keys/ })).toBeInTheDocument();
    const google = await card("Google Ads");
    await user.click(within(google).getByRole("button", { name: /Add API keys/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Google Ads (and YouTube)")).toBeInTheDocument();
    expect(await within(dialog).findByDisplayValue(CREDS.redirectUrls.GOOGLE)).toBeInTheDocument();
  });

  it("locked org: Connect is disabled and Choose a plan links to billing", async () => {
    setup({ locked: true, superAdmin: true });
    const meta = await card("Meta Ads");
    expect(within(meta).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(within(meta).getByRole("link", { name: /Choose a plan/ })).toHaveAttribute("href", "/w/ws_1/settings/billing");
    // The operator can still change keys on a locked org.
    expect(within(meta).getByRole("button", { name: /Change API keys/ })).toBeEnabled();
  });

  it("people who can't manage integrations can't connect", async () => {
    setup({ role: "ANALYST" });
    expect(within(await card("Meta Ads")).getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("shows Connected and offers another login when a live connection exists", async () => {
    setup({ connections: [makeConnection(), makeConnection({ id: "c_demo", mode: "DEMO" }), makeConnection({ id: "c_rev", platform: "SHOPIFY", status: "REVOKED" })] });
    const meta = await card("Meta Ads");
    await waitFor(() => expect(within(meta).getByText("Connected")).toBeInTheDocument());
    expect(within(meta).getByRole("button", { name: /Connect another login/ })).toBeInTheDocument();
    expect(within(await card("Shopify")).queryByText("Connected")).not.toBeInTheDocument();
  });

  it("Connect starts the OAuth sign-in", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/connections/meta/authorize": { url: "https://facebook.com/dialog/oauth?x" } } });
    await user.click(within(await card("Meta Ads")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://facebook.com/dialog/oauth?x"));
    expect(vi.mocked(api).mock.calls.find((c) => c[0] === "/orgs/org_1/connections/meta/authorize")![1]!.body).toEqual({ workspaceId: "ws_1" });
  });

  it("a failing Connect toasts and re-enables the button", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/connections/meta/authorize": () => { throw new Error("Meta is down"); } } });
    await user.click(within(await card("Meta Ads")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Meta is down"));
    expect(within(await card("Meta Ads")).getByRole("button", { name: "Connect" })).toBeEnabled();
  });
});

describe("Integrations · connect with the organization's own keys", () => {
  it("asks for the platform's keys and connects", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/connections/outbrain/credentials": { accounts: 2 } } });
    await user.click(within(await card("Outbrain")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Where to find them" })).toHaveAttribute("href", "https://developer.outbrain.com/home-page/amplify-api/");
    const token = within(dialog).getByLabelText("Amplify API token");
    expect(token).toHaveAttribute("type", "password");
    expect(within(dialog).queryByRole("button", { name: /Use the admin console keys/ })).not.toBeInTheDocument();
    await user.type(token, "tok_123");
    await user.click(within(dialog).getByRole("button", { name: /Check and connect/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Outbrain connected", { description: "2 ad accounts found. Your data is syncing now." }));
    const body = vi.mocked(api).mock.calls.find((c) => String(c[0]).endsWith("/credentials"))![1]!.body;
    expect(body).toEqual({ workspaceId: "ws_1", credentials: { apiToken: "tok_123" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows the server's message and field errors when the keys are wrong", async () => {
    const { user } = setup({
      extra: { "POST /orgs/org_1/connections/outbrain/credentials": () => { throw new ApiError(400, "BAD_KEYS", "Outbrain rejected the token", { apiToken: ["Token expired"] }); } },
    });
    await user.click(within(await card("Outbrain")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Amplify API token"), "bad");
    await user.click(within(dialog).getByRole("button", { name: /Check and connect/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Outbrain rejected the token");
    expect(within(dialog).getByText("Token expired")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Amplify API token")).toHaveAttribute("aria-invalid", "true");
  });

  it("the operator may use the admin console keys instead", async () => {
    PLATFORMS[2] = makePlatform("OUTBRAIN", { connectsWithCredentials: true, operatorKeys: true });
    const { user } = setup({ superAdmin: true, extra: { "POST /orgs/org_1/connections/outbrain/authorize": { url: "https://outbrain.example/oauth" } } });
    await user.click(within(await card("Outbrain")).getByRole("button", { name: "Connect" }));
    await user.click(await screen.findByRole("button", { name: /Use the admin console keys/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://outbrain.example/oauth"));
    PLATFORMS[2] = makePlatform("OUTBRAIN", { connectsWithCredentials: true });
  });
});

describe("Integrations · Shopify", () => {
  it("checks the store domain before starting the sign-in", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/connections/shopify/authorize": { url: "https://acme.myshopify.com/admin/oauth" } } });
    await user.click(within(await card("Shopify")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Shopify" });
    const input = within(dialog).getByLabelText("Store domain");
    expect(within(dialog).getByRole("button", { name: /Continue to Shopify/ })).toBeDisabled();
    await user.type(input, "not a store!");
    await user.click(within(dialog).getByRole("button", { name: /Continue to Shopify/ }));
    expect(within(dialog).getByText("Enter the store domain, like your-store.myshopify.com.")).toBeInTheDocument();
    await user.clear(input);
    await user.click(input);
    await user.paste("https://Acme.myshopify.com/admin");
    await user.click(within(dialog).getByRole("button", { name: /Continue to Shopify/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://acme.myshopify.com/admin/oauth"));
    expect(vi.mocked(api).mock.calls.find((c) => String(c[0]).includes("shopify/authorize"))![1]!.body).toEqual({ workspaceId: "ws_1", shop: "acme.myshopify.com" });
  });

  it("accepts a bare store name", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/connections/shopify/authorize": () => { throw new Error("Store not found"); } } });
    await user.click(within(await card("Shopify")).getByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog", { name: "Connect Shopify" });
    await user.type(within(dialog).getByLabelText("Store domain"), "acme");
    await user.click(within(dialog).getByRole("button", { name: /Continue to Shopify/ }));
    expect(await within(dialog).findByText("Store not found")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.find((c) => String(c[0]).includes("shopify/authorize"))![1]!.body).toEqual({ workspaceId: "ws_1", shop: "acme.myshopify.com" });
  });
});

describe("Integrations · connections and ad accounts", () => {
  it("explains when there are no connections and loads sample data", async () => {
    const { user } = setup({ extra: { "POST /orgs/org_1/sample-data": undefined } });
    expect(await screen.findByText("No connections yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Load sample data/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sample data is loading"));
  });

  it("lists connections with their sync health and hides hidden platforms", async () => {
    setup({
      connections: [
        makeConnection({ id: "a", externalUserName: "Asha BM", syncStatus: "RUNNING" }),
        makeConnection({ id: "b", platform: "GOOGLE", syncStatus: "FAILED", lastSyncError: "Token revoked" }),
        makeConnection({ id: "c", platform: "SHOPIFY", status: "EXPIRED" }),
        makeConnection({ id: "d", platform: "OUTBRAIN", mode: "DEMO", syncStatus: "QUEUED", adAccountCount: 1 }),
        makeConnection({ id: "e", platform: "TIKTOK" }),
        makeConnection({ id: "f", platform: "SPOTIFY", lastSyncedAt: new Date().toISOString() }),
        makeConnection({ id: "g", platform: "CRITEO" }),
      ],
    });
    expect(await screen.findByText(/Asha BM/)).toBeInTheDocument();
    expect(screen.getByText("Syncing…")).toBeInTheDocument();
    expect(screen.getByText("Sync failed")).toBeInTheDocument();
    expect(screen.getByText("Access expired · reconnect")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Sample data")).toBeInTheDocument();
    expect(screen.getByText(/Simulated account/)).toHaveTextContent("1 account");
    expect(screen.getByText(/^Synced .* ago$/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for first sync")).toBeInTheDocument();
    expect(screen.queryByText("TikTok Ads")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove sample data/ })).toBeInTheDocument();
  });

  it("syncs and disconnects a connection", async () => {
    const { user } = setup({
      connections: [makeConnection()],
      extra: { "POST /orgs/org_1/connections/conn_1/sync": undefined, "DELETE /orgs/org_1/connections/conn_1": undefined },
    });
    await user.click(await screen.findByRole("button", { name: "Connection actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Sync now/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Sync started", expect.anything()));
    await user.click(screen.getByRole("button", { name: "Connection actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Disconnect/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Its 2 ad accounts/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: /Disconnect/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Meta Ads disconnected"));
  });

  it("hides connection actions from people who can't manage integrations", async () => {
    setup({ role: "ANALYST", connections: [makeConnection()] });
    expect(await screen.findByText(/Asha \(Business Manager\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connection actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sample data/ })).not.toBeInTheDocument();
  });

  it("assigns ad accounts to workspaces", async () => {
    const ws2 = makeWorkspace({ id: "ws_2", name: "Clients" });
    const { user } = setup({
      org: { workspaces: [makeWorkspace(), ws2] },
      extra: {
        "GET /orgs/org_1/ad-accounts": [makeOrgAccount(), makeOrgAccount({ id: "acc_t", platform: "TIKTOK", name: "TikTok acct" })],
        "PATCH /orgs/org_1/ad-accounts/acc_1": undefined,
      },
    });
    expect(await screen.findByText("Acme India")).toBeInTheDocument();
    expect(screen.queryByText("TikTok acct")).not.toBeInTheDocument();
    const row = screen.getByText("Acme India").closest("tr")!;
    await user.click(within(row).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Clients" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Ad account assigned"));
    expect(vi.mocked(api).mock.calls.find((c) => c[1]?.method === "PATCH")![1]!.body).toEqual({ workspaceId: "ws_2" });
  });

  it("shows the workspace name read-only to others", async () => {
    setup({ role: "MANAGER", extra: { "GET /orgs/org_1/ad-accounts": [makeOrgAccount({ workspaceName: null, workspaceId: null })] } });
    const row = (await screen.findByText("Acme India")).closest("tr")!;
    expect(within(row).getByText("Not assigned")).toBeInTheDocument();
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Integrations · OAuth result", () => {
  it("toasts the result of the OAuth callback and cleans the URL", async () => {
    navigation.reset({ pathname: "/w/ws_1/integrations", search: { connected: "META", accounts: "3" } });
    setup();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Meta Ads connected", { description: "3 ad accounts found. Your data is syncing now." }));
    expect(navigation.router.replace).toHaveBeenCalledWith("/w/ws_1/integrations");
  });

  it("toasts OAuth errors", async () => {
    navigation.reset({ pathname: "/w/ws_1/integrations", search: { error: "Access denied" } });
    setup();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Connection failed", { description: "Access denied" }));
  });
});
