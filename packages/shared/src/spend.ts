import { z } from "zod";
import type { Platform } from "./platforms";

/**
 * Spend control. Payment itself stays on each ad platform (their card, invoice or prepaid
 * balance): platforms don't let another app pay their bills. From here people see what each
 * account has spent, set a monthly budget with alerts (and optionally a pause at the limit),
 * set the platform's own account spending limit where its API allows it, and open the
 * platform's billing page to pay.
 */

/** ok: nothing to do. attention: near a limit or a payment needs a look. blocked: ads can't run until it's fixed. */
export type BillingHealth = "ok" | "attention" | "blocked" | "unknown";

/** What the platform reports about an ad account's billing, in the account's currency. */
export interface PlatformBillingDTO {
  /** The account spending limit set on the platform (Meta spend cap, Google account budget). */
  spendLimit: number | null;
  /** Spent toward that limit; on Meta without a cap, the account's lifetime spend. */
  spentTowardLimit: number | null;
  /** Owed now and not yet charged (Meta's balance). */
  balanceDue: number | null;
  /** Prepaid funds left, where the platform reports them. */
  fundsRemaining: number | null;
  health: BillingHealth;
  /** Why health isn't ok, e.g. "Payment failed. Ads stop until the balance is paid." */
  note: string | null;
  fetchedAt: string;
}

export type SpendLimitKind = "spend_cap" | "account_budget";

export interface PlatformBillingInfo {
  /** Where the customer pays, changes the card or downloads invoices. */
  billingUrl: (externalId: string) => string;
  /**
   * The platform's own account-level limit this app can set, if any. Meta: a spend cap on
   * any account. Google: an account budget, which only monthly-invoiced accounts have.
   */
  accountLimit: SpendLimitKind | null;
  /** Whether the connector reads billing (limit, balance, payment state) from the platform. */
  readsBilling: boolean;
}

const digits = (id: string) => id.replace(/\D/g, "");

/** Billing pages per platform. Each opens the platform's own billing for that account where the URL allows it. */
export const PLATFORM_BILLING: Partial<Record<Platform, PlatformBillingInfo>> = {
  META: {
    billingUrl: (id) => `https://business.facebook.com/billing_hub/accounts/details?asset_id=${encodeURIComponent(digits(id))}`,
    accountLimit: "spend_cap",
    readsBilling: true,
  },
  GOOGLE: {
    billingUrl: (id) => `https://ads.google.com/aw/billing/summary?__e=${encodeURIComponent(digits(id))}`,
    accountLimit: "account_budget",
    readsBilling: true,
  },
  MICROSOFT: {
    billingUrl: (id) => `https://ui.ads.microsoft.com/campaign/vnext/billing?aid=${encodeURIComponent(id)}`,
    accountLimit: null,
    readsBilling: true,
  },
  LINKEDIN: {
    billingUrl: (id) => `https://www.linkedin.com/campaignmanager/accounts/${encodeURIComponent(id)}/billing`,
    accountLimit: null,
    readsBilling: false,
  },
  SNAPCHAT: { billingUrl: () => "https://ads.snapchat.com/", accountLimit: null, readsBilling: false },
  PINTEREST: {
    billingUrl: (id) => `https://ads.pinterest.com/advertiser/${encodeURIComponent(id)}/billing/`,
    accountLimit: null,
    readsBilling: false,
  },
  AMAZON: { billingUrl: () => "https://advertising.amazon.com/billing", accountLimit: null, readsBilling: false },
  X: { billingUrl: (id) => `https://ads.x.com/accounts/${encodeURIComponent(id)}/billing`, accountLimit: null, readsBilling: false },
  APPLE: { billingUrl: () => "https://app-ads.apple.com/cm/app/billing", accountLimit: null, readsBilling: false },
  SPOTIFY: { billingUrl: () => "https://adstudio.spotify.com/", accountLimit: null, readsBilling: false },
  CRITEO: { billingUrl: () => "https://marketing.criteo.com/", accountLimit: null, readsBilling: false },
  TABOOLA: { billingUrl: () => "https://ads.taboola.com/", accountLimit: null, readsBilling: false },
  OUTBRAIN: { billingUrl: () => "https://my.outbrain.com/", accountLimit: null, readsBilling: false },
  TRADEDESK: { billingUrl: () => "https://desk.thetradedesk.com/", accountLimit: null, readsBilling: false },
  YAHOO: { billingUrl: () => "https://dsp.yahooinc.com/", accountLimit: null, readsBilling: false },
};

export const SPEND_ALERT_PERCENTS = [50, 75, 80, 90, 95] as const;

export const spendBudgetSchema = z.object({
  /** Monthly budget in the ad account's currency; null removes it. */
  monthlyLimit: z.number().positive().max(1_000_000_000).nullable(),
  alertPercent: z.number().int().min(10).max(99).default(80),
  /** Pause the account's running campaigns once the month's spend reaches the budget. */
  pauseAtLimit: z.boolean().default(false),
});
export type SpendBudgetInput = z.infer<typeof spendBudgetSchema>;

export const spendLimitSchema = z.object({
  /** The platform's account spending limit in the account's currency; null removes it. */
  amount: z.number().positive().max(1_000_000_000).nullable(),
});

export interface SpendBudgetDTO {
  monthlyLimit: number;
  alertPercent: number;
  pauseAtLimit: boolean;
  /** When campaigns were paused for reaching this month's budget. */
  pausedAt: string | null;
}

export interface SpendAccountDTO {
  id: string;
  platform: Platform;
  name: string;
  externalId: string;
  currency: string;
  timezone: string | null;
  sample: boolean;
  status: string;
  /** This calendar month so far, in the account's timezone and currency. */
  monthSpend: number;
  /** Average daily spend over the month so far, projected to the month's end. */
  projectedMonthSpend: number;
  activeCampaigns: number;
  budget: SpendBudgetDTO | null;
  platformBilling: PlatformBillingDTO | null;
  billingUrl: string | null;
  /** The platform limit this account can have set from here, if any. */
  accountLimit: SpendLimitKind | null;
  readsBilling: boolean;
}

export interface SpendPlatformTotal {
  platform: Platform;
  /** Converted to the workspace currency (when rates are available). */
  monthSpend: number;
  monthlyBudget: number | null;
  accounts: number;
  share: number;
}

export interface SpendOverviewDTO {
  /** YYYY-MM of the workspace's timezone. */
  month: string;
  currency: string;
  /** Whether totals in other currencies were converted. */
  converted: boolean;
  totals: { monthSpend: number; monthlyBudget: number | null; projectedMonthSpend: number };
  platforms: SpendPlatformTotal[];
  accounts: SpendAccountDTO[];
}

/** Share of the budget used, 0–∞ (1 = the whole budget). */
export const budgetUsed = (spend: number, limit: number | null | undefined) => (limit && limit > 0 ? spend / limit : null);
