import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { makeOrgAccount, makeWsAccount, renderWithProviders, routeApi, type WorkspaceAdAccount } from "@/test-utils";
import type { AdAccountDTO, BuilderDraft } from "@ashniva/shared";
import { BuilderStart } from "./builder-start";

function setup(ws: WorkspaceAdAccount[], org: AdAccountDTO[] = [], opts: Parameters<typeof renderWithProviders>[1] = {}, preset?: Parameters<typeof BuilderStart>[0]["preset"]) {
  routeApi(api, { "GET /workspaces/ws_1/ad-accounts": ws, "GET /orgs/org_1/ad-accounts": org });
  const onStart = vi.fn<(d: BuilderDraft) => void>();
  const utils = renderWithProviders(<BuilderStart onStart={onStart} preset={preset} />, opts);
  return { ...utils, onStart };
}

const continueButton = () => screen.getByRole("button", { name: /Continue/ });

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe("BuilderStart", () => {
  it("walks platform → account → objective → name, saying what's missing until Continue works", async () => {
    const { user, onStart } = setup([makeWsAccount()]);
    const meta = await screen.findByRole("button", { name: /Meta Ads/ });
    expect(meta).toHaveTextContent("1 ad account");
    expect(screen.getByRole("button", { name: /Google Ads/ })).toBeDisabled();
    expect(screen.getByText("Choose a platform to begin")).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    await user.click(meta);
    // A single account is picked automatically.
    expect(screen.getByText("Meta Ads · Acme India")).toBeInTheDocument();
    expect(screen.getByText("Select the campaign objective to continue")).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Traffic" }));
    expect(screen.getByText("Name your campaign to continue")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Campaign name"), "A");
    expect(continueButton()).toBeDisabled();
    await user.type(screen.getByLabelText("Campaign name"), "B ");
    expect(screen.queryByText(/to continue$/)).not.toBeInTheDocument();
    expect(continueButton()).toBeEnabled();

    await user.click(continueButton());
    const draft = onStart.mock.calls[0]![0];
    expect(draft).toMatchObject({ version: 2, platform: "META", adAccountId: "acc_1", setup: { objective: "OUTCOME_TRAFFIC" } });
    expect(draft.campaign.name).toBe("AB");
    expect(draft.adGroups).toHaveLength(1);
  });

  it("asks to pick an ad account when there are several", async () => {
    const { user } = setup([makeWsAccount(), makeWsAccount({ id: "acc_2", name: "Acme Global", externalId: "act_222", currency: "USD", sample: true })]);
    await user.click(await screen.findByRole("button", { name: /Meta Ads/ }));
    expect(screen.getByText("Select an ad account to continue")).toBeInTheDocument();
    expect(screen.queryByLabelText("Campaign name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Acme Global/ }));
    expect(screen.getByText("USD · act_222")).toBeInTheDocument();
    expect(screen.getByText("Sample account")).toBeInTheDocument();
    expect(screen.getByLabelText("Campaign name")).toBeInTheDocument();
  });

  it("resets the objective when the platform changes", async () => {
    const { user } = setup([makeWsAccount(), makeWsAccount({ id: "g1", platform: "GOOGLE", name: "Acme Google" })]);
    await user.click(await screen.findByRole("button", { name: /Meta Ads/ }));
    await user.click(screen.getByRole("radio", { name: "Traffic" }));
    await user.click(screen.getByRole("button", { name: /Google Ads/ }));
    expect(screen.queryByRole("radio", { name: "Traffic" })).not.toBeInTheDocument();
    expect(screen.getByText(/^Select the .* to continue$/)).toBeInTheDocument();
  });

  it("explains an empty workspace and points to workspaces that have accounts", async () => {
    setup([], [makeOrgAccount({ workspaceId: "ws_2", workspaceName: "Clients" }), makeOrgAccount({ id: "acc_9", workspaceId: "ws_2", workspaceName: "Clients" })]);
    expect(await screen.findByText("The “Main workspace” workspace has no ad accounts yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Switch to Clients (2 accounts)" })).toHaveAttribute("href", "/w/ws_2/campaigns/new");
    expect(screen.getByRole("link", { name: /Add or assign ad accounts/ })).toHaveAttribute("href", "/w/ws_1/integrations");
    expect(screen.getByRole("button", { name: /Meta Ads/ })).toBeDisabled();
  });

  it("locked org: shows the plan banner and keeps Continue disabled even when complete", async () => {
    const { user } = setup([makeWsAccount()], [], { locked: true });
    expect(await screen.findByText("Choose a plan to create campaigns.")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Choose a plan/ })[0]).toHaveAttribute("href", "/w/ws_1/settings/billing");
    await user.click(screen.getByRole("button", { name: /Meta Ads/ }));
    await user.click(screen.getByRole("radio", { name: "Traffic" }));
    await user.type(screen.getByLabelText("Campaign name"), "Festive");
    expect(screen.getByText("Choose a plan to continue")).toBeInTheDocument();
    expect(continueButton()).toBeDisabled();
  });

  it("preset platform without an account: no platform grid, connect banner instead", async () => {
    setup([makeWsAccount({ platform: "GOOGLE" })], [], { locked: true }, { platform: "META", setup: { objective: "OUTCOME_SALES" } });
    expect(await screen.findByText("Connect a Meta Ads ad account first.")).toBeInTheDocument();
    expect(screen.queryByText("Where do you want to advertise?")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Go to Integrations/ })).toHaveAttribute("href", "/w/ws_1/integrations");
    // Locked too: a second "Choose a plan" button sits in the banner.
    expect(screen.getAllByRole("link", { name: /Choose a plan/ })).toHaveLength(2);
    expect(screen.getByText("Choose a plan to continue")).toBeInTheDocument();
  });

  it("preset with an account keeps the preset objective selected", async () => {
    setup([makeWsAccount()], [], {}, { platform: "META", setup: { objective: "OUTCOME_SALES" } });
    expect(await screen.findByRole("radio", { name: "Sales" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Name your campaign to continue")).toBeInTheDocument();
  });

  it("platforms without an API say so", async () => {
    setup([makeWsAccount()], [], {}, { platform: "SWIGGY", setup: {} });
    expect(await screen.findByText("Swiggy Ads cannot be connected from here yet.")).toBeInTheDocument();
  });

  it("shows a skeleton while accounts load", async () => {
    vi.mocked(api).mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithProviders(<BuilderStart onStart={() => {}} />);
    await waitFor(() => expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull());
  });
});
