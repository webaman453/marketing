/**
 * Shared OAuth helpers for the newer ad platforms. Each connector still owns
 * its own endpoints and campaign mapping.
 */
import { createHash, createHmac } from "node:crypto";
import { CONNECT_CREDENTIALS, PLATFORM_INFO, type Platform } from "@ashniva/shared";
import { ConnectorError } from "./errors";
import { codeFromStatus, requestJson } from "./http";
import type { EntityStatus, OAuthTokens, PlatformCredentials } from "./types";

export const CLIENT_REFRESH = "client_credentials";

export function apiError(label: string) {
  return (status: number, body: unknown) => {
    const b = body as {
      error_description?: string;
      message?: string;
      error?: string | { message?: string; error_user_msg?: string };
      errors?: { message?: string }[];
    };
    const nested = typeof b?.error === "string" ? b.error : b?.error?.error_user_msg ?? b?.error?.message;
    const msg = b?.error_description ?? nested ?? b?.errors?.[0]?.message ?? b?.message ?? `${label} error (${status})`;
    return new ConnectorError(codeFromStatus(status), msg, body);
  };
}

export async function formToken(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<OAuthTokens> {
  const res = await requestJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }>(
    url,
    { method: "POST", form: true, headers, body },
    apiError("OAuth"),
  );
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : undefined,
    scopes: typeof res.scope === "string" ? res.scope.split(/[ ,]/).filter(Boolean) : [],
  };
}

/** Browser returns to our callback so a saved token or client-credentials grant can finish Connect. */
export function selfRedirect(redirectUri: string, state: string, code = CLIENT_REFRESH) {
  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  u.searchParams.set("state", state);
  return u.toString();
}

/** PKCE pair derived from the OAuth state, so the token exchange can rebuild the verifier. */
export function pkce(secret: string, state: string) {
  const verifier = createHmac("sha256", secret).update(state).digest("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function mapStatus(status: string | undefined, active = ["ACTIVE", "ENABLED", "RUNNING", "ACCEPTED", "APPROVED"]): EntityStatus {
  const s = (status ?? "").toUpperCase();
  if (active.includes(s)) return "ACTIVE";
  if (["ARCHIVED", "DELETED", "REMOVED", "COMPLETED"].includes(s)) return s === "ARCHIVED" ? "ARCHIVED" : "REMOVED";
  return "PAUSED";
}

export function authHeader(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** A customer's own API keys for the platform, trimmed, with every field filled in; throws naming the first missing one. */
export function requireCredentials(platform: Platform, credentials: PlatformCredentials): PlatformCredentials {
  const out: PlatformCredentials = {};
  for (const field of CONNECT_CREDENTIALS[platform]?.fields ?? []) {
    const value = credentials[field.key]?.trim();
    if (!value) throw new ConnectorError("INVALID_REQUEST", `Enter the ${PLATFORM_INFO[platform].name} ${field.label}.`);
    out[field.key] = value;
  }
  return out;
}
