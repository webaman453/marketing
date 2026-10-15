import type { FieldError } from "react-hook-form";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Label + control + inline validation message. */
export function FormField({
  id,
  label,
  error,
  hint,
  action,
  className,
  children,
}: {
  id: string;
  label: React.ReactNode;
  error?: FieldError | { message?: string };
  hint?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="text-[13px]">
          {label}
        </Label>
        {action}
      </div>
      {children}
      {error?.message ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive animate-fade-up">
          {error.message}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
