/**
 * Microsoft Advertising campaign creation from a builder draft (Campaign
 * Management API v13, REST/JSON): campaign → criteria → ad groups or asset
 * groups → keywords → ads → extensions. Rolled back on failure.
 */
import { LANGUAGES, countryName, type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type TargetingValue, type Values } from "@ashniva/shared";
import { budgetOf, excluded, included, keywords, mediaOf, num, pinned, repeater, str, strs, texts } from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset } from "../types";

type Row = Record<string, any>;

export interface MicrosoftApi {
  call<T = Row>(path: string, body: unknown, method?: "POST" | "PUT" | "DELETE"): Promise<T>;
  download(url: string): Promise<string>;
}

// ───────── Locations (from Microsoft's geographic locations file) ─────────

let geoCache: { at: number; rows: { id: string; name: string; type: string }[] } | null = null;

async function geoLocations(api: MicrosoftApi) {
  if (geoCache && Date.now() - geoCache.at < 7 * 86_400_000) return geoCache.rows;
  const res = await api.call<{ FileUrl?: string }>("/GeoLocationsFileUrl/Query", { Version: "2.0", LanguageLocale: "en" });
  if (!res.FileUrl) throw new ConnectorError("PLATFORM_ERROR", "Microsoft didn't return its locations file.");
  const csv = await api.download(res.FileUrl);
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const header = lines.shift()!.split(",").map((h) => h.replace(/"/g, "").trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const [idCol, nameCol, typeCol] = [col("Location Id"), col("Bing Display Name"), col("Location Type")];
  const rows = lines.map((line) => {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
    return { id: cells[idCol] ?? "", name: cells[nameCol] ?? "", type: cells[typeCol] ?? "" };
  });
  geoCache = { at: Date.now(), rows: rows.filter((r) => r.id) };
  return geoCache.rows;
}

export async function microsoftSearchTargeting(api: MicrosoftApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  if (kind !== "location" || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  return (await geoLocations(api))
    .filter((r) => r.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.type === "Country") - Number(a.type === "Country") || a.name.length - b.name.length)
    .slice(0, 25)
    .map((r) => ({ id: r.id, name: r.name, type: r.type === "Country" ? "country" : r.type === "City" ? "city" : "region", detail: r.type }));
}

async function locationIds(api: MicrosoftApi, list: TargetingValue[]) {
  const out: string[] = [];
  for (const l of list) {
    if (/^\d+$/.test(l.id)) {
      out.push(l.id);
      continue;
    }
    const name = countryName(l.id);
    const hit = (await geoLocations(api)).find((r) => r.type === "Country" && r.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw new ConnectorError("INVALID_REQUEST", `Microsoft Advertising can't target ${name}.`);
    out.push(hit.id);
  }
  return out;
}

export async function microsoftBuilderOptions(api: MicrosoftApi, accountId: string): Promise<BuilderOptions> {
  const goals = await api.call<{ ConversionGoals?: Row[] }>("/ConversionGoals/QueryByIds", { ConversionGoalTypes: "Url Event Duration PagesViewedPerVisit AppInstall OfflineConversion InStoreTransaction", ReturnAdditionalFields: null, AccountId: Number(accountId) }).catch(() => ({ ConversionGoals: [] }));
  return { conversionActions: (goals.ConversionGoals ?? []).map((g) => ({ id: String(g.Id), name: g.Name ?? String(g.Id), detail: g.Type })) };
}

// ───────── Mapping ─────────

const TIMEZONES: Record<string, string> = {
  "Asia/Kolkata": "ChennaiKolkataMumbaiNewDelhi",
  "Asia/Calcutta": "ChennaiKolkataMumbaiNewDelhi",
  "Asia/Dubai": "AbuDhabiMuscat",
  "Asia/Singapore": "KualaLumpurSingapore",
  "Europe/London": "GreenwichMeanTimeDublinEdinburghLisbonLondon",
  "America/New_York": "EasternTimeUSCanada",
  "America/Chicago": "CentralTimeUSCanada",
  "America/Los_Angeles": "PacificTimeUSCanadaTijuana",
  "Australia/Sydney": "CanberraMelbourneSydney",
};

function biddingScheme(c: Values) {
  const s = str(c, "bidStrategy") || "MaxConversions";
  const amount = (n: number | null) => (n ? { Amount: n } : null);
  switch (s) {
    case "MaxClicks":
      return { Type: "MaxClicksBiddingScheme", MaxCpc: amount(num(c, "maxCpc")) };
    case "MaxConversionValue":
      return { Type: "MaxConversionValueBiddingScheme", TargetRoas: num(c, "targetRoas") ? num(c, "targetRoas")! / 100 : null };
    case "TargetImpressionShare":
      return { Type: "TargetImpressionShareBiddingScheme", TargetAdPosition: str(c, "impressionSharePosition") || "TopPage", TargetImpressionShare: num(c, "impressionShareTarget") ?? 70, MaxCpc: amount(num(c, "maxCpc")) };
    case "EnhancedCpc":
      return { Type: "EnhancedCpcBiddingScheme" };
    case "ManualCpc":
      return { Type: "ManualCpcBiddingScheme" };
    default:
      return { Type: "MaxConversionsBiddingScheme", TargetCpa: num(c, "targetCpa") };
  }
}

const textLinks = (list: { text: string; pin: string | null }[], pins: Record<string, string> = {}) =>
  list.map((t) => ({ Asset: { Type: "TextAsset", Text: t.text }, ...(t.pin && pins[t.pin] ? { PinnedField: pins[t.pin] } : {}) }));

const PINS = { H1: "Headline1", H2: "Headline2", H3: "Headline3", D1: "Description1", D2: "Description2" };
const MATCH: Record<string, string> = { BROAD: "Broad", PHRASE: "Phrase", EXACT: "Exact" };
const DAY: Record<string, string> = { MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday" };

/** Throws on partial errors for the entities that matter. */
function check(res: Row, what: string) {
  const errs = [...(res.PartialErrors ?? []), ...(res.NestedPartialErrors ?? [])].filter(Boolean) as Row[];
  if (errs.length) throw new ConnectorError("INVALID_REQUEST", `${what}: ${errs.map((e) => e.Message ?? e.ErrorCode ?? "error").slice(0, 3).join("; ")}`, errs);
}

async function mediaId(api: MicrosoftApi, accountId: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("media:")) return Number(asset.cachedRef.slice(6));
  const res = await api.call<{ MediaIds?: number[] } & Row>("/Media", { AccountId: Number(accountId), Media: [{ Type: "Image", MediaType: "Image", Data: (await asset.load()).toString("base64") }] });
  check(res, `Image “${asset.filename}”`);
  const id = res.MediaIds?.[0];
  if (!id) throw new ConnectorError("PLATFORM_ERROR", `Microsoft didn't accept the image “${asset.filename}”.`);
  await asset.onUploaded?.(`media:${id}`);
  return id;
}

const imageLinks = async (api: MicrosoftApi, accountId: string, list: BuilderAsset[], subType: string) =>
  Promise.all(list.map(async (a) => ({ Asset: { Type: "ImageAsset", Id: await mediaId(api, accountId, a), SubType: subType } })));

// ───────── Create ─────────

export async function microsoftCreateCampaign(
  api: MicrosoftApi,
  account: { externalId: string; currency: string; timezone?: string | null },
  draft: BuilderDraft,
  assets: Map<string, BuilderAsset>,
): Promise<AccountStructure> {
  const accountId = account.externalId;
  const c = draft.campaign;
  const type = String(draft.setup.campaignType);
  const campaignType = type === "PERFORMANCE_MAX" ? "PerformanceMax" : type === "AUDIENCE" ? "Audience" : "Search";
  const status = c.launchStatus === "ACTIVE" ? "Active" : "Paused";
  const budget = budgetOf(c);
  if (!budget) throw new ConnectorError("INVALID_REQUEST", "Enter the campaign budget.");
  const warnings: string[] = [];
  const languages = type === "AUDIENCE" ? ["All"] : strs(c, "languages").map((code) => LANGUAGES.find((l) => l.code === code)?.name ?? code);

  const res = await api.call<{ CampaignIds?: number[] } & Row>("/Campaigns", {
    AccountId: Number(accountId),
    Campaigns: [
      {
        Name: str(c, "name"),
        CampaignType: campaignType,
        BudgetType: "DailyBudgetStandard",
        DailyBudget: budget.amount,
        Status: status,
        TimeZone: TIMEZONES[account.timezone ?? ""] ?? "EasternTimeUSCanada",
        Languages: languages.length ? languages : ["English"],
        BiddingScheme: biddingScheme(c),
        ...(strs(c, "conversionGoals").length ? { GoalIds: strs(c, "conversionGoals").map(Number) } : {}),
        ...(str(c, "trackingTemplate") ? { TrackingUrlTemplate: str(c, "trackingTemplate") } : {}),
        ...(str(c, "finalUrlSuffix") ? { FinalUrlSuffix: str(c, "finalUrlSuffix") } : {}),
        ...(type === "PERFORMANCE_MAX" ? { Settings: [{ Type: "PerformanceMaxSetting", FinalUrlExpansionOptOut: c.pmaxUrlExpansion === false }] } : {}),
        ...(type === "AUDIENCE" && str(c, "startDate") ? { StartDate: str(c, "startDate"), EndDate: str(c, "endDate") || null } : {}),
      },
    ],
  });
  check(res, "Campaign");
  const campaignId = String(res.CampaignIds?.[0] ?? "");
  if (!campaignId) throw new ConnectorError("PLATFORM_ERROR", "Microsoft didn't return a campaign id.");

  const structure: AccountStructure = {
    campaigns: [
      { externalId: campaignId, name: str(c, "name"), status: status === "Active" ? "ACTIVE" : "PAUSED", deliveryStatus: null, objective: campaignType, dailyBudget: budget.amount, lifetimeBudget: null, startDate: null, endDate: null, updatedAt: new Date(), raw: {} },
    ],
    adGroups: [],
    ads: [],
    warnings,
  };

  try {
    // Campaign criteria: locations, intent, schedule, devices.
    const criteria: Row[] = [];
    for (const id of await locationIds(api, included(c, "locations"))) criteria.push({ Type: "BiddableCampaignCriterion", CampaignId: Number(campaignId), Criterion: { Type: "LocationCriterion", LocationId: Number(id) } });
    for (const id of await locationIds(api, excluded(c, "locations"))) criteria.push({ Type: "NegativeCampaignCriterion", CampaignId: Number(campaignId), Criterion: { Type: "LocationCriterion", LocationId: Number(id) } });
    criteria.push({ Type: "BiddableCampaignCriterion", CampaignId: Number(campaignId), Criterion: { Type: "LocationIntentCriterion", IntentOption: str(c, "locationIntent") || "PeopleInOrSearchingForOrViewingPages" } });
    for (const [day, slots] of Object.entries((c.adSchedule as { days?: Record<string, [number, number][]> })?.days ?? {})) {
      for (const [from, to] of slots) criteria.push({ Type: "BiddableCampaignCriterion", CampaignId: Number(campaignId), Criterion: { Type: "DayTimeCriterion", Day: DAY[day], FromHour: from, FromMinute: "Zero", ToHour: to, ToMinute: "Zero" } });
    }
    if (Array.isArray(c.devices)) {
      for (const d of ["Computers", "Smartphones", "Tablets"]) {
        if (!strs(c, "devices").includes(d)) criteria.push({ Type: "BiddableCampaignCriterion", CampaignId: Number(campaignId), Criterion: { Type: "DeviceCriterion", DeviceName: d }, CriterionBid: { Type: "BidMultiplier", Multiplier: -100 } });
      }
    }
    check(await api.call("/CampaignCriterions", { CampaignCriterions: criteria, CriterionType: "Targets" }), "Targeting");

    for (const g of draft.adGroups) {
      const v = g.values;
      if (type === "PERFORMANCE_MAX") {
        const ag = await api.call<{ AssetGroupIds?: number[] } & Row>("/AssetGroups", {
          CampaignId: Number(campaignId),
          AssetGroups: [
            {
              Name: str(v, "name"),
              FinalUrls: [str(v, "finalUrl")],
              BusinessName: str(v, "businessName"),
              Headlines: textLinks(pinned(v, "headlines")),
              LongHeadlines: textLinks(pinned(v, "longHeadlines")),
              Descriptions: textLinks(pinned(v, "descriptions")),
              Images: [
                ...(await imageLinks(api, accountId, mediaOf(v, "landscapeImages", assets), "LandscapeImageMedia")),
                ...(await imageLinks(api, accountId, mediaOf(v, "squareImages", assets), "SquareImageMedia")),
                ...(await imageLinks(api, accountId, mediaOf(v, "logos", assets), "SquareLogoMedia")),
              ],
              CallToAction: str(v, "cta") ? str(v, "cta").replace(/_/g, " ").toLowerCase().replace(/(^|\s)\w/g, (m) => m.toUpperCase()).replace(/\s/g, "") : null,
              Status: "Active",
            },
          ],
        });
        check(ag, "Asset group");
        const id = String(ag.AssetGroupIds?.[0] ?? "");
        structure.adGroups.push({ externalId: id, campaignExternalId: campaignId, name: str(v, "name"), status: "ACTIVE", dailyBudget: null, bidStrategy: str(c, "bidStrategy") || null, targeting: null, raw: { kind: "assetGroup" }, sourceKey: g.key });
        structure.ads.push({ externalId: `${id}~ag`, adGroupExternalId: id, campaignExternalId: campaignId, name: str(v, "name"), status: "ACTIVE", headline: texts(v, "headlines")[0] ?? null, body: texts(v, "descriptions")[0] ?? null, thumbnailUrl: null, finalUrl: str(v, "finalUrl") || null, raw: {}, sourceKey: g.key });
        if (texts(v, "searchThemes").length || included(v, "audienceSignals").length) warnings.push(`Search themes and audience signals for “${str(v, "name")}” need to be added in Microsoft Advertising.`);
        continue;
      }

      const groupRes = await api.call<{ AdGroupIds?: number[] } & Row>("/AdGroups", {
        CampaignId: Number(campaignId),
        AdGroups: [
          {
            Name: str(v, "name"),
            Status: "Active",
            ...(num(v, "defaultBid") ? { CpcBid: { Amount: num(v, "defaultBid") } } : {}),
            ...(type === "SEARCH" ? { Network: str(v, "network") || "OwnedAndOperatedAndSyndicatedSearch", AdRotation: { Type: str(v, "rotation") || "OptimizeForClicks" } } : {}),
          },
        ],
      });
      check(groupRes, `Ad group “${str(v, "name")}”`);
      const groupId = String(groupRes.AdGroupIds?.[0] ?? "");
      structure.adGroups.push({ externalId: groupId, campaignExternalId: campaignId, name: str(v, "name"), status: "ACTIVE", dailyBudget: null, bidStrategy: str(c, "bidStrategy") || null, targeting: null, raw: {}, sourceKey: g.key });

      if (type === "SEARCH") {
        const kws = keywords(v, "keywords");
        if (kws.length) check(await api.call("/Keywords", { AdGroupId: Number(groupId), Keywords: kws.map((k) => ({ Text: k.text, MatchType: MATCH[k.matchType], Status: "Active" })) }), "Keywords");
        const negatives = keywords(v, "negativeKeywords");
        if (negatives.length) {
          try {
            check(await api.call("/EntityNegativeKeywords", { EntityNegativeKeywords: [{ EntityId: Number(groupId), EntityType: "AdGroup", NegativeKeywords: negatives.map((k) => ({ Text: k.text, MatchType: k.matchType === "EXACT" ? "Exact" : "Phrase" })) }] }), "Negative keywords");
          } catch (err) {
            warnings.push(`Negative keywords weren't added to “${str(v, "name")}”: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      if (type === "AUDIENCE") {
        const ages = strs(v, "ageRanges");
        const crit: Row[] = [];
        if (ages.length) for (const a of ["EighteenToTwentyFour", "TwentyFiveToThirtyFour", "ThirtyFiveToFortyNine", "FiftyToSixtyFour", "SixtyFiveAndAbove"]) if (!ages.includes(a)) crit.push({ Type: "NegativeAdGroupCriterion", AdGroupId: Number(groupId), Criterion: { Type: "AgeCriterion", AgeRange: a } });
        if (str(v, "gender") && str(v, "gender") !== "ALL") crit.push({ Type: "NegativeAdGroupCriterion", AdGroupId: Number(groupId), Criterion: { Type: "GenderCriterion", GenderType: str(v, "gender") === "Female" ? "Male" : "Female" } });
        if (crit.length) check(await api.call("/AdGroupCriterions", { AdGroupCriterions: crit, CriterionType: "Targets" }), "Demographics");
        if (included(v, "audiences").length) warnings.push(`Audiences for “${str(v, "name")}” need to be attached in Microsoft Advertising.`);
      }

      for (const ad of g.ads) {
        const a = ad.values;
        const body =
          type === "SEARCH"
            ? { Type: "ResponsiveSearch", FinalUrls: [str(a, "finalUrl")], Headlines: textLinks(pinned(a, "headlines"), PINS), Descriptions: textLinks(pinned(a, "descriptions"), PINS), ...(str(a, "path1") ? { Path1: str(a, "path1") } : {}), ...(str(a, "path2") ? { Path2: str(a, "path2") } : {}), Status: "Active" }
            : {
                Type: "ResponsiveAd",
                FinalUrls: [str(a, "finalUrl")],
                BusinessName: str(a, "businessName"),
                Headlines: textLinks(pinned(a, "headlines")),
                LongHeadlines: textLinks(pinned(a, "longHeadlines")),
                Descriptions: textLinks(pinned(a, "descriptions")),
                Images: [...(await imageLinks(api, accountId, mediaOf(a, "landscapeImages", assets), "LandscapeImageMedia")), ...(await imageLinks(api, accountId, mediaOf(a, "squareImages", assets), "SquareImageMedia"))],
                Status: "Active",
              };
        const adRes = await api.call<{ AdIds?: number[] } & Row>("/Ads", { AdGroupId: Number(groupId), Ads: [body] });
        check(adRes, `Ad “${str(a, "name")}”`);
        structure.ads.push({ externalId: String(adRes.AdIds?.[0] ?? ""), adGroupExternalId: groupId, campaignExternalId: campaignId, name: str(a, "name") || "Ad", status: "ACTIVE", headline: texts(a, "headlines")[0] ?? null, body: texts(a, "descriptions")[0] ?? null, thumbnailUrl: null, finalUrl: str(a, "finalUrl") || null, raw: {}, sourceKey: ad.key });

        // Extensions are account-level objects associated with the ad group.
        const extensions: Row[] = [
          ...repeater(a, "sitelinks").filter((s) => str(s, "text") && str(s, "url")).map((s) => ({ Type: "SitelinkAdExtension", DisplayText: str(s, "text"), Description1: str(s, "description1") || null, Description2: str(s, "description2") || null, FinalUrls: [str(s, "url")] })),
          ...texts(a, "callouts").map((t) => ({ Type: "CalloutAdExtension", Text: t })),
          ...(str(a, "snippetHeader") && texts(a, "snippetValues").length >= 3 ? [{ Type: "StructuredSnippetAdExtension", Header: str(a, "snippetHeader"), Values: texts(a, "snippetValues") }] : []),
          ...(str(a, "phone") ? [{ Type: "CallAdExtension", PhoneNumber: str(a, "phone").replace(/[^\d+]/g, ""), CountryCode: (included(c, "locations").find((l) => (l.type ?? "country") === "country")?.id ?? "IN").toUpperCase() }] : []),
        ];
        if (extensions.length) {
          try {
            const ext = await api.call<{ AdExtensionIdentities?: { Id: number }[] } & Row>("/AdExtensions", { AccountId: Number(accountId), AdExtensions: extensions });
            check(ext, "Extensions");
            const ids = (ext.AdExtensionIdentities ?? []).map((x) => x.Id).filter(Boolean);
            check(await api.call("/AdExtensionsAssociations/Set", { AccountId: Number(accountId), AssociationType: "AdGroup", AdExtensionIdToEntityIdAssociations: ids.map((id) => ({ AdExtensionId: id, EntityId: Number(groupId) })) }), "Extension links");
          } catch (err) {
            warnings.push(`Sitelinks, callouts or other extensions weren't attached to “${str(v, "name")}”: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
    return structure;
  } catch (err) {
    await api.call("/Campaigns", { AccountId: Number(accountId), CampaignIds: [Number(campaignId)] }, "DELETE").catch(() => undefined);
    throw err;
  }
}
