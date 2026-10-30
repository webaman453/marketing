import type { CredentialGroupStatus, CredentialsDTO } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { toast } from "sonner";
import { api } from "@/lib/api";
import { renderWithProviders, routeApi, type Handler } from "@/test-utils";
import { CredentialDialog, CredentialsPanel } from "./credentials-panel";

const field = (key: string, o: Partial<CredentialGroupStatus["fields"][number]> = {}) => ({ key, set: false, source: null, display: null, ...o });

const STATUS: CredentialGroupStatus[] = [
  {
    id: "META",
    configured: true,
    updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    fields: [field("META_APP_ID", { set: true, source: "console", display: "1234" }), field("META_APP_SECRET", { set: true, source: "console", display: "…cdef" }), field("META_API_VERSION")],
  },
  { id: "GOOGLE", configured: false, updatedAt: null, fields: [field("GOOGLE_CLIENT_ID", { set: true, source: "console", display: "abc.apps" }), field("GOOGLE_CLIENT_SECRET")] },
  { id: "LINKEDIN", configured: false, updatedAt: null, fields: [field("LINKEDIN_CLIENT_ID"), field("LINKEDIN_CLIENT_SECRET")] },
  { id: "AI", configured: true, updatedAt: null, fields: [field("AI_PROVIDER", { set: true, source: "env", display: "GEMINI" }), field("AI_API_KEY", { set: true, source: "env", display: "…xyz" })] },
  {
    id: "EMAIL",
    configured: false,
    updatedAt: null,
    // Only the Resend key is set while SMTP is the provider: that doesn't make SMTP "started".
    fields: [field("EMAIL_PROVIDER"), field("SMTP_HOST"), field("SMTP_USER"), field("SMTP_PASSWORD"), field("RESEND_API_KEY", { set: true, source: "console", display: "…key" })],
  },
];

const CREDS: CredentialsDTO = {
  redirectUrls: { META: "http://localhost:3100/api/oauth/meta/callback", GOOGLE: "https://ads.example.com/api/oauth/google/callback" },
  webhookUrl: "https://ads.example.com/api/webhooks/razorpay",
  groups: STATUS,
};

function setup(ui: React.ReactElement, extra: Record<string, Handler> = {}) {
  routeApi(api, { "GET /admin/settings/credentials": CREDS, "PUT /admin/settings/credentials": undefined, ...extra });
  return renderWithProviders(ui, { noWorkspace: true });
}

const groupCard = async (title: string) => (await screen.findByRole("heading", { name: title, level: 3 })).closest<HTMLElement>("[data-slot=card]")!;
const putBodies = () => vi.mocked(api).mock.calls.filter((c) => c[1]?.method === "PUT").map((c) => (c[1]!.body as { values: Record<string, string | null> }).values);

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("CredentialsPanel cards", () => {
  it("shows Set up / Incomplete / Not set up badges and where keys come from", async () => {
    setup(<CredentialsPanel />);
    const meta = await groupCard("Meta (Facebook & Instagram)");
    await waitFor(() => expect(within(meta).getByText("Set up")).toBeInTheDocument());
    expect(within(meta).getByText("Updated 3 days ago")).toBeInTheDocument();
    expect(within(meta).getByRole("button", { name: "Edit keys" })).toBeInTheDocument();
    expect(within(await groupCard("Google Ads (and YouTube)")).getByText("Incomplete")).toBeInTheDocument();
    expect(within(await groupCard("LinkedIn Ads")).getByText("Not set up")).toBeInTheDocument();
    expect(within(await groupCard("LinkedIn Ads")).getByRole("button", { name: "Set up" })).toBeInTheDocument();
    expect(within(await groupCard("AI provider")).getByText("From the server's .env file")).toBeInTheDocument();
    // A Resend key while SMTP is chosen doesn't count as started.
    expect(within(await groupCard("Email (SMTP or Resend)")).getByText("Not set up")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "TikTok Ads" })).not.toBeInTheDocument();
  });

  it("opens the initial group's dialog", async () => {
    setup(<CredentialsPanel initialGroup="RAZORPAY" />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Webhook URL")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(CREDS.webhookUrl)).toBeInTheDocument();
  });
});

