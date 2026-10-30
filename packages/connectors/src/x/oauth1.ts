/**
 * OAuth 1.0a for the X Ads API: HMAC-SHA1 request signing and the stored token.
 * Docs: https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
 */
import { createHmac, randomBytes } from "node:crypto";
import { ConnectorError } from "../errors";

/** RFC 3986 percent-encoding, which OAuth 1.0a requires (encodeURIComponent leaves !'()* alone). */
export function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `a=1&b=2` with RFC 3986 encoding, undefined/null values left out. */
export function encodeParams(params: Record<string, unknown>) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(String(v))}`)
    .join("&");
}

export interface SignInput {
  method: string;
  /** Full URL; its query parameters are signed. */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  /** Extra oauth_* parameters (oauth_callback, oauth_verifier). */
  oauth?: Record<string, string>;
  /** Form-encoded body parameters; JSON and multipart bodies are not signed. */
  form?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}

/** The signature base string: METHOD&base-url&sorted-parameters, each part percent-encoded. */
export function signatureBase(input: SignInput, oauth: Record<string, string>) {
  const u = new URL(input.url);
  const pairs: [string, string][] = [];
  u.searchParams.forEach((v, k) => pairs.push([k, v]));
  for (const [k, v] of Object.entries(input.form ?? {})) pairs.push([k, v]);
  for (const [k, v] of Object.entries(oauth)) pairs.push([k, v]);
  const encoded = pairs.map(([k, v]) => [percentEncode(k), percentEncode(v)] as const);
  encoded.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  const params = encoded.map(([k, v]) => `${k}=${v}`).join("&");
  const base = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  return [input.method.toUpperCase(), percentEncode(base), percentEncode(params)].join("&");
}

/** The `Authorization: OAuth …` header for one request. */
export function oauthHeader(input: SignInput) {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: input.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(input.token ? { oauth_token: input.token } : {}),
    ...input.oauth,
  };
  const key = `${percentEncode(input.consumerSecret)}&${percentEncode(input.tokenSecret ?? "")}`;
  oauth.oauth_signature = createHmac("sha1", key).update(signatureBase(input, oauth)).digest("base64");
  return `OAuth ${Object.entries(oauth)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(", ")}`;
}

/** What a connection stores as its "access token": the user's token, its secret, and who it belongs to. */
export interface XToken {
  token: string;
  secret: string;
  userId?: string;
  screenName?: string;
}

export const packToken = (t: XToken) => JSON.stringify({ oauth1: t });

/** Connections made before OAuth 1.0a hold a plain OAuth 2.0 token, which the Ads API refuses. */
export function unpackToken(accessToken: string): XToken {
  try {
    const t = (JSON.parse(accessToken) as { oauth1?: XToken }).oauth1;
    if (t?.token && t.secret) return t;
  } catch {
    /* not ours */
  }
  throw new ConnectorError("AUTH_EXPIRED", "Reconnect X: the X Ads API needs a fresh sign-in.");
}
