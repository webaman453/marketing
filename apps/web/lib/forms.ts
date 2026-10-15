import type { FieldValues, Path, UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import { ApiError, errorMessage } from "./api";

/**
 * Shows API validation errors next to their fields when possible; otherwise
 * falls back to a root form error (or a toast when no root slot is rendered).
 */
export function applyServerErrors<T extends FieldValues>(err: unknown, setError: UseFormSetError<T>, fields: readonly string[]) {
  if (err instanceof ApiError && err.details) {
    let matched = false;
    for (const [key, messages] of Object.entries(err.details)) {
      if (fields.includes(key) && messages[0]) {
        setError(key as Path<T>, { type: "server", message: messages[0] });
        matched = true;
      }
    }
    if (matched) return;
  }
  setError("root" as Path<T>, { type: "server", message: errorMessage(err) });
}

/** Shows an error toast; plan-limit errors (402) get a shortcut to the plans page. */
export function toastError(err: unknown) {
  if (err instanceof ApiError && err.status === 402 && typeof window !== "undefined") {
    const ws = window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];
    if (err.code === "AI_TOKENS_EXHAUSTED") {
      toast.error("AI tokens used up", {
        description: err.message,
        action: ws ? { label: "Buy tokens", onClick: () => window.location.assign(`/w/${ws}/settings/ai`) } : undefined,
      });
      return;
    }
    toast.error(err.code === "ORG_LOCKED" ? "Your plan is inactive" : "Upgrade required", {
      description: err.message,
      action: ws ? { label: "View plans", onClick: () => window.location.assign(`/w/${ws}/settings/billing`) } : undefined,
    });
    return;
  }
  toast.error(errorMessage(err));
}
