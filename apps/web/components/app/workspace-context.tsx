"use client";

import { can, type MeResponse, type OrgDTO, type Permission, type WorkspaceDTO } from "@ashniva/shared";
import { createContext, useContext } from "react";

export interface WorkspaceContextValue {
  me: MeResponse;
  org: OrgDTO;
  workspace: WorkspaceDTO;
  can: (permission: Permission) => boolean;
}

const Ctx = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  me,
  org,
  workspace,
  children,
}: Omit<WorkspaceContextValue, "can"> & { children: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ me, org, workspace, can: (p) => can(org.role, p) }}>{children}</Ctx.Provider>
  );
}

export function useWorkspace() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside the workspace layout");
  return v;
}

/** Remembers the last workspace so /app can return the user to it. */
export const LAST_WORKSPACE_KEY = "ashniva-last-workspace";
