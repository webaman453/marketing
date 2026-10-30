/**
 * Meta campaign builder (src/meta/builder.ts): builder options, targeting search and
 * createCampaign from a real BUILDER_SPECS draft — request bodies, paused default,
 * budgets in minor units, and rollback when a later step fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuilderDraft } from "@ashniva/shared";
import { MetaConnector } from "../../src/meta";
import type { ConnectorError } from "../../src/errors";
import { hits, http, HttpResponse, onlyHit, server, useMswServer, type Hit } from "../msw/server";
import { account, auth } from "../msw/fixtures";
import { assetsOf, imageAsset, makeDraft, setMedia, videoAsset } from "../msw/drafts";
import { GRAPH, metaConfig, metaCreateHandlers, metaError } from "../msw/handlers/meta";

useMswServer();

const meta = () => new MetaConnector(metaConfig);
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as ConnectorError);
const ACT = account("42", { currency: "USD", timezone: "America/Los_Angeles" });
const form = (h: Hit) => Object.fromEntries(h.form!);
const parsed = (h: Hit, key: string) => JSON.parse(h.form!.get(key)!);

/** A Traffic → Website draft with one ad set and one single-image ad, as the builder makes it. */
function trafficDraft(over: Parameters<typeof makeDraft>[2] = {}): BuilderDraft {
  const draft = makeDraft("META", { objective: "OUTCOME_TRAFFIC" }, {
    ...over,
    adGroup: { locations: [{ id: "IN", name: "India", type: "country" }], ...over.adGroup },
    ad: {
      pageId: "page-1",
      instagramId: "ig-1",
      url: "https://shop.example.com/festive",
      primaryTexts: ["Festive silk sarees, handwoven."],
      headlines: ["Shop the edit"],
      descriptions: ["Free shipping"],
      cta: "SHOP_NOW",
      ...over.ad,
    },
  });
  setMedia(draft, "media", ["img-1"]);
  return draft;
}

const origTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = origTz;
  if (origTz === undefined) delete process.env.TZ;
});

describe("Meta getBuilderOptions", () => {
  it("loads pages, Instagram accounts, pixels, apps, audiences and each Page's lead forms", async () => {
    server.use(
      // Edges: https://developers.facebook.com/docs/marketing-api/reference/ad-account/ (promote_pages,
      // instagram_accounts, adspixels, advertisable_applications, customaudiences)
      http.get(`${GRAPH}/act_42/promote_pages`, () => HttpResponse.json({ data: [{ id: "page-1", name: "Zari" }] })),
      http.get(`${GRAPH}/act_42/instagram_accounts`, () => HttpResponse.json({ data: [{ id: "ig-1", username: "zari.studio" }] })),
      http.get(`${GRAPH}/act_42/adspixels`, () => metaError(403, 200, "No pixel access")),
      http.get(`${GRAPH}/act_42/advertisable_applications`, () => HttpResponse.json({ data: [{ id: "app-1", name: "Zari App", object_store_urls: { google_play: "https://play.google.com/store/apps/details?id=zari" } }] })),
      http.get(`${GRAPH}/act_42/customaudiences`, () => HttpResponse.json({ data: [{ id: "aud-1", name: "Buyers", subtype: "CUSTOM", approximate_count_lower_bound: 12000 }] })),
      // https://developers.facebook.com/docs/graph-api/reference/page/leadgen_forms/
      http.get(`${GRAPH}/page-1/leadgen_forms`, () => HttpResponse.json({ data: [{ id: "form-1", name: "Festive form" }] })),
    );
    const o = await meta().getBuilderOptions(auth(), ACT);
    expect(o.pages).toEqual([{ id: "page-1", name: "Zari" }]);
    expect(o.instagramAccounts).toEqual([{ id: "ig-1", name: "@zari.studio" }]);
    expect(o.pixels).toEqual([]); // a failing edge gives an empty list, not a failed form
    expect(o.apps).toEqual([{ id: "app-1|https://play.google.com/store/apps/details?id=zari", name: "Zari App", detail: "https://play.google.com/store/apps/details?id=zari" }]);
    expect(o.audiences?.[0]).toMatchObject({ id: "aud-1", name: "Buyers" });
    expect(o.audiences?.[0]!.detail).toContain("CUSTOM");
    expect(o.leadForms).toEqual([{ id: "form-1", name: "Festive form", detail: "Zari" }]);
  });
});

