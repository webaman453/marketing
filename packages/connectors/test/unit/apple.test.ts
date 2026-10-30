import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppleAdsConnector, appleClientSecret } from "../../src/apple";
import { fail, hits, http, HttpResponse, server, useMswServer } from "../msw/server";
import { account, auth, NOW, queryOf, REDIRECT, STATE, STATUS_CODES } from "../msw/fixtures";
import { makeDraft } from "../msw/drafts";
import { acl, AP, apAd, apAdGroup, apCampaign, apCreate, apList, APPLE_TOKEN, apToken } from "../msw/handlers/apple";

useMswServer();
afterEach(() => vi.useRealTimers());

const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = p256.privateKey.export({ type: "sec1", format: "pem" }).toString();
const keys = { clientId: "SEARCHADS.client-1", teamId: "SEARCHADS.team-1", keyId: "key-1", privateKey: pem };

const operator = () => new AppleAdsConnector({ clientId: "SEARCHADS.op", clientSecret: "op-presigned-jwt" });
const customer = auth("ap-access", keys);
const acct = account("40669820", { currency: "USD" });

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

function checkSecret(secret: string, expected: { clientId: string; teamId: string; keyId: string }, publicKey = p256.publicKey) {
  const [h, p, s] = secret.split(".");
  expect(decode(h!)).toEqual({ alg: "ES256", kid: expected.keyId });
  const payload = decode(p!);
  expect(payload).toMatchObject({ sub: expected.clientId, iss: expected.teamId, aud: "https://appleid.apple.com" });
  expect(payload.exp - payload.iat).toBe(3600);
  // ES256 per RFC 7518: raw r||s (64 bytes), not DER.
  const sig = Buffer.from(s!, "base64url");
  expect(sig).toHaveLength(64);
  expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  return payload;
}

