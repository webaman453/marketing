/**
 * Shopify Admin API. OAuth is per store. A created campaign is a marketing
 * event (UTM, budget, landing page). Shopify does not serve the ad.
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BuilderDraft } from "@ashniva/shared";
import { budgetOf, str } from "../builder-values";
import { ConnectorError } from "../errors";
import { allPages, nextLink, requestJson, requestWithHeaders, type RequestOptions } from "../http";
import { apiError, formToken } from "../oauth-flow";
import { accountTree } from "../tree";
import type { AccountRef, AccountStructure, AdPlatformConnector, BuilderAsset, ConnectorAuth, EntityStatus, ExternalAdAccount, ExternalMetricRow, OAuthTokens } from "../types";

export interface ShopifyConfig {
  clientId?: string;
  clientSecret?: string;
}

const API_VERSION = "2026-04";
type Row = Record<string, any>;

/** Accepts "your-store", a URL, or your-store.myshopify.com. */
export function shopifyShop(raw: string) {
  let shop = raw.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "";
  if (shop && !shop.includes(".")) shop = `${shop}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new ConnectorError("INVALID_REQUEST", "Enter the store domain, like your-store.myshopify.com.");
  }
  return shop;
}

/**
 * Checks the `hmac` Shopify adds to the OAuth callback query: HMAC-SHA256 of the
 * other params, sorted and joined as k=v&…, keyed with the app secret.
 */
export function verifyShopifyHmac(query: Record<string, unknown>, secret: string) {
  const given = typeof query.hmac === "string" ? query.hmac : "";
  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${Array.isArray(query[k]) ? (query[k] as unknown[]).join(",") : String(query[k])}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  // Compare bytes: a forged value with multi-byte characters can match the string length but not
  // the byte length, and timingSafeEqual throws on unequal lengths.
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function pack(shop: string, token: string) {
  return `${shop} ${token}`;
}

function unpack(packed: string) {
  const space = packed.indexOf(" ");
  const shop = space > 0 ? packed.slice(0, space) : "";
  const token = space > 0 ? packed.slice(space + 1) : "";
  if (!shop.endsWith(".myshopify.com") || !token) {
    throw new ConnectorError("AUTH_EXPIRED", "Reconnect Shopify. The stored store login is incomplete.");
  }
  return { shop, token };
}

function shopFromState(state: string) {
  const payload = state.split(".")[1];
  if (!payload) throw new ConnectorError("INVALID_REQUEST", "Enter the store domain before connecting Shopify.");
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString()) as { shop?: string };
    return shopifyShop(String(json.shop ?? ""));
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError("INVALID_REQUEST", "Enter the store domain before connecting Shopify.");
  }
}

export class ShopifyConnector implements AdPlatformConnector {
  readonly platform = "SHOPIFY" as const;
  constructor(private readonly config: ShopifyConfig) {}

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertConfigured() {
    if (!this.isConfigured()) throw new ConnectorError("NOT_CONFIGURED", "Shopify credentials are not configured.");
  }

  private async admin<T>(auth: ConnectorAuth, path: string, opts: RequestOptions = {}) {
    const { shop, token } = unpack(auth.accessToken);
    return requestJson<T>(
      `https://${shop}/admin/api/${API_VERSION}/${path}`,
      { ...opts, headers: { "X-Shopify-Access-Token": token, ...opts.headers } },
      apiError("Shopify"),
    );
  }

  getAuthUrl({ state, redirectUri }: { state: string; redirectUri: string }) {
    this.assertConfigured();
    const shop = shopFromState(state);
    const u = new URL(`https://${shop}/admin/oauth/authorize`);
    u.searchParams.set("client_id", this.config.clientId!);
    u.searchParams.set("scope", "write_marketing_events");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  }

  /**
   * The API passes the raw callback query, so the `hmac` Shopify signs it with is
   * checked here; the signed state already pins the shop.
   */
  async exchangeCode({ code, redirectUri, state, query }: { code: string; redirectUri: string; state?: string; query?: Record<string, unknown> }): Promise<OAuthTokens> {
    this.assertConfigured();
    if (query && !verifyShopifyHmac(query, this.config.clientSecret!)) {
      throw new ConnectorError("INVALID_REQUEST", "Shopify's sign-in reply failed its signature check. Start Connect again.");
    }
    const shop = shopFromState(state ?? "");
    const tokens = await formToken(`https://${shop}/admin/oauth/access_token`, {
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
      code,
      redirect_uri: redirectUri,
    });
    if (tokens.scopes.length && !tokens.scopes.includes("write_marketing_events")) {
      throw new ConnectorError("INVALID_REQUEST", "The store did not grant marketing events. Approve that permission and connect again.");
    }
    return {
      ...tokens,
      accessToken: pack(shop, tokens.accessToken),
      refreshToken: tokens.refreshToken ? pack(shop, tokens.refreshToken) : undefined,
    };
  }

  async refreshTokens(refreshToken: string) {
    this.assertConfigured();
    const { shop, token } = unpack(refreshToken);
    const tokens = await formToken(`https://${shop}/admin/oauth/access_token`, {
      client_id: this.config.clientId!,
      client_secret: this.config.clientSecret!,
      grant_type: "refresh_token",
      refresh_token: token,
    });
    return {
      ...tokens,
      accessToken: pack(shop, tokens.accessToken),
      refreshToken: pack(shop, tokens.refreshToken || token),
    };
  }

  async getUser(auth: ConnectorAuth) {
    const res = await this.admin<{ shop?: Row }>(auth, "shop.json");
    const shop = res.shop ?? {};
    return { id: String(shop.myshopify_domain ?? unpack(auth.accessToken).shop), name: shop.name ?? "Shopify store" };
  }

  async listAdAccounts(auth: ConnectorAuth): Promise<ExternalAdAccount[]> {
    const res = await this.admin<{ shop?: Row }>(auth, "shop.json");
    const shop = res.shop ?? {};
    const domain = String(shop.myshopify_domain ?? unpack(auth.accessToken).shop);
    return [{
      externalId: domain,
      name: shop.name ?? domain,
      currency: shop.currency ?? "USD",
      timezone: shop.iana_timezone ?? null,
      status: "ACTIVE",
      meta: { shop: domain },
    }];
  }

  async fetchStructure(auth: ConnectorAuth, _account: AccountRef): Promise<AccountStructure> {
    const { shop, token } = unpack(auth.accessToken);
    const first = `https://${shop}/admin/api/${API_VERSION}/marketing_events.json?limit=250`;
    // Pages are linked with Link: <…page_info…>; rel="next".
    const events = await allPages<Row, string>(first, async (url) => {
      const { data, headers } = await requestWithHeaders<{ marketing_events?: Row[] }>(url, { headers: { "X-Shopify-Access-Token": token } }, apiError("Shopify"));
      return { items: data?.marketing_events ?? [], next: nextLink(headers.get("link")) };
    }, "Shopify marketing event list");
    const trees = events.map((event) => this.eventTree(event));
    return {
      campaigns: trees.flatMap((t) => t.campaigns),
      adGroups: trees.flatMap((t) => t.adGroups),
      ads: trees.flatMap((t) => t.ads),
    };
  }

  fetchMetrics(): Promise<ExternalMetricRow[]> {
    return Promise.resolve([]);
  }

  async setCampaignStatus(auth: ConnectorAuth, _account: AccountRef, campaign: { externalId: string }, status: "ACTIVE" | "PAUSED") {
    await this.admin(auth, `marketing_events/${campaign.externalId}.json`, {
      method: "PUT",
      body: { marketing_event: { id: Number(campaign.externalId), ended_at: status === "PAUSED" ? new Date().toISOString() : null } },
    });
  }

  async setCampaignDailyBudget(auth: ConnectorAuth, account: AccountRef & { currency: string }, campaign: { externalId: string }, amount: number) {
    await this.admin(auth, `marketing_events/${campaign.externalId}.json`, {
      method: "PUT",
      body: { marketing_event: { id: Number(campaign.externalId), budget: amount.toFixed(2), budget_type: "daily", currency: account.currency } },
    });
  }

  async createCampaign(auth: ConnectorAuth, account: AccountRef & { currency: string }, draft: BuilderDraft, _assets: Map<string, BuilderAsset>): Promise<AccountStructure> {
    const c = draft.campaign;
    const group = draft.adGroups[0];
    const adNode = group?.ads[0];
    const ad = adNode?.values ?? {};
    const paused = c.launchStatus !== "ACTIVE";
    const budget = budgetOf(c);
    // A marketing event only records the ad and has no paused state. "Create paused" is
    // "Record as ended" in the form: the event ends when it starts, so a later sync reads it
    // as paused (ended_at in the past), the same as setCampaignStatus(PAUSED) does.
    const started = new Date().toISOString();
    const endedAt = paused ? started : undefined;
    const url = str(ad, "url");
    let referring: string | undefined;
    try {
      referring = new URL(url).hostname;
    } catch {
      referring = undefined;
    }
    const made = await this.admin<{ marketing_event?: Row }>(auth, "marketing_events.json", {
      method: "POST",
      body: {
        marketing_event: {
          event_type: "ad",
          marketing_channel: String(draft.setup.channel || "social"),
          paid: true,
          started_at: started,
          ended_at: endedAt,
          budget: budget ? budget.amount.toFixed(2) : undefined,
          budget_type: budget?.lifetime ? "lifetime" : "daily",
          currency: account.currency,
          utm_campaign: str(c, "name").slice(0, 255),
          utm_source: str(c, "utmSource") || undefined,
          utm_medium: str(c, "utmMedium") || undefined,
          description: str(ad, "description") || str(c, "name"),
          referring_domain: referring,
        },
      },
    });
    const id = String(made.marketing_event?.id ?? "");
    if (!id) throw new ConnectorError("INVALID_REQUEST", "Shopify did not return a marketing event.");
    const status: EntityStatus = paused ? "PAUSED" : "ACTIVE";
    const tree = this.eventTree({
      id,
      utm_campaign: str(c, "name"),
      marketing_channel: draft.setup.channel,
      budget: budget && !budget.lifetime ? budget.amount : null,
      description: str(ad, "description"),
      referring_domain: referring,
      started_at: started,
      ended_at: endedAt ?? null,
    }, status);
    if (group && tree.adGroups[0]) tree.adGroups[0].sourceKey = group.key;
    if (adNode && tree.ads[0]) tree.ads[0].sourceKey = adNode.key;
    tree.warnings = ["Saved on the Shopify store as a marketing event. Shopify does not serve this ad."];
    return tree;
  }

  private eventTree(event: Row, status?: EntityStatus): AccountStructure {
    const id = String(event.id);
    const ended = event.ended_at ? new Date(event.ended_at).getTime() <= Date.now() : false;
    const state: EntityStatus = status ?? (ended ? "PAUSED" : "ACTIVE");
    const name = String(event.utm_campaign || event.description || `Event ${id}`);
    return accountTree({
      campaign: {
        id,
        name,
        status: state,
        objective: event.marketing_channel ? String(event.marketing_channel) : null,
        daily: event.budget_type === "lifetime" ? null : event.budget != null ? Number(event.budget) : null,
        lifetime: event.budget_type === "lifetime" && event.budget != null ? Number(event.budget) : null,
        start: event.started_at ? String(event.started_at).slice(0, 10) : null,
        end: event.ended_at ? String(event.ended_at).slice(0, 10) : null,
      },
      groups: [{ id: `${id}:track`, name: "Tracking", status: state }],
      ads: [{
        id: `${id}:page`,
        groupId: `${id}:track`,
        name: name,
        status: state,
        body: event.description ? String(event.description) : null,
        url: event.referring_domain ? `https://${event.referring_domain}` : null,
      }],
    });
  }
}
