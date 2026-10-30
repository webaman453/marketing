import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { ApiError } from "./api";
import { applyServerErrors, toastError } from "./forms";

describe("applyServerErrors", () => {
  it("puts field messages next to known fields", () => {
    const setError = vi.fn();
    applyServerErrors(new ApiError(400, "VALIDATION", "Invalid", { email: ["Taken", "Other"], unknown: ["x"] }), setError, ["email", "name"]);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledWith("email", { type: "server", message: "Taken" });
  });

  it("falls back to a root error when no detail matches a field", () => {
    const setError = vi.fn();
    applyServerErrors(new ApiError(400, "VALIDATION", "Invalid input", { other: ["x"] }), setError, ["email"]);
    expect(setError).toHaveBeenCalledWith("root", { type: "server", message: "Invalid input" });
  });

  it("skips empty message lists", () => {
    const setError = vi.fn();
    applyServerErrors(new ApiError(400, "VALIDATION", "Invalid input", { email: [] }), setError, ["email"]);
    expect(setError).toHaveBeenCalledWith("root", { type: "server", message: "Invalid input" });
  });

  it("uses a generic root message for non-API errors", () => {
    const setError = vi.fn();
    applyServerErrors("weird", setError, ["email"]);
    expect(setError).toHaveBeenCalledWith("root", { type: "server", message: "Something went wrong. Please try again." });
  });
});

describe("toastError", () => {
  const assign = vi.fn();
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    assign.mockClear();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, pathname: "/w/ws_9/campaigns", assign } });
  });
  afterEach(() => vi.mocked(toast.error).mockClear());

  it("shows the plain message for ordinary errors", () => {
    toastError(new Error("Network down"));
    expect(toast.error).toHaveBeenCalledWith("Network down");
  });

  it("offers the plans page on plan-limit errors (402)", () => {
    toastError(new ApiError(402, "PLAN_LIMIT", "Your plan allows 1 workspace."));
    const [title, opts] = vi.mocked(toast.error).mock.calls[0]! as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe("Upgrade required");
    expect(opts.description).toBe("Your plan allows 1 workspace.");
    expect(opts.action.label).toBe("View plans");
    opts.action.onClick();
    expect(assign).toHaveBeenCalledWith("/w/ws_9/settings/billing");
  });

  it("says the plan is inactive for locked orgs", () => {
    toastError(new ApiError(402, "ORG_LOCKED", "Read-only"));
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toBe("Your plan is inactive");
  });

  it("offers to buy tokens when AI tokens run out", () => {
    toastError(new ApiError(402, "AI_TOKENS_EXHAUSTED", "No tokens left"));
    const [title, opts] = vi.mocked(toast.error).mock.calls[0]! as [string, { action: { label: string; onClick: () => void } }];
    expect(title).toBe("AI tokens used up");
    expect(opts.action.label).toBe("Buy tokens");
    opts.action.onClick();
    expect(assign).toHaveBeenCalledWith("/w/ws_9/settings/ai");
  });

  it("has no shortcut outside a workspace", () => {
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, pathname: "/admin", assign } });
    toastError(new ApiError(402, "PLAN_LIMIT", "Upgrade"));
    const opts = vi.mocked(toast.error).mock.calls[0]![1] as { action?: unknown };
    expect(opts.action).toBeUndefined();
  });
});
