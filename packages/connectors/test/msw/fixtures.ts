/** Small fixtures shared across connector unit tests. */
import type { AccountRef, ConnectorAuth } from "../../src/types";

export const REDIRECT = "https://app.ashniva.test/api/integrations/callback";
export const STATE = "state-jwt-123";

export const auth = (accessToken = "access-1", credentials?: Record<string, string>): ConnectorAuth => ({ accessToken, credentials });

export const account = (externalId: string, over: Partial<AccountRef & { currency: string }> = {}): AccountRef & { currency: string; timezone: string | null } => ({
  externalId,
  currency: "USD",
  timezone: "UTC",
  meta: null,
  ...over,
});

/** Parses a URL's query string into a plain object. */
export const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

/** Fixed clock for expiresAt math. */
export const NOW = new Date("2026-10-15T10:00:00.000Z");

/** Status codes and the ConnectorError code each must map to (errors.ts / http.ts codeFromStatus). */
export const STATUS_CODES: [number, string][] = [
  [401, "AUTH_EXPIRED"],
  [403, "PERMISSION_DENIED"],
  [429, "RATE_LIMITED"],
  [400, "INVALID_REQUEST"],
  [500, "PLATFORM_ERROR"],
  [503, "PLATFORM_ERROR"],
];
