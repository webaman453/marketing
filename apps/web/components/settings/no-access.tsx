import { Lock } from "lucide-react";
import { Card } from "@/components/ui/card";

/** Shown when someone opens a settings page their role can't change. */
export function NoAccess({ what }: { what: string }) {
  return (
    <Card className="items-center gap-2 px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Lock className="size-4.5" />
      </span>
      <h3 className="font-semibold">You can&apos;t change {what}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">Ask an owner or admin of your organization if something needs to change here.</p>
    </Card>
  );
}
