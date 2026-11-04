import { describe, expect, it } from "vitest";
import { setupSteps } from "./setup-checklist";

const base = { workspaceId: "ws_1", hasCampaigns: false, hasRules: false, hasAlertChannel: false, canCreateCampaigns: true, canManageRules: true, canManageOrg: true };
const keys = (input: Parameters<typeof setupSteps>[0]) => setupSteps(input).map((s) => `${s.key}:${s.done ? "done" : "todo"}`);

describe("setupSteps", () => {
  it("starts with the platform connected and everything else to do", () => {
    expect(keys(base)).toEqual(["connect:done", "campaign:todo", "rule:todo", "alerts:todo"]);
  });

  it("marks steps done from what exists", () => {
    expect(keys({ ...base, hasCampaigns: true, hasRules: true, hasAlertChannel: true })).toEqual(["connect:done", "campaign:done", "rule:done", "alerts:done"]);
  });

  it("only lists what the person can do, so nobody is sent to a no-access page", () => {
    expect(keys({ ...base, canCreateCampaigns: false, canManageRules: false, canManageOrg: false })).toEqual(["connect:done"]);
    expect(keys({ ...base, canManageOrg: false })).toEqual(["connect:done", "campaign:todo", "rule:todo"]);
  });

  it("links into the workspace", () => {
    expect(setupSteps(base).map((s) => s.href)).toEqual([
      "/w/ws_1/integrations",
      "/w/ws_1/campaigns/new",
      "/w/ws_1/automations",
      "/w/ws_1/settings/alerts",
    ]);
  });
});
