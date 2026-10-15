/**
 * Platform-provided AI, metered in tokens. Every organization starts with a
 * free allowance; after that it buys token packs. Each AI action deducts the
 * tokens the model actually used (input + output).
 */

export const AI_PROVIDERS = ["GEMINI", "OPENAI", "ANTHROPIC", "OPENAI_COMPATIBLE"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** One-time free allowance for new organizations (overridable with AI_FREE_TOKENS). */
export const AI_FREE_TOKENS = 100_000;

/** Below this balance AI actions are refused, so a call can't start with nothing left. */
export const AI_MIN_BALANCE = 1_000;

/** Owners and admins get a "running low" alert when usage takes the balance below this. */
export const AI_LOW_BALANCE = 10_000;

export interface AiTokenPack {
  id: string;
  name: string;
  tokens: number;
  /** Price in INR (rupees) */
  price: number;
  popular?: boolean;
}

export const AI_TOKEN_PACKS: AiTokenPack[] = [
  { id: "pack_500k", name: "Starter", tokens: 500_000, price: 499 },
  { id: "pack_2m", name: "Growth", tokens: 2_000_000, price: 1_499, popular: true },
  { id: "pack_10m", name: "Scale", tokens: 10_000_000, price: 5_999 },
];

export const aiPackById = (id: string) => AI_TOKEN_PACKS.find((p) => p.id === id);

/** AI actions and their typical cost, shown so people know what a balance buys. */
export const AI_FEATURES: Record<string, { label: string; detail: string; typicalTokens: number }> = {
  "builder.fill": { label: "Fill an ad from a brief", detail: "Headlines, descriptions, texts and CTA in the platform's limits.", typicalTokens: 3_000 },
  "builder.suggest": { label: "Field suggestions", detail: "Alternatives for one headline, description or caption.", typicalTokens: 800 },
  "builder.keywords": { label: "Keyword ideas", detail: "Search keywords with match types.", typicalTokens: 1_500 },
  "builder.audience": { label: "Audience ideas", detail: "Interests, ages and gender for your product.", typicalTokens: 1_200 },
  "builder.review": { label: "Pre-launch review", detail: "Score and fixes for policy risks, copy and targeting.", typicalTokens: 3_500 },
  "insights.overview": { label: "Workspace insights", detail: "What's working and where budget is wasted.", typicalTokens: 6_000 },
  "insights.campaign": { label: "Campaign analysis", detail: "Plain-language read-out of one campaign.", typicalTokens: 3_000 },
  "rules.fromText": { label: "Rule from a sentence", detail: "Describe an automation rule in words.", typicalTokens: 1_500 },
};
export type AiFeatureKey = keyof typeof AI_FEATURES;

export interface AiStatusDTO {
  /** The platform has an AI provider configured */
  available: boolean;
  balance: number;
  /** Balance is high enough to run an action */
  canUse: boolean;
}

export interface AiLedgerEntryDTO {
  id: string;
  type: "FREE_GRANT" | "PURCHASE" | "USAGE" | "ADJUSTMENT";
  tokens: number;
  balanceAfter: number;
  feature: string | null;
  note: string | null;
  user: string | null;
  createdAt: string;
}

export interface AiWalletDTO extends AiStatusDTO {
  usedThisMonth: number;
  purchasedTotal: number;
  ledger: AiLedgerEntryDTO[];
  /** Razorpay checkout available for token packs */
  checkoutEnabled: boolean;
  razorpayKeyId: string | null;
}

// ───────── Builder AI responses ─────────

export interface AiFillResponse {
  /** Field key → suggested value, for the ad level (and campaign/ad group where noted). */
  ad: Record<string, unknown>;
  adGroup: Record<string, unknown>;
  campaign: Record<string, unknown>;
  notes: string[];
}

export interface AiSuggestResponse {
  suggestions: string[];
}

export interface AiKeywordIdea {
  text: string;
  matchType: "BROAD" | "PHRASE" | "EXACT";
  intent: "high" | "medium" | "low";
}

export interface AiAudienceResponse {
  interests: string[];
  ageMin: number;
  ageMax: number;
  gender: "ALL" | "MALE" | "FEMALE";
  rationale: string;
}

export interface AiReviewIssue {
  severity: "high" | "medium" | "low";
  area: string;
  message: string;
  fix: string;
}

export interface AiReviewResponse {
  score: number;
  summary: string;
  strengths: string[];
  issues: AiReviewIssue[];
}
