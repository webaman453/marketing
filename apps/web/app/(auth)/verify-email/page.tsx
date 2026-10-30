"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { qk } from "@/lib/queries";

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ status: "pending" } | { status: "done" } | { status: "error"; message: string }>(
    token ? { status: "pending" } : { status: "error", message: "This verification link is missing its token." },
  );
  // Links are single-use, so a second (dev double-mount) request would report the link as used.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    api("/auth/verify-email", { method: "POST", body: { token } })
      .then(() => {
        setState({ status: "done" });
        void queryClient.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) =>
        setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't verify your email." }),
      );
  }, [token, queryClient]);

  if (state.status === "pending") {
    return (
      <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
        <Loader2 className="size-6 animate-spin" />
        Verifying your email…
      </div>
    );
  }

  const ok = state.status === "done";
  return (
    <div className="text-center animate-fade-up">
      <div
        className={`mx-auto mb-5 flex size-12 items-center justify-center rounded-full ${ok ? "bg-success/10" : "bg-destructive/10"}`}
      >
        {ok ? <CheckCircle2 className="size-6 text-success" /> : <AlertCircle className="size-6 text-destructive" />}
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{ok ? "Email verified" : "Link not valid"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {state.status === "done"
          ? "Thanks for confirming your email address."
          : state.message}
      </p>
      <Button asChild className="mt-8 h-10 w-full">
        <Link href="/app">{ok ? "Continue" : "Go to the app"}</Link>
      </Button>
    </div>
  );
}
