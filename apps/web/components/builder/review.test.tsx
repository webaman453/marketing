import type { BuilderDraft, BuilderIssue, DraftDTO, PlatformBuilderSpec } from "@ashniva/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { makeAi, makeCreative, renderWithBuilder, routeApi } from "@/test-utils";
import { ReviewScreen } from "./review";

const OPTS = [
  { value: "A", label: "Alpha" },
  { value: "B", label: "Bravo" },
];

const spec: PlatformBuilderSpec = {
  platform: "META",
  setup: [{ key: "objective", label: "Objective", description: "", options: [{ value: "SALES", label: "Sales" }] }],
  campaign: {
    label: "Campaign",
    sections: [
      {
        id: "c",
        title: "Campaign",
        fields: [
          { key: "name", type: "text", label: "Campaign name" },
          { key: "budget", type: "money", label: "Daily budget" },
          { key: "budget2", type: "money", label: "Lifetime budget" },
          { key: "share", type: "percent", label: "Share" },
          { key: "cbo", type: "toggle", label: "Advantage budget" },
          { key: "off", type: "toggle", label: "Off toggle" },
          { key: "type", type: "select", label: "Type", options: OPTS },
          { key: "unknownChoice", type: "radio", label: "Unknown choice", options: OPTS },
          { key: "cats", type: "checkboxes", label: "Categories", options: OPTS },
          { key: "secret", type: "text", label: "Advanced field", advanced: true },
          { key: "empty", type: "text", label: "Empty field" },
          { key: "note", type: "info", label: "Just info" },
          { key: "launchStatus", type: "segmented", label: "Status", options: [{ value: "PAUSED", label: "Paused" }, { value: "ACTIVE", label: "Active" }] },
        ],
      },
      { id: "hidden", title: "Hidden", showIf: () => false, fields: [{ key: "hiddenField", type: "text", label: "Hidden section field" }] },
    ],
  },
  adGroup: {
    label: "Ad set",
    sections: [
      {
        id: "g",
        title: "Ad set",
        fields: [
          { key: "name", type: "text", label: "Ad set name" },
          { key: "locations", type: "targeting", kind: "location", label: "Locations" },
          { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD"], max: 10 },
          { key: "age", type: "ageRange", label: "Age", min: 18, max: 65, openEnded: true },
          { key: "placements", type: "placements", label: "Placements", autoLabel: "Advantage+ placements", autoDescription: "", groups: [] },
          { key: "manual", type: "placements", label: "Manual", autoLabel: "Auto", autoDescription: "", groups: [] },
          { key: "schedule", type: "adSchedule", label: "Schedule" },
          { key: "allDay", type: "adSchedule", label: "All day" },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Ad",
    sections: [
      {
        id: "a",
        title: "Ad",
        fields: [
          { key: "name", type: "text", label: "Ad name" },
          { key: "pageId", type: "accountOption", source: "pages", label: "Facebook Page" },
          { key: "media", type: "media", label: "Media", accept: ["IMAGE"], min: 1, max: 5 },
          { key: "manyMedia", type: "media", label: "Gallery", accept: ["IMAGE"], min: 1, max: 5 },
          { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 1, max: 5, maxLength: 40 },
          { key: "blankList", type: "textList", label: "Blank list", itemLabel: "Line", min: 0, max: 5, maxLength: 40 },
          { key: "cards", type: "repeater", label: "Cards", itemLabel: "Card", min: 2, max: 5, fields: [] },
        ],
      },
    ],
  }),
  maxAdGroups: 5,
  maxAds: 5,
  previews: () => ["fb_feed"],
};

function draft(): BuilderDraft {
  return {
    version: 2,
    platform: "META",
    adAccountId: "acc_1",
    setup: { objective: "SALES" },
    campaign: {
      name: "Festive Sale",
      budget: 1500,
      budget2: 1250.5,
      share: 20,
      cbo: true,
      off: false,
      type: "B",
      unknownChoice: "Z",
      cats: ["A", "B"],
      secret: "should not show",
      empty: "",
      launchStatus: "PAUSED",
    },
    adGroups: [
      {
        key: "g1",
        values: {
          name: "India 18+",
          locations: [{ id: "IN", name: "India" }, { id: "PK", name: "Mumbai", exclude: true }],
          keywords: [{ text: "a", matchType: "BROAD" }, { text: "b", matchType: "BROAD" }],
          age: { min: 21, max: 65 },
          placements: { mode: "AUTO", items: [] },
          manual: { mode: "MANUAL", items: ["x", "y", "z"] },
          schedule: { days: { MON: [[9, 18]] } },
          allDay: { days: {} },
        },
        ads: [
          {
            key: "a1",
            values: {
              name: "Ad one",
              pageId: "p1",
              media: ["c1", "c2"],
              manyMedia: ["c1", "c2", "c3"],
              headlines: ["Big Diwali sale", { text: "Second", pin: "1" }, "  "],
              blankList: ["", " "],
              cards: [{}, {}],
            },
          },
        ],
      },
    ],
  };
}

const creatives = [makeCreative({ id: "c1", name: "hero.jpg" }), makeCreative({ id: "c2", name: "story.jpg" }), makeCreative({ id: "c3", name: "third.jpg" })];

function renderReview(o: { issues?: BuilderIssue[]; initial?: DraftDTO | null; saveNow?: () => Promise<string>; ai?: ReturnType<typeof makeAi>; d?: BuilderDraft } = {}) {
  const onBack = vi.fn();
  const onGoTo = vi.fn();
  const saveNow = vi.fn(o.saveNow ?? (async () => "d_1"));
  const utils = renderWithBuilder(
    <ReviewScreen draft={o.d ?? draft()} spec={spec} issues={o.issues ?? []} initial={o.initial ?? null} saveNow={saveNow} onBack={onBack} onGoTo={onGoTo} />,
    { creatives, options: { pages: [{ id: "p1", name: "Acme Store (sample data)" }] }, ai: o.ai },
  );
  return { ...utils, onBack, onGoTo, saveNow };
}

const term = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling!;

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(toast.error).mockClear();
});

describe("ReviewScreen summaries", () => {
  it("shows readable values for every field type", () => {
    renderReview();
    expect(screen.getByRole("heading", { name: "Festive Sale" })).toBeInTheDocument();
    expect(screen.getByText("Meta Ads · Sales")).toBeInTheDocument();
    // Whole amounts have no paise; fractional ones keep them.
    expect(term("Daily budget")).toHaveTextContent(/^₹1,500$/);
    expect(term("Lifetime budget")).toHaveTextContent(/^₹1,250\.50$/);
    expect(term("Share")).toHaveTextContent("20%");
    expect(term("Advantage budget")).toHaveTextContent("On");
    expect(term("Off toggle")).toHaveTextContent("Off");
    expect(term("Type")).toHaveTextContent("Bravo");
    expect(term("Unknown choice")).toHaveTextContent("Z");
    expect(term("Categories")).toHaveTextContent("Alpha, Bravo");
    expect(term("Locations")).toHaveTextContent("India, not Mumbai");
    expect(term("Keywords")).toHaveTextContent("2 keywords");
    expect(term("Age")).toHaveTextContent("21–65+");
    expect(term("Placements")).toHaveTextContent("Advantage+ placements");
    expect(term("Manual")).toHaveTextContent("3 manual placements");
    expect(term("Schedule")).toHaveTextContent("Custom hours");
    expect(term("Facebook Page")).toHaveTextContent(/^Acme Store$/);
    expect(term("Media")).toHaveTextContent("hero.jpg, story.jpg");
    expect(term("Gallery")).toHaveTextContent("3 files");
    expect(term("Headlines")).toHaveTextContent("“Big Diwali sale” + 1 more");
    expect(term("Cards")).toHaveTextContent("2 × card");
    expect(screen.getByText("1 ad: Ad one")).toBeInTheDocument();
  });

  it("leaves out empty, advanced, info and hidden fields", () => {
    renderReview();
    for (const label of ["Advanced field", "Empty field", "Just info", "All day", "Blank list", "Hidden section field"]) {
      expect(screen.queryByText(label, { selector: "dt" })).not.toBeInTheDocument();
    }
  });

  it("names media by count when a file is missing from the library", () => {
    const d = draft();
    d.adGroups[0]!.ads[0]!.values.media = ["c1", "gone"];
    renderReview({ d });
    expect(term("Media")).toHaveTextContent("2 files");
  });
});

describe("ReviewScreen pre-publish checks and publishing", () => {
  const issues: BuilderIssue[] = [
    { level: "campaign", field: "name", message: "Campaign name is required." },
    { level: "adGroup", nodeKey: "g1", field: "locations", message: "Add at least one location." },
    { level: "ad", nodeKey: "a1", field: "media", message: "Media: add an image." },
  ];

  it("lists issues with where they are, and Fix jumps to the field", async () => {
    const { user, onGoTo } = renderReview({ issues });
    const list = screen.getByText("Pre-publish checks").closest("[data-slot=card]")!;
    expect(within(list as HTMLElement).getByText("India 18+")).toBeInTheDocument();
    expect(within(list as HTMLElement).getByText("Ad one")).toBeInTheDocument();
    const fixes = screen.getAllByRole("button", { name: "Fix" });
    await user.click(fixes[0]!);
    expect(onGoTo).toHaveBeenLastCalledWith({ level: "campaign" }, "name");
    await user.click(fixes[1]!);
    expect(onGoTo).toHaveBeenLastCalledWith({ level: "adGroup", key: "g1" }, "locations");
    await user.click(fixes[2]!);
    expect(onGoTo).toHaveBeenLastCalledWith({ level: "ad", groupKey: "g1", key: "a1" }, "media");
  });

  it("disables Publish while there are problems", () => {
    renderReview({ issues });
    expect(screen.getByRole("button", { name: /Publish to Meta Ads/ })).toBeDisabled();
    expect(screen.getByText("Fix 3 problems to publish.")).toBeInTheDocument();
  });

  it("says ready and publishes: saves first, then launches", async () => {
    let finish!: (d: DraftDTO) => void;
    routeApi(api, { "POST /workspaces/ws_1/drafts/d_1/launch": () => new Promise<DraftDTO>((r) => (finish = r)) });
    const { user, saveNow, onBack } = renderReview();
    expect(screen.getByText("Ready to publish.")).toBeInTheDocument();
    expect(screen.getByText(/Created paused/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Edit/ }));
    expect(onBack).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Publish to Meta Ads/ }));
    expect(saveNow).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /Publishing…/ })).toBeDisabled();
    finish({
      id: "d_1",
      name: "Festive Sale",
      status: "LAUNCHED",
      payload: {},
      results: [{ adAccountId: "acc_1", platform: "META", ok: true, campaignId: "camp_9", created: { adGroups: 1, ads: 2 } }],
      createdBy: null,
      launchedAt: null,
      updatedAt: "",
    });
    expect(await screen.findByText("Campaign published")).toBeInTheDocument();
    expect(screen.getByText(/with 1 ad set and 2 ads/)).toBeInTheDocument();
    expect(screen.getByText(/It's paused/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View campaign" })).toHaveAttribute("href", "/w/ws_1/campaigns/camp_9");
    expect(screen.getByRole("link", { name: "Create another" })).toHaveAttribute("href", "/w/ws_1/campaigns/new");
  });

  it("shows the server's builder issues when the platform rejects the draft", async () => {
    routeApi(api, {
      "POST /workspaces/ws_1/drafts/d_1/launch": () => {
        throw new ApiError(422, "DRAFT_INVALID", "Draft invalid", undefined, [{ level: "ad", nodeKey: "a1", message: "Page can't run ads." }]);
      },
    });
    const { user } = renderReview();
    await user.click(screen.getByRole("button", { name: /Publish to Meta Ads/ }));
    expect(await screen.findByText("Page can't run ads.")).toBeInTheDocument();
    expect(screen.getByText("Fix 1 problem to publish.")).toBeInTheDocument();
  });

  it("falls back to the error message when DRAFT_INVALID has no issues", async () => {
    routeApi(api, { "POST /workspaces/ws_1/drafts/d_1/launch": () => { throw new ApiError(422, "DRAFT_INVALID", "Account is disabled"); } });
    const { user } = renderReview();
    await user.click(screen.getByRole("button", { name: /Publish to Meta Ads/ }));
    expect(await screen.findByText("Account is disabled")).toBeInTheDocument();
  });

  it("toasts other errors and re-enables Publish", async () => {
    routeApi(api, { "POST /workspaces/ws_1/drafts/d_1/launch": () => { throw new Error("Network down"); } });
    const { user } = renderReview();
    await user.click(screen.getByRole("button", { name: /Publish to Meta Ads/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Network down"));
    expect(screen.getByRole("button", { name: /Publish to Meta Ads/ })).toBeEnabled();
  });

  it("shows why the last publish failed", () => {
    renderReview({
      initial: { id: "d_1", name: "x", status: "FAILED", payload: {}, results: [{ adAccountId: "acc_1", platform: "META", ok: false, error: "Payment method missing" }], createdBy: null, launchedAt: null, updatedAt: "" },
    });
    expect(screen.getByText("Meta Ads didn't accept the campaign")).toBeInTheDocument();
    expect(screen.getByText("Payment method missing")).toBeInTheDocument();
  });

  it("active campaigns say they start delivering", () => {
    const d = draft();
    d.campaign.launchStatus = "ACTIVE";
    renderReview({ d });
    expect(screen.getByText("Starts delivering as soon as the platform approves the ads.")).toBeInTheDocument();
  });
});

describe("ReviewScreen AI review", () => {
  it("is hidden without AI", () => {
    renderReview();
    expect(screen.queryByText("AI review")).not.toBeInTheDocument();
  });

  it("shows the tokens notice when AI can't be used", () => {
    renderReview({ ai: makeAi({ available: true, canUse: false }) });
    expect(screen.getByText("AI review")).toBeInTheDocument();
    expect(screen.getByText(/AI tokens used up/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Review/ })).not.toBeInTheDocument();
  });

  it("runs a review and shows score, strengths and issues", async () => {
    routeApi(api, {
      "POST /workspaces/ws_1/ai/builder/review": {
        score: 72,
        summary: "Solid, needs a stronger hook.",
        strengths: ["Clear offer"],
        issues: [{ severity: "high", area: "Copy", message: "Headline is generic", fix: "Mention the discount" }],
      },
    });
    const { user } = renderReview({ ai: makeAi({ available: true, canUse: true }) });
    await user.click(screen.getByRole("button", { name: /^Review$/ }));
    expect(await screen.findByText("72")).toHaveClass("text-warning");
    expect(screen.getByText("Clear offer")).toBeInTheDocument();
    expect(screen.getByText("Headline is generic")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-run/ })).toBeInTheDocument();
  });
});
