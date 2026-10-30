import type { BuilderDraft, Values } from "@ashniva/shared";
import { budgetOf, dayIn, dayOf, keywords, mediaOf, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { accountTree } from "../tree";
import type { AccountStructure, BuilderAsset, EntityStatus } from "../types";

type Row = Record<string, any>;

export interface AmazonApi {
  send<T = Row>(path: string, method: "POST" | "PUT" | "DELETE", body: unknown, accept?: string): Promise<T>;
}

const SP = "application/vnd.spCampaign.v3+json";
const SP_GROUP = "application/vnd.spAdGroup.v3+json";
const SP_AD = "application/vnd.spProductAd.v3+json";
const SP_KW = "application/vnd.spKeyword.v3+json";
const SB = "application/vnd.sbcampaignresource.v4+json";
const SB_GROUP = "application/vnd.sbadgroupresource.v4+json";
const SB_AD = "application/vnd.sbadresource.v4+json";

const ID_KEYS = ["campaignId", "adGroupId", "adId", "keywordId"];

/** Platform message(s) from an SP v3 / SB v4 multi-status error entry, or a legacy row. */
function errorText(err: Row | undefined) {
  const list: Row[] = Array.isArray(err?.errors) ? err.errors : err ? [err] : [];
  const parts = list.map((e) => {
    const value = e?.errorValue && typeof e.errorValue === "object" ? Object.values(e.errorValue)[0] : null;
    return (value as Row | null)?.message ?? e?.message ?? e?.details ?? e?.description ?? e?.errorType ?? e?.code;
  });
  return parts.filter(Boolean).join("; ") || "rejected";
}

/**
 * The id of the one entity created by an SP v3 / SB v4 call. Those reply
 * 207 with `{ <key>: { success: [{ campaignId… }], error: [{ index, errors }] } }`.
 */
export function createdId(res: Row, key: string, what: string) {
  const block = res?.[key];
  const success: Row[] = Array.isArray(block?.success) ? block.success : [];
  const failed: Row[] = Array.isArray(block?.error) ? block.error : [];
  const row = success[0];
  const id = row ? ID_KEYS.map((k) => row[k] ?? row[key.slice(0, -1)]?.[k]).find((v) => v != null) : undefined;
  if (id == null || failed.length) throw new ConnectorError("INVALID_REQUEST", `${what}: ${errorText(failed[0] ?? res)}`, res);
  return String(id);
}

/** Every id from a multi-status reply; throws with the platform's messages if any item failed. */
export function createdIds(res: Row, key: string, what: string) {
  const block = res?.[key];
  const failed: Row[] = Array.isArray(block?.error) ? block.error : [];
  if (failed.length || !Array.isArray(block?.success)) throw new ConnectorError("INVALID_REQUEST", `${what}: ${errorText(failed[0] ?? res)}`, res);
  return (block.success as Row[]).map((row) => String(ID_KEYS.map((k) => row[k]).find((v) => v != null)));
}

/** Every id from a Sponsored Display (v3) array reply; throws if any row is not SUCCESS. */
export function sdIds(res: Row[] | Row, key: string, what: string) {
  const rows: Row[] = Array.isArray(res) ? res : [];
  const bad = rows.find((row) => row?.code && row.code !== "SUCCESS");
  if (!rows.length || bad) throw new ConnectorError("INVALID_REQUEST", `${what}: ${errorText(bad ?? (res as Row))}`, res);
  return rows.map((row) => String(row[key]));
}

/** Sponsored Display (v3, not multi-status) replies with an array of `{ code, campaignId… }`. */
function sdId(res: Row[] | Row, key: string, what: string) {
  const row = Array.isArray(res) ? res[0] : undefined;
  const id = row?.[key];
  if (id == null || (row?.code && row.code !== "SUCCESS")) throw new ConnectorError("INVALID_REQUEST", `${what}: ${errorText(row ?? (res as Row))}`, res);
  return String(id);
}

/** `timeZone` is the profile's zone: a campaign with no start date starts today there, not today in UTC. */
export async function amazonCreateCampaign(api: AmazonApi, draft: BuilderDraft, assets: Map<string, BuilderAsset>, timeZone = "UTC"): Promise<AccountStructure> {
  const product = String(draft.setup.adProduct || "SPONSORED_PRODUCTS");
  const c = draft.campaign;
  const status: EntityStatus = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const state = status === "ACTIVE" ? "ENABLED" : "PAUSED";
  const budget = budgetOf(c);
  if (product === "SPONSORED_BRANDS") return brands(api, draft, status, state, budget?.amount ?? 1, assets);
  if (product === "SPONSORED_DISPLAY") return display(api, draft, status, state, budget?.amount ?? 1);
  return products(api, draft, status, state, budget?.amount ?? 1, dayIn(new Date(), timeZone));
}

/** Archives a half-built campaign so a failed create leaves nothing running or billable. */
async function rollback(api: AmazonApi, product: string, campaignId: string) {
  const include = { campaignIdFilter: { include: [campaignId] } };
  const undo =
    product === "SPONSORED_BRANDS" ? api.send("/sb/v4/campaigns/delete", "POST", include, SB)
    : product === "SPONSORED_DISPLAY" ? api.send(`/sd/campaigns/${campaignId}`, "DELETE", undefined)
    : api.send("/sp/campaigns/delete", "POST", include, SP);
  await undo.catch(() => undefined);
}

async function products(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, state: string, amount: number, today: string): Promise<AccountStructure> {
  const c = draft.campaign;
  const targetingType = str(c, "targetingType") || "MANUAL";
  // An ad group with no product ad has nothing to serve; refuse before anything is created.
  for (const g of draft.adGroups) {
    if (!g.ads.some((ad) => str(ad.values, "asin") || str(ad.values, "sku"))) {
      throw new ConnectorError("INVALID_REQUEST", `Ad group "${str(g.values, "name") || "Ad group"}" needs at least one ad with an ASIN or SKU.`);
    }
  }
  const start = dayOf(c, "startDate") ?? today;
  const end = dayOf(c, "endDate");
  const created = await api.send("/sp/campaigns", "POST", {
    campaigns: [{ name: str(c, "name"), targetingType, state, budget: { budgetType: "DAILY", budget: amount }, startDate: start, endDate: end ?? undefined, dynamicBidding: { strategy: "LEGACY_FOR_SALES" } }],
  }, SP);
  const campaignId = createdId(created, "campaigns", "Sponsored Products campaign");
  try {
    const groups = [];
    const ads = [];
    for (const g of draft.adGroups) {
      const group = await api.send("/sp/adGroups", "POST", { adGroups: [{ campaignId, name: str(g.values, "name"), state, defaultBid: Number(g.values.defaultBid ?? 1) }] }, SP_GROUP);
      const groupId = createdId(group, "adGroups", "Ad group");
      groups.push({ id: groupId, name: str(g.values, "name"), status, bid: String(g.values.defaultBid ?? ""), key: g.key });
      // Automatic campaigns pick their own targets; Amazon rejects keywords on them.
      const kws = targetingType === "AUTO" ? [] : keywords(g.values, "keywords");
      if (kws.length) {
        const made = await api.send("/sp/keywords", "POST", { keywords: kws.map((k) => ({ campaignId, adGroupId: groupId, keywordText: k.text, matchType: k.matchType, state, bid: Number(g.values.defaultBid ?? 1) })) }, SP_KW);
        createdIds(made, "keywords", "Keywords");
      }
      for (const ad of g.ads) {
        const made = await api.send("/sp/productAds", "POST", { productAds: [{ campaignId, adGroupId: groupId, state, asin: str(ad.values, "asin") || undefined, sku: str(ad.values, "sku") || undefined }] }, SP_AD);
        ads.push({ id: createdId(made, "productAds", "Product ad"), groupId, name: str(ad.values, "name") || str(ad.values, "asin"), status, headline: str(ad.values, "asin"), key: ad.key });
      }
    }
    return accountTree({ campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_PRODUCTS", daily: amount, start, end, raw: { product: "SPONSORED_PRODUCTS" } }, groups, ads });
  } catch (err) {
    await rollback(api, "SPONSORED_PRODUCTS", campaignId);
    throw err;
  }
}

function lines(values: Values, key: string) {
  const raw = values[key];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

async function brands(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, state: string, amount: number, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const c = draft.campaign;
  // The form allows one ad group with one ad for Sponsored Brands.
  const g = draft.adGroups[0];
  const ad = g?.ads[0];
  const v = ad?.values ?? {};
  const asins = lines(v, "asins");
  const headline = str(v, "headline");
  const landing = str(v, "url");
  if (!asins.length) throw new ConnectorError("INVALID_REQUEST", "Sponsored Brands needs at least one product ASIN.");
  if (lines(v, "asins").length > 3) throw new ConnectorError("INVALID_REQUEST", "Sponsored Brands takes at most 3 ASINs.");
  const brandName = str(v, "brandName") || str(c, "name");
  const adName = str(v, "name") || headline || str(c, "name");
  // Amazon wants an asset-library id for the logo. A creative already uploaded there carries it as cachedRef.
  const [logo] = mediaOf(v, "brandLogo", assets);
  const warnings: string[] = [];
  if (logo && !logo.cachedRef) warnings.push("The brand logo was not sent: upload it to the Amazon Ads asset library first.");
  const created = await api.send("/sb/v4/campaigns", "POST", {
    campaigns: [{ name: str(c, "name"), state, budget: amount, budgetType: "DAILY", startDate: dayOf(c, "startDate") ?? undefined, endDate: dayOf(c, "endDate") ?? undefined }],
  }, SB);
  const campaignId = createdId(created, "campaigns", "Sponsored Brands campaign");
  try {
    const groupName = str(g?.values ?? {}, "name") || "Brand creative";
    const group = await api.send("/sb/v4/adGroups", "POST", { adGroups: [{ campaignId, name: groupName, state }] }, SB_GROUP);
    const groupId = createdId(group, "adGroups", "Sponsored Brands ad group");
    const made = await api.send("/sb/v4/ads", "POST", {
      ads: [{
        adGroupId: groupId,
        name: adName,
        state,
        creative: { asins, headline: headline || undefined, brandName, brandLogoAssetID: logo?.cachedRef || undefined },
        landingPage: landing ? { url: landing } : { asins },
      }],
    }, SB_AD);
    const adId = createdId(made, "ads", "Sponsored Brands ad");
    const tree = accountTree({
      campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_BRANDS", daily: amount, start: dayOf(c, "startDate"), end: dayOf(c, "endDate"), raw: { product: "SPONSORED_BRANDS" } },
      groups: [{ id: groupId, name: groupName, status, key: g?.key }],
      ads: [{ id: adId, groupId, name: adName, status, headline, url: landing, key: ad?.key }],
    });
    if (warnings.length) tree.warnings = warnings;
    return tree;
  } catch (err) {
    await rollback(api, "SPONSORED_BRANDS", campaignId);
    throw err;
  }
}

async function display(api: AmazonApi, draft: BuilderDraft, status: EntityStatus, spState: string, amount: number): Promise<AccountStructure> {
  const c = draft.campaign;
  // Sponsored Display (v3) spells states in lower case.
  const state = spState.toLowerCase();
  // The form allows one ad group with one ad for Sponsored Display.
  const g = draft.adGroups[0];
  const ad = g?.ads[0];
  const asin = str(ad?.values ?? {}, "asin");
  // A Sponsored Display ad group serves its product ads; without an ASIN it would serve nothing.
  if (!asin) throw new ConnectorError("INVALID_REQUEST", "Sponsored Display needs the ASIN of the product to advertise.");
  // SD v3 writes dates as YYYYMMDD.
  const sdDay = (key: string) => dayOf(c, key)?.replace(/-/g, "") ?? undefined;
  const created = await api.send<Row[]>("/sd/campaigns", "POST", [{ name: str(c, "name"), state, budgetType: "daily", budget: amount, startDate: sdDay("startDate"), endDate: sdDay("endDate"), tactic: str(c, "tactic") || "T00020" }]);
  const campaignId = sdId(created, "campaignId", "Sponsored Display campaign");
  try {
    const groupName = str(g?.values ?? {}, "name") || "Audience";
    const groups = await api.send<Row[]>("/sd/adGroups", "POST", [{ campaignId: Number(campaignId), name: groupName, state, defaultBid: 1 }]);
    const groupId = sdId(groups, "adGroupId", "Sponsored Display ad group");
    const made = await api.send<Row[]>("/sd/productAds", "POST", [{ campaignId: Number(campaignId), adGroupId: Number(groupId), state, asin }]);
    const adId = sdId(made, "adId", "Sponsored Display ad");
    const tree = accountTree({
      campaign: { id: campaignId, name: str(c, "name"), status, objective: "SPONSORED_DISPLAY", daily: amount, start: dayOf(c, "startDate"), end: dayOf(c, "endDate"), raw: { product: "SPONSORED_DISPLAY" } },
      groups: [{ id: groupId, name: groupName, status, key: g?.key }],
      ads: [{ id: adId, groupId, name: str(ad?.values ?? {}, "name") || asin, status, headline: asin, key: ad?.key }],
    });
    // A custom SD headline lives on a separate creative that also needs a brand logo from the
    // asset library, which this form does not collect, so the headline is not sent.
    if (str(ad?.values ?? {}, "headline")) tree.warnings = ["The Sponsored Display headline was not sent. Amazon shows the product title until a custom creative is added in Amazon Ads."];
    return tree;
  } catch (err) {
    await rollback(api, "SPONSORED_DISPLAY", campaignId);
    throw err;
  }
}
