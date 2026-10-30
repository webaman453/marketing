/**
 * LinkedIn campaign creation from a builder draft (Marketing API, versioned
 * REST): campaign group → campaigns → media → creatives (inline dark posts).
 */
import { LINKEDIN_JOB_FUNCTIONS, countryName, type BuilderDraft, type BuilderOptions, type TargetingKind, type TargetingSearchResult, type TargetingValue } from "@ashniva/shared";
import { bool, budgetOf, builderZone, dayIn, excluded, included, instantOf, mediaOf, num, repeater, str, strs, withParams } from "../builder-values";
import { ConnectorError } from "../errors";
import type { AccountStructure, BuilderAsset } from "../types";

type Row = Record<string, any>;

export interface LinkedInApi {
  get<T>(pathAndQuery: string): Promise<T>;
  /** POST that returns the new entity's id from the x-restli-id header (or the body). */
  create(pathAndQuery: string, body: unknown): Promise<string>;
  post<T>(pathAndQuery: string, body: unknown): Promise<T>;
  /** JSON PUT to a versioned REST path (e.g. a campaignConversions association). */
  putJson(pathAndQuery: string, body: unknown): Promise<void>;
  /** The signed-in member from OpenID userinfo (/v2/userinfo). */
  userinfo(): Promise<{ sub?: string; name?: string }>;
  put(url: string, data: Buffer, contentType: string): Promise<string | null>;
  /** Rest.li partial update ($set). */
  patch(pathAndQuery: string, set: Record<string, unknown>): Promise<void>;
}

const enc = encodeURIComponent;
const urnId = (urn: string) => urn.split(":").pop()!;

export async function linkedinBuilderOptions(api: LinkedInApi, accountId: string): Promise<BuilderOptions> {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [acls, conversions, forms, me] = await Promise.all([
    safe(api.get<{ elements?: Row[] }>(`/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`), { elements: [] }),
    safe(api.get<{ elements?: Row[] }>(`/conversions?q=account&account=${enc(`urn:li:sponsoredAccount:${accountId}`)}`), { elements: [] }),
    safe(api.get<{ elements?: Row[] }>(`/leadForms?q=owner&owner=(sponsoredAccount:${enc(`urn:li:sponsoredAccount:${accountId}`)})`), { elements: [] }),
    safe(api.userinfo(), {} as { sub?: string; name?: string }),
  ]);
  const orgUrns = (acls.elements ?? []).map((a) => String(a.organization ?? a.organizationTarget ?? "")).filter(Boolean);
  const orgs = await Promise.all(
    orgUrns.slice(0, 20).map(async (urn) => {
      const org = await safe(api.get<{ localizedName?: string }>(`/organizations/${urnId(urn)}`), {} as { localizedName?: string });
      return { id: urn, name: org.localizedName ?? urn };
    }),
  );
  return {
    organizations: orgs,
    conversionActions: (conversions.elements ?? []).map((c) => ({ id: String(c.id), name: c.name ?? String(c.id), detail: c.type })),
    leadForms: (forms.elements ?? []).map((f) => ({ id: `urn:li:adForm:${f.id}`, name: f.name ?? String(f.id) })),
    profiles: me.sub ? [{ id: `urn:li:person:${me.sub}`, name: me.name ?? "You" }] : [],
  };
}

const FACET: Partial<Record<TargetingKind, string>> = {
  location: "locations",
  jobTitle: "titles",
  industry: "industries",
  skill: "skills",
  company: "employers",
};

export async function linkedinSearchTargeting(api: LinkedInApi, kind: TargetingKind, query: string): Promise<TargetingSearchResult[]> {
  const facet = FACET[kind];
  if (!facet || !query.trim()) return [];
  const res = await api.get<{ elements?: Row[] }>(`/adTargetingEntities?q=typeahead&facet=${enc(`urn:li:adTargetingFacet:${facet}`)}&query=${enc(query.trim())}`);
  return (res.elements ?? []).slice(0, 25).map((e) => ({ id: String(e.urn), name: String(e.name), type: kind === "location" ? "region" : undefined }));
}

/** Country ISO codes → LinkedIn geo URNs via typeahead on the country name. */
async function geoUrns(api: LinkedInApi, list: TargetingValue[]) {
  const out: string[] = [];
  for (const l of list) {
    if (l.id.startsWith("urn:li:")) {
      out.push(l.id);
      continue;
    }
    const name = countryName(l.id);
    const hits = await linkedinSearchTargeting(api, "location", name);
    const hit = hits.find((h) => h.name.toLowerCase() === name.toLowerCase()) ?? hits[0];
    if (!hit) throw new ConnectorError("INVALID_REQUEST", `LinkedIn can't target ${name}.`);
    out.push(hit.id);
  }
  return out;
}