describe("CredentialDialog", () => {
  it("shows the steps, redirect URL with a localhost warning, and copies it", async () => {
    const { user } = setup(<CredentialDialog groupId="META" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: /Open Meta for Developers/ })).toHaveAttribute("href", "https://developers.facebook.com/apps");
    expect(await within(dialog).findByDisplayValue(CREDS.redirectUrls.META!)).toBeInTheDocument();
    expect(within(dialog).getByText(/This server runs on localhost/)).toBeInTheDocument();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(within(dialog).getByRole("button", { name: /Copy/ }));
    expect(writeText).toHaveBeenCalledWith(CREDS.redirectUrls.META);
    expect(within(dialog).getByRole("button", { name: /Copied/ })).toBeInTheDocument();
  });

  it("fills plain fields with saved values; secrets start empty with a hint", async () => {
    setup(<CredentialDialog groupId="META" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByDisplayValue("1234")).toHaveAttribute("id", "cred-META_APP_ID");
    const secret = within(dialog).getByLabelText("App secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("type", "password");
    expect(within(dialog).getByText("Saved (…cdef). Leave empty to keep it.")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Marketing API version (optional)")).toBeInTheDocument();
  });

  it("guards a new App ID without a new secret is refused", async () => {
    const { user } = setup(<CredentialDialog groupId="META" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const id = await within(dialog).findByDisplayValue("1234");
    await user.clear(id);
    await user.type(id, "9999");
    await user.click(within(dialog).getByRole("button", { name: /^Save$/ }));
    expect(toast.error).toHaveBeenCalledWith("Paste the new secret too", expect.anything());
    expect(putBodies()).toEqual([]);
    await user.type(within(dialog).getByLabelText("App secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(putBodies()).toEqual([{ META_APP_ID: "9999", META_APP_SECRET: "s3cret" }]));
  });

  it("saves only what changed, clearing emptied plain fields", async () => {
    const onClose = vi.fn();
    const { user } = setup(<CredentialDialog groupId="GOOGLE" onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    await user.clear(await within(dialog).findByDisplayValue("abc.apps"));
    await user.type(within(dialog).getByLabelText("API version (optional)"), "v25");
    await user.click(within(dialog).getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBodies()).toEqual([{ GOOGLE_CLIENT_ID: null, GOOGLE_ADS_API_VERSION: "v25" }]);
    expect(toast.success).toHaveBeenCalledWith("Google Ads (and YouTube) saved", { description: "Some required keys are still empty." });
  });

  it("email: SMTP fields by default, Resend fields after switching", async () => {
    const { user } = setup(<CredentialDialog groupId="EMAIL" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("SMTP host")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Resend API key")).not.toBeInTheDocument();
    // Required SMTP fields are empty: test is not possible yet.
    expect(within(dialog).getByRole("button", { name: /Save & test/ })).toBeDisabled();
    await user.click(within(dialog).getByRole("combobox", { name: "Send with" }));
    await user.click(await screen.findByRole("option", { name: "Resend" }));
    expect(within(dialog).queryByLabelText("SMTP host")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Resend API key")).toBeInTheDocument();
    // The Resend key is already saved, so the test can run.
    expect(within(dialog).getByRole("button", { name: /Save & test/ })).toBeEnabled();
  });

  it("AI: Base URL appears only for OpenAI-compatible providers", async () => {
    const { user } = setup(<CredentialDialog groupId="AI" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Base URL")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: /OpenAI-compatible/ }));
    expect(within(dialog).getByLabelText("Base URL")).toBeInTheDocument();
  });

  it("Save & test saves the chosen option and shows the result", async () => {
    const { user } = setup(<CredentialDialog groupId="AI" onClose={() => {}} />, {
      "POST /admin/settings/credentials/AI/test": { ok: false, message: "Key rejected by Gemini" },
    });
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("combobox", { name: "Provider" }));
    await user.click(await screen.findByRole("option", { name: "OpenAI" }));
    await user.click(within(dialog).getByRole("button", { name: /Save & test/ }));
    expect(await within(dialog).findByText("Key rejected by Gemini")).toBeInTheDocument();
    expect(putBodies()).toEqual([{ AI_PROVIDER: "OPENAI" }]);
  });

  it("removes keys saved in the console", async () => {
    const onClose = vi.fn();
    const { user } = setup(<CredentialDialog groupId="META" onClose={onClose} />);
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Remove saved keys/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(putBodies()).toEqual([{ META_APP_ID: null, META_APP_SECRET: null, META_API_VERSION: null }]);
  });

  it("explains groups that can't be tested", async () => {
    setup(<CredentialDialog groupId="LINKEDIN" onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/can only be checked by connecting a real account/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Save & test/ })).not.toBeInTheDocument();
  });

  it("renders nothing for no group", () => {
    setup(<CredentialDialog groupId={null} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
