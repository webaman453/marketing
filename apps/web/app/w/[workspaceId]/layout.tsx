import { AppShell } from "@/components/app/app-shell";

export default function WorkspaceLayout({ children }: LayoutProps<"/w/[workspaceId]">) {
  return <AppShell>{children}</AppShell>;
}
