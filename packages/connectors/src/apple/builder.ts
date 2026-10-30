import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, instantOf, keywords, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface AppleApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
  put<T = Row>(path: string, body: unknown): Promise<T>;
}

/**
 * An ad group schedule value as Apple's UTC date-time ("2026-11-02T04:30:00.000").
 * The form's wall-clock time is in the ad account's zone. A start that is not in the
 * future is left out: Apple refuses past start times and starts the ad group now.
 */
function appleTime(v: Record<string, unknown>, key: string, timeZone: string, edge: "start" | "end") {
  const t = instantOf(v, key, timeZone, edge);
  if (!t || (edge === "start" && t.getTime() <= Date.now())) return undefined;
  return t.toISOString().replace(/Z$/, "");
}

export async function appleCreateCampaign(api: AppleApi, draft: BuilderDraft, currency: string, _assets: Map<string, BuilderAsset>, timeZone = "UTC"): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const countries = countryCodes(c);
  const adamId = str(c, "adamId");
  if (!/^\d+$/.test(adamId)) throw new ConnectorError("INVALID_REQUEST", "The App Store app id (adamId) must be the number from the app's App Store link, like 1234567890.");
  const created = await api.send<{ data?: Row }>("/campaigns", {
    name: str(c, "name"),
    adamId: Number(adamId),
    adChannelType: "SEARCH",
    status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
    dailyBudgetAmount: { amount: String(budget?.amount ?? 1), currency },
    countriesOrRegions: countries.length ? countries : ["US"],
  });
  const campaignId = String(created.data?.id ?? "");
  if (!campaignId) throw new ConnectorError("INVALID_REQUEST", "Apple Ads did not return a campaign id.", created);
  try {
    return await buildGroups(api, draft, currency, adamId, campaignId, status, budget?.amount ?? null, timeZone);
  } catch (err) {
    // A live campaign whose later step failed would keep delivering what was made so far: pause it.
    if (status === "ACTIVE") await api.put(`/campaigns/${campaignId}`, { campaign: { status: "PAUSED" } }).catch(() => undefined);
    throw err;
  }
}

async function buildGroups(api: AppleApi, draft: BuilderDraft, currency: string, adamId: string, campaignId: string, status: EntityStatus, daily: number | null, timeZone: string): Promise<AccountStructure> {
  const c = draft.campaign;
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const group = await api.send<{ data?: Row }>(`/campaigns/${campaignId}/adgroups`, {
      name: str(g.values, "name"),
      status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
      defaultBidAmount: { amount: String(g.values.cpt ?? 1), currency },
      cpaGoal: g.values.cpa ? { amount: String(g.values.cpa), currency } : undefined,
      automatedKeywordsOptIn: g.values.searchMatch !== false,
      startTime: appleTime(g.values, "startDate", timeZone, "start"),
      endTime: appleTime(g.values, "endDate", timeZone, "end"),
    });
    const groupId = idOf(group, "ad group");
    groups.push({ id: groupId, name: str(g.values, "name"), status, bid: String(g.values.cpt ?? ""), key: g.key });
    const kws = keywords(g.values, "keywords");
    if (kws.length) {
      // The documented body is a bare [Keyword] array.
      await api.send(
        `/campaigns/${campaignId}/adgroups/${groupId}/targetingkeywords/bulk`,
        kws.map((k) => ({ text: k.text, matchType: k.matchType === "PHRASE" ? "BROAD" : k.matchType, status: "ACTIVE" })),
      );
    }
    for (const ad of g.ads) {
      const creativeType = str(ad.values, "creativeType") || "SEARCH_RESULTS";
      let creativeId: string | undefined;
      if (creativeType === "CUSTOM_PRODUCT_PAGE") {
        // A custom product page ad points at a creative made from the page id.
        // RISK: /creatives body follows Apple's v5 docs; not verified against a live org.
        const productPageId = str(ad.values, "productPageId");
        if (!productPageId) throw new ConnectorError("INVALID_REQUEST", `Ad "${str(ad.values, "name")}" needs the custom product page id.`);
        const creative = await api.send<{ data?: Row }>("/creatives", { adamId: Number(adamId), name: str(ad.values, "name"), type: "CUSTOM_PRODUCT_PAGE", productPageId });
        creativeId = idOf(creative, "creative");
      }
      const made = await api.send<{ data?: Row }>(`/campaigns/${campaignId}/adgroups/${groupId}/ads`, {
        name: str(ad.values, "name"),
        creativeType,
        creativeId,
        status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
      });
      ads.push({ id: idOf(made, "ad"), groupId, name: str(ad.values, "name"), status, headline: creativeType, key: ad.key });
    }
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: "SEARCH", daily },
    groups,
    ads,
  });
}

function idOf(res: { data?: Row }, what: string) {
  const id = res?.data?.id;
  if (id == null || id === "") throw new ConnectorError("PLATFORM_ERROR", `Apple Ads did not return an id for the ${what}.`, res);
  return String(id);
}
