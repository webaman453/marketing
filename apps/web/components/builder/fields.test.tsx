import type { Field } from "@ashniva/shared";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => import("@/test-utils/next-link"));
vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn(), apiUpload: vi.fn() }));

import { api } from "@/lib/api";
import { renderField } from "@/test-utils/field-harness";
import { makeAi, routeApi } from "@/test-utils";
import { renderWithBuilder } from "@/test-utils";
import { OptionIcon, SectionTitleContext, FieldRenderer } from "./fields";

const OPTIONS = [
  { value: "A", label: "Alpha", description: "First letter", icon: "Megaphone", badge: "New" },
  { value: "B", label: "Bravo" },
  { value: "C", label: "Charlie" },
];

describe("FieldRenderer · text fields", () => {
  const text: Field = { key: "headline", type: "text", label: "Headline", maxLength: 10, recommendedLength: 6, required: true, placeholder: "Say it", help: "Shown above the image." };

  it("shows the label, required star, help and a live character counter", async () => {
    const { user, last } = renderField(text);
    const input = screen.getByLabelText(/Headline/);
    expect(input).toHaveAttribute("id", "f-headline");
    expect(input).toHaveAttribute("placeholder", "Say it");
    expect(screen.getByText("*")).toBeInTheDocument();
    expect(screen.getByText("Shown above the image.")).toBeInTheDocument();
    expect(screen.getByText("0/10")).toBeInTheDocument();
    await user.type(input, "Hello");
    expect(last()).toBe("Hello");
    expect(screen.getByText("5/10")).not.toHaveAttribute("title");
  });

  it("warns past the recommended length and turns red past the limit", async () => {
    const { user } = renderField(text);
    const input = screen.getByLabelText(/Headline/);
    await user.type(input, "Hello wo");
    expect(screen.getByText("8/10")).toHaveAttribute("title", "Over 6 characters may be cut off in some placements");
    expect(screen.getByText("8/10")).toHaveClass("text-warning");
    await user.type(input, "rld!");
    // The counter reports, it doesn't cut people off: the platform's limit is checked on publish.
    expect(screen.getByText("12/10")).toHaveClass("text-destructive");
    expect(input).toHaveValue("Hello world!");
  });

  it("has no counter without a maxLength", () => {
    renderField({ key: "n", type: "text", label: "Name" }, { value: "abc" });
    expect(screen.queryByText(/\/\d+$/)).not.toBeInTheDocument();
  });

  it("adds https:// to a URL on blur", async () => {
    const { user, last } = renderField({ key: "url", type: "url", label: "Website URL" });
    const input = screen.getByLabelText("Website URL");
    expect(input).toHaveAttribute("type", "url");
    await user.type(input, "  shop.example.com ");
    await user.tab();
    expect(last()).toBe("https://shop.example.com");
    expect(input).toHaveValue("https://shop.example.com");
  });

  it("leaves URLs that already have a scheme, and empty URLs, alone", async () => {
    const { user, onChange } = renderField({ key: "url", type: "url", label: "Website URL" }, { value: "mailto:a@b.co" });
    await user.click(screen.getByLabelText("Website URL"));
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    const empty = renderField({ key: "url2", type: "url", label: "Other URL" }, { value: "   " });
    await empty.user.click(screen.getByLabelText("Other URL"));
    await empty.user.tab();
    expect(empty.onChange).not.toHaveBeenCalled();
  });

  it("never rewrites plain text fields on blur", async () => {
    const { user, onChange } = renderField({ key: "t", type: "text", label: "Title" }, { value: "shop.example.com" });
    await user.click(screen.getByLabelText("Title"));
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a textarea with its rows and marks it invalid with errors", () => {
    renderField({ key: "body", type: "textarea", label: "Primary text", rows: 5 }, { errors: ["Primary text is required.", "Too short"] });
    const area = screen.getByLabelText("Primary text");
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveAttribute("rows", "5");
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Primary text is required.")).toBeInTheDocument();
    expect(screen.getByText("Too short")).toBeInTheDocument();
  });

  it("shows errors instead of the help text", () => {
    renderField({ key: "x", type: "text", label: "X", help: "Helpful" }, { errors: ["X is required."] });
    expect(screen.queryByText("Helpful")).not.toBeInTheDocument();
    expect(screen.getByText("X is required.")).toBeInTheDocument();
  });

  it("uses the default value when none is set", () => {
    renderField({ key: "x", type: "text", label: "X", default: "Preset" });
    expect(screen.getByLabelText("X")).toHaveValue("Preset");
  });

  it("hides fields whose showIf is false", () => {
    const { container } = renderField({ key: "x", type: "text", label: "Hidden", showIf: (ctx) => ctx.setup.mode === "on" });
    expect(container).toBeEmptyDOMElement();
  });

  it("treats a required condition as required only when it holds", () => {
    renderField({ key: "x", type: "text", label: "Conditional", required: (ctx) => ctx.campaign.need === true }, { ctx: { campaign: { need: true } } });
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("keeps the label for screen readers only when it repeats the section title", () => {
    renderWithBuilder(
      <SectionTitleContext.Provider value="Budget">
        <FieldRenderer field={{ key: "b", type: "number", label: "Budget" }} value={null} onChange={() => {}} ctx={{ setup: {}, campaign: {}, adGroup: {}, ad: {} }} errors={[]} />
      </SectionTitleContext.Provider>,
    );
    expect(screen.getByText("Budget").parentElement).toHaveClass("sr-only");
  });
});

describe("FieldRenderer · text lists", () => {
  const list: Field = { key: "headlines", type: "textList", label: "Headlines", itemLabel: "Headline", min: 1, max: 3, maxLength: 30 };

  it("starts with one row, adds rows up to max and removes them", async () => {
    const { user, last } = renderField(list);
    expect(screen.getAllByPlaceholderText(/Headline \d/)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Remove headline" })).not.toBeInTheDocument();
    expect(screen.getByText("0/3")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Headline 1"), "First");
    expect(last()).toEqual(["First"]);
    expect(screen.getByText("1/3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Add headline/ }));
    await user.click(screen.getByRole("button", { name: /Add headline/ }));
    expect(screen.getAllByPlaceholderText(/Headline \d/)).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Add headline/ })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Remove headline" })[0]!);
    expect(last()).toEqual(["", ""]);
  });

  it("lets every row go when min is 0", async () => {
    const { user, last } = renderField({ ...list, min: 0 } as Field, { value: ["one"] });
    await user.click(screen.getByRole("button", { name: "Remove headline" }));
    expect(last()).toEqual([]);
  });

  it("keeps pins on pinnable lists", async () => {
    const { user, last } = renderField({ ...list, pinnable: { positions: ["1", "2"] }, multiline: true } as Field, { value: [{ text: "Pinned", pin: null }] });
    expect(screen.getByDisplayValue("Pinned").tagName).toBe("TEXTAREA");
    await user.click(screen.getByRole("combobox", { name: "Pin position" }));
    await user.click(await screen.findByRole("option", { name: "Pin 2" }));
    expect(last()).toEqual([{ text: "Pinned", pin: "2" }]);
  });
});

describe("FieldRenderer · numbers", () => {
  it("emits numbers, null when cleared, and passes min/max/step", async () => {
    const { user, last } = renderField({ key: "cap", type: "number", label: "Frequency cap", min: 1, max: 90, suffix: "×" });
    const input = screen.getByLabelText("Frequency cap");
    expect(input).toHaveAttribute("min", "1");
    expect(input).toHaveAttribute("max", "90");
    expect(input).toHaveAttribute("step", "any");
    expect(screen.getByText("×")).toBeInTheDocument();
    await user.type(input, "12");
    expect(last()).toBe(12);
    await user.clear(input);
    expect(last()).toBeNull();
  });

  it("shows the currency symbol on money fields and steps by whole units", () => {
    renderField({ key: "budget", type: "money", label: "Daily budget", min: 100 }, { value: 500, env: { currency: "USD" } });
    expect(screen.getByText("$")).toBeInTheDocument();
    expect(screen.getByLabelText("Daily budget")).toHaveAttribute("step", "1");
    expect(screen.getByLabelText("Daily budget")).toHaveValue(500);
  });

  it("uses ₹ for INR and % for percent fields", () => {
    renderField({ key: "budget", type: "money", label: "Budget" }, { value: 1 });
    expect(screen.getByText("₹")).toBeInTheDocument();
    renderField({ key: "share", type: "percent", label: "Share" }, { value: 5 });
    expect(screen.getByText("%")).toBeInTheDocument();
  });
});

describe("FieldRenderer · single choice", () => {
  it("select: shows a placeholder and picks an option", async () => {
    const { user, last } = renderField({ key: "cta", type: "select", label: "Call to action", options: OPTIONS, placeholder: "Pick one" });
    const trigger = screen.getByRole("combobox", { name: "Call to action" });
    expect(trigger).toHaveTextContent("Pick one");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Bravo" }));
    expect(last()).toBe("B");
    expect(screen.getByRole("combobox", { name: "Call to action" })).toHaveTextContent("Bravo");
  });

  it("radio: defaults to the first option and switches", async () => {
    const { user, last } = renderField({ key: "loc", type: "radio", label: "Location", options: OPTIONS });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute("data-state", "checked");
    expect(screen.getByText("First letter")).toBeInTheDocument();
    await user.click(radios[2]!);
    expect(last()).toBe("C");
  });

  it("cards: icons, badges, descriptions and disabled cards", async () => {
    const opts = [...OPTIONS, { value: "D", label: "Delta", disabled: true, disabledReason: "Not on this account" }];
    const { user, last } = renderField({ key: "obj", type: "cards", label: "Objective", options: opts }, { value: "B" });
    expect(screen.getByRole("radio", { name: "Bravo" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Delta" })).toBeDisabled();
    expect(screen.getByText("Not on this account")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Alpha" }));
    expect(last()).toBe("A");
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
  });

  it("segmented: toggles aria-checked", async () => {
    const { user, last } = renderField({ key: "mode", type: "segmented", label: "Mode", options: OPTIONS.slice(1), default: "C" });
    expect(screen.getByRole("radio", { name: "Charlie" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Bravo" }));
    expect(last()).toBe("B");
    expect(screen.getByRole("radio", { name: "Bravo" })).toHaveAttribute("aria-checked", "true");
  });

  it("resolves options from a function of the context", () => {
    renderField(
      { key: "x", type: "segmented", label: "Dynamic", options: (ctx) => [{ value: String(ctx.setup.kind), label: `Kind ${String(ctx.setup.kind)}` }] },
      { ctx: { setup: { kind: "z" } } },
    );
    expect(screen.getByRole("radio", { name: "Kind z" })).toBeInTheDocument();
  });

  it("OptionIcon renders nothing for unknown icon names", () => {
    const { container } = renderWithBuilder(<OptionIcon name="NoSuchIcon" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FieldRenderer · multiple choice", () => {
  it("multiSelect: picks from the popover, shows a count and removable chips, respects max", async () => {
    const { user, last } = renderField({ key: "countries", type: "multiSelect", label: "Countries", options: OPTIONS, max: 2 });
    const trigger = screen.getByRole("button", { name: "Countries" });
    expect(trigger).toHaveTextContent("Choose…");
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: /Alpha/ }));
    expect(last()).toEqual(["A"]);
    await user.click(screen.getByRole("option", { name: /Charlie/ }));
    expect(last()).toEqual(["A", "C"]);
    await user.click(screen.getByRole("option", { name: /Bravo/ }));
    // Max reached: nothing added.
    expect(last()).toEqual(["A", "C"]);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Countries" })).toHaveTextContent("2 selected");
    await user.click(screen.getByRole("button", { name: "Remove Alpha" }));
    expect(last()).toEqual(["C"]);
  });

  it("chips: toggle on and off", async () => {
    const { user, last } = renderField({ key: "days", type: "chips", label: "Days", options: OPTIONS }, { value: ["B"] });
    await user.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(last()).toEqual(["B", "A"]);
    await user.click(screen.getByRole("button", { name: /Bravo/ }));
    expect(last()).toEqual(["A"]);
  });

  it("checkboxes: tick and untick, honouring max", async () => {
    const { user, last } = renderField({ key: "cats", type: "checkboxes", label: "Categories", options: OPTIONS, max: 1 });
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[0]!);
    expect(last()).toEqual(["A"]);
    await user.click(boxes[1]!);
    expect(last()).toEqual(["A"]);
    await user.click(boxes[0]!);
    expect(last()).toEqual([]);
  });
});

describe("FieldRenderer · toggle, date, age, info", () => {
  it("toggle switches on and off", async () => {
    const { user, last } = renderField({ key: "cbo", type: "toggle", label: "Advantage+ budget", description: "Let Meta spread the budget" });
    expect(screen.getByText("Let Meta spread the budget")).toBeInTheDocument();
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    await user.click(sw);
    expect(last()).toBe(true);
    await user.click(sw);
    expect(last()).toBe(false);
  });

  it("date: sets a value and clears an optional one", async () => {
    const { user, last } = renderField({ key: "end", type: "date", label: "End date" });
    const input = screen.getByLabelText("End date");
    expect(input).toHaveAttribute("type", "date");
    expect(screen.queryByRole("button", { name: "Clear date" })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "2026-12-31" } });
    expect(last()).toBe("2026-12-31");
    await user.click(screen.getByRole("button", { name: "Clear date" }));
    expect(last()).toBeNull();
  });

  it("datetime: required dates can't be cleared", () => {
    renderField({ key: "start", type: "datetime", label: "Start", required: true }, { value: "2026-11-01T10:00" });
    expect(screen.getByLabelText(/Start/)).toHaveAttribute("type", "datetime-local");
    expect(screen.queryByRole("button", { name: "Clear date" })).not.toBeInTheDocument();
  });

  it("date and datetime fields name the zone they're entered in", () => {
    renderField({ key: "start", type: "datetime", label: "Start" }, { env: { timeZone: { zone: "Asia/Kolkata", source: "account" } } });
    const note = screen.getByText("Times are in Asia/Kolkata (ad account time zone)");
    expect(screen.getByLabelText("Start")).toHaveAttribute("aria-describedby", note.id);
  });

  it("date fields fall back to the workspace zone", () => {
    renderField({ key: "end", type: "date", label: "End date" }, { env: { timeZone: { zone: "Europe/London", source: "workspace" } } });
    expect(screen.getByText("Dates are in Europe/London (workspace time zone)")).toBeInTheDocument();
  });

  it("ageRange: picks a minimum and shows 65+", async () => {
    const { user, last } = renderField({ key: "age", type: "ageRange", label: "Age", min: 18, max: 65, openEnded: true });
    const [minSel, maxSel] = screen.getAllByRole("combobox");
    expect(minSel).toHaveTextContent("18");
    expect(maxSel).toHaveTextContent("65+");
    await user.click(minSel!);
    await user.click(await screen.findByRole("option", { name: "25" }));
    expect(last()).toEqual({ min: 25, max: 65 });
  });

  it("info: shows label and help, warning tone", () => {
    const { container } = renderField({ key: "i", type: "info", label: "Heads up", help: "Ads need review.", tone: "warning" });
    expect(screen.getByText("Heads up")).toBeInTheDocument();
    expect(screen.getByText("Ads need review.")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("border-warning/40");
  });
});

describe("FieldRenderer · account options", () => {
  const field: Field = { key: "pageId", type: "accountOption", source: "pages", label: "Facebook Page", required: true, autoSelect: true };

  it("lists the account's options and shows the chosen name", async () => {
    const { user, last } = renderField(field, { env: { options: { pages: [{ id: "p1", name: "Acme Store", detail: "1.2K followers" }, { id: "p2", name: "Acme Outlet" }] } } });
    const trigger = screen.getByRole("combobox", { name: /Facebook Page/ });
    expect(trigger).toHaveTextContent("Choose…");
    await user.click(trigger);
    expect(await screen.findByText("1.2K followers")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Acme Outlet/ }));
    expect(last()).toBe("p2");
    expect(screen.getByRole("combobox", { name: /Facebook Page/ })).toHaveTextContent("Acme Outlet");
  });

  it("says Loading… while options load and explains when the account has none", () => {
    renderField(field, { env: { optionsLoading: true } });
    expect(screen.getByRole("combobox")).toHaveTextContent("Loading…");
  });

  it("explains when the ad account has none", () => {
    renderField(field);
    expect(screen.getByRole("combobox")).toHaveTextContent("None found in this ad account");
    expect(screen.getByText(/This ad account has none yet/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the failure with a Retry instead of saying there are none", async () => {
    const retryOptions = vi.fn();
    const { user } = renderField(field, { env: { optionsError: "Meta didn't respond.", retryOptions } });
    expect(screen.getByRole("combobox")).toHaveTextContent("Couldn't load from the ad account");
    expect(screen.queryByText(/None found/)).not.toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load facebook page from the ad account. Meta didn't respond.");
    await user.click(within(alert).getByRole("button", { name: /Retry/ }));
    expect(retryOptions).toHaveBeenCalledOnce();
  });

  it("multiple: uses the multi-select popover", async () => {
    const { user, last } = renderField({ ...field, multiple: true } as Field, { env: { options: { pages: [{ id: "p1", name: "Acme Store" }] } } });
    await user.click(screen.getByRole("button", { name: /Facebook Page/ }));
    await user.click(await screen.findByRole("option", { name: /Acme Store/ }));
    expect(last()).toEqual(["p1"]);
  });
});

describe("FieldRenderer · AI suggestions on text", () => {
  const field: Field = { key: "headline", type: "text", label: "Headline", maxLength: 40, ai: { purpose: "short headline" } };

  it("is hidden when AI isn't available", () => {
    renderField(field, { env: { ai: makeAi({ available: false }) } });
    expect(screen.queryByRole("button", { name: /Suggest/ })).not.toBeInTheDocument();
  });

  it("loads suggestions and inserts the one picked", async () => {
    routeApi(api, { "POST /workspaces/ws_1/ai/builder/suggest": { suggestions: ["Big Diwali Sale", "Flat 40% off"] } });
    const onAiUsed = vi.fn();
    const { user, last } = renderField(field, { env: { ai: makeAi({ available: true, canUse: true, balance: 5000 }), onAiUsed } });
    await user.click(screen.getByRole("button", { name: /Suggest/ }));
    await user.click(await screen.findByRole("button", { name: /Flat 40% off/ }));
    expect(last()).toBe("Flat 40% off");
    expect(onAiUsed).toHaveBeenCalled();
    const body = vi.mocked(api).mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ platform: "META", label: "Headline", purpose: "short headline", maxLength: 40, count: 4 });
    expect(screen.queryByRole("button", { name: /Flat 40% off/ })).not.toBeInTheDocument();
  });

  it("points to buying tokens when the balance has run out", async () => {
    const { user } = renderField(field, { env: { ai: makeAi({ available: true, canUse: false }) } });
    await user.click(screen.getByRole("button", { name: /Suggest/ }));
    const notice = await screen.findByText(/AI tokens used up/);
    expect(within(notice).getByRole("link", { name: "Buy tokens" })).toHaveAttribute("href", "/w/ws_1/settings/ai");
  });
});
