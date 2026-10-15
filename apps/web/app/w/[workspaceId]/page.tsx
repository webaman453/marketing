import { redirect } from "next/navigation";

export default async function WorkspaceIndex({ params }: PageProps<"/w/[workspaceId]">) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/overview`);
}
