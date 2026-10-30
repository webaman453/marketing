/** Canned API shapes for web tests. Every builder takes overrides. */
import type {
  AdAccountDTO,
  AiStatusDTO,
  ConnectionDTO,
  CreativeDTO,
  LeadDTO,
  LeadsResponse,
  MeResponse,
  OrgDTO,
  Role,
  UserDTO,
  WorkspaceDTO,
} from "@ashniva/shared";
import type { BillingInfo, PlatformCatalogItem } from "@/lib/queries";
import { LEAD_STATUSES, PLATFORM_INFO, type Platform } from "@ashniva/shared";

export const makeUser = (o: Partial<UserDTO> = {}): UserDTO => ({
  id: "user_1",
  name: "Asha Verma",
  email: "asha@example.com",
  avatarUrl: null,
  emailVerified: true,
  isSuperAdmin: false,
  trialUsed: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

export const makeWorkspace = (o: Partial<WorkspaceDTO> = {}): WorkspaceDTO => ({
  id: "ws_1",
  orgId: "org_1",
  name: "Main workspace",
  slug: "main",
  currency: "INR",
  timezone: "Asia/Kolkata",
  adAccountCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

export const makeOrg = (o: Partial<OrgDTO> = {}): OrgDTO => ({
  id: "org_1",
  name: "Acme Retail",
  slug: "acme",
  plan: "GROWTH",
  trialEndsAt: null,
  subscriptionStatus: "ACTIVE",
  currentPeriodEnd: null,
  locked: false,
  branding: { brandName: null, brandColor: null, brandLogoUrl: null, reportFooter: null },
  role: "OWNER",
  workspaces: [makeWorkspace()],
  ...o,
});

export const makeMe = (o: { user?: Partial<UserDTO>; orgs?: OrgDTO[] } = {}): MeResponse => ({
  user: makeUser(o.user),
  orgs: o.orgs ?? [makeOrg()],
});

export const makeCreative = (o: Partial<CreativeDTO> = {}): CreativeDTO => ({
  id: "cr_1",
  name: "square.jpg",
  type: "IMAGE",
  mimeType: "image/jpeg",
  sizeBytes: 120_000,
  width: 1080,
  height: 1080,
  url: "https://cdn.example.com/square.jpg",
  tags: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

export const makeAi = (o: Partial<AiStatusDTO> = {}): AiStatusDTO => ({ available: false, balance: 0, canUse: false, ...o });

export type WorkspaceAdAccount = { id: string; name: string; externalId: string; platform: Platform; currency: string; sample: boolean; connected: boolean };

export const makeWsAccount = (o: Partial<WorkspaceAdAccount> = {}): WorkspaceAdAccount => ({
  id: "acc_1",
  name: "Acme India",
  externalId: "act_111",
  platform: "META",
  currency: "INR",
  sample: false,
  connected: true,
  ...o,
});

export const makeOrgAccount = (o: Partial<AdAccountDTO> = {}): AdAccountDTO => ({
  id: "acc_1",
  platform: "META",
  externalId: "act_111",
  name: "Acme India",
  currency: "INR",
  timezone: "Asia/Kolkata",
  status: "ACTIVE",
  connectionId: "conn_1",
  workspaceId: "ws_1",
  workspaceName: "Main workspace",
  lastSyncedAt: null,
  ...o,
});

export const makeConnection = (o: Partial<ConnectionDTO> = {}): ConnectionDTO => ({
  id: "conn_1",
  platform: "META",
  mode: "LIVE",
  status: "ACTIVE",
  externalUserName: "Asha (Business Manager)",
  syncStatus: "SUCCESS",
  lastSyncedAt: null,
  lastSyncError: null,
  adAccountCount: 2,
  connectedBy: "Asha",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

export const makePlatform = (id: Platform, o: Partial<PlatformCatalogItem> = {}): PlatformCatalogItem => ({
  ...PLATFORM_INFO[id],
  supported: true,
  configured: true,
  ...o,
});

export const makeBilling = (o: Partial<BillingInfo> = {}): BillingInfo => ({
  plan: "GROWTH",
  subscriptionStatus: "ACTIVE",
  trialEndsAt: null,
  currentPeriodEnd: null,
  provider: null,
  usage: { workspaces: 1, adAccounts: 2, members: 3 } as BillingInfo["usage"],
  limits: { workspaces: 5, adAccounts: 10, members: null },
  checkoutEnabled: false,
  razorpayKeyId: null,
  ...o,
});

export const makeLead = (o: Partial<LeadDTO> = {}): LeadDTO => ({
  id: "lead_1",
  platform: "META",
  source: "fb",
  name: "Ravi Kumar",
  email: "ravi@example.com",
  phone: "+91 90000 00000",
  campaignId: "c_1",
  campaignName: "Diwali leads",
  adGroupId: "g_1",
  adGroupName: "Ad set 1",
  adId: "ad_1",
  adName: "Ad 1",
  formId: "form_1",
  formName: "Diwali form",
  isOrganic: false,
  createdTime: "2026-10-20T10:30:00.000Z",
  estCost: 120,
  currency: "INR",
  fields: { full_name: ["Ravi Kumar"], city: ["Pune"] },
  status: "NEW",
  note: null,
  statusUpdatedAt: null,
  statusUpdatedBy: null,
  ...o,
});

export const makeLeads = (o: Partial<LeadsResponse> = {}): LeadsResponse => {
  const leads = o.leads ?? [makeLead()];
  return {
    total: leads.length,
    page: 1,
    pageSize: 25,
    leads,
    summary: { total: leads.length, avgCost: 120, totalCost: 120, currency: "INR", withPhone: leads.length, withEmail: leads.length, organic: 0 },
    byStatus: LEAD_STATUSES.map((status) => ({ status, count: leads.filter((l) => l.status === status).length })),
    bySource: [{ source: "fb", count: leads.length }],
    byPlatform: [{ platform: "META", count: leads.length }],
    byHour: Array.from({ length: 24 }, (_, h) => (h === 10 ? leads.length : 0)),
    byDay: [],
    byCampaign: [{ campaignId: "c_1", name: "Diwali leads", count: leads.length, cost: 120 }],
    byAdGroup: [{ id: "g_1", name: "Ad set 1", count: leads.length }],
    byAd: [{ id: "ad_1", name: "Ad 1", count: leads.length }],
    byForm: [{ id: "form_1", name: "Diwali form", count: leads.length }],
    leadsError: null,
    timezone: "Asia/Kolkata",
    ...o,
  };
};

export const ROLES_ALL: Role[] = ["OWNER", "ADMIN", "MANAGER", "ANALYST", "CLIENT"];
