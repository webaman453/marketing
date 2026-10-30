/**
 * Spend control: what each ad account has spent this month, monthly budgets with alerts and an
 * optional pause at the limit, and the platform's own billing (spend cap, balance, payment state).
 * Payment itself stays on each platform.
 */
import { ConnectorError, isConnectorError, type ConnectorAuth } from "@ashniva/connectors";
import { num, prisma, type AdAccount, type PlatformConnection, type Prisma } from "@ashniva/db";
import { PLATFORM_BILLING, PLATFORM_INFO, money as formatMoney, type BillingHealth, type PlatformBillingDTO } from "@ashniva/shared";
import { audit } from "./audit";
import { changeCampaignStatus, campaignWithConnection, type Actor } from "./campaign-actions";
import { connectors } from "./connectors";
import { isOrgLocked } from "./entitlements";
import { notify } from "./notifications";
import { getConnectorAuth } from "./tokens";

const SPEND_ROLES = ["OWNER", "ADMIN", "MANAGER"] as const;

const zoneOk = (tz: string | null | undefined) => {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

/** The calendar day (YYYY-MM-DD) in a timezone; platforms report spend by the account's day. */
export function dayInZone(d: Date, tz: string | null | undefined) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zoneOk(tz), year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export interface MonthSpend {
  month: string;
  spend: number;
  /** Days of the month so far (today included) and in the whole month. */
  daysElapsed: number;
  daysInMonth: number;
  /** Month so far at the same daily rate. */
  projected: number;
}

/** This month's spend per ad account, each in its own timezone and currency. */
export async function monthSpendByAccount(accounts: { id: string; timezone: string | null }[], now = new Date()) {
  const byMonth = new Map<string, { ids: string[]; today: string }>();
  for (const a of accounts) {
    const today = dayInZone(now, a.timezone);
    const month = today.slice(0, 7);
    const key = `${month}|${today}`;
    const group = byMonth.get(key) ?? { ids: [], today };
    group.ids.push(a.id);
    byMonth.set(key, group);
  }
  const out = new Map<string, MonthSpend>();
  for (const { ids, today } of byMonth.values()) {
    const month = today.slice(0, 7);
    const rows = await prisma.metricDaily.groupBy({
      by: ["adAccountId"],
      where: { adAccountId: { in: ids }, level: "CAMPAIGN", date: { gte: new Date(`${month}-01T00:00:00Z`), lte: new Date(`${today}T00:00:00Z`) } },
      _sum: { spend: true },
    });
    const spendOf = new Map(rows.map((r) => [r.adAccountId, num(r._sum.spend)]));
    const daysElapsed = Number(today.slice(8, 10));
    const [y, m] = month.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    for (const id of ids) {
      const spend = round2(spendOf.get(id) ?? 0);
      out.set(id, { month, spend, daysElapsed, daysInMonth, projected: round2((spend / daysElapsed) * daysInMonth) });
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const HEALTH_RANK: Record<BillingHealth, number> = { unknown: 0, ok: 0, attention: 1, blocked: 2 };

type AccountWithConnection = AdAccount & { connection: PlatformConnection };

const accountRef = (a: AdAccount) => ({
  externalId: a.externalId,
  currency: a.currency,
  timezone: a.timezone,
  meta: a.meta as Record<string, unknown> | null,
});

export const billingOf = (a: Pick<AdAccount, "billing">) => (a.billing as PlatformBillingDTO | null) ?? null;

const spendLink = (workspaceId: string | null) => (workspaceId ? `/w/${workspaceId}/spend` : undefined);

/**
 * Reads the platform's billing for one account and stores it. People are told when it gets
 * worse (a payment problem, a spend cap nearly used up), once per change.
 */
export async function refreshAccountBilling(account: AccountWithConnection, auth?: ConnectorAuth): Promise<PlatformBillingDTO | null> {
  const connector = connectors().get(account.platform, account.connection.mode);
  if (!connector.getBilling) return null;
  const fetched = await connector.getBilling(auth ?? (await getConnectorAuth(account.connection)), accountRef(account));
  const billing: PlatformBillingDTO = { ...fetched, fetchedAt: new Date().toISOString() };
  const previous = billingOf(account);
  await prisma.adAccount.update({
    where: { id: account.id },
    data: { billing: billing as unknown as Prisma.InputJsonValue, billingFetchedAt: new Date(billing.fetchedAt) },
  });
  const worse = HEALTH_RANK[billing.health] > HEALTH_RANK[previous?.health ?? "ok"];
  if (worse && account.workspaceId) {
    const platform = PLATFORM_INFO[account.platform].name;
    await notify({
      orgId: account.orgId,
      workspaceId: account.workspaceId,
      type: "spend.billing_issue",
      title: billing.health === "blocked" ? `${platform}: ads on ${account.name} can't run` : `${platform}: ${account.name} needs a look`,
      body: `${billing.note ?? "The platform reports a billing problem."} Payment is made on ${platform}; open its billing page from Spend & billing.`,
      link: spendLink(account.workspaceId),
      ctaLabel: "Open Spend & billing",
      roles: [...SPEND_ROLES],
      email: true,
      emailPref: "spendAlerts",
    });
  }
  return billing;
}

/** After a sync: refreshes billing for the connection's assigned accounts. Billing problems never fail the sync. */
export async function refreshConnectionBilling(connection: PlatformConnection, auth: ConnectorAuth) {
  if (!connectors().get(connection.platform, connection.mode).getBilling) return 0;
  const accounts = await prisma.adAccount.findMany({ where: { connectionId: connection.id, workspaceId: { not: null } } });
  let refreshed = 0;
  for (const account of accounts) {
    try {
      await refreshAccountBilling({ ...account, connection }, auth);
      refreshed++;
    } catch (err) {
      if (isConnectorError(err) && err.code === "AUTH_EXPIRED") throw err;
      console.warn(`[spend] billing for ${account.id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refreshed;
}

/** Sets or removes the platform's account spending limit (Meta spend cap, Google account budget). */
export async function setPlatformSpendLimit(account: AccountWithConnection, amount: number | null, actor: Actor) {
  const connector = connectors().get(account.platform, account.connection.mode);
  if (!connector.setSpendLimit) {
    throw new ConnectorError("UNSUPPORTED", `${PLATFORM_INFO[account.platform].name} doesn't let apps set an account spending limit. Use the monthly budget instead.`);
  }
  const auth = await getConnectorAuth(account.connection);
  const before = billingOf(account)?.spendLimit ?? null;
  await connector.setSpendLimit(auth, accountRef(account), amount);
  const billing = await refreshAccountBilling(account, auth).catch(() => null);
  await audit({
    orgId: actor.orgId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    action: "ad_account.spend_limit_changed",
    entityType: "ad_account",
    entityId: account.id,
    entityName: `${account.name} (${PLATFORM_INFO[account.platform].name})`,
    changes: { spendLimit: { from: before, to: amount } },
    ip: actor.ip,
  });
  return billing;
}

/** Pauses every running campaign of an account. Returns how many were paused. */
export async function pauseAccountCampaigns(adAccountId: string, actor: Actor) {
  const campaigns = await prisma.campaign.findMany({ where: { adAccountId, status: "ACTIVE" }, include: campaignWithConnection });
  let paused = 0;
  const failed: string[] = [];
  for (const c of campaigns) {
    try {
      if (await changeCampaignStatus(c, "PAUSED", actor)) paused++;
    } catch (err) {
      failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { paused, failed };
}

export interface SpendCheckResult {
  checked: number;
  alerts: number;
  paused: number;
}

/**
 * Compares each monthly budget with the month's spend: alerts once at the alert percent and
 * once at the budget, and pauses the account's campaigns at the budget when asked to.
 * A new month starts the alerts again; paused campaigns stay paused until someone resumes them.
 */
export async function checkSpendBudgets(now = new Date()): Promise<SpendCheckResult> {
  const budgets = await prisma.spendBudget.findMany({
    where: { adAccount: { workspaceId: { not: null }, workspace: { archivedAt: null }, connection: { status: { not: "REVOKED" } } } },
    include: {
      adAccount: true,
      org: { select: { plan: true, trialEndsAt: true, subscriptionStatus: true, currentPeriodEnd: true } },
    },
  });
  const active = budgets.filter((b) => !isOrgLocked(b.org, now));
  const spend = await monthSpendByAccount(active.map((b) => b.adAccount), now);
  const result: SpendCheckResult = { checked: active.length, alerts: 0, paused: 0 };

  for (const b of active) {
    const s = spend.get(b.adAccountId);
    if (!s) continue;
    const account = b.adAccount;
    const limit = num(b.monthlyLimit);
    const level = s.spend >= limit ? 2 : s.spend >= (limit * b.alertPercent) / 100 ? 1 : 0;
    const newMonth = b.alertedMonth !== s.month;
    const already = newMonth ? 0 : b.alertedLevel;
    if (level <= already) {
      if (newMonth && (b.alertedMonth || b.pausedAt)) {
        await prisma.spendBudget.update({ where: { id: b.id }, data: { alertedMonth: s.month, alertedLevel: 0, pausedAt: null } });
      }
      continue;
    }

    const platform = PLATFORM_INFO[account.platform].name;
    const money = (n: number) => formatMoney(n, account.currency);
    let pausedNote = "";
    let pausedAt: Date | null = newMonth ? null : b.pausedAt;
    if (level === 2 && b.pauseAtLimit && !pausedAt) {
      const run = await pauseAccountCampaigns(account.id, {
        orgId: account.orgId,
        workspaceId: account.workspaceId,
        userId: null,
        via: `Monthly budget ${money(limit)} reached`,
      });
      result.paused += run.paused;
      pausedAt = now;
      pausedNote =
        run.paused > 0
          ? ` ${run.paused} running campaign${run.paused === 1 ? " was" : "s were"} paused. Resume them in Campaigns after raising the budget.`
          : " No campaigns were running.";
      if (run.failed.length) pausedNote += ` Couldn't pause ${run.failed.length}: ${run.failed.slice(0, 3).join("; ")}`;
    }

    await prisma.spendBudget.update({ where: { id: b.id }, data: { alertedMonth: s.month, alertedLevel: level, pausedAt } });
    await notify({
      orgId: account.orgId,
      workspaceId: account.workspaceId,
      type: level === 2 ? "spend.budget_reached" : "spend.budget_alert",
      title:
        level === 2
          ? `${account.name} reached its monthly budget (${platform})`
          : `${account.name} has used ${Math.floor((s.spend / limit) * 100)}% of its monthly budget (${platform})`,
      body: `Spent ${money(s.spend)} of ${money(limit)} this month.${level === 1 ? ` At this rate the month ends near ${money(s.projected)}.` : ""}${pausedNote}`,
      link: spendLink(account.workspaceId),
      ctaLabel: "Open Spend & billing",
      roles: [...SPEND_ROLES],
      email: true,
      emailPref: "spendAlerts",
    });
    result.alerts++;
  }
  return result;
}

export const billingInfo = (platform: AdAccount["platform"]) => PLATFORM_BILLING[platform] ?? null;
