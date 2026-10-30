import { describe, expect, it } from "vitest";
import { ROLES, ROLE_INFO, can, canManageMember, hasAllWorkspaceAccess, type Permission, type Role } from "./roles";

const PERMISSIONS: Permission[] = [
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
];

/** The full matrix: role → permissions it has. */
const EXPECTED: Record<Role, Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: ["org:update", "members:manage", "workspaces:manage", "integrations:manage", "campaigns:edit", "data:view", "audit:view", "leads:export", "leads:manage"],
  MANAGER: ["campaigns:edit", "data:view", "leads:export", "leads:manage"],
  ANALYST: ["data:view"],
  CLIENT: ["data:view"],
};

describe("can", () => {
  const cells = ROLES.flatMap((role) => PERMISSIONS.map((permission) => ({ role, permission, allowed: EXPECTED[role].includes(permission) })));
  it.each(cells)("$role / $permission → $allowed", ({ role, permission, allowed }) => {
    expect(can(role, permission)).toBe(allowed);
  });

  it("only the owner can delete the org or manage billing", () => {
    expect(ROLES.filter((r) => can(r, "org:delete"))).toEqual(["OWNER"]);
    expect(ROLES.filter((r) => can(r, "billing:manage"))).toEqual(["OWNER"]);
  });
  it("lead export (personal data) is limited to owner, admin and manager", () => {
    expect(ROLES.filter((r) => can(r, "leads:export"))).toEqual(["OWNER", "ADMIN", "MANAGER"]);
  });
  it("working leads (status, notes) is limited to owner, admin and manager; analysts and clients only read", () => {
    expect(ROLES.filter((r) => can(r, "leads:manage"))).toEqual(["OWNER", "ADMIN", "MANAGER"]);
  });
  it("everyone can view data", () => {
    for (const r of ROLES) expect(can(r, "data:view")).toBe(true);
  });
});

describe("hasAllWorkspaceAccess", () => {
  it.each([
    ["OWNER", true],
    ["ADMIN", true],
    ["MANAGER", false],
    ["ANALYST", false],
    ["CLIENT", false],
  ] as const)("%s → %s", (role, expected) => {
    expect(hasAllWorkspaceAccess(role)).toBe(expected);
  });
});

describe("canManageMember", () => {
  it("nobody manages the owner; only the owner manages admins; admins manage the rest", () => {
    for (const actor of ROLES) expect(canManageMember(actor, "OWNER")).toBe(false);
    expect(canManageMember("OWNER", "ADMIN")).toBe(true);
    expect(canManageMember("ADMIN", "ADMIN")).toBe(false);
    for (const target of ["MANAGER", "ANALYST", "CLIENT"] as const) {
      expect(canManageMember("OWNER", target)).toBe(true);
      expect(canManageMember("ADMIN", target)).toBe(true);
      expect(canManageMember("MANAGER", target)).toBe(false);
      expect(canManageMember("ANALYST", target)).toBe(false);
      expect(canManageMember("CLIENT", target)).toBe(false);
    }
  });
});

it("ROLE_INFO describes every role", () => {
  expect(Object.keys(ROLE_INFO)).toEqual([...ROLES]);
  for (const r of ROLES) expect(ROLE_INFO[r].label.length).toBeGreaterThan(0);
});
