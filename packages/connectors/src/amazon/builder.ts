import type { BuilderDraft, Values } from "@ashniva/shared";
import { budgetOf, isoDate, dateOf, keywords, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface AmazonApi {
  send<T = Row>(path: string, method: "POST" | "PUT", body: unknown, accept?: string): Promise<T>;
}

const SP = "application/vnd.spCampaign.v3+json";
const SP_GROUP = "application/vnd.spAdGroup.v3+json";
const SP_AD = "application/vnd.spProductAd.v3+json";
const SP_KW = "application/vnd.spKeyword.v3+json";
const SB = "application/vnd.sbcampaignresource.v4+json";
const SB_GROUP = "application/vnd.sbadgroupresource.v4+json";
const SB_AD = "application/vnd.sbadresource.v4+json";

function first(res: Row, key: string, what: string) {
  const row = res[key]?.[0] ?? res[key.slice(0, -1)]?.[0];
  const err = row?.errors?.[0] ?? res.errors?.[0];
  const id = row?.campaignId ?? row?.adGroupId ?? row?.adId ?? row?.keywordId ?? row?.success?.[0]?.campaignId;
  if (!id) throw new ConnectorError("INVALID_REQUEST", `${what}: ${err?.errorValue?.message ?? err?.message ?? "rejected"}`, res);
  return String(id);
}

export async function amazonCreateCampaign(api: AmazonApi, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const product = String(draft.setup.adProduct || "SPONSORED_PRODUCTS");
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const state = status === "ACTIVE" ? "ENABLED" : "PAUSED";
  const budget = budgetOf(c);
  if (product === "SPONSORED_BRANDS") return brands(api, draft, status, state, budget?.amount ?? 1);
  if (product === "SPONSORED_DISPLAY") return display(api, draft, status, state, budget?.amount ?? 1);
  return products(api, draft, status, state, budget?.amount ?? 1);
}

async function products(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, state: string, amount: number): Promise<AccountStructure> {
  const c = draft.campaign;
  const start = isoDate(dateOf(c, "startDate")) ?? new Date().toISOString().slice(0, 10);
  const created = await api.send("/sp/campaigns", "POST", {
    campaigns: [{ name: str(c, "name"), targetingType: str(c, "targetingType") || "MANUAL", state, budget: { budgetType: "DAILY", budget: amount }, startDate: start, dynamicBidding: { strategy: "LEGACY_FOR_SALES" } }],
  }, SP);
  const campaignId = first(created, "campaigns", "Sponsored Products campaign");
  const groups = [];
  const ads = [];
  for (const g of draft.adGroups) {
    const group = await api.send("/sp/adGroups", "POST", { adGroups: [{ campaignId, name: str(g.values, "name"), state, defaultBid: Number(g.values.defaultBid ?? 1) }] }, SP_GROUP);
    const groupId = first(group, "adGroups", "Ad group");
    groups.push({ id: groupId, name: str(g.values, "name"), status, bid: String(g.values.defaultBid ?? ""), key: g.key });
    const kws = keywords(g.values, "keywords");
    if (kws.length) {
      await api.send("/sp/keywords", "POST", { keywords: kws.map((k) => ({ campaignId, adGroupId: groupId, keywordText: k.text, matchType: k.matchType, state, bid: Number(g.values.defaultBid ?? 1) })) }, SP_KW);
    }
    for (const ad of g.ads) {
      const made = await api.send("/sp/productAds", "POST", { productAds: [{ campaignId, adGroupId: groupId, state, asin: str(ad.values, "asin") || undefined, sku: str(ad.values, "sku") || undefined }] }, SP_AD);
      ads.push({ id: first(made, "productAds", "Product ad"), groupId, name: str(ad.values, "name") || str(ad.values, "asin"), status, headline: str(ad.values, "asin"), key: ad.key });
    }
  }
  return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_PRODUCTS", daily: amount, start }, groups, ads });
}

function lines(values: Values, key: string) {
  const raw = values[key];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw ?? "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

async function brands(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, state: string, amount: number): Promise<AccountStructure> {
  const c = draft.campaign;
  const ad = draft.adGroups[0]?.ads[0];
  const asins = lines(ad?.values ?? {}, "asins").slice(0, 3);
  const headline = str(ad?.values ?? {}, "headline");
  const created = await api.send("/sb/v4/campaigns", "POST", {
    campaigns: [{ name: str(c, "name"), state, budget: amount, budgetType: "DAILY", startDate: isoDate(dateOf(c, "startDate")) ?? undefined }],
  }, SB);
  const campaignId = first(created, "campaigns", "Sponsored Brands campaign");
  const group = await api.send("/sb/v4/adGroups", "POST", {
    adGroups: [{ campaignId, name: str(draft.adGroups[0]?.values ?? {}, "name") || "Brand creative", state }],
  }, SB_GROUP);
  const groupId = first(group, "adGroups", "Sponsored Brands ad group");
  const landing = str(ad?.values ?? {}, "url");
  const made = await api.send("/sb/v4/ads", "POST", {
    ads: [{
      adGroupId: groupId,
      name: headline || str(c, "name"),
      state,
      creative: { asins, headline: headline || undefined, brandName: str(c, "name") },
      landingPage: landing ? { url: landing } : asins.length ? { asins } : undefined,
    }],
  }, SB_AD);
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_BRANDS", daily: amount },
    groups: [{ id: groupId, name: "Brand creative", status, key: draft.adGroups[0]?.key }],
    ads: [{ id: first(made, "ads", "Sponsored Brands ad"), groupId, name: headline || "Brand ad", status, headline, url: landing, key: ad?.key }],
  });
}

async function display(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, state: string, amount: number): Promise<AccountStructure> {
  const c = draft.campaign;
  const created = await api.send<Row[]>("/sd/campaigns", "POST", [{ name: str(c, "name"), state, budgetType: "daily", budget: amount, startDate: isoDate(dateOf(c, "startDate")) ?? undefined, tactic: str(c, "tactic") || "T00020" }]);
  const campaignId = String(created?.[0]?.campaignId ?? "");
  if (!campaignId) throw new ConnectorError("INVALID_REQUEST", "Sponsored Display campaign was rejected.", created);
  const g = draft.adGroups[0];
  const ad = g?.ads[0];
  const groups = await api.send<Row[]>("/sd/adGroups", "POST", [{ campaignId: Number(campaignId), name: str(g?.values ?? {}, "name") || "Audience", state, defaultBid: 1 }]);
  const groupId = String(groups?.[0]?.adGroupId ?? "");
  if (!groupId) throw new ConnectorError("INVALID_REQUEST", "Sponsored Display ad group was rejected.", groups);
  const asin = str(ad?.values ?? {}, "asin");
  let adId = "";
  if (asin) {
    const made = await api.send<Row[]>("/sd/productAds", "POST", [{ campaignId: Number(campaignId), adGroupId: Number(groupId), state, asin }]);
    adId = String(made?.[0]?.adId ?? "");
  }
  return accountTree({
    campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_DISPLAY", daily: amount },
    groups: [{ id: groupId, name: str(g?.values ?? {}, "name") || "Audience", status, key: g?.key }],
    ads: adId ? [{ id: adId, groupId, name: str(ad?.values ?? {}, "name") || asin, status, headline: str(ad?.values ?? {}, "headline") || asin, key: ad?.key }] : [],
  });
}
