"use client";

import { Loader2, MailWarning } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { toastError } from "@/lib/forms";

/** Shown in the app shell until the user clicks the link we emailed them at sign-up. */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    try {
      await api("/auth/resend-verification", { method: "POST" });
      toast.success("Verification email sent", { description: `Check ${email} for a new link.` });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-primary/20 bg-primary/5 px-4 py-2 text-center text-sm">
      <MailWarning className="size-4 shrink-0 text-primary" />
      <span className="font-medium">Verify your email address.</span>
      <span className="text-muted-foreground">We sent a link to {email}. You need it to invite teammates.</span>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={busy}
        className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-60"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        Resend link
      </button>
    </div>
  );
}
