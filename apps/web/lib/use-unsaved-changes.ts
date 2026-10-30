"use client";

import { useCallback, useEffect, useRef } from "react";

export const UNSAVED_CHANGES_MESSAGE = "You have unsaved changes. Leave without saving?";

/** The same-origin page an in-app link click would open, or null when the click isn't a plain navigation away. */
function leavingTo(e: MouseEvent): URL | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const target = e.target instanceof Element ? e.target : null;
  const a = target?.closest("a[href]");
  if (!(a instanceof HTMLAnchorElement)) return null;
  if (a.hasAttribute("download") || (a.target && a.target !== "_self")) return null;
  let url: URL;
  try {
    url = new URL(a.href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  // Jumping to an anchor on the same page keeps the form.
  if (url.pathname === window.location.pathname && url.search === window.location.search) return null;
  return url;
}

/**
 * Warns before unsaved edits are lost: the browser's own prompt on reload, close or an external
 * link, and a confirm on in-app link clicks (sidebar, breadcrumbs, back links…).
 * Programmatic `router.push` isn't intercepted; call `confirmLeave()` before one.
 */
export function useUnsavedChanges(dirty: boolean, message = UNSAVED_CHANGES_MESSAGE) {
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      e.returnValue = "";
    };
    // Capture phase on the document runs before React's handlers, so a cancelled click never
    // reaches next/link's onClick.
    const onClick = (e: MouseEvent) => {
      if (!leavingTo(e)) return;
      if (window.confirm(message)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);

  /** True when it's fine to navigate away (nothing unsaved, or the user agreed to discard). */
  const confirmLeave = useCallback(() => !dirtyRef.current || window.confirm(message), [message]);
  return { confirmLeave };
}