const facet = (name: string, values: string[]) => (values.length ? [{ or: { [`urn:li:adTargetingFacet:${name}`]: values } }] : []);

async function targetingCriteria(api: LinkedInApi, v: Record<string, unknown>) {
  const and = [
    ...facet("locations", await geoUrns(api, included(v, "locations"))),
    ...facet("interfaceLocales", [`urn:li:locale:${str(v, "locale") || "en_US"}`]),
    ...facet("titles", included(v, "jobTitles").map((t) => t.id)),
    ...facet("jobFunctions", strs(v, "jobFunctions").map((f) => LINKEDIN_JOB_FUNCTIONS.indexOf(f) + 1).filter((n) => n > 0).map((n) => `urn:li:function:${n}`)),
    ...facet("seniorities", strs(v, "seniorities").map((s) => `urn:li:seniority:${s}`)),
    ...facet("industries", included(v, "industries").map((t) => t.id)),
    ...facet("staffCountRanges", strs(v, "companySizes").map((s) => `urn:li:staffCountRange:${s}`)),
    ...facet("employers", included(v, "companies").map((t) => t.id)),
    ...facet("skills", included(v, "skills").map((t) => t.id)),
    ...facet("ageRanges", strs(v, "ageRanges").map((s) => `urn:li:ageRange:${s}`)),
    ...(str(v, "genders") && str(v, "genders") !== "ALL" ? facet("genders", [`urn:li:gender:${str(v, "genders")}`]) : []),
  ];
  const ex = await geoUrns(api, excluded(v, "locations"));
  return { include: { and }, ...(ex.length ? { exclude: { or: { "urn:li:adTargetingFacet:locations": ex } } } : {}) };
}

const money = (amount: number, currency: string) => ({ amount: amount.toFixed(2), currencyCode: currency });

function bidding(v: Record<string, unknown>, currency: string, video: boolean) {
  const goal = str(v, "optimizationGoal") || "MAX_CLICK";
  const strategy = str(v, "bidStrategy") || "MAXIMUM_DELIVERY";
  const amount = num(v, "bidAmount") ?? 0;
  if (strategy === "COST_CAP") {
    const cap: Record<string, string> = { MAX_CLICK: "CAP_COST_AND_MAXIMIZE_CLICKS", MAX_IMPRESSION: "CAP_COST_AND_MAXIMIZE_IMPRESSIONS", MAX_VIDEO_VIEW: "CAP_COST_AND_MAXIMIZE_VIDEO_VIEWS", MAX_LEAD: "CAP_COST_AND_MAXIMIZE_LEADS" };
    return { optimizationTargetType: cap[goal] ?? "CAP_COST_AND_MAXIMIZE_CLICKS", costType: "CPM", unitCost: money(amount, currency) };
  }
  if (strategy === "MANUAL") {
    return { optimizationTargetType: "NONE", costType: goal === "MAX_IMPRESSION" || goal === "MAX_REACH" ? "CPM" : video ? "CPV" : "CPC", unitCost: money(amount, currency) };
  }
  return { optimizationTargetType: goal, costType: goal === "MAX_VIDEO_VIEW" ? "CPV" : "CPM" };
}

const FORMAT: Record<string, { type: string; format?: string }> = {
  SINGLE_IMAGE: { type: "SPONSORED_UPDATES", format: "STANDARD_UPDATE" },
  VIDEO: { type: "SPONSORED_UPDATES", format: "SINGLE_VIDEO" },
  CAROUSEL: { type: "SPONSORED_UPDATES", format: "CAROUSEL" },
  TEXT_AD: { type: "TEXT_AD", format: "TEXT_AD" },
};

async function uploadImage(api: LinkedInApi, owner: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("urn:li:image:")) return asset.cachedRef;
  const init = await api.post<{ value: { uploadUrl: string; image: string } }>(`/images?action=initializeUpload`, { initializeUploadRequest: { owner } });
  await api.put(init.value.uploadUrl, await asset.load(), asset.mimeType);
  await asset.onUploaded?.(init.value.image);
  return init.value.image;
}

