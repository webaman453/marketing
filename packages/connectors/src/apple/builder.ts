import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, countryCodes, isoDate, dateOf, keywords, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface AppleApi {
  send<T = Row>(path: string, body: unknown): Promise<T>;
}

export async function appleCreateCampaign(api: AppleApi, draft: BuilderDraft, currency: string, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const budget = budgetOf(c);
  const countries = countryCodes(c);
  const created = await api.send<{ data?: Row }>("/campaigns", {
    name: str(c, "name"),
    adamId: Number(str(c, "adamId")),
    adChannelType: "SEARCH",
    status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
    dailyBudgetAmount: { amount: String(budget?.amount ?? 1), currency },
    countriesOrRegions: countries.length ? countries : ["US"],
    startTime: isoDate(dateOf(c, "startDate")) ?? undefined,
  });
  const campaignId = String(created.data?.id ?? "");
  if (!campaignId) throw new ConnectorError("INVALID_REQUEST", "Apple Ads did not return a campaign id.", created);
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const group = await api.send<{ data?: Row }>(`/campaigns/${campaignId}/adgroups`, {
      name: str(g.values, "name"),
      status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
      defaultBidAmount: { amount: String(g.values.cpt ?? 1), currency },
      cpaGoal: g.values.cpa ? { amount: String(g.values.cpa), currency } : undefined,
      automatedKeywordsOptIn: g.values.searchMatch !== false,
      startTime: isoDate(dateOf(g.values, "startDate")) ?? undefined,
    });
    const groupId = String(group.data?.id);
    groups.push({ id: groupId, name: str(g.values, "name"), status, bid: String(g.values.cpt ?? ""), key: g.key });
    const kws = keywords(g.values, "keywords");
    if (kws.length) {
      await api.send(`/campaigns/${campaignId}/adgroups/${groupId}/targetingkeywords/bulk`, {
        keywords: kws.map((k) => ({ text: k.text, matchType: k.matchType === "PHRASE" ? "BROAD" : k.matchType, status: "ACTIVE" })),
      });
    }
    for (const ad of g.ads) {
      const made = await api.send<{ data?: Row }>(`/campaigns/${campaignId}/adgroups/${groupId}/ads`, {
        name: str(ad.values, "name"),
        creativeType: str(ad.values, "creativeType") || "SEARCH_RESULTS",
        status: status === "ACTIVE" ? "ENABLED" : "PAUSED",
      });
      ads.push({ id: String(made.data?.id ?? `${groupId}:ad`), groupId, name: str(ad.values, "name"), status, headline: str(ad.values, "creativeType"), key: ad.key });
    }
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: "SEARCH", daily: budget?.amount ?? null },
    groups,
    ads,
  });
}
