import type { Field, TargetingSearchResult } from "@ashniva/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn(), apiUpload: vi.fn() }));

import { toast } from "sonner";
import { api, apiUpload, ApiError } from "@/lib/api";
import { renderField } from "@/test-utils/field-harness";
import { makeAi, makeCreative, routeApi } from "@/test-utils";

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(apiUpload).mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

// ───────── Targeting ─────────

describe("TargetingInput", () => {
  const field: Field = { key: "locations", type: "targeting", kind: "location", label: "Locations", allowExclude: true, max: 3 };
  const results: TargetingSearchResult[] = [
    { id: "IN", name: "India", type: "country" },
    { id: "MUM", name: "Mumbai", type: "city", countryCode: "IN", detail: "Maharashtra, India" },
  ];

  it("searches the platform and adds a location", async () => {
    routeApi(api, { "GET /workspaces/ws_1/builder/targeting": results });
    const { user, last } = renderField(field);
    expect(screen.getByText("No locations yet.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add locations/ }));
    expect(await screen.findByText("Maharashtra, India")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls[0]![1]!.query).toMatchObject({ adAccountId: "acc_1", kind: "location", q: "" });
    await user.click(screen.getByRole("option", { name: /Mumbai/ }));
    expect(last()).toEqual([{ id: "MUM", name: "Mumbai", type: "city", countryCode: "IN" }]);
    expect(screen.getByText("· city")).toBeInTheDocument();
  });

  it("excludes a location with the Exclude button", async () => {
    routeApi(api, { "GET /workspaces/ws_1/builder/targeting": results });
    const { user, last } = renderField(field);
    await user.click(screen.getByRole("button", { name: /Add locations/ }));
    const india = await screen.findByRole("option", { name: /^India/ });
    await user.click(within(india).getByRole("button", { name: "Exclude" }));
    expect(last()).toEqual([{ id: "IN", name: "India", type: "country", countryCode: undefined, exclude: true }]);
  });

  it("passes the typed query, skips duplicates and removes chips", async () => {
    routeApi(api, { "GET /workspaces/ws_1/builder/targeting": (o?: { query?: Record<string, unknown> }) => results.filter((r) => r.name.toLowerCase().includes(String(o?.query?.q ?? "").toLowerCase())) });
    const { user, last, onChange } = renderField(field, { value: [{ id: "IN", name: "India", type: "country" }] });
    await user.click(screen.getByRole("button", { name: /Add locations/ }));
    await user.type(screen.getByPlaceholderText("Search countries, regions, cities…"), "ind");
    await waitFor(() => expect(vi.mocked(api).mock.calls.some((c) => c[1]?.query?.q === "ind")).toBe(true));
    const india = await screen.findByRole("option", { name: /^India/ });
    expect(india).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Remove India" }));
    expect(last()).toEqual([]);
  });

  it("stops at max", async () => {
    routeApi(api, { "GET /workspaces/ws_1/builder/targeting": results });
    const { user, onChange } = renderField({ ...field, max: 1 } as Field, { value: [{ id: "X", name: "X" }] });
    await user.click(screen.getByRole("button", { name: /Add locations/ }));
    await user.click(await screen.findByRole("option", { name: /Mumbai/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says broad targeting is used when interests are empty", () => {
    renderField({ key: "interests", type: "targeting", kind: "interest", label: "Interests" });
    expect(screen.getByText("None added; the platform will use broad targeting.")).toBeInTheDocument();
  });

  it("AI audience ideas are matched to real options and added", async () => {
    routeApi(api, {
      "POST /workspaces/ws_1/ai/builder/audience": { rationale: "Festive shoppers", interests: ["Ethnic wear", "Unknown thing"] },
      "GET /workspaces/ws_1/builder/targeting": (o?: { query?: Record<string, unknown> }) =>
        o?.query?.q === "Ethnic wear" ? [{ id: "i1", name: "Ethnic wear" }, { id: "i2", name: "Ethnic wear (fashion)" }] : [],
    });
    const onAiUsed = vi.fn();
    const brief = { product: "Kurtas", audience: "", offer: "", tone: "", language: "English" };
    const { user, last } = renderField(
      { key: "interests", type: "targeting", kind: "interest", label: "Interests", ai: { purpose: "interests" } },
      { env: { ai: makeAi({ available: true, canUse: true }), brief, onAiUsed } },
    );
    await user.click(screen.getByRole("button", { name: /Suggest with AI/ }));
    await user.click(await screen.findByRole("button", { name: /Suggest audiences/ }));
    expect(await screen.findByText("Festive shoppers")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add 1" }));
    expect(last()).toEqual([{ id: "i1", name: "Ethnic wear", type: undefined }]);
    expect(onAiUsed).toHaveBeenCalled();
  });

  it("AI audience asks for a brief first", async () => {
    const requestBrief = vi.fn();
    const { user } = renderField(
      { key: "interests", type: "targeting", kind: "interest", label: "Interests", ai: { purpose: "interests" } },
      { env: { ai: makeAi({ available: true, canUse: true }), requestBrief } },
    );
    await user.click(screen.getByRole("button", { name: /Suggest with AI/ }));
    await user.click(await screen.findByRole("button", { name: /Suggest audiences/ }));
    expect(requestBrief).toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });
});

// ───────── Keywords ─────────

describe("KeywordsInput", () => {
  const field: Field = { key: "keywords", type: "keywords", label: "Keywords", matchTypes: ["BROAD", "PHRASE", "EXACT"], max: 4 };

  it("parses pasted keywords with [exact], \"phrase\" and the chosen match type", async () => {
    const { user, last } = renderField(field);
    const box = screen.getByPlaceholderText(/kurta for women/);
    fireEvent.change(box, { target: { value: 'Silk Saree, [Buy Kurta]\n"ethnic wear"' } });
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(last()).toEqual([
      { text: "silk saree", matchType: "PHRASE" },
      { text: "buy kurta", matchType: "EXACT" },
      { text: "ethnic wear", matchType: "PHRASE" },
    ]);
    expect(box).toHaveValue("");
    expect(screen.getByText("3 keywords")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "[buy kurta]" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: '"ethnic wear"' })).toBeInTheDocument();
  });

  it("adds on Enter with the selected match type and ignores duplicates and overflow", async () => {
    const { user, last } = renderField(field, { value: [{ text: "shoes", matchType: "BROAD" }] });
    await user.click(screen.getByRole("button", { name: "broad" }));
    await user.type(screen.getByPlaceholderText(/kurta for women/), "shoes, socks, hats, caps, belts{Enter}");
    // "shoes" BROAD exists already; the list stops at max (4).
    expect(last()).toEqual([
      { text: "shoes", matchType: "BROAD" },
      { text: "socks", matchType: "BROAD" },
      { text: "hats", matchType: "BROAD" },
      { text: "caps", matchType: "BROAD" },
    ]);
  });

  it("Shift+Enter keeps typing, Add stays disabled while empty", async () => {
    const { user, onChange } = renderField(field);
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/kurta for women/), "a{Shift>}{Enter}{/Shift}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cycles the match type when a keyword is clicked, and removes it", async () => {
    const { user, last } = renderField(field, { value: [{ text: "shoes", matchType: "EXACT" }] });
    await user.click(screen.getByRole("button", { name: "[shoes]" }));
    expect(last()).toEqual([{ text: "shoes", matchType: "BROAD" }]);
    await user.click(screen.getByRole("button", { name: "shoes" }));
    expect(last()).toEqual([{ text: "shoes", matchType: "PHRASE" }]);
    await user.click(screen.getByRole("button", { name: "Remove shoes" }));
    expect(last()).toEqual([]);
  });

  it("new keywords use a match type the platform offers when it has no phrase match (Apple)", async () => {
    const { user, last } = renderField({ ...field, matchTypes: ["BROAD", "EXACT"] } as Field);
    await user.type(screen.getByPlaceholderText(/kurta for women/), "running shoes{Enter}");
    expect(["BROAD", "EXACT"]).toContain((last() as { matchType: string }[])[0]!.matchType);
  });

  it("negative keywords: own placeholder and counter", () => {
    renderField({ ...field, negative: true } as Field, { value: [{ text: "free", matchType: "PHRASE" }] });
    expect(screen.getByPlaceholderText("free, jobs, diy")).toBeInTheDocument();
    expect(screen.getByText("1 negative keywords")).toBeInTheDocument();
  });

  it("AI keyword ideas can be unticked before adding", async () => {
    routeApi(api, {
      "POST /workspaces/ws_1/ai/builder/keywords": {
        keywords: [
          { text: "buy kurta", matchType: "EXACT", intent: "high" },
          { text: "kurta designs", matchType: "BROAD", intent: "low" },
        ],
      },
    });
    const brief = { product: "Kurtas", audience: "", offer: "", tone: "", language: "English" };
    const { user, last } = renderField(field, { env: { ai: makeAi({ available: true, canUse: true }), brief } });
    await user.click(screen.getByRole("button", { name: /Keyword ideas/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("high intent")).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole("checkbox")[1]!);
    await user.click(within(dialog).getByRole("button", { name: "Add 1" }));
    expect(last()).toEqual([{ text: "buy kurta", matchType: "EXACT" }]);
  });

  it("AI keyword errors are toasted", async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError(500, "AI_DOWN", "AI is down"));
    const brief = { product: "Kurtas", audience: "", offer: "", tone: "", language: "English" };
    const { user } = renderField(field, { env: { ai: makeAi({ available: true, canUse: true }), brief } });
    await user.click(screen.getByRole("button", { name: /Keyword ideas/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("AI is down"));
  });
});

// ───────── Placements ─────────

describe("PlacementsInput", () => {
  const field: Field = {
    key: "placements",
    type: "placements",
    label: "Placements",
    autoLabel: "Advantage+ placements",
    autoDescription: "Let Meta choose.",
    groups: [
      { id: "feeds", label: "Feeds", items: [{ value: "fb.feed", label: "Facebook Feed" }, { value: "ig.feed", label: "Instagram feed", description: "Main feed" }] },
      { id: "stories", label: "Stories", items: [{ value: "ig.story", label: "Instagram Stories" }] },
    ],
  };

  it("switches to manual and unticks a whole group or one placement", async () => {
    const { user, last } = renderField(field);
    expect(screen.getByText("Advantage+ placements")).toBeInTheDocument();
    await user.click(screen.getAllByRole("radio")[1]!);
    expect(last()).toEqual({ mode: "MANUAL", items: ["fb.feed", "ig.feed", "ig.story"] });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[0]!); // Feeds group
    expect(last()).toEqual({ mode: "MANUAL", items: ["ig.story"] });
    expect(screen.getByText("0/2")).toBeInTheDocument();
    await user.click(screen.getAllByRole("checkbox")[2]!); // Instagram feed
    expect(last()).toEqual({ mode: "MANUAL", items: ["ig.story", "ig.feed"] });
    expect(screen.getAllByRole("checkbox")[0]).toHaveAttribute("data-state", "indeterminate");
    await user.click(screen.getAllByRole("radio")[0]!);
    expect(last()).toEqual({ mode: "AUTO", items: ["fb.feed", "ig.feed", "ig.story"] });
  });
});

// ───────── Media ─────────

describe("MediaInput", () => {
  const square = makeCreative({ id: "sq", name: "square.jpg", width: 1080, height: 1080 });
  const story = makeCreative({ id: "st", name: "story.jpg", width: 1080, height: 1920 });
  const wide = makeCreative({ id: "wd", name: "wide.jpg", width: 1600, height: 900 });
  const video = makeCreative({ id: "vd", name: "clip.mp4", type: "VIDEO", width: 1080, height: 1080, url: "https://cdn.example.com/clip.mp4" });
  const field: Field = { key: "media", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 2, ratios: ["1:1", "9:16"], specs: "JPG or PNG, 30 MB max" };

  it("starts with only the files that fit and can show everything", async () => {
    const { user } = renderField(field, { env: { creatives: [square, story, wide, video] } });
    expect(screen.getByText("Best: 1:1, 9:16")).toBeInTheDocument();
    expect(screen.getByText("JPG or PNG, 30 MB max")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add media" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Choose up to 2 files/)).toBeInTheDocument();
    const onlyFit = within(dialog).getByRole("checkbox");
    expect(onlyFit).toHaveAttribute("data-state", "checked");
    expect(within(dialog).getByTitle("square.jpg")).toBeInTheDocument();
    expect(within(dialog).getByTitle("story.jpg")).toBeInTheDocument();
    expect(within(dialog).queryByTitle("wide.jpg")).not.toBeInTheDocument();
    // Videos never show in an image-only field.
    expect(within(dialog).queryByTitle("clip.mp4")).not.toBeInTheDocument();
    await user.click(onlyFit);
    expect(within(dialog).getByTitle("wide.jpg")).toBeInTheDocument();
    expect(within(dialog).getByText("16:9 · Video/Display")).toBeInTheDocument();
  });

  it("starts showing everything when nothing fits", async () => {
    const { user } = renderField(field, { env: { creatives: [wide] } });
    await user.click(screen.getByRole("button", { name: "Add media" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox")).toHaveAttribute("data-state", "unchecked");
    expect(within(dialog).getByTitle("wide.jpg")).toBeInTheDocument();
  });

  it("picks files up to max, then shows and removes them", async () => {
    const { user, last } = renderField(field, { env: { creatives: [square, story, makeCreative({ id: "sq2", name: "square2.jpg" })] } });
    await user.click(screen.getByRole("button", { name: "Add media" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByTitle("square.jpg"));
    await user.click(within(dialog).getByTitle("story.jpg"));
    await user.click(within(dialog).getByTitle("square2.jpg"));
    await user.click(within(dialog).getByRole("button", { name: "Use 2 files" }));
    expect(last()).toEqual(["sq", "st"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
    expect(screen.getByAltText("square.jpg")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove square.jpg" }));
    expect(last()).toEqual(["st"]);
  });

  it("single-file fields replace the pick, and requiredRatio filters hard", async () => {
    const one: Field = { key: "v", type: "media", label: "Video", accept: ["VIDEO"], min: 1, max: 1, requiredRatio: "9:16" };
    const tall = makeCreative({ id: "tv", name: "tall.mp4", type: "VIDEO", width: 1080, height: 1920 });
    const { user, last } = renderField(one, { env: { creatives: [video, tall] } });
    await user.click(screen.getByRole("button", { name: "Choose media" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Choose one file/)).toBeInTheDocument();
    expect(within(dialog).queryByTitle("clip.mp4")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTitle("tall.mp4"));
    await user.click(within(dialog).getByRole("button", { name: "Use 1 file" }));
    expect(last()).toEqual(["tv"]);
  });

  it("explains an empty library", async () => {
    const { user } = renderField({ ...field, ratios: undefined } as Field, { env: { creatives: [] } });
    await user.click(screen.getByRole("button", { name: "Add media" }));
    expect(await screen.findByText("No images yet. Upload one to continue.")).toBeInTheDocument();
    expect(screen.queryByText("Only show files that fit")).not.toBeInTheDocument();
  });

  it("uploads files and selects them", async () => {
    const uploaded = makeCreative({ id: "new1", name: "fresh.jpg" });
    vi.mocked(apiUpload).mockResolvedValueOnce([uploaded]);
    const { user, last } = renderField(field, { env: { creatives: [square] } });
    await user.click(screen.getByRole("button", { name: "Add media" }));
    const dialog = await screen.findByRole("dialog");
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute("accept", "image/*");
    await user.upload(input, new File(["x"], "fresh.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 file uploaded"));
    expect(vi.mocked(apiUpload).mock.calls[0]![0]).toBe("/workspaces/ws_1/creatives");
    await user.click(within(dialog).getByRole("button", { name: "Use 1 file" }));
    expect(last()).toEqual(["new1"]);
  });

  it("toasts upload failures", async () => {
    vi.mocked(apiUpload).mockRejectedValueOnce(new Error("Too big"));
    const { user } = renderField(field, { env: { creatives: [] } });
    await user.click(screen.getByRole("button", { name: "Add media" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, new File(["x"], "a.jpg", { type: "image/jpeg" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Too big"));
  });

  it("cancel keeps the previous selection", async () => {
    const { user, onChange } = renderField(field, { value: ["sq"], env: { creatives: [square, story] } });
    await user.click(screen.getByRole("button", { name: "Change" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByTitle("story.jpg"));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ───────── Repeater ─────────

describe("RepeaterInput", () => {
  const field: Field = {
    key: "cards",
    type: "repeater",
    label: "Cards",
    itemLabel: "Card",
    min: 2,
    max: 3,
    fields: [
      { key: "headline", type: "text", label: "Headline", maxLength: 40 },
      { key: "image", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 1 },
    ],
  };

  it("starts with min items, adds up to max and removes", async () => {
    const { user, last } = renderField(field);
    expect(screen.getByText("Card 1")).toBeInTheDocument();
    expect(screen.getByText("Card 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add card/ }));
    expect(last()).toHaveLength(3);
    expect((last() as unknown[])[2]).toEqual({ headline: "", image: [] });
    expect(screen.queryByRole("button", { name: /Add card/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove card 2" }));
    expect(last()).toHaveLength(2);
  });

  it("edits one item's field and shows that item's errors", async () => {
    const { user, last } = renderField(field, { errors: ["Card 2: Headline is required.", "Add at least 2 cards."] });
    expect(screen.getByText("Headline is required.")).toBeInTheDocument();
    const inputs = screen.getAllByLabelText("Headline");
    await user.type(inputs[0]!, "Hi");
    expect(last()).toEqual([
      { headline: "Hi", image: [] },
      { headline: "", image: [] },
    ]);
  });

  it("doesn't let people remove cards below the minimum", () => {
    renderField(field);
    expect(screen.queryByRole("button", { name: /Remove card/ })).not.toBeInTheDocument();
  });
});

// ───────── Ad schedule ─────────

describe("AdScheduleInput", () => {
  const field: Field = { key: "schedule", type: "adSchedule", label: "Ad schedule" };

  it("runs all day until an hour is switched off", async () => {
    const { user, last } = renderField(field);
    expect(screen.getByText(/Ads run all day, every day/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "MON 3:00" }));
    const v = last() as { days: Record<string, [number, number][]> };
    expect(v.days.MON).toEqual([
      [0, 3],
      [4, 24],
    ]);
    expect(v.days.TUE).toEqual([[0, 24]]);
    expect(screen.getByText("Ads run only in the highlighted hours.")).toBeInTheDocument();
    // Switching it back on makes every day full again: stored as "always".
    await user.click(screen.getByRole("button", { name: "MON 3:00" }));
    expect(last()).toEqual({ days: {} });
  });

  it("Reset goes back to always on", async () => {
    const { user, last } = renderField(field, { value: { days: { MON: [[9, 18]] } } });
    expect(screen.getByRole("button", { name: "MON 9:00" })).toHaveClass("bg-primary/80");
    expect(screen.getByRole("button", { name: "MON 8:00" })).toHaveClass("bg-muted");
    expect(screen.getByRole("button", { name: "TUE 9:00" })).toHaveClass("bg-muted");
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(last()).toEqual({ days: {} });
  });
});
