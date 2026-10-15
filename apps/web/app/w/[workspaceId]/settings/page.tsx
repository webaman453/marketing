import { redirect } from "next/navigation";

export default async function SettingsIndex({ params }: PageProps<"/w/[workspaceId]/settings">) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/settings/general`);
}
