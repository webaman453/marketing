import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Titled settings block with an optional footer bar for the save action. */
export function SettingsCard({
  title,
  description,
  footer,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("gap-5", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && <CardFooter className="justify-end gap-2 border-t bg-muted/30 py-3">{footer}</CardFooter>}
    </Card>
  );
}