async function uploadVideo(api: LinkedInApi, owner: string, asset: BuilderAsset) {
  if (asset.cachedRef?.startsWith("urn:li:video:")) return asset.cachedRef;
  const data = await asset.load();
  const init = await api.post<{ value: { video: string; uploadToken?: string; uploadInstructions: { uploadUrl: string; firstByte: number; lastByte: number }[] } }>(`/videos?action=initializeUpload`, {
    initializeUploadRequest: { owner, fileSizeBytes: data.length, uploadCaptions: false, uploadThumbnail: false },
  });
  const etags: string[] = [];
  for (const part of init.value.uploadInstructions) {
    const etag = await api.put(part.uploadUrl, data.subarray(part.firstByte, part.lastByte + 1), "application/octet-stream");
    if (etag) etags.push(etag);
  }
  await api.post(`/videos?action=finalizeUpload`, { finalizeUploadRequest: { video: init.value.video, uploadToken: init.value.uploadToken ?? "", uploadedPartIds: etags } });
  await asset.onUploaded?.(init.value.video);
  return init.value.video;
}

export async function linkedinCreateCampaign(api: LinkedInApi, account: { externalId: string; currency: string; timezone?: string | null }, draft: BuilderDraft, assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
  const acct = account.externalId;
  const accountUrn = `urn:li:sponsoredAccount:${acct}`;
  const c = draft.campaign;
  const status = c.launchStatus === "ACTIVE" ? "ACTIVE" : "PAUSED";
  const objective = String(draft.setup.objective);
  const fmt = FORMAT[String(draft.setup.format)];
  if (!fmt) throw new ConnectorError("UNSUPPORTED", "This LinkedIn ad format can't be published from here yet.");
  // The group's schedule spans its campaigns (LinkedIn needs one on the group too).
  // Dates are days in the ad account's zone: start of the start day, end of the end day.
  const tz = builderZone(account);
  const starts = draft.adGroups.map((g) => instantOf(g.values, "startDate", tz)).filter((d): d is Date => Boolean(d));
  const ends = draft.adGroups.map((g) => instantOf(g.values, "endDate", tz, "end"));
  const start = starts.length ? new Date(Math.min(Date.now(), ...starts.map((d) => d.getTime()))) : new Date();
  const end = ends.every((d) => d) ? new Date(Math.max(...ends.map((d) => d!.getTime()))) : null;

  const groupId = await api.create(`/adAccounts/${acct}/adCampaignGroups`, {
    account: accountUrn,
    name: str(c, "name"),
    status,
    runSchedule: { start: start.getTime(), ...(end ? { end: end.getTime() } : {}) },
    ...(bool(c, "groupBudget") && num(c, "groupBudgetAmount") ? { totalBudget: money(num(c, "groupBudgetAmount")!, account.currency) } : {}),
  });
  const groupUrn = `urn:li:sponsoredCampaignGroup:${groupId}`;
  const structure: AccountStructure = {
    campaigns: [
      { externalId: groupId, name: str(c, "name"), status, deliveryStatus: null, objective, dailyBudget: null, lifetimeBudget: null, startDate: dayIn(start, tz), endDate: end ? dayIn(end, tz) : null, updatedAt: new Date(), raw: {} },
    ],
    adGroups: [],
    ads: [],
  };

  try {
    for (const g of draft.adGroups) {
      const v = g.values;
      const budget = budgetOf(v);
      if (!budget) throw new ConnectorError("INVALID_REQUEST", `Enter a budget for campaign “${str(v, "name")}”.`);
      const gStart = instantOf(v, "startDate", tz) ?? start;
      const gEnd = instantOf(v, "endDate", tz, "end") ?? end;
      const [lang, country] = (str(v, "locale") || "en_US").split("_");
      const campaignId = await api.create(`/adAccounts/${acct}/adCampaigns`, {
        account: accountUrn,
        campaignGroup: groupUrn,
        name: str(v, "name"),
        type: fmt.type,
        ...(fmt.format ? { format: fmt.format } : {}),
        objectiveType: objective,
        locale: { country: country ?? "US", language: lang ?? "en" },
        targetingCriteria: await targetingCriteria(api, v),
        audienceExpansionEnabled: bool(v, "audienceExpansion"),
        offsiteDeliveryEnabled: v.audienceNetwork !== false && fmt.type === "SPONSORED_UPDATES" && objective !== "LEAD_GENERATION" && draft.setup.format !== "CAROUSEL",
        ...(budget.lifetime ? { totalBudget: money(budget.amount, account.currency) } : { dailyBudget: money(budget.amount, account.currency) }),
        runSchedule: { start: gStart.getTime(), ...(gEnd ? { end: gEnd.getTime() } : {}) },
        ...bidding(v, account.currency, draft.setup.format === "VIDEO"),
        creativeSelection: str(v, "rotation") || "OPTIMIZED",
        politicalIntent: str(v, "politicalIntent") || "NOT_POLITICAL",
        status,
      });
      const campaignUrn = `urn:li:sponsoredCampaign:${campaignId}`;
      for (const conv of strs(v, "conversions")) {
        const conversion = `urn:lla:llaPartnerConversion:${conv}`;
        try {
          // conversion-tracking doc: associate with PUT /campaignConversions/(campaign:…,conversion:…).
          await api.putJson(`/campaignConversions/(campaign:${enc(campaignUrn)},conversion:${enc(conversion)})`, { campaign: campaignUrn, conversion });
        } catch (err) {
          (structure.warnings ??= []).push(`Conversion ${conv} couldn't be linked to “${str(v, "name")}”: ${err instanceof Error ? err.message : String(err)}. Link it in Campaign Manager.`);
        }
      }
      structure.adGroups.push({ externalId: campaignId, campaignExternalId: groupId, name: str(v, "name"), status, dailyBudget: budget.lifetime ? null : budget.amount, bidStrategy: str(v, "bidStrategy") || null, targeting: null, raw: {}, sourceKey: g.key });

      for (const ad of g.ads) {
        const a = ad.values;
        const owner = str(a, "organizationId");
        if (!owner) throw new ConnectorError("INVALID_REQUEST", "Choose the LinkedIn Page for each creative.");
        const url = withParams(str(a, "url"), "");
        const intended = status === "ACTIVE" ? "ACTIVE" : "PAUSED";
        let creativeId: string;
        if (draft.setup.format === "TEXT_AD") {
          const [img] = mediaOf(a, "textImage", assets);
          creativeId = await api.create(`/adAccounts/${acct}/creatives`, {
            campaign: campaignUrn,
            intendedStatus: intended,
            name: str(a, "name"),
            content: { textAd: { headline: str(a, "textHeadline"), description: str(a, "textDescription"), landingPage: url, ...(img ? { image: await uploadImage(api, owner, img) } : {}) } },
          });
        } else {
          let content: Record<string, unknown>;
          if (draft.setup.format === "CAROUSEL") {
            const cards = [];
            for (const card of repeater(a, "cards")) {
              const [img] = mediaOf(card, "image", assets);
              if (!img) throw new ConnectorError("INVALID_REQUEST", "Every carousel card needs an image.");
              cards.push({ media: { id: await uploadImage(api, owner, img), title: str(card, "headline") }, landingPage: str(card, "url") });
            }
            content = { carousel: { cards } };
          } else {
            const [media] = mediaOf(a, draft.setup.format === "VIDEO" ? "video" : "image", assets);
            if (!media) throw new ConnectorError("INVALID_REQUEST", "Each creative needs an image or video.");
            const id = media.type === "VIDEO" ? await uploadVideo(api, owner, media) : await uploadImage(api, owner, media);
            content = { media: { id, title: str(a, "headline") } };
          }
          const leadForm = objective === "LEAD_GENERATION" ? str(a, "leadFormId") : "";
          creativeId = await api.create(`/adAccounts/${acct}/creatives?action=createInline`, {
            creative: {
              campaign: campaignUrn,
              intendedStatus: intended,
              name: str(a, "name"),
              inlineContent: {
                post: {
                  author: owner,
                  commentary: str(a, "introText"),
                  visibility: "PUBLIC",
                  lifecycleState: "PUBLISHED",
                  isReshareDisabledByAuthor: false,
                  distribution: { feedDistribution: "NONE", targetEntities: [], thirdPartyDistributionChannels: [] },
                  adContext: { dscAdAccount: accountUrn, dscStatus: "ACTIVE", dscName: str(a, "name") },
                  content,
                  ...(url && !leadForm ? { contentLandingPage: url, contentCallToActionLabel: str(a, "cta") || "LEARN_MORE" } : {}),
                },
              },
              ...(leadForm ? { leadgenCallToAction: { destination: leadForm, label: str(a, "cta") || "LEARN_MORE" } } : {}),
            },
          });
        }
        structure.ads.push({
          externalId: urnId(creativeId),
          adGroupExternalId: campaignId,
          campaignExternalId: groupId,
          name: str(a, "name"),
          status,
          headline: str(a, "headline") || str(a, "textHeadline") || null,
          body: str(a, "introText") || str(a, "textDescription") || null,
          thumbnailUrl: null,
          finalUrl: url || null,
          raw: {},
          sourceKey: ad.key,
        });
      }
    }
    return structure;
  } catch (err) {
    // Archive what was made so nothing half-built can deliver.
    await api.patch(`/adAccounts/${acct}/adCampaignGroups/${groupId}`, { status: "ARCHIVED" }).catch(() => undefined);
    throw err;
  }
}
