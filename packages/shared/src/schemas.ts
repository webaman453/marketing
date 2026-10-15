import { z } from "zod";
import { PLATFORMS } from "./platforms";
import { ROLES } from "./roles";

const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password is too long")
  .regex(/[A-Za-z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const name = z.string().trim().min(2, "Must be at least 2 characters").max(80);
const email = z.email("Enter a valid email address").trim().toLowerCase();

// ---------- Auth ----------
const companyName = z.string().trim().min(2, "Enter your company name").max(80);

export const registerSchema = z.object({ name, email, password, companyName });
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email,
  password: z.string({ error: "Enter your password" }).min(1, "Enter your password"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: z.string().min(10), password });
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const updateProfileSchema = z.object({ name });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password"),
  newPassword: password,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ---------- Organization & team ----------
export const createOrgSchema = z.object({ companyName });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z.object({ name: z.string().trim().min(2).max(80) });
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>;

export const inviteMemberSchema = z
  .object({
    email,
    role: z.enum(ROLES).exclude(["OWNER"]),
    workspaceIds: z.array(z.string()).default([]),
  })
  // Managers, analysts and clients only see the workspaces they're given.
  .refine((v) => v.role === "ADMIN" || v.workspaceIds.length > 0, { path: ["workspaceIds"], message: "Choose at least one workspace" });
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(ROLES).exclude(["OWNER"]),
  workspaceIds: z.array(z.string()).optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(10),
  name: name.optional(),
  password: password.optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

// ---------- Workspaces ----------
export const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "AUD", "CAD", "SGD"] as const;

export const workspaceSchema = z.object({
  name: z.string().trim().min(2, "Must be at least 2 characters").max(60),
  currency: z.enum(CURRENCIES).default("INR"),
  timezone: z
    .string()
    .min(1)
    .default("Asia/Kolkata")
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid timezone"),
});
export type WorkspaceInput = z.infer<typeof workspaceSchema>;

// ---------- Integrations ----------
export const platformParam = z.enum(PLATFORMS);

export const assignAdAccountSchema = z.object({
  workspaceId: z.string().nullable(),
});
export type AssignAdAccountInput = z.infer<typeof assignAdAccountSchema>;

// ---------- Campaigns ----------
export const ENTITY_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED", "REMOVED"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const updateCampaignStatusSchema = z.object({
  status: z.enum(["ACTIVE", "PAUSED"]),
});

export const updateCampaignBudgetSchema = z.object({
  dailyBudget: z.number().positive("Budget must be greater than zero").max(100_000_000),
});

export const bulkCampaignActionSchema = z.object({
  campaignIds: z.array(z.string()).min(1).max(200),
  status: z.enum(["ACTIVE", "PAUSED"]),
});

// ---------- Queries ----------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const dateRangeQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { message: "`from` must be before `to`" });
export type DateRangeQuery = z.infer<typeof dateRangeQuery>;

export const campaignListQuery = z.object({
  from: isoDate,
  to: isoDate,
  platform: z.enum(PLATFORMS).optional(),
  status: z.enum(ENTITY_STATUSES).optional(),
  adAccountId: z.string().optional(),
  search: z.string().trim().max(100).optional(),
});
export type CampaignListQuery = z.infer<typeof campaignListQuery>;
