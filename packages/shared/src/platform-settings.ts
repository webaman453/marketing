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
  /** Only shown (and only required) when another field has one of these values. */
  showWhen?: { key: string; values: string[] };
}

export type CredentialGroupId =
  | "META"
  | "GOOGLE"
  | "TIKTOK"
  | "LINKEDIN"
  | "MICROSOFT"
  | "SNAPCHAT"
  | "PINTEREST"
  | "AMAZON"
  | "X"
  | "APPLE"
  | "SPOTIFY"
  | "CRITEO"
  | "TABOOLA"
  | "OUTBRAIN"
  | "TRADEDESK"
  | "YAHOO"
  | "SHOPIFY"
  | "AI"
  | "RAZORPAY"
  | "EMAIL";

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
    consoleUrl: "https://console.cloud.google.com/apis/api/googleads.googleapis.com/overview",
    consoleLabel: "Google Ads API",
    steps: [
      "In Google Cloud Console, create a project and enable the Google Ads API. That gives the project Test access, which only works with Google's test accounts.",
      "On this project's Google Ads API overview page, apply for Explorer access so real ad accounts work (2,880 operations a day). For 15,000 a day, complete brand verification, then apply for Basic access. Do not apply from a Google Ads manager account's API Center; Google no longer processes those.",
      "Set up the OAuth consent screen and add the scope https://www.googleapis.com/auth/adwords.",
      "Credentials → Create credentials → OAuth client ID → Web application. Add the redirect URL below under Authorized redirect URIs, then paste the Client ID and Client secret here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "GOOGLE_CLIENT_ID", label: "OAuth client ID", placeholder: "xxxx.apps.googleusercontent.com" },
      { key: "GOOGLE_CLIENT_SECRET", label: "OAuth client secret", secret: true },
      {
        key: "GOOGLE_ADS_DEVELOPER_TOKEN",
        label: "Developer token",
        secret: true,
        optional: true,
        help: "Leave empty. Google stopped requiring developer tokens on 9 September 2026. Access now follows the Cloud project that owns this OAuth client. An old token is ignored if you still paste one.",
      },
      { key: "GOOGLE_ADS_API_VERSION", label: "API version", optional: true, placeholder: "v25", help: "Leave empty for v25, the version this release calls. v25 stays available through August 2027." },
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
    id: "AMAZON",
    title: "Amazon Ads",
    kind: "platform",
    platform: "AMAZON",
    purpose: "Lets customers connect Amazon Ads profiles.",
    consoleUrl: "https://advertising.amazon.com/about-api",
    consoleLabel: "Amazon Ads API",
    steps: [
      "Apply for the Amazon Ads API and create a Login with Amazon security profile.",
      "Add the redirect URL below as an allowed return URL.",
      "Paste the Client ID and Client secret here. Customers then connect the Amazon account that owns their advertising profiles.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "AMAZON_CLIENT_ID", label: "Client ID" },
      { key: "AMAZON_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "X",
    title: "X Ads",
    kind: "platform",
    platform: "X",
    purpose: "Lets customers connect X (Twitter) ad accounts.",
    consoleUrl: "https://developer.x.com/en/portal/dashboard",
    consoleLabel: "X developer portal",
    steps: [
      "Create an app and apply for Ads API access for it. The Ads API signs every call with OAuth 1.0a, not OAuth 2.0.",
      "In User authentication settings, turn on OAuth 1.0a with Read and write permissions and add the redirect URL below as a Callback URL.",
      "Under Keys and tokens, paste the API Key (consumer key) and API Key Secret (consumer secret) here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "X_CONSUMER_KEY", label: "API Key (consumer key)" },
      { key: "X_CONSUMER_SECRET", label: "API Key Secret (consumer secret)", secret: true },
    ],
  },
  {
    id: "APPLE",
    title: "Apple Ads",
    kind: "platform",
    platform: "APPLE",
    purpose: "Optional. Customers connect Apple Search Ads with their own API user; these keys only let your own organization connect without entering them.",
    consoleUrl: "https://app.searchads.apple.com/cm/app",
    consoleLabel: "Apple Search Ads",
    steps: [
      "In Apple Search Ads, open Account Settings → API and create an API user with campaign management access.",
      "Copy the Client ID and the client secret (the signed secret Apple shows once) into the fields here.",
      "Connect uses those keys to list the organizations this API user can manage. No redirect URL is required.",
    ],
    fields: [
      { key: "APPLE_ADS_CLIENT_ID", label: "Client ID" },
      { key: "APPLE_ADS_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "SPOTIFY",
    title: "Spotify Ads",
    kind: "platform",
    platform: "SPOTIFY",
    purpose: "Lets customers connect Spotify Ads accounts.",
    consoleUrl: "https://adsmanager.spotify.com/api-terms",
    consoleLabel: "Spotify developer dashboard",
    steps: [
      "Create a Spotify app and choose Ads API as the API you plan to use.",
      "In Ads Manager, accept the Ads API terms for this Client ID. Spotify can take up to an hour to allow it.",
      "Add the redirect URL below.",
      "Paste the Client ID and Client secret. Connect with the Spotify user that owns the Ads Manager account.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "SPOTIFY_CLIENT_ID", label: "Client ID" },
      { key: "SPOTIFY_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "CRITEO",
    title: "Criteo",
    kind: "platform",
    platform: "CRITEO",
    purpose: "Optional. Customers connect Criteo with their own client id and secret; these keys only let your own organization connect without entering them.",
    consoleUrl: "https://developers.criteo.com/",
    consoleLabel: "Criteo developers",
    steps: [
      "Create a Criteo app with the Marketing Solutions API and consent for the advertiser accounts you manage.",
      "Paste the Client ID and Client secret here. Connect requests a token and lists those advertisers.",
    ],
    fields: [
      { key: "CRITEO_CLIENT_ID", label: "Client ID" },
      { key: "CRITEO_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "TABOOLA",
    title: "Taboola",
    kind: "platform",
    platform: "TABOOLA",
    purpose: "Optional. Customers connect Taboola with their own client id and secret; these keys only let your own organization connect without entering them.",
    consoleUrl: "https://backstage.taboola.com/",
    consoleLabel: "Taboola Backstage",
    steps: [
      "In Backstage, open API → Apps and create an app with campaign permissions.",
      "Paste the Client ID and Client secret here. Connect lists the accounts this app can manage.",
    ],
    fields: [
      { key: "TABOOLA_CLIENT_ID", label: "Client ID" },
      { key: "TABOOLA_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "OUTBRAIN",
    title: "Outbrain",
    kind: "platform",
    platform: "OUTBRAIN",
    purpose: "Optional. Customers connect Outbrain with their own Amplify token; this token only lets your own organization connect without entering one.",
    consoleUrl: "https://my.outbrain.com/amplify/site/api",
    consoleLabel: "Outbrain Amplify",
    steps: [
      "In Amplify, open Settings and create an API token for the marketer you want to manage.",
      "Paste that token here. There is no OAuth redirect. Connect uses the token to list marketers.",
    ],
    fields: [{ key: "OUTBRAIN_API_TOKEN", label: "API token", secret: true }],
  },
  {
    id: "TRADEDESK",
    title: "The Trade Desk",
    kind: "platform",
    platform: "TRADEDESK",
    purpose: "Optional. Customers connect The Trade Desk with their own token and partner id; these keys only let your own organization connect without entering them.",
    consoleUrl: "https://partner.thetradedesk.com/",
    consoleLabel: "The Trade Desk partner portal",
    steps: [
      "Ask The Trade Desk for a long-lived API token and your partner id.",
      "Paste both here. There is no OAuth redirect. Connect lists advertisers under that partner.",
    ],
    fields: [
      { key: "TRADEDESK_API_TOKEN", label: "API token", secret: true },
      { key: "TRADEDESK_PARTNER_ID", label: "Partner ID" },
    ],
  },
  {
    id: "YAHOO",
    title: "Yahoo DSP",
    kind: "platform",
    platform: "YAHOO",
    purpose: "Lets customers connect Yahoo DSP advertisers.",
    consoleUrl: "https://developer.yahooinc.com/",
    consoleLabel: "Yahoo developer",
    steps: [
      "Create a Yahoo DSP OAuth app with traffic API access.",
      "Add the redirect URL below.",
      "Paste the Client ID and Client secret here.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "YAHOO_CLIENT_ID", label: "Client ID" },
      { key: "YAHOO_CLIENT_SECRET", label: "Client secret", secret: true },
    ],
  },
  {
    id: "SHOPIFY",
    title: "Shopify",
    kind: "platform",
    platform: "SHOPIFY",
    purpose: "Lets a store connect and save marketing events with UTM tags.",
    consoleUrl: "https://dev.shopify.com/dashboard",
    consoleLabel: "Shopify Dev Dashboard",
    steps: [
      "Create an app and copy its Client ID and Client secret.",
      "Add the redirect URL below under Allowed redirection URLs.",
      "On Connect, enter that store's your-store.myshopify.com domain.",
    ],
    needsRedirectUrl: true,
    fields: [
      { key: "SHOPIFY_CLIENT_ID", label: "Client ID" },
      { key: "SHOPIFY_CLIENT_SECRET", label: "Client secret", secret: true },
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
      { key: "AI_BASE_URL", label: "Base URL", placeholder: "https://openrouter.ai/api/v1", help: "Where the OpenAI-compatible service answers.", showWhen: { key: "AI_PROVIDER", values: ["OPENAI_COMPATIBLE"] } },
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
    title: "Email (SMTP or Resend)",
    kind: "email",
    purpose: "Sends invitations, password reset links, alerts and scheduled reports.",
    consoleUrl: "https://resend.com/api-keys",
    consoleLabel: "Resend",
    steps: [
      "SMTP works with any mail server or provider: your own server, Google Workspace (smtp.gmail.com, with an app password), Zoho (smtp.zoho.in), Microsoft 365 (smtp.office365.com), Hostinger (smtp.hostinger.com), Amazon SES and others.",
      "Use port 587 (STARTTLS) or 465 (SSL). The username is usually the full mailbox address.",
      "Or choose Resend: add and verify your domain at resend.com, then create an API key with sending access.",
      "Set the From address to a mailbox on your domain (with SMTP it usually has to match the username), then use Test to send yourself an email.",
    ],
    testable: true,
    fields: [
      {
        key: "EMAIL_PROVIDER",
        label: "Send with",
        options: [
          { value: "SMTP", label: "SMTP server" },
          { value: "RESEND", label: "Resend" },
        ],
      },
      { key: "SMTP_HOST", label: "SMTP host", placeholder: "smtp.yourdomain.com", showWhen: { key: "EMAIL_PROVIDER", values: ["SMTP"] } },
      { key: "SMTP_PORT", label: "Port", optional: true, placeholder: "587", help: "587 (STARTTLS) or 465 (SSL).", showWhen: { key: "EMAIL_PROVIDER", values: ["SMTP"] } },
      { key: "SMTP_USER", label: "Username", placeholder: "no-reply@yourdomain.com", showWhen: { key: "EMAIL_PROVIDER", values: ["SMTP"] } },
      { key: "SMTP_PASSWORD", label: "Password", secret: true, showWhen: { key: "EMAIL_PROVIDER", values: ["SMTP"] } },
      { key: "RESEND_API_KEY", label: "Resend API key", secret: true, placeholder: "re_…", showWhen: { key: "EMAIL_PROVIDER", values: ["RESEND"] } },
      { key: "EMAIL_FROM", label: "From address", optional: true, placeholder: "Ashniva Ads <no-reply@yourdomain.com>" },
    ],
  },
];

export const MANAGED_ENV_KEYS = CREDENTIAL_GROUPS.flatMap((g) => g.fields.map((f) => f.key));

/** A dropdown field without a saved value counts as its first option. */
export function credentialValue(field: CredentialField, raw: string | null | undefined) {
  return raw || field.options?.[0]?.value || "";
}

/**
 * Whether a field applies given the group's other values (e.g. SMTP fields
 * only when sending with SMTP). `valueOf` returns the raw value of a key.
 */
export function credentialFieldApplies(group: CredentialGroup, field: CredentialField, valueOf: (key: string) => string | null | undefined) {
  if (!field.showWhen) return true;
  const dep = group.fields.find((f) => f.key === field.showWhen!.key);
  const v = dep ? credentialValue(dep, valueOf(dep.key)) : valueOf(field.showWhen.key) ?? "";
  return field.showWhen.values.includes(v);
}

/** Which email service sends mail: EMAIL_PROVIDER, or whichever one has keys (SMTP first). */
export function emailProvider(env: Record<string, string | undefined>): "SMTP" | "RESEND" | null {
  const chosen = env.EMAIL_PROVIDER?.toUpperCase();
  const smtp = Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);
  const resend = Boolean(env.RESEND_API_KEY);
  if (chosen === "SMTP") return smtp ? "SMTP" : null;
  if (chosen === "RESEND") return resend ? "RESEND" : null;
  return smtp ? "SMTP" : resend ? "RESEND" : null;
}
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