describe("Meta searchTargeting", () => {
  // https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search/
  it("searches locations with adgeolocation and uses the country code as a country's id", async () => {
    server.use(
      http.get(`${GRAPH}/search`, () =>
        HttpResponse.json({
          data: [
            { key: "IN", name: "India", type: "country", country_code: "IN" },
            { key: "1035921", name: "Mumbai", type: "city", country_code: "IN", country_name: "India", region: "Maharashtra" },
          ],
        }),
      ),
    );
    const res = await meta().searchTargeting(auth("tok"), ACT, "location", "mum");
    expect(res[0]).toMatchObject({ id: "IN", type: "country", detail: "Country" });
    expect(res[1]).toMatchObject({ id: "1035921", type: "city", countryCode: "IN", detail: "City · Maharashtra · India" });
    const q = (await onlyHit({ path: "/search" })).url.searchParams;
    expect(q.get("type")).toBe("adgeolocation");
    expect(q.get("q")).toBe("mum");
    expect(JSON.parse(q.get("location_types")!)).toEqual(["country", "region", "city"]);
  });

  it("searches interests with adinterest", async () => {
    server.use(http.get(`${GRAPH}/search`, () => HttpResponse.json({ data: [{ id: "6003", name: "Sarees", audience_size_lower_bound: 5000, path: ["Shopping", "Clothing", "Sarees"] }] })));
    const [r] = await meta().searchTargeting(auth(), ACT, "interest", "saree");
    expect(r).toMatchObject({ id: "6003", name: "Sarees", type: "interests" });
    expect(r!.detail).toContain("Shopping › Clothing");
    expect((await onlyHit({ path: "/search" })).url.searchParams.get("type")).toBe("adinterest");
  });

  it("returns nothing without a query or for kinds Meta does not search", async () => {
    expect(await meta().searchTargeting(auth(), ACT, "interest", "  ")).toEqual([]);
    expect(await meta().searchTargeting(auth(), ACT, "jobTitle", "designer")).toEqual([]);
    expect(await hits()).toHaveLength(0);
  });
});