describe("appleClientSecret (ES256)", () => {
  it("signs a JWT Apple can verify with the uploaded public key", () => {
    const payload = checkSecret(appleClientSecret(keys, NOW.getTime()), keys);
    expect(payload.iat).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it("accepts a PEM pasted with literal \\n sequences and a PKCS#8 key", () => {
    checkSecret(appleClientSecret({ ...keys, privateKey: pem.replace(/\n/g, "\\n") }), keys);
    checkSecret(appleClientSecret({ ...keys, privateKey: p256.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }), keys);
  });

  it("rejects garbage, RSA and non-P-256 keys with INVALID_REQUEST", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    for (const privateKey of ["not a key", rsa, p384]) {
      expect(() => appleClientSecret({ ...keys, privateKey })).toThrow(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }
  });
});

describe("Apple tokens", () => {
  it("getAuthUrl returns to our callback with code=client_credentials; unconfigured throws", () => {
    expect(queryOf(operator().getAuthUrl({ state: STATE, redirectUri: REDIRECT }))).toEqual({ code: "client_credentials", state: STATE });
    expect(() => new AppleAdsConnector({}).getAuthUrl({ state: STATE, redirectUri: REDIRECT })).toThrow(/not configured/);
  });

  it("connectWithCredentials signs a fresh client secret from the customer's key and asks for searchadsorg", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    server.use(apToken());
    const t = await new AppleAdsConnector({}).connectWithCredentials({ ...keys, clientId: ` ${keys.clientId} ` });
    expect(t).toMatchObject({ accessToken: "ap-access", refreshToken: "client_credentials" });
    expect(t.expiresAt!.getTime()).toBe(NOW.getTime() + 3600_000);
    const form = (await hits({ path: "/auth/oauth2/token" }))[0]!.form!;
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(keys.clientId);
    expect(form.get("scope")).toBe("searchadsorg");
    checkSecret(form.get("client_secret")!, keys);
  });

  it("refreshTokens(rt, credentials) signs with the connection's key, never the operator's secret", async () => {
    server.use(apToken());
    await operator().refreshTokens("client_credentials", keys);
    const form = (await hits())[0]!.form!;
    expect(form.get("client_id")).toBe(keys.clientId);
    expect(form.get("client_secret")).not.toBe("op-presigned-jwt");
    checkSecret(form.get("client_secret")!, keys);
  });

  it("the operator's own connection uses the configured client id and pre-signed secret", async () => {
    server.use(apToken());
    await operator().exchangeCode({ code: "client_credentials", redirectUri: REDIRECT });
    await operator().refreshTokens("client_credentials", null);
    for (const h of await hits()) {
      expect(h.form!.get("client_id")).toBe("SEARCHADS.op");
      expect(h.form!.get("client_secret")).toBe("op-presigned-jwt");
    }
    await expect(new AppleAdsConnector({}).refreshTokens("x", null)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });

  it("missing fields and bad keys fail before any request", async () => {
    await expect(operator().connectWithCredentials({ ...keys, keyId: "" })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("Key ID") });
    await expect(operator().connectWithCredentials({ ...keys, privateKey: "-----BEGIN nonsense" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("Apple's invalid_client maps to AUTH_EXPIRED", async () => {
    server.use(http.post(APPLE_TOKEN, () => fail(401, { error: "invalid_client" })));
    await expect(operator().connectWithCredentials(keys)).rejects.toMatchObject({ code: "AUTH_EXPIRED", message: "invalid_client" });
  });
});

describe("Apple accounts", () => {
  it("lists every org from /acls without an org context header", async () => {
    server.use(http.get(`${AP}/acls`, () => HttpResponse.json({ data: [acl(1, { currency: "INR", timeZone: "Asia/Kolkata" }), acl(2, { timeZone: undefined })] })));
    expect(await operator().listAdAccounts(customer)).toEqual([
      { externalId: "1", name: "Org 1", currency: "INR", timezone: "Asia/Kolkata", status: "ACTIVE" },
      { externalId: "2", name: "Org 2", currency: "USD", timezone: null, status: "ACTIVE" },
    ]);
    const h = (await hits())[0]!;
    expect(h.headers.get("authorization")).toBe("Bearer ap-access");
    expect(h.headers.get("x-ap-context")).toBeNull();
  });

  it("getUser is the first org", async () => {
    server.use(http.get(`${AP}/acls`, () => HttpResponse.json({ data: [acl(7, { orgName: "Ashniva" })] })));
    expect(await operator().getUser(customer)).toEqual({ id: "7", name: "Ashniva" });
  });

  it.each(STATUS_CODES)("maps HTTP %i on /acls to %s", async (status, code) => {
    server.use(http.get(`${AP}/acls`, () => fail(status, { error: { errors: [{ message: "x" }] } })));
    await expect(operator().listAdAccounts(customer)).rejects.toMatchObject({ code });
  });
});

describe("Apple structure", () => {
  it("maps campaigns (string money to numbers), ad groups and ads, scoped to the org", async () => {
    server.use(
      apList("/campaigns", [apCampaign(11), apCampaign(12, { status: "PAUSED", dailyBudgetAmount: null, budgetAmount: null, startTime: null, endTime: null, adChannelType: undefined })]),
      apList("/campaigns/:cid/adgroups", (p) => (p.cid === "11" ? [apAdGroup(21, 11), apAdGroup(22, 11, { status: "PAUSED" })] : [])),
      apList("/campaigns/:cid/adgroups/:gid/ads", (p) => (p.gid === "21" ? [apAd(31)] : [])),
    );
    const s = await operator().fetchStructure(customer, acct);
    expect(s.campaigns.map((c) => [c.externalId, c.status, c.deliveryStatus, c.objective, c.dailyBudget, c.lifetimeBudget, c.startDate, c.endDate, c.raw])).toEqual([
      ["11", "ACTIVE", "RUNNING", "SEARCH", 50, 1000.5, "2026-10-01", "2026-12-31", { adamId: 1234567890 }],
      ["12", "PAUSED", "RUNNING", "SEARCH", null, null, null, null, { adamId: 1234567890 }],
    ]);
    expect(s.adGroups.map((g) => [g.externalId, g.campaignExternalId, g.status, g.bidStrategy])).toEqual([
      ["21", "11", "ACTIVE", "CPC"],
      ["22", "11", "PAUSED", "CPC"],
    ]);
    expect(s.ads).toEqual([expect.objectContaining({ externalId: "31", adGroupExternalId: "21", campaignExternalId: "11", status: "ACTIVE" })]);
    for (const h of await hits()) expect(h.headers.get("x-ap-context")).toBe("orgId=40669820");
  });

  it("follows offset pages to the end using pagination.totalResults", async () => {
    server.use(apList("/campaigns", Array.from({ length: 2500 }, (_, i) => apCampaign(i))), apList("/campaigns/:cid/adgroups", []));
    const s = await operator().fetchStructure(customer, acct);
    expect(s.campaigns).toHaveLength(2500);
    const pages = (await hits({ path: /\/campaigns$/ })).map((h) => [h.url.searchParams.get("offset"), h.url.searchParams.get("limit")]);
    expect(pages).toEqual([["0", "1000"], ["1000", "1000"], ["2000", "1000"]]);
    // 2,500 campaigns means 2,500 ad group lists too; slow on a busy machine.
  }, 30_000);

  it("gives up with an error instead of a partial list when paging never ends", async () => {
    server.use(http.get(`${AP}/campaigns`, ({ request }) => {
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      return HttpResponse.json({ data: Array.from({ length: 1000 }, (_, i) => apCampaign(offset + i)), pagination: { totalResults: 10_000_000 } });
    }));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });

  it("an ad list the campaign type cannot serve (4xx) leaves no ads; auth errors still throw", async () => {
    server.use(apList("/campaigns", [apCampaign(11)]), apList("/campaigns/:cid/adgroups", [apAdGroup(21, 11)]), http.get(`${AP}/campaigns/11/adgroups/21/ads`, () => fail(400)));
    expect((await operator().fetchStructure(customer, acct)).ads).toEqual([]);
    server.use(http.get(`${AP}/campaigns/11/adgroups/21/ads`, () => fail(401)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("propagates campaign and ad group list errors", async () => {
    server.use(http.get(`${AP}/campaigns`, () => fail(429)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    server.use(apList("/campaigns", [apCampaign(11)]), http.get(`${AP}/campaigns/11/adgroups`, () => fail(500)));
    await expect(operator().fetchStructure(customer, acct)).rejects.toMatchObject({ code: "PLATFORM_ERROR" });
  });
});

describe("Apple metrics", () => {
  const report = (granularity: Record<string, unknown>[]) => ({ data: { reportingDataResponse: { row: [{ metadata: { campaignId: 11, campaignName: "C" }, granularity }] } } });

  it("requests a daily campaign report for the range and parses each day", async () => {
    server.use(http.post(`${AP}/reports/campaigns`, () => HttpResponse.json(report([
      { date: "2026-10-01", impressions: 1200, taps: 40, localSpend: { amount: "12.34", currency: "USD" } },
      { date: "2026-10-02", impressions: 0, taps: 0, localSpend: { amount: "0", currency: "USD" } },
    ]))));
    const rows = await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-02" });
    expect(rows.map((r) => [r.date, r.externalId, r.impressions, r.clicks, r.spend])).toEqual([
      ["2026-10-01", "11", 1200, 40, 12.34],
      ["2026-10-02", "11", 0, 0, 0],
    ]);
    const h = (await hits({ path: "/reports/campaigns" }))[0]!;
    expect(h.json).toMatchObject({ startTime: "2026-10-01", endTime: "2026-10-02", granularity: "DAILY", returnRowTotals: false });
    // No timeZone sent: Apple's default is ORTZ (the org's time zone), which matches the account's day boundaries.
    expect(h.json.timeZone ?? "ORTZ").toBe("ORTZ");
    expect(h.headers.get("x-ap-context")).toBe("orgId=40669820");
  });

  // apple/index.ts:187 reads `g.installs`; v5 SpendRow has tapInstalls/viewInstalls/totalInstalls, no `installs`.
  it("counts installs from the v5 SpendRow (totalInstalls), not the removed `installs`", async () => {
    server.use(http.post(`${AP}/reports/campaigns`, () => HttpResponse.json(report([{ date: "2026-10-01", impressions: 10, taps: 5, tapInstalls: 2, viewInstalls: 1, totalInstalls: 3, localSpend: { amount: "1", currency: "USD" } }]))));
    const [row] = await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" });
    expect(row!.conversions).toBe(3);
  });

  it("a 4xx report gives no rows; auth errors throw", async () => {
    server.use(http.post(`${AP}/reports/campaigns`, () => fail(400)));
    expect(await operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
    server.use(http.post(`${AP}/reports/campaigns`, () => fail(401)));
    await expect(operator().fetchMetrics(customer, acct, { from: "2026-10-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });
});

describe("Apple actions", () => {
  it("status and daily budget are PUT { campaign: … } with Money as a decimal string", async () => {
    server.use(...apCreate());
    await operator().setCampaignStatus(customer, acct, { externalId: "11" }, "PAUSED");
    await operator().setCampaignStatus(customer, acct, { externalId: "11" }, "ACTIVE");
    await operator().setCampaignDailyBudget(customer, { ...acct, currency: "GBP" }, { externalId: "11" }, 25.5);
    expect((await hits({ method: "PUT" })).map((h) => h.json)).toEqual([
      { campaign: { status: "PAUSED" } },
      { campaign: { status: "ENABLED" } },
      { campaign: { dailyBudgetAmount: { amount: "25.5", currency: "GBP" } } },
    ]);
  });
});

describe("Apple createCampaign", () => {
  const draft = (over: Parameters<typeof makeDraft>[2] = {}) =>
    makeDraft("APPLE", { channel: "SEARCH" }, {
      ...over,
      campaign: { adamId: "1234567890", budget: 30, locations: [{ id: "in", name: "India", type: "country" }], ...over.campaign },
      adGroup: { cpt: 1.25, keywords: [{ text: "saree app", matchType: "EXACT" }, { text: "ethnic wear", matchType: "PHRASE" }], ...over.adGroup },
    });

  it("creates a paused search campaign, ad group, keywords and ad", async () => {
    server.use(...apCreate());
    const d = draft();
    const made = await operator().createCampaign(customer, acct, d, new Map());
    const camp = (await hits({ method: "POST", path: /\/campaigns$/ }))[0]!.json;
    expect(camp).toEqual({ name: "Festive Sale", adamId: 1234567890, adChannelType: "SEARCH", status: "PAUSED", dailyBudgetAmount: { amount: "30", currency: "USD" }, countriesOrRegions: ["IN"] });
    const group = (await hits({ method: "POST", path: /\/adgroups$/ }))[0]!.json;
    expect(group).toMatchObject({ status: "PAUSED", defaultBidAmount: { amount: "1.25", currency: "USD" }, automatedKeywordsOptIn: true });
    const ad = (await hits({ method: "POST", path: /\/ads$/ }))[0]!.json;
    expect(ad).toMatchObject({ creativeType: "SEARCH_RESULTS", status: "PAUSED" });
    expect(made.campaigns[0]).toMatchObject({ externalId: "101", status: "PAUSED", dailyBudget: 30 });
    expect(made.adGroups[0]).toMatchObject({ externalId: "102", sourceKey: d.adGroups[0]!.key, bidStrategy: "1.25" });
    expect(made.ads[0]).toMatchObject({ adGroupExternalId: "102", sourceKey: d.adGroups[0]!.ads[0]!.key });
    for (const h of await hits()) expect(h.headers.get("x-ap-context")).toBe("orgId=40669820");
  });

  it("sends phrase-match keywords as broad (Apple has no phrase match)", async () => {
    server.use(...apCreate());
    await operator().createCampaign(customer, acct, draft(), new Map());
    const body = (await hits({ path: "/targetingkeywords/bulk" }))[0]!.json;
    const list = Array.isArray(body) ? body : body.keywords;
    expect(list.map((k: { matchType: string }) => k.matchType)).toEqual(["EXACT", "BROAD"]);
  });

  // apple/builder.ts:46 posts { keywords: [...] }; the documented body is a bare [Keyword] array.
  it("posts targeting keywords as the documented bare array", async () => {
    server.use(...apCreate());
    await operator().createCampaign(customer, acct, draft(), new Map());
    expect(Array.isArray((await hits({ path: "/targetingkeywords/bulk" }))[0]!.json)).toBe(true);
  });

  it("an ACTIVE launch enables everything; a custom product page ad makes its creative first", async () => {
    server.use(...apCreate());
    await operator().createCampaign(customer, acct, draft({ campaign: { launchStatus: "ACTIVE" }, ad: { creativeType: "CUSTOM_PRODUCT_PAGE", productPageId: "pp-1" } }), new Map());
    expect((await hits({ method: "POST", path: /\/campaigns$/ }))[0]!.json.status).toBe("ENABLED");
    const creative = (await hits({ path: "/creatives" }))[0]!.json;
    expect(creative).toEqual({ adamId: 1234567890, name: expect.any(String), type: "CUSTOM_PRODUCT_PAGE", productPageId: "pp-1" });
    expect((await hits({ method: "POST", path: /\/ads$/ }))[0]!.json).toMatchObject({ creativeType: "CUSTOM_PRODUCT_PAGE", status: "ENABLED", creativeId: expect.any(String) });
  });

  it("rejects a non-numeric adamId before any request", async () => {
    await expect(operator().createCampaign(customer, acct, draft({ campaign: { adamId: "id123" } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await hits()).toHaveLength(0);
  });

  it("fails when Apple returns no campaign id", async () => {
    server.use(http.post(`${AP}/campaigns`, () => HttpResponse.json({ data: {} })));
    await expect(operator().createCampaign(customer, acct, draft(), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("pauses the new campaign when a later step fails after an ACTIVE launch", async () => {
    let groups = 0;
    server.use(http.post(`${AP}/campaigns/:cid/adgroups`, async ({ request }) => (++groups === 2 ? fail(400, { error: { errors: [{ message: "bad bid" }] } }) : HttpResponse.json({ data: { ...((await request.json()) as object), id: 900 } }))), ...apCreate());
    await expect(operator().createCampaign(customer, acct, draft({ groups: 2, campaign: { launchStatus: "ACTIVE" } }), new Map())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // Ad group 1 is ENABLED with an ENABLED ad; the caller sees a failure, so nothing may keep delivering.
    const paused = (await hits({ method: "PUT" })).filter((h) => JSON.stringify(h.json).includes("PAUSED"));
    expect(paused.length).toBeGreaterThan(0);
  });
});
