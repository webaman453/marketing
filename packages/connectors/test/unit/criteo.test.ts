import { afterEach, describe, expect, it, vi } from "vitest";
import { CriteoConnector } from "../../src/criteo";
import { fail, hits, http, HttpResponse, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import {
  CR,
  CRITEO_TOKEN,
  crAdSet,
  crAdSetSearch,
  crAdvertiser,
  crAdvertisersMe,
  crLegacyCreate,
  crLegacyPatch,
  crStartStop,
  crToken,
} from "../msw/handlers/criteo";

useMswServer();
afterEach(() => vi.useRealTimers());

const operator = () => new CriteoConnector({ clientId: "op-id", clientSecret: "op-secret" });
const keys = { clientId: "cust-id", clientSecret: "cust-secret" };
const customer = auth("cr-access", keys);
const acct = account("adv1");

describe("Criteo tokens", () => {
  it("getAuthUrl returns to our callback with code=client_credentials; unconfigured throws", () => {
    expect(queryOf(operator().getAuthUrl({ state: STATE, redirectUri: REDIRECT }))).toEqual({ code: "client_credentials", state: STATE });
    expect(() => new CriteoConnector({ clientId: "x" }).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
  });

  it("exchangeCode runs client credentials with the operator's keys and computes expiresAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(crToken());
    const t = await operator().exchangeCode({ code: "client_credentials", redirectUri: REDIRECT });
    expect(t).toMatchObject({ accessToken: "cr-access", refreshToken: "client_credentials" });
    expect(t.expiresAt!.getTime()).toBe(NOW.getTime() + 900_000);
    expect(Object.fromEntries((await hits())[0]!.form!)).toEqual({ grant_type: "client_credentials", client_id: "op-id", client_secret: "op-secret" });
  });

  it("connectWithCredentials and refreshTokens(rt, credentials) use the connection's own keys, even with no operator keys", async () => {
    server.use(crToken());
    const c = new CriteoConnector({});
    await c.connectWithCredentials({ clientId: " cust-id ", clientSecret: " cust-secret " });
    const r = await c.refreshTokens("client_credentials", keys);
    expect(r.refreshToken).toBe("client_credentials");
    expect((await hits()).map((h) => [h.form!.get("client_id"), h.form!.get("client_secret")])).toEqual([["cust-id", "cust-secret"], ["cust-id", "cust-secret"]]);
  });

  it("refreshTokens without credentials uses the operator's keys, and needs them", async () => {
    server.use(crToken());
    await operator().refreshTokens("x", null);
    expect((await hits())[0]!.form!.get("client_id")).toBe("op-id");
    await expect(new CriteoConnector({}).refreshTokens("x", null)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("missing keys fail before any request; rejected keys map to AUTH_EXPIRED with Criteo's message", async () => {
    await expect(operator().connectWithCredentials({ clientSecret: "s" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Client ID") });
    expect(await hits()).toHaveLength(0);
    server.use(http.post(CRITEO_TOKEN, () => fail(401, { error: "invalid_client", error_description: "Unknown client" })));
    await expect(operator().connectWithCredentials(keys)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "Unknown client" });
  });
});

describe("Criteo accounts", () => {
  it("lists advertisers with the bearer token", async () => {
    server.use(crAdvertisersMe([crAdvertiser("a1", { currency: "EUR" }), crAdvertiser("a2", { advertiserName: undefined, name: "Named" })]));
    expect(await operator().listAdAccounts(customer)).toEqual([
      { externalId: "a1", name: "Advertiser a1", currency: "EUR", timezone: null, status: "ACTIVE" },
      { externalId: "a2", name: "Named", currency: "USD", timezone: null, status: "ACTIVE" },
    ]);
    expect((await hits())[0]!.headers.get("authorization")).toBe("Bearer cr-access");
  });

  it("getUser is the first advertiser", async () => {
    server.use(crAdvertisersMe([{ id: 7, attributes: { name: "Seven" } }]));
    expect(await operator().getUser(customer)).toEqual({ id: "7", name: "Seven" });
  });

  it.each(STATUS_CODES)("maps HTTP %i on the advertiser list to %s", async (status, code) => {
    server.use(http.get(`${CR}/advertisers/me`, () => fail(status, { errors: [{ message: "nope" }] })));
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code, message: "nope" });
  });

  // Criteo documents the portfolio as GET /{version}/advertisers/me (GET /advertisers is not an endpoint).
  it("lists the advertiser portfolio from the documented GET /advertisers/me", async () => {
    server.use(crAdvertisersMe([crAdvertiser("a1")]), http.get(`${CR}/advertisers`, () => fail(404, { errors: [{ message: "Not found" }] })));
    expect(await operator().listAdAccounts(customer)).toHaveLength(1);
  });
});

describe("Criteo structure", () => {
  it("groups ad sets into campaigns and keeps their ids for later actions", async () => {
    server.use(crAdSetSearch([crAdSet("s1", "c1"), crAdSet("s2", "c1", { status: "PAUSED", budget: { amount: 12.5 } }), crAdSet("s3", "c2", { status: "ARCHIVED", campaignName: "Brand" })]));
    const s = await operator().fetchStructure(customer, acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.raw])).toEqual([
      ["c1", "ACTIVE", { adSetIds: ["s1", "s2"] }],
      ["c2", "ARCHIVED", { adSetIds: ["s3"] }],
    ]);
    expect(s.campaigns[1]!.name).toBe("Brand");
    expect(s.adGroups.map((g) => [g.externalId, g.campaignExternalId, g.status, g.dailyBudget, g.bidStrategy])).toEqual([
      ["s1", "c1", "ACTIVE", 30, "CPC"],
      ["s2", "c1", "PAUSED", 12.5, "CPC"],
      ["s3", "c2", "ARCHIVED", 30, "CPC"],
    ]);
    expect(s.ads).toEqual([]);
  });

  it("propagates an ad set list error", async () => {
    server.use(http.post(`${CR}/marketing-solutions/ad-sets/search`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  // Criteo documents ad set listing as POST /marketing-solutions/ad-sets/search, filtered by advertiser.
  it("lists ad sets with the documented POST /marketing-solutions/ad-sets/search", async () => {
    server.use(crAdSetSearch([crAdSet("s1", "c1")]), http.get(`${CR}/advertisers/adv1/ad-sets`, () => fail(404)));
    expect((await operator().fetchStructure(customer, acct)).adGroups).toHaveLength(1);
  });

  it("fetchMetrics reports nothing yet", async () => {
    expect(await operator().fetchMetrics()).toEqual([]);
  });
});

describe("Criteo actions", () => {
  it("pauses every ad set of the campaign from its synced ids", async () => {
    server.use(...crStartStop());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1", raw: { adSetIds: ["s1", "s2"] } }, "PAUSED");
    expect((await hits({ method: "POST" })).map((h) => [h.url.pathname, h.json])).toEqual([
      ["/2025-10/marketing-solutions/ad-sets/stop", { data: [{ type: "AdSetId", id: "s1" }, { type: "AdSetId", id: "s2" }] }],
    ]);
  });

  it("looks the ad sets up when the campaign has none on record", async () => {
    server.use(crAdSetSearch([crAdSet("s1", "c1"), crAdSet("s9", "other")]), ...crStartStop());
    await operator().setCampaignStatus(customer, acct, { externalId: "c1", raw: {} }, "ACTIVE");
    const search = await hits({ path: "/ad-sets/search" });
    expect(search.map((h) => h.json)).toEqual([{ filters: { advertiserIds: ["adv1"] } }]);
    expect((await hits({ path: "/ad-sets/start" })).map((h) => h.json)).toEqual([{ data: [{ type: "AdSetId", id: "s1" }] }]);
  });

  it("a per-id error in the start/stop reply fails the status change", async () => {
    server.use(http.post(`${CR}/marketing-solutions/ad-sets/stop`, () => HttpResponse.json({ data: [], errors: [{ title: "Ad set not found", detail: "Ad set s1 not found" }] })));
    await expect(operator().setCampaignStatus(customer, acct, { externalId: "c1", raw: { adSetIds: ["s1"] } }, "PAUSED")).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "Ad set s1 not found" });
  });

  it("refuses when no ad set belongs to the campaign", async () => {
    server.use(crAdSetSearch([]));
    await expect(operator().setCampaignStatus(customer, acct, { externalId: "c1" }, "PAUSED")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("splits a daily budget evenly across the ad sets, rounded down to cents", async () => {
    server.use(crLegacyPatch());
    await operator().setCampaignDailyBudget(customer, acct, { externalId: "c1", raw: { adSetIds: ["s1", "s2", "s3"] } }, 100);
    expect((await hits({ method: "PATCH" })).map((h) => h.json.data.attributes.budget)).toEqual(Array(3).fill({ amount: 33.33, type: "DAILY" }));
  });

  // Criteo documents status changes as POST /marketing-solutions/ad-sets/stop|start.
  it("pauses ad sets through the documented POST /marketing-solutions/ad-sets/stop", async () => {
    server.use(...crStartStop(), http.patch(`${CR}/ad-sets/:id`, () => fail(404)));
    await operator().setCampaignStatus(customer, acct, { externalId: "c1", raw: { adSetIds: ["s1"] } }, "PAUSED");
    expect((await hits({ path: "/marketing-solutions/ad-sets/stop" }))[0]!.json).toEqual({ data: [{ type: "AdSetId", id: "s1" }] });
  });
});

describe("Criteo createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("CRITEO", { goal: "RETARGETING" }, { ...over, campaign: { budget: 45, locations: [{ id: "fr", name: "France", type: "country" }], ...over.campaign }, ad: { imageUrl: "https://cdn.example.com/b.jpg", ...over.ad } });

  it("creates one paused ad set with the daily budget and its ads", async () => {
    server.use(...crLegacyCreate());
    const d = draft();
    const made = await operator().createCampaign(customer, acct, d, new Map());
    const set = (await hits({ method: "POST", path: "/advertisers/adv1/ad-sets" }))[0]!.json;
    expect(set).toEqual({ data: { type: "AdSet", attributes: { name: "Festive Sale", status: "PAUSED", goal: "RETARGETING", budget: { amount: 45, type: "DAILY" }, geo: ["FR"] } } });
    const ad = (await hits({ method: "POST", path: "/ad-sets/set1/ads" }))[0]!.json;
    expect(ad.data).toMatchObject({ type: "Ad", attributes: { format: "DISPLAY", clickUrl: "https://shop.example.com/festive", imageUrl: "https://cdn.example.com/b.jpg" } });
    expect(made.campaigns[0]).toMatchObject({ externalId: "cmp-9", status: "PAUSED", dailyBudget: 45, raw: { adSetIds: ["set1"] } });
    expect(made.adGroups[0]).toMatchObject({ externalId: "set1", sourceKey: d.adGroups[0]!.key });
    expect(made.ads[0]).toMatchObject({ adGroupExternalId: "set1", sourceKey: d.adGroups[0]!.ads[0]!.key });
  });

  it("falls back to the ad set id when Criteo returns no campaign id", async () => {
    server.use(...crLegacyCreate(null));
    expect((await operator().createCampaign(customer, acct, draft(), new Map())).campaigns[0]!.externalId).toBe("set1");
  });

  it("rejects more than one ad set before creating anything", async () => {
    await expect(operator().createCampaign(customer, acct, draft({ groups: 2 }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("fails when the ad set comes back without an id", async () => {
    server.use(http.post(`${CR}/advertisers/adv1/ad-sets`, () => HttpResponse.json({ data: {} })));
    await expect(operator().createCampaign(customer, acct, draft(), new Map())).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("stops the new ad set when an ad fails after an ACTIVE launch", async () => {
    server.use(http.post(`${CR}/ad-sets/:id/ads`, () => fail(400, { errors: [{ message: "Bad creative" }] })), ...crLegacyCreate(), crLegacyPatch(), ...crStartStop());
    await expect(operator().createCampaign(customer, acct, draft({ campaign: { launchStatus: "ACTIVE" } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const paused = (await hits()).filter((h) => h.url.pathname.endsWith("/ad-sets/stop") || (h.method === "PATCH" && h.json?.data?.attributes?.status === "PAUSED"));
    expect(paused.length).toBeGreaterThan(0);
  });
});