describe("Meta createCampaign", () => {
  it("creates a paused campaign → ad set → image → creative → ad from a realistic draft", async () => {
    server.use(...metaCreateHandlers());
    const uploaded = vi.fn(async () => undefined);
    const draft = trafficDraft();
    const result = await meta().createCampaign(auth("tok"), ACT, draft, assetsOf(imageAsset("img-1", { onUploaded: uploaded })));

    // Campaign (CBO by default, so the budget is on the campaign, in cents)
    const c = await onlyHit({ method: "POST", path: "/act_42/campaigns" });
    expect(form(c)).toMatchObject({
      access_token: "tok",
      name: "Festive Sale",
      objective: "OUTCOME_TRAFFIC",
      status: "PAUSED",
      buying_type: "AUCTION",
      special_ad_categories: "[]",
      daily_budget: "2500",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    });
    expect(c.form!.has("is_adset_budget_sharing_enabled")).toBe(false);

    // Ad set: paused, no own budget under CBO, website destination, targeting as JSON
    const s = await onlyHit({ method: "POST", path: "/act_42/adsets" });
    const set = form(s);
    expect(set).toMatchObject({ campaign_id: "cmp-1", status: "PAUSED", destination_type: "WEBSITE" });
    expect(set.daily_budget).toBeUndefined();
    expect(set.lifetime_budget).toBeUndefined();
    expect(set.bid_strategy).toBeUndefined();
    expect(set.optimization_goal).toBeTruthy();
    expect(set.billing_event).toBe(set.optimization_goal === "LINK_CLICKS" ? "LINK_CLICKS" : "IMPRESSIONS");
    expect(parsed(s, "targeting").geo_locations).toEqual({ countries: ["IN"] });
    expect(parsed(s, "promoted_object")).toEqual({ page_id: "page-1" });
    expect(new Date(set.start_time!).toString()).not.toBe("Invalid Date");
    expect(set).not.toHaveProperty("end_time");
    for (const v of Object.values(set)) expect(v).not.toMatch(/^(undefined|null)$/);

    // Image upload by bytes, then cached
    const img = await onlyHit({ method: "POST", path: "/act_42/adimages" });
    expect(Buffer.from(img.form!.get("bytes")!, "base64").toString()).toBe("fake-jpeg-bytes");
    expect(uploaded).toHaveBeenCalledWith("img:hash-abc");

    // Creative: single image link ad
    const cr = await onlyHit({ method: "POST", path: "/act_42/adcreatives" });
    const story = parsed(cr, "object_story_spec");
    expect(story).toMatchObject({
      page_id: "page-1",
      instagram_user_id: "ig-1",
      link_data: {
        link: "https://shop.example.com/festive",
        message: "Festive silk sarees, handwoven.",
        name: "Shop the edit",
        description: "Free shipping",
        image_hash: "hash-abc",
        call_to_action: { type: "SHOP_NOW", value: { link: "https://shop.example.com/festive" } },
      },
    });
    expect(cr.form!.has("asset_feed_spec")).toBe(false);

    // Ad
    const ad = await onlyHit({ method: "POST", path: /\/act_42\/ads$/ });
    expect(form(ad)).toMatchObject({ adset_id: "set-2", status: "PAUSED" });
    expect(parsed(ad, "creative")).toEqual({ creative_id: "cre-3" });

    expect(await hits({ method: "DELETE" })).toHaveLength(0);

    // Returned structure mirrors what was created and carries draft keys
    expect(result.campaigns[0]).toMatchObject({ externalId: "cmp-1", status: "PAUSED", deliveryStatus: "PAUSED", dailyBudget: 25, lifetimeBudget: null, raw: { daily_budget: "2500" } });
    expect(result.adGroups[0]).toMatchObject({ externalId: "set-2", campaignExternalId: "cmp-1", sourceKey: draft.adGroups[0]!.key, dailyBudget: null });
    expect(result.ads[0]).toMatchObject({ externalId: "ad-4", adGroupExternalId: "set-2", headline: "Shop the edit", body: "Festive silk sarees, handwoven.", finalUrl: "https://shop.example.com/festive", raw: { creative_id: "cre-3" }, sourceKey: draft.adGroups[0]!.ads[0]!.key });
  });

  it("starts delivering only when the draft asks for ACTIVE", async () => {
    server.use(...metaCreateHandlers());
    const res = await meta().createCampaign(auth(), ACT, trafficDraft({ campaign: { launchStatus: "ACTIVE" } }), assetsOf(imageAsset("img-1")));
    for (const path of ["/act_42/campaigns", "/act_42/adsets", /\/act_42\/ads$/] as const) {
      expect((await onlyHit({ method: "POST", path })).form!.get("status")).toBe("ACTIVE");
    }
    expect(res.campaigns[0]!.deliveryStatus).toBe("IN_PROCESS");
  });

  it("puts ad set budgets (lifetime, zero-decimal JPY) on each ad set when CBO is off", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({ campaign: { cbo: false }, adGroup: { budget: 3000, budgetType: "LIFETIME", startDate: "2026-11-01", endDate: "2026-11-30", bidStrategy: "COST_CAP", bidAmount: 45 }, groups: 2 });
    setMedia(draft, "media", ["img-1"]);
    const res = await meta().createCampaign(auth(), account("42", { currency: "JPY" }), draft, assetsOf(imageAsset("img-1", { cachedRef: "img:cached-hash" })));
    const c = form(await onlyHit({ method: "POST", path: "/act_42/campaigns" }));
    expect(c.is_adset_budget_sharing_enabled).toBe("false");
    expect(c.daily_budget).toBeUndefined();
    const sets = await hits({ method: "POST", path: "/act_42/adsets" });
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect(form(s)).toMatchObject({ lifetime_budget: "3000", bid_strategy: "COST_CAP", bid_amount: "45" });
      expect(s.form!.get("end_time")).toBeTruthy();
    }
    // A cached image hash skips the upload.
    expect(await hits({ path: "/adimages" })).toHaveLength(0);
    expect(parsed((await hits({ path: "/adcreatives" }))[0]!, "object_story_spec").link_data.image_hash).toBe("cached-hash");
    expect(res.adGroups.map((g) => g.dailyBudget)).toEqual([null, null]);
    expect(res.campaigns[0]!.dailyBudget).toBeNull();
  });

  it("sends a daily ad set budget in cents under ABO", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({ campaign: { cbo: false }, adGroup: { budget: 19.99, budgetType: "DAILY" } });
    const res = await meta().createCampaign(auth(), ACT, draft, assetsOf(imageAsset("img-1")));
    expect(form(await onlyHit({ method: "POST", path: "/act_42/adsets" })).daily_budget).toBe("1999");
    expect(res.adGroups[0]!.dailyBudget).toBe(19.99);
  });

  it("maps targeting: excluded places, age, gender, interests, audiences, languages, manual placements, devices", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({
      adGroup: {
        locations: [
          { id: "IN", name: "India", type: "country" },
          { id: "1035921", name: "Mumbai", type: "city" },
          { id: "PK", name: "Pakistan", type: "country", exclude: true },
        ],
        age: { min: 25, max: 44 },
        gender: "FEMALE",
        interests: [{ id: "6003", name: "Sarees" }],
        customAudiences: ["aud-1"],
        excludedAudiences: ["aud-2"],
        languages: ["en"],
        placements: { mode: "MANUAL", items: ["facebook.feed", "instagram.stream"] },
        devices: "mobile",
        advantageAudience: false,
      },
    });
    await meta().createCampaign(auth(), ACT, draft, assetsOf(imageAsset("img-1")));
    const t = parsed(await onlyHit({ method: "POST", path: "/act_42/adsets" }), "targeting");
    expect(t).toEqual({
      geo_locations: { countries: ["IN"], cities: [{ key: "1035921" }] },
      excluded_geo_locations: { countries: ["PK"] },
      age_min: 25,
      age_max: 44,
      genders: [2],
      flexible_spec: [{ interests: [{ id: "6003", name: "Sarees" }] }],
      custom_audiences: [{ id: "aud-1" }],
      excluded_custom_audiences: [{ id: "aud-2" }],
      locales: [1001],
      targeting_automation: { advantage_audience: 0 },
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed"],
      instagram_positions: ["stream"],
      device_platforms: ["mobile"],
    });
  });

  it("uploads a video, waits for its thumbnail and builds a video_data creative", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft();
    setMedia(draft, "media", ["vid-1"]);
    const uploaded = vi.fn(async () => undefined);
    // The multipart upload (a File part + AbortSignal.timeout) aborts with "Premature close" when it
    // goes through the shared recorder's request clone, so this one call is answered by a fetch spy.
    // Response shape: https://developers.facebook.com/docs/marketing-api/reference/ad-account/advideos/#Creating
    const realFetch = globalThis.fetch;
    let sent: { url: string; body: FormData } | null = null;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/act_42/advideos")) {
        sent = { url: String(input), body: init!.body as FormData };
        return Response.json({ id: "vid-99" });
      }
      return realFetch(input, init);
    });
    try {
      await meta().createCampaign(auth("tok"), ACT, draft, assetsOf(videoAsset("vid-1", { onUploaded: uploaded })));
    } finally {
      spy.mockRestore();
    }
    expect(sent!.url).toBe(`${GRAPH}/act_42/advideos`);
    expect(sent!.body.get("access_token")).toBe("tok");
    expect(sent!.body.get("name")).toBe("vid-1.mp4");
    const file = sent!.body.get("source") as File;
    expect(file.type).toBe("video/mp4");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("fake-mp4-bytes");
    expect(uploaded).toHaveBeenCalledWith("vid:vid-99");
    // Thumbnail poll: GET /{video-id}?fields=status,picture
    expect((await onlyHit({ path: "/vid-99" })).url.searchParams.get("fields")).toBe("status,picture");
    const story = parsed(await onlyHit({ path: "/act_42/adcreatives" }), "object_story_spec");
    expect(story.video_data).toMatchObject({ video_id: "vid-99", image_url: "https://scontent.example/vid-99.jpg", title: "Shop the edit" });
    expect(story.link_data).toBeUndefined();
  });

  it("uses asset_feed_spec for several text options", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({ ad: { primaryTexts: ["One", "Two"], headlines: ["H1", "H2"] } });
    await meta().createCampaign(auth(), ACT, draft, assetsOf(imageAsset("img-1")));
    const cr = await onlyHit({ path: "/act_42/adcreatives" });
    const feed = parsed(cr, "asset_feed_spec");
    expect(feed).toMatchObject({ images: [{ hash: "hash-abc" }], bodies: [{ text: "One" }, { text: "Two" }], titles: [{ text: "H1" }, { text: "H2" }], ad_formats: ["SINGLE_IMAGE"], optimization_type: "DEGREES_OF_FREEDOM", call_to_action_types: ["SHOP_NOW"] });
    expect(parsed(cr, "object_story_spec")).toEqual({ page_id: "page-1", instagram_user_id: "ig-1" });
  });

  it("refuses a CBO campaign without a budget before calling Meta", async () => {
    const draft = trafficDraft();
    draft.campaign.budget = 0;
    const err = await errorOf(meta().createCampaign(auth(), ACT, draft, assetsOf(imageAsset("img-1"))));
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(await hits()).toHaveLength(0);
  });

  it("refuses a placement Meta no longer offers before creating anything", async () => {
    const draft = trafficDraft({ adGroup: { placements: { mode: "MANUAL", items: ["facebook.right_hand_column_old"] } } });
    const err = await errorOf(meta().createCampaign(auth(), ACT, draft, assetsOf(imageAsset("img-1"))));
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(err?.message).toContain("facebook.right_hand_column_old");
    expect(await hits()).toHaveLength(0);
  });

  it("deletes the campaign when the ad set is rejected, and rethrows Meta's error", async () => {
    server.use(...metaCreateHandlers({ fail: { adsets: metaError(400, 100, "Invalid targeting spec", 1487079) } }));
    const err = await errorOf(meta().createCampaign(auth("tok"), ACT, trafficDraft(), assetsOf(imageAsset("img-1"))));
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(err?.message).toBe("Invalid targeting spec");
    const del = await onlyHit({ method: "DELETE" });
    expect(del.url.pathname).toBe(new URL(`${GRAPH}/cmp-1`).pathname);
    expect(del.url.searchParams.get("access_token")).toBe("tok");
    expect(await hits({ path: "/adcreatives" })).toHaveLength(0);
  });

  it("deletes the campaign when the creative fails after the ad set was created", async () => {
    server.use(...metaCreateHandlers({ fail: { adcreatives: metaError(400, 100, "Invalid page") } }));
    const err = await errorOf(meta().createCampaign(auth(), ACT, trafficDraft(), assetsOf(imageAsset("img-1"))));
    expect(err?.message).toBe("Invalid page");
    expect((await onlyHit({ method: "DELETE" })).url.pathname).toMatch(/\/cmp-1$/);
  });

  it("rolls back when an ad has no media, with a clear INVALID_REQUEST", async () => {
    server.use(...metaCreateHandlers());
    const draft = trafficDraft();
    const err = await errorOf(meta().createCampaign(auth(), ACT, draft, new Map()));
    expect(err?.code).toBe("INVALID_REQUEST");
    expect(err?.message).toMatch(/image or video/);
    expect(await hits({ method: "DELETE" })).toHaveLength(1);
  });

  it("still surfaces the original error when the rollback delete fails too", async () => {
    server.use(...metaCreateHandlers({ fail: { ads: metaError(500, 2, "Service temporarily unavailable"), delete: metaError(500, 2, "delete failed") } }));
    const err = await errorOf(meta().createCampaign(auth(), ACT, trafficDraft(), assetsOf(imageAsset("img-1"))));
    expect(err?.code).toBe("PLATFORM_ERROR");
    expect(err?.message).toBe("Service temporarily unavailable");
  });

  it("does not create anything when the campaign itself is rejected", async () => {
    server.use(...metaCreateHandlers({ fail: { campaigns: metaError(400, 190, "expired") } }));
    const err = await errorOf(meta().createCampaign(auth(), ACT, trafficDraft(), assetsOf(imageAsset("img-1"))));
    expect(err?.code).toBe("AUTH_EXPIRED");
    expect(await hits({ method: "DELETE" })).toHaveLength(0);
    expect(await hits({ path: "/adsets" })).toHaveLength(0);
  });

  it("ad set start_time follows the ad account's timezone, not the server's — 2026-11-01 for a New York account starts on Nov 1 there", async () => {
    process.env.TZ = "UTC";
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({ adGroup: { startDate: "2026-11-01" } });
    await meta().createCampaign(auth(), account("42", { currency: "USD", timezone: "America/New_York" }), draft, assetsOf(imageAsset("img-1")));
    const start = form(await onlyHit({ method: "POST", path: "/act_42/adsets" })).start_time!;
    const dayInAccount = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(start));
    expect(dayInAccount).toBe("2026-11-01");
  });

  it("reads datetime start/end as wall-clock time in an India account's zone, whatever the server's", async () => {
    process.env.TZ = "UTC";
    server.use(...metaCreateHandlers());
    const draft = trafficDraft({ adGroup: { startDate: "2026-11-01T09:30", endDate: "2026-11-30T18:00" } });
    await meta().createCampaign(auth(), account("42", { currency: "INR", timezone: "Asia/Kolkata" }), draft, assetsOf(imageAsset("img-1")));
    const set = form(await onlyHit({ method: "POST", path: "/act_42/adsets" }));
    expect(set.start_time).toBe("2026-11-01T04:00:00.000Z");
    expect(set.end_time).toBe("2026-11-30T12:30:00.000Z");
  });

  it("falls back to UTC when the account has no timezone", async () => {
    server.use(...metaCreateHandlers());
    await meta().createCampaign(auth(), account("42", { currency: "INR", timezone: null }), trafficDraft({ adGroup: { startDate: "2026-11-01T09:30" } }), assetsOf(imageAsset("img-1")));
    expect(form(await onlyHit({ method: "POST", path: "/act_42/adsets" })).start_time).toBe("2026-11-01T09:30:00.000Z");
  });
});
