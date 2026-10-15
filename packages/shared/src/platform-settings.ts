/**
 * Settings the platform owner (super admin) manages from the admin console:
 * app credentials for every integration, and the public price list (plans,
 * trial, AI tokens). Values saved there override the server's .env.
 */
import { z } from "zod";
import { AI_FREE_TOKENS, AI_MIN_BALANCE, AI_TOKEN_PACKS, type AiTokenPack } from "./ai";
import { PLANS, type Feature, type PlanId } from "./plans";
import type { Platform } from "./platforms";

// ───────── Credentials ─────────

export interface CredentialField {
  /** Environment variable it replaces, e.g. META_APP_SECRET */
  key: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[];
}

export type CredentialGroupId = "META" | "GOOGLE" | "TIKTOK" | "LINKEDIN" | "MICROSOFT" | "SNAPCHAT" | "PINTEREST" | "AI" | "RAZORPAY" | "EMAIL";

export interface CredentialGroup {
  id: CredentialGroupId;
  title: string;
  kind: "platform" | "ai" | "billing" | "email";
  platform?: Platform;
  /** What it unlocks, in one line. */
  purpose: string;
  /** Where the keys come from. */
  consoleUrl: string;
  consoleLabel: string;
  steps: string[];
  /** Shows the OAuth redirect URL to register with the platform. */
  needsRedirectUrl?: boolean;
  /** Shows the webhook URL to register (Razorpay). */
  needsWebhookUrl?: boolean;
  /** The server can check these keys without a customer login. */
  testable?: boolean;
  fields: CredentialField[];
}

