import type { ReportDTO } from "@ashniva/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { apiCalls, renderWithProviders, routeApi } from "@/test-utils";
import { navigation } from "@/test-utils/next-navigation";
import { ReportEditor } from "./report-editor";

const report: ReportDTO = {
  id: "r1",
  name: "Monthly summary",
  description: null,
  config: { metrics: ["spend", "clicks"], dimension: "campaign", datePreset: "30d", platforms: [], compare: true, chartMetric: "spend" },
  schedule: { frequency: null, hour: 9, dayOfWeek: 1, dayOfMonth: 1, recipients: [], nextRunAt: null, lastRunAt: null },
  shareToken: null,
  createdBy: null,
  updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(api).mockReset();
  navigation.reset({ pathname: "/w/ws_1/reports/r1" });
  routeApi(api, {
    "GET /workspaces/ws_1/ad-accounts": [],
    // The preview never answers; these tests are about the editor around it.
    "POST /workspaces/ws_1/reports/preview": () => new Promise(() => {}),
    "DELETE /workspaces/ws_1/reports/r1": undefined,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("ReportEditor", () => {
  it("asks before deleting a report", { timeout: 30_000 }, async () => {
    const { user } = renderWithProviders(<ReportEditor report={report} />);
    await user.click(screen.getByRole("button", { name: /Delete report/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete “Monthly summary”?")).toBeInTheDocument();
    expect(apiCalls(api)).not.toContain("DELETE /workspaces/ws_1/reports/r1");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(apiCalls(api)).not.toContain("DELETE /workspaces/ws_1/reports/r1");

    await user.click(screen.getByRole("button", { name: /Delete report/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /Delete report/ }));
    await waitFor(() => expect(navigation.router.push).toHaveBeenCalledWith("/w/ws_1/reports"));
    expect(apiCalls(api)).toContain("DELETE /workspaces/ws_1/reports/r1");
  });

  it("warns before a link leaves unsaved edits", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { user } = renderWithProviders(<ReportEditor report={report} />);
    const back = screen.getByRole("link", { name: /Reports/ });

    fireEvent.click(back);
    expect(confirm).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Report name"), " v2");
    fireEvent.click(back);
    expect(confirm).toHaveBeenCalledWith("You have unsaved changes. Leave without saving?");
  });
});
