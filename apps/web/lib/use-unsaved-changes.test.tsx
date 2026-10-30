import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => import("@/test-utils/next-link"));

import { UNSAVED_CHANGES_MESSAGE, useUnsavedChanges } from "./use-unsaved-changes";

function Form({ dirty, onNav }: { dirty: boolean; onNav: () => void }) {
  const { confirmLeave } = useUnsavedChanges(dirty);
  return (
    <div>
      {/* next/link's stand-in; navigates from React's onClick unless the click was cancelled. */}
      <Link
        href="/w/ws_1/overview"
        onClick={(e) => {
          if (e.defaultPrevented) return;
          e.preventDefault();
          onNav();
        }}
      >
        Overview
      </Link>
      <a href="#section" onClick={(e) => e.preventDefault()}>Jump</a>
      <a href="https://example.com/" onClick={(e) => e.preventDefault()}>External</a>
      <button onClick={() => confirmLeave() && onNav()}>Cancel</button>
    </div>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useUnsavedChanges", () => {
  it("lets links through when nothing is unsaved", () => {
    const confirm = vi.spyOn(window, "confirm");
    const onNav = vi.fn();
    render(<Form dirty={false} onNav={onNav} />);
    fireEvent.click(screen.getByText("Overview"));
    expect(confirm).not.toHaveBeenCalled();
    expect(onNav).toHaveBeenCalledOnce();
  });

  it("asks before an in-app link leaves unsaved changes, and stays when told to", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onNav = vi.fn();
    render(<Form dirty onNav={onNav} />);
    fireEvent.click(screen.getByText("Overview"));
    expect(confirm).toHaveBeenCalledWith(UNSAVED_CHANGES_MESSAGE);
    expect(onNav).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText("Overview"));
    expect(onNav).toHaveBeenCalledOnce();
  });

  it("ignores same-page anchors, other sites and modified clicks", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Form dirty onNav={vi.fn()} />);
    fireEvent.click(screen.getByText("Jump"));
    fireEvent.click(screen.getByText("External"));
    fireEvent.click(screen.getByText("Overview"), { metaKey: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("blocks unload only while dirty", () => {
    const { rerender } = render(<Form dirty onNav={vi.fn()} />);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    rerender(<Form dirty={false} onNav={vi.fn()} />);
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("confirmLeave guards programmatic navigation", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onNav = vi.fn();
    render(<Form dirty onNav={onNav} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(confirm).toHaveBeenCalled();
    expect(onNav).not.toHaveBeenCalled();
  });
});