export const CREDENTIAL_GROUPS: CredentialGroup[] = [
  {
    id: "META",
    title: "Meta (Facebook & Instagram)",
    kind: "platform",
    platform: "META",
    purpose: "Lets customers connect Facebook and Instagram ad accounts.",
    consoleUrl: "https://developers.facebook.com/apps",
    consoleLabel: "Meta for Developers",
    steps: [
      "Open Meta for Developers → My Apps → Create app, and choose the Business type.",
      "Add the products Marketing API and Facebook Login for Business.",
      "In Facebook Login for Business → Settings, paste the redirect URL below into Valid OAuth Redirect URIs.",
      "Go to App settings → Basic and copy the App ID and App secret into the fields here.",
      "Before outside customers can connect, complete Business Verification and App Review for ads_management, ads_read, business_management, pages_show_list and pages_read_engagement.",
    ],
    needsRedirectUrl: true,
    testable: true,
    fields: [
      { key: "META_APP_ID", label: "App ID", placeholder: "1234567890123456" },
      { key: "META_APP_SECRET", label: "App secret", secret: true },
      { key: "META_API_VERSION", label: "Marketing API version", optional: true, placeholder: "v26.0", help: "Leave empty for the version this release was built for." },
    ],
  },
  {
    id: "GOOGLE",
    title: "Google Ads (and YouTube)",
    kind: "platform",
    platform: "GOOGLE",
    purpose: "Lets customers connect Google Ads accounts, including YouTube campaigns.",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    consoleLabel: "Google Cloud Console",
    steps: [
      "In Google Cloud Console, create a project and enable the Google Ads API.",
      "Set up the OAuth consent screen (External) and add the scope https://www.googleapis.com/auth/adwords.",
      "Credentials → Create credentials → OAuth client ID → Web application. Add the redirect URL below under Authorized redirect URIs, then copy the Client ID and Client secret here.",
      "In your Google Ads manager (MCC) account, open Tools → API Center and apply for a developer token. A test token only works with test accounts; apply for Basic access for real ones.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "GOOGLE_CLIENT_ID", label: "OAuth client ID", placeholder: "xxxx.apps.googleusercontent.com" },
      { key: "GOOGLE_CLIENT_SECRET", label: "OAuth client secret", secret: true },
      { key: "GOOGLE_ADS_DEVELOPER_TOKEN", label: "Developer token", secret: true },
      { key: "GOOGLE_ADS_API_VERSION", label: "API version", optional: true, placeholder: "v25" },
    ],
  },
  {
    id: "TIKTOK",
    title: "TikTok Ads",
    kind: "platform",
    platform: "TIKTOK",
    purpose: "Lets customers connect TikTok advertiser accounts.",
    consoleUrl: "https://business-api.tiktok.com/portal/apps",
    consoleLabel: "TikTok API for Business",
    steps: [
      "Sign in to TikTok API for Business → My Apps → Create an app.",
      "Use the redirect URL below as the Advertiser redirect URL.",
      "Request the permissions Ad account management, Ads management, Reporting and Audience management.",
      "Once TikTok approves the app, copy its App ID and Secret here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "TIKTOK_APP_ID", label: "App ID" },
      { key: "TIKTOK_APP_SECRET", label: "Secret", secret: true },
    ],
  },
  {
    id: "LINKEDIN",
    title: "LinkedIn Ads",
    kind: "platform",
    platform: "LINKEDIN",
    purpose: "Lets customers connect LinkedIn Campaign Manager accounts.",
    consoleUrl: "https://www.linkedin.com/developers/apps",
    consoleLabel: "LinkedIn Developers",
    steps: [
      "Create an app in LinkedIn Developers and link it to your company's LinkedIn Page.",
      "On the Products tab, request access to the Advertising API.",
      "On the Auth tab, add the redirect URL below under Authorized redirect URLs.",
      "Copy the Client ID and Primary client secret here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "LINKEDIN_CLIENT_ID", label: "Client ID" },
      { key: "LINKEDIN_CLIENT_SECRET", label: "Client secret", secret: true },
      { key: "LINKEDIN_API_VERSION", label: "API version", optional: true, placeholder: "202609" },
    ],
  },
  {
    id: "MICROSOFT",
    title: "Microsoft Advertising",
    kind: "platform",
    platform: "MICROSOFT",
    purpose: "Lets customers connect Microsoft (Bing) Ads accounts.",
    consoleUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    consoleLabel: "Azure app registrations",
    steps: [
      "In the Azure portal, open App registrations → New registration. Allow accounts in any organizational directory and personal Microsoft accounts.",
      "Add the redirect URL below as a Web redirect URI.",
      "Certificates & secrets → New client secret. Copy the Application (client) ID and the secret value here.",
      "In Microsoft Advertising, open Tools → Developer portal and request a developer token (needs a Super Admin user).",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "MICROSOFT_CLIENT_ID", label: "Application (client) ID" },
      { key: "MICROSOFT_CLIENT_SECRET", label: "Client secret", secret: true },
      { key: "MICROSOFT_DEVELOPER_TOKEN", label: "Developer token", secret: true },
      { key: "MICROSOFT_TENANT", label: "Tenant", optional: true, placeholder: "common" },
    ],
  },
  {
    id: "SNAPCHAT",
    title: "Snapchat Ads",
    kind: "platform",
    platform: "SNAPCHAT",
    purpose: "Lets customers connect Snapchat ad accounts.",
    consoleUrl: "https://business.snapchat.com",
    consoleLabel: "Snapchat Business Manager",
    steps: [
      "In Snapchat Business Manager, open Business Details → OAuth Apps → + OAuth App.",
      "Add the redirect URL below.",
      "Copy the Snap Client ID and Client Secret here. Marketing API access may need approval from Snap.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "SNAPCHAT_CLIENT_ID", label: "Client ID" },
      { key: "SNAPCHAT_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "PINTEREST",
    title: "Pinterest Ads",
    kind: "platform",
    platform: "PINTEREST",
    purpose: "Lets customers connect Pinterest ad accounts.",
    consoleUrl: "https://developers.pinterest.com/apps",
    consoleLabel: "Pinterest Developers",
    steps: [
      "In Pinterest Developers, open My apps → Connect app and request Standard access with the Ads API.",
      "Add the redirect URL below to the app's Redirect URIs.",
      "Copy the App ID and App secret key here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "PINTEREST_APP_ID", label: "App ID" },
      { key: "PINTEREST_APP_SECRET", label: "App secret key", secret: true },
    ],
  },
  {
    id: "AI",
    title: "AI provider",
    kind: "ai",
    purpose: "Powers ad writing, suggestions and insights. Every organization uses this one key and pays in AI tokens.",
    consoleUrl: "https://aistudio.google.com/apikey",
    consoleLabel: "Google AI Studio",
    steps: [
      "Pick a provider. Gemini: aistudio.google.com/apikey · OpenAI: platform.openai.com/api-keys · Anthropic: console.anthropic.com → API keys.",
      "Create an API key and paste it here. Add billing on the provider's side so requests don't stop.",
      "Leave the model empty to use the recommended one. For OpenRouter, Groq and similar services choose OpenAI-compatible and add the base URL.",
      "Use Test to check the key. Token prices for your customers are set under Plans & pricing.",
    ],
    testable: true,
    fields: [
      {
        key: "AI_PROVIDER",
        label: "Provider",
        options: [
          { value: "GEMINI", label: "Google Gemini" },
          { value: "OPENAI", label: "OpenAI" },
          { value: "ANTHROPIC", label: "Anthropic Claude" },
          { value: "OPENAI_COMPATIBLE", label: "OpenAI-compatible (OpenRouter, Groq…)" },
        ],
      },
      { key: "AI_API_KEY", label: "API key", secret: true },
      { key: "AI_MODEL", label: "Model", optional: true, placeholder: "Recommended model", help: "Defaults: gemini-3.8-flash · gpt-6.1-sol · claude-sonnet-5-5." },
      { key: "AI_BASE_URL", label: "Base URL", optional: true, placeholder: "https://openrouter.ai/api/v1", help: "Only for OpenAI-compatible providers." },
    ],
  },
  {
    id: "RAZORPAY",
    title: "Razorpay payments",
    kind: "billing",
    purpose: "Takes payments for plans (monthly subscriptions) and AI token packs.",
    consoleUrl: "https://dashboard.razorpay.com/app/website-app-settings/api-keys",
    consoleLabel: "Razorpay Dashboard",
    steps: [
      "In the Razorpay Dashboard, open Account & Settings → API Keys and generate a key. Start in Test mode, switch to Live keys when you go live.",
      "Copy the Key ID and Key secret here.",
      "Open Webhooks → Add new webhook. Use the webhook URL below, choose a secret, and tick subscription.activated, subscription.charged, subscription.cancelled, subscription.halted, subscription.completed, order.paid and payment.captured.",
      "Paste the same webhook secret here. Subscription plans are created in Razorpay automatically from the prices you set under Plans & pricing.",
    ],
    needsWebhookUrl: true,
    testable: true,
    fields: [
      { key: "RAZORPAY_KEY_ID", label: "Key ID", placeholder: "rzp_test_…" },
      { key: "RAZORPAY_KEY_SECRET", label: "Key secret", secret: true },
      { key: "RAZORPAY_WEBHOOK_SECRET", label: "Webhook secret", secret: true },
    ],
  },
  {
    id: "EMAIL",
    title: "Email (Resend)",
    kind: "email",
    purpose: "Sends invitations, password resets, alerts and scheduled reports.",
    consoleUrl: "https://resend.com/api-keys",
    consoleLabel: "Resend",
    steps: [
      "In Resend, add your domain under Domains and add the DNS records it shows.",
      "Create an API key with sending access and paste it here.",
      "Set the From address to an address on that verified domain, then use Test to send yourself an email.",
    ],
    testable: true,
    fields: [
      { key: "RESEND_API_KEY", label: "API key", secret: true, placeholder: "re_…" },
      { key: "EMAIL_FROM", label: "From address", optional: true, placeholder: "Ashniva Ads <no-reply@yourdomain.com>" },
    ],
  },
];

export const MANAGED_ENV_KEYS = CREDENTIAL_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
export const credentialGroupFor = (platform: Platform) => CREDENTIAL_GROUPS.find((g) => g.platform === platform);

export interface CredentialFieldStatus {
  key: string;
  set: boolean;
  /** Saved in the admin console, or read from the server's .env */
  source: "console" | "env" | null;
  /** Full value for plain fields, last characters for secrets. */
  display: string | null;
}

export interface CredentialGroupStatus {
  id: CredentialGroupId;
  configured: boolean;
  fields: CredentialFieldStatus[];
  updatedAt: string | null;
}

export interface CredentialsDTO {
  redirectUrls: Partial<Record<Platform, string>>;
  webhookUrl: string;
  groups: CredentialGroupStatus[];
}

/** `null` clears a console value (falling back to .env); omitted keys are untouched. */
export const saveCredentialsSchema = z.object({
  values: z.record(z.string(), z.string().trim().max(4000).nullable()),
});

// ───────── Price list ─────────

const limit = z.number().int().min(0).max(1_000_000).nullable();

export const catalogPlanSchema = z.object({
  name: z.string().trim().min(2).max(40),
  audience: z.string().trim().max(120),
  priceMonthly: z.number().int().min(0).max(10_000_000),
  /** `null` means unlimited */
  limits: z.object({ workspaces: limit, adAccounts: limit, members: limit }),
  features: z.array(z.enum(["campaign_builder", "scheduled_reports", "automation_rules", "ai_assistant", "white_label", "public_api"])),
  highlights: z.array(z.string().trim().min(1).max(80)).max(12),
  popular: z.boolean().default(false),
});

export const tokenPackSchema = z.object({
  id: z.string().trim().min(2).max(40).regex(/^[a-z0-9_-]+$/, "Use lowercase letters, numbers, - or _"),
  name: z.string().trim().min(2).max(40),
  tokens: z.number().int().min(1_000).max(1_000_000_000),
  price: z.number().int().min(1).max(10_000_000),
  popular: z.boolean().optional(),
});

export const catalogSchema = z.object({
  trialDays: z.number().int().min(0).max(365),
  /** Added on top of every price at checkout. */
  gstPercent: z.number().min(0).max(50),
  plans: z.object({
    TRIAL: catalogPlanSchema,
    STARTER: catalogPlanSchema,
    GROWTH: catalogPlanSchema,
    AGENCY: catalogPlanSchema,
  }),
  aiFreeTokens: z.number().int().min(0).max(100_000_000),
  aiMinBalance: z.number().int().min(0).max(1_000_000),
  tokenPacks: z.array(tokenPackSchema).min(1).max(8),
});

export type CatalogPlan = z.infer<typeof catalogPlanSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

/** Values the app reads at runtime; the defaults below apply until the owner saves a price list. */
export const PRICING = { trialDays: 14, gstPercent: 18, aiFreeTokens: AI_FREE_TOKENS, aiMinBalance: AI_MIN_BALANCE };

const toLimit = (n: number) => (Number.isFinite(n) ? n : null);
const fromLimit = (n: number | null) => (n == null ? Number.POSITIVE_INFINITY : n);

const DEFAULT_PLANS = Object.fromEntries(
  Object.entries(PLANS).map(([id, p]) => [id, { ...p, limits: { ...p.limits }, features: [...p.features], highlights: [...p.highlights] }]),
) as typeof PLANS;
const DEFAULT_PACKS: AiTokenPack[] = AI_TOKEN_PACKS.map((p) => ({ ...p }));
const DEFAULT_PRICING = { ...PRICING };

/** The price list this release ships with. */
export function defaultCatalog(): Catalog {
  const plan = (id: PlanId): CatalogPlan => {
    const p = DEFAULT_PLANS[id];
    return {
      name: p.name,
      audience: p.audience,
      priceMonthly: p.priceMonthly,
      limits: { workspaces: toLimit(p.limits.workspaces), adAccounts: toLimit(p.limits.adAccounts), members: toLimit(p.limits.members) },
      features: [...p.features],
      highlights: [...p.highlights],
      popular: id === "GROWTH",
    };
  };
  return {
    ...DEFAULT_PRICING,
    plans: { TRIAL: plan("TRIAL"), STARTER: plan("STARTER"), GROWTH: plan("GROWTH"), AGENCY: plan("AGENCY") },
    tokenPacks: DEFAULT_PACKS.map((p) => ({ ...p })),
  };
}

/** The current price list, read back from the runtime values. */
export function currentCatalog(): Catalog {
  const plan = (id: PlanId): CatalogPlan => {
    const p = PLANS[id];
    return {
      name: p.name,
      audience: p.audience,
      priceMonthly: p.priceMonthly,
      limits: { workspaces: toLimit(p.limits.workspaces), adAccounts: toLimit(p.limits.adAccounts), members: toLimit(p.limits.members) },
      features: [...p.features],
      highlights: [...p.highlights],
      popular: Boolean(p.popular),
    };
  };
  return {
    ...PRICING,
    plans: { TRIAL: plan("TRIAL"), STARTER: plan("STARTER"), GROWTH: plan("GROWTH"), AGENCY: plan("AGENCY") },
    tokenPacks: AI_TOKEN_PACKS.map((p) => ({ ...p })),
  };
}

/**
 * Applies a price list to the shared PLANS, AI_TOKEN_PACKS and PRICING
 * objects in place, so every existing reader (limits, feature gates, pages)
 * sees the owner's prices. Used by the API, the worker and the web app.
 */
export function applyCatalog(catalog: Catalog) {
  for (const id of Object.keys(PLANS) as PlanId[]) {
    const c = catalog.plans[id];
    Object.assign(PLANS[id], {
      name: c.name,
      audience: c.audience,
      priceMonthly: id === "TRIAL" ? 0 : c.priceMonthly,
      limits: { workspaces: fromLimit(c.limits.workspaces), adAccounts: fromLimit(c.limits.adAccounts), members: fromLimit(c.limits.members) },
      features: [...c.features] as Feature[],
      highlights: [...c.highlights],
      popular: c.popular,
    });
  }
  AI_TOKEN_PACKS.splice(0, AI_TOKEN_PACKS.length, ...catalog.tokenPacks.map((p) => ({ ...p })));
  Object.assign(PRICING, {
    trialDays: catalog.trialDays,
    gstPercent: catalog.gstPercent,
    aiFreeTokens: catalog.aiFreeTokens,
    aiMinBalance: catalog.aiMinBalance,
  });
}

/** A price with GST, in whole rupees. */
export const withGst = (price: number) => Math.round(price * (1 + PRICING.gstPercent / 100));
