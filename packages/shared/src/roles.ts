export const ROLES = ["OWNER", "ADMIN", "MANAGER", "ANALYST", "CLIENT"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  OWNER: { label: "Owner", description: "Full access including billing and deleting the organization." },
  ADMIN: { label: "Admin", description: "Manage team, integrations, workspaces and all campaigns." },
  MANAGER: { label: "Manager", description: "Create and edit campaigns in assigned workspaces." },
  ANALYST: { label: "Analyst", description: "View data and build reports. Cannot change campaigns." },
  CLIENT: { label: "Client", description: "Read-only access to assigned workspaces." },
};

export type Permission =
  | "org:update"
  | "org:delete"
  | "billing:manage"
  | "members:manage"
  | "workspaces:manage"
  | "integrations:manage"
  | "campaigns:edit"
  | "data:view"
  | "audit:view"
  /** Download leads (names, emails, phones) as CSV. */
  | "leads:export"
  /** Move leads through the follow-up workflow (status) and write notes on them. */
  | "leads:manage";

const PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: [
    "org:update",
    "org:delete",
    "billing:manage",
    "members:manage",
    "workspaces:manage",
    "integrations:manage",
    "campaigns:edit",
    "data:view",
    "audit:view",
    "leads:export",
    "leads:manage",
  ],
  ADMIN: [
    "org:update",
    "members:manage",
    "workspaces:manage",
    "integrations:manage",
    "campaigns:edit",
    "data:view",
    "audit:view",
    "leads:export",
    "leads:manage",
  ],
  MANAGER: ["campaigns:edit", "data:view", "leads:export", "leads:manage"],
  ANALYST: ["data:view"],
  CLIENT: ["data:view"],
};

export const can = (role: Role, permission: Permission) => PERMISSIONS[role].includes(permission);

/** Roles below ADMIN only see workspaces they are explicitly assigned to. */
export const hasAllWorkspaceAccess = (role: Role) => role === "OWNER" || role === "ADMIN";

/**
 * Whether `actor` may change the role of, or remove, a member with role `target`.
 * Nobody manages the owner; only the owner manages admins.
 */
export const canManageMember = (actor: Role, target: Role) =>
  target !== "OWNER" && (actor === "OWNER" || (actor === "ADMIN" && target !== "ADMIN"));
