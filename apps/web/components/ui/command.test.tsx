import "@/test-utils/polyfills";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command";

describe("CommandDialog", () => {
  it("renders cmdk parts inside its own Command root, so opening it doesn't crash", async () => {
    const onSelect = vi.fn();
    render(
      <CommandDialog open title="Search" description="Jump to a page">
        <CommandInput placeholder="Search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Pages">
            <CommandItem onSelect={onSelect}>Overview</CommandItem>
            <CommandItem>Reports</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>,
    );

    expect(screen.getByRole("dialog", { name: "Search" })).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Search…");
    expect(screen.getByRole("option", { name: "Overview" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(input, "rep");
    expect(screen.queryByRole("option", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Reports" })).toBeInTheDocument();

    await user.clear(input);
    await user.click(screen.getByRole("option", { name: "Overview" }));
    expect(onSelect).toHaveBeenCalled();
  });
});
