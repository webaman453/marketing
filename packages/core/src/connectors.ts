import { createConnectorRegistry, type ConnectorRegistry } from "@ashniva/connectors";

let registry: ConnectorRegistry | undefined;

/** Drops the registry so the next call picks up changed credentials. */
export function resetConnectors() {
  registry = undefined;
}

/** Connector registry configured from environment variables (and the admin console, via process.env). */
export function connectors(): ConnectorRegistry {
  registry ??= createConnectorRegistry({
    meta: {
      appId: process.env.META_APP_ID || undefined,
      appSecret: process.env.META_APP_SECRET || undefined,
      apiVersion: process.env.META_API_VERSION || "v26.0",
    },
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || undefined,
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || undefined,
      apiVersion: process.env.GOOGLE_ADS_API_VERSION || "v25",
    },
    tiktok: {
      appId: process.env.TIKTOK_APP_ID || undefined,
      appSecret: process.env.TIKTOK_APP_SECRET || undefined,
    },
    linkedin: {
      clientId: process.env.LINKEDIN_CLIENT_ID || undefined,
      clientSecret: process.env.LINKEDIN_CLIENT_SECRET || undefined,
      apiVersion: process.env.LINKEDIN_API_VERSION || "202609",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || undefined,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || undefined,
      developerToken: process.env.MICROSOFT_DEVELOPER_TOKEN || undefined,
      tenant: process.env.MICROSOFT_TENANT || "common",
    },
    snapchat: {
      clientId: process.env.SNAPCHAT_CLIENT_ID || undefined,
      clientSecret: process.env.SNAPCHAT_CLIENT_SECRET || undefined,
    },
    pinterest: {
      appId: process.env.PINTEREST_APP_ID || undefined,
      appSecret: process.env.PINTEREST_APP_SECRET || undefined,
    },
  });
  return registry;
}
